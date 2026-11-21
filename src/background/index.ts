import { isInternalUrl, loadConfig, saveConfig } from "../shared/config.ts";
import type { ActivityState, BackgroundMessage, OpenTabInfo, SnapshotWindow, StatusPayload, TabSummary } from "../shared/types.ts";
import {
  archiveTabs,
  deleteArchivedTab,
  handleBookmarkRemoved,
  loadArchive,
  planArchives,
  planArchivesWithBreakdown,
  removeArchivedByUrl,
  restoreArchivedTab,
  syncArchive,
  searchArchive,
} from "./archive.ts";
import { updateActionBadge } from "./badge.ts";
import { computeOpenTabActions, isTabProtected, planEvictions } from "./eviction.ts";
import { getMemorySnapshot, hasNativeMessagingPermission, pingNativeHost } from "./memory.ts";
import { checkTabHasUnsavedForm, hasHostAccessPermission, loadCachedWeights, sampleTabWeights } from "./sampler.ts";
import {
  captureSessionSnapshot,
  captureWindowMetadata,
  type CachedGroups,
  clearSnapshots,
  setSyncFolder,
  deleteSnapshot,
  findRecoverableSnapshot,
  isRestoreInFlight,
  listAllSnapshots,
  loadSnapshots,
  restoreSessionSnapshot,
} from "./session.ts";
import {
  detectSyncFolders,
  enqueueConfigMutation,
  getSyncStatus,
  getLocalConfigVersion,
  loadDeviceIdentity,
  pickSyncFolder,
  pullConfigFromSync,
  pushConfigToSync,
  setDeviceName,
  setLocalConfigVersion,
  syncPendingLocalSnapshots,
  setLastSyncAt,
} from "./sync.ts";
import {
  clearKeptTabIds,
  getTabLastActiveAt,
  loadActivityState,
  loadKeptTabIds,
  reconcileActivityOnStartup,
  recordTabVisit,
  removeKeptTabId,
  removeTrackedTab,
  saveActivityState,
  syncActiveTabs,
  toggleKeptTabId,
  toTabSummary,
} from "./tracker.ts";

const SWEEP_ALARM = "tabReaper.sweep";
const REOPEN_OPTIONS_KEY = "tabReaper.reopenOptions";
const WINDOW_TABS_SESSION_KEY = "tabReaper.windowTabsCache";
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let sweepInFlight = false;
let lastSyncRunAt = 0;
let activityQueue: Promise<void> = Promise.resolve();
interface CachedWindow {
  tabs: TabSummary[];
  groups?: CachedGroups;
  window?: SnapshotWindow;
}
type WindowTabs = Record<string, CachedWindow>;

async function loadWindowTabs(): Promise<WindowTabs> {
  const stored = await chrome.storage.session.get(WINDOW_TABS_SESSION_KEY);
  const windows = stored[WINDOW_TABS_SESSION_KEY] as Record<string, CachedWindow | TabSummary[]> | undefined;
  return Object.fromEntries(Object.entries(windows ?? {}).map(([id, value]) =>
    [id, Array.isArray(value) ? { tabs: value } : value]
  ));
}

async function cacheWindowTabs(tabs: TabSummary[], inserted = false): Promise<void> {
  if (!(await loadConfig()).enableSessionSnapshots) {
    await chrome.storage.session.remove(WINDOW_TABS_SESSION_KEY);
    return;
  }
  const [windows, metadata, groups] = await Promise.all([
    loadWindowTabs(),
    captureWindowMetadata(new Set(tabs.map(t => t.windowId))),
    chrome.tabGroups.query({}).catch(() => []),
  ]);
  // Chrome can report an already partially closed window during a sweep. Only
  // individual tab-removal events may discard its cached tabs before onRemoved.
  const byWindow = new Map<number, Map<number, TabSummary>>();
  for (const tab of tabs) {
    const known = byWindow.get(tab.windowId) ?? new Map((windows[tab.windowId]?.tabs ?? []).map(t => [t.id, t]));
    if (inserted && tab.index !== undefined && !known.has(tab.id)) {
      for (const other of known.values()) {
        if (other.index !== undefined && other.index >= tab.index) other.index++;
      }
    }
    known.set(tab.id, tab);
    byWindow.set(tab.windowId, known);
  }
  for (const [id, known] of byWindow) {
    const previous = windows[id];
    const cachedGroups = { ...previous?.groups };
    for (const group of groups) {
      if (group.windowId === id) {
        cachedGroups[group.id] = { title: group.title, color: group.color, collapsed: group.collapsed };
      }
    }
    windows[id] = { tabs: [...known.values()], groups: cachedGroups, window: metadata.find(w => w.id === id) ?? previous?.window };
  }
  try {
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  } catch (error) {
    console.warn("Window recovery cache update failed", error);
  }
}

async function runPeriodicSync(
  force = false,
): Promise<{ ok: boolean; configUpdated: boolean; archiveChanged: boolean }> {
  const now = Date.now();
  if (!force && now - lastSyncRunAt < SYNC_INTERVAL_MS) {
    return { ok: true, configUpdated: false, archiveChanged: false };
  }
  lastSyncRunAt = now;
  try {
    const configRes = await pullConfigFromSync(loadConfig, async (remoteCfg) => {
      await saveConfig(remoteCfg);
    });
    const archiveRes = await syncArchive(now);
    const snapRes = await syncPendingLocalSnapshots(loadSnapshots, now);
    const ok = configRes.ok && archiveRes.ok && snapRes.ok;
    if (ok) await setLastSyncAt(now);
    return {
      ok,
      configUpdated: configRes.updated,
      archiveChanged: archiveRes.changed,
    };
  } catch {
    return { ok: false, configUpdated: false, archiveChanged: false };
  }
}

function enqueueActivityUpdate<T>(fn: () => Promise<T>): Promise<T> {
  const next = activityQueue.then(fn, fn);
  activityQueue = next.then(() => {}, () => {});
  return next;
}

async function maybeReopenOptions(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(REOPEN_OPTIONS_KEY);
    if (stored[REOPEN_OPTIONS_KEY]) {
      await chrome.storage.local.remove(REOPEN_OPTIONS_KEY);
      await chrome.runtime.openOptionsPage();
    }
  } catch {
    // Best-effort reopen after optional-permission reload.
  }
}

function isBrowserOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

async function queryAllTabs(): Promise<TabSummary[]> {
  return enqueueActivityUpdate(async () => {
    const [tabs, keptIds] = await Promise.all([chrome.tabs.query({}), loadKeptTabIds()]);
    const summaries: TabSummary[] = [];
    for (const tab of tabs) {
      const summary = toTabSummary(tab, keptIds);
      if (summary) summaries.push(summary);
    }
    await cacheWindowTabs(summaries);
    return summaries;
  });
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (!existing) {
    await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
  }
}

async function runSweep(mode: "sweep" | "startup" = "sweep"): Promise<{ discarded: number; archived: number }> {
  if (sweepInFlight || isRestoreInFlight()) return { discarded: 0, archived: 0 };
  sweepInFlight = true;

  try {
    const now = Date.now();
    const config = await loadConfig();
    const tabs = await queryAllTabs();
    let activity!: ActivityState;

    await enqueueActivityUpdate(async () => {
      const loaded = await loadActivityState();
      activity =
        mode === "startup"
          ? reconcileActivityOnStartup(loaded, tabs, now)
          : syncActiveTabs(loaded, tabs, now);
      if (mode === "startup" || activity !== loaded) {
        await saveActivityState(activity);
      }
    });

    const memory = mode === "startup" ? null : await getMemorySnapshot(config, now);
    const online = isBrowserOnline();

    // Sample only eligible loaded tabs when we might need to choose among them.
    const eligibleLoaded = tabs.filter((t) => !t.discarded && !isTabProtected(t, config));
    const shouldSample =
      mode === "sweep" &&
      online &&
      eligibleLoaded.length > 1 &&
      (eligibleLoaded.length > config.maxActiveTabs || Boolean(memory?.overBudget));
    const weights = shouldSample ? await sampleTabWeights(eligibleLoaded, now) : new Map();

    const evictions = planEvictions({
      tabs,
      activity,
      weights,
      config,
      memory,
      now,
      mode,
      isOnline: online,
    });

    let discarded = 0;
    for (const candidate of evictions) {
      try {
        if (mode === "sweep" && config.protectUnsavedForms && !weights.has(candidate.tab.id)) {
          const hasForm = await checkTabHasUnsavedForm(candidate.tab.id);
          if (hasForm) continue;
        }
        await chrome.tabs.discard(candidate.tab.id);
        discarded++;
      } catch {
        // Tab may have become active, closed, or non-discardable concurrently.
      }
    }

    let archived = 0;
    if (mode === "sweep") {
      const toArchive = planArchives({ tabs, activity, weights, config, now });
      archived = await archiveTabs(toArchive, activity, config, now);
    }

    const loadedCount = Math.max(0, tabs.filter((t) => !t.discarded).length - discarded);
    await updateActionBadge(memory, loadedCount, online);

    if (mode === "sweep" && config.enableSessionSnapshots) {
      try {
        await captureSessionSnapshot(tabs, { now, activity });
      } catch {
        // Snapshot persistence is best-effort and must never fail a sweep.
      }
    }

    if (mode === "sweep") {
      void runPeriodicSync(false);
    }

    return { discarded, archived };
  } finally {
    sweepInFlight = false;
  }
}

async function buildStatus(): Promise<StatusPayload> {
  const now = Date.now();
  const online = isBrowserOnline();
  const config = await loadConfig();
  const [tabs, windows, memory, archive, activity, snapshots, nativeMessaging, hostAccess] = await Promise.all([
    queryAllTabs(),
    chrome.windows.getAll().catch(() => [] as chrome.windows.Window[]),
    getMemorySnapshot(config, now),
    loadArchive(),
    loadActivityState(),
    loadSnapshots(),
    hasNativeMessagingPermission(),
    hasHostAccessPermission(),
  ]);

  const windowById = new Map<number, chrome.windows.Window>();
  for (const win of windows) {
    if (typeof win.id === "number") {
      windowById.set(win.id, win);
    }
  }

  const loadedSummaries = tabs.filter((t) => !t.discarded);
  const weights = hostAccess ? await sampleTabWeights(loadedSummaries, now) : await loadCachedWeights(now);

  let loadedCount = 0;
  let discardedCount = 0;
  let protectedCount = 0;
  const openTabs: OpenTabInfo[] = [];

  for (const tab of tabs) {
    const sample = weights.get(tab.id);
    const win = windowById.get(tab.windowId);
    const isPwa = win?.type === "app";
    const isFocusedActive = tab.active && win?.focused === true;
    const actions = computeOpenTabActions(tab, config, sample, isFocusedActive);

    if (actions.protectedReason !== null) {
      protectedCount++;
    }
    if (tab.discarded) {
      discardedCount++;
    } else {
      loadedCount++;
    }

    const lastActiveAt = getTabLastActiveAt(activity, tab, now);
    const idleMinutes = Math.max(0, Math.round((now - lastActiveAt) / 60_000));

    openTabs.push({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      discarded: tab.discarded,
      kept: Boolean(tab.kept),
      idleMinutes,
      protectedReason: actions.protectedReason,
      weightMultiplier: sample?.weightMultiplier ?? 1.0,
      jsHeapBytes: sample ? sample.jsHeapBytes : null,
      hasUnsavedForm: Boolean(sample?.hasUnsavedForm),
      isPwa,
      canKeep: actions.canKeep,
      canSleep: actions.canSleep,
      canArchive: actions.canArchive,
      canClose: actions.canClose,
    });
  }

  openTabs.sort((a, b) => {
    if (a.discarded !== b.discarded) return a.discarded ? 1 : -1;
    if (!a.discarded) {
      const aHeap = a.jsHeapBytes ?? -1;
      const bHeap = b.jsHeapBytes ?? -1;
      if (aHeap !== bHeap) return bHeap - aHeap;
    }
    // Shortest idle first so tabs that just left active appear at the top.
    return a.idleMinutes - b.idleMinutes;
  });

  await updateActionBadge(memory, loadedCount, online);

  return {
    config,
    memory,
    online,
    loadedCount,
    discardedCount,
    protectedCount,
    archivedCount: archive.length,
    openTabs,
    recoverableSnapshot: await findRecoverableSnapshot(tabs, snapshots, now),
    permissions: { nativeMessaging, hostAccess },
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const tabs = await queryAllTabs();
  const activity = reconcileActivityOnStartup(await loadActivityState(), tabs, Date.now());
  await saveActivityState(activity);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await clearKeptTabIds();
  const config = await loadConfig();
  if (config.startupSweep) {
    await runSweep("startup");
  } else {
    const tabs = await queryAllTabs();
    const activity = reconcileActivityOnStartup(await loadActivityState(), tabs, Date.now());
    await saveActivityState(activity);
  }
  void runPeriodicSync(true);
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return;
    const url = tab.url ?? tab.pendingUrl;
    await enqueueActivityUpdate(async () => {
      const state = recordTabVisit(await loadActivityState(), tabId, url, Date.now(), windowId);
      await saveActivityState(state);
    });
    await runSweep("sweep");
  } catch {
    // Tab closed before lookup.
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== "number" || tab.incognito || isRestoreInFlight()) return;
  const tabId = tab.id;
  const url = tab.url ?? tab.pendingUrl;
  const activeWindowId = tab.active ? tab.windowId : undefined;
  await enqueueActivityUpdate(async () => {
    const state = recordTabVisit(await loadActivityState(), tabId, url, Date.now(), activeWindowId);
    await saveActivityState(state);
  });
  await runSweep("sweep");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.incognito) return;
  if (changeInfo.url || changeInfo.groupId !== undefined || changeInfo.pinned !== undefined) {
    await enqueueActivityUpdate(async () => {
      const summary = toTabSummary(tab, await loadKeptTabIds());
      if (summary) await cacheWindowTabs([summary]);
    });
  }
  if (changeInfo.url && !isInternalUrl(changeInfo.url)) {
    if (tab.active) {
      const nextUrl = changeInfo.url;
      await enqueueActivityUpdate(async () => {
        const state = recordTabVisit(await loadActivityState(), tabId, nextUrl, Date.now(), tab.windowId);
        await saveActivityState(state);
      });
    }
  }
});

async function forgetWindowTab(windowId: number, tabId: number, oldIndex?: number): Promise<void> {
  const windows = await loadWindowTabs();
  const cached = windows[windowId];
  if (!cached) return;
  const index = oldIndex ?? cached.tabs.find(t => t.id === tabId)?.index;
  cached.tabs = cached.tabs.filter(t => t.id !== tabId);
  if (index !== undefined) {
    for (const tab of cached.tabs) {
      if (tab.index !== undefined && tab.index > index) tab.index--;
    }
  }
  await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
}

chrome.tabGroups.onUpdated.addListener(group => enqueueActivityUpdate(async () => {
  const windows = await loadWindowTabs();
  const cached = windows[group.windowId];
  if (cached) {
    (cached.groups ??= {})[group.id] = { title: group.title, color: group.color, collapsed: group.collapsed };
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
}));

chrome.windows.onBoundsChanged.addListener(win => enqueueActivityUpdate(async () => {
  if (!win.id || win.incognito) return;
  const windows = await loadWindowTabs();
  const cached = windows[win.id];
  if (cached) {
    const { id, focused, state, left, top, width, height } = win;
    cached.window = { id, focused, state, left, top, width, height };
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
}));

chrome.tabs.onMoved.addListener((tabId, { windowId, fromIndex, toIndex }) =>
  enqueueActivityUpdate(async () => {
    const windows = await loadWindowTabs();
    const cached = windows[windowId];
    if (!cached) return;
    for (const tab of cached.tabs) {
      if (tab.id === tabId) tab.index = toIndex;
      else if (tab.index !== undefined) {
        if (toIndex <= tab.index && tab.index < fromIndex) tab.index++;
        else if (fromIndex < tab.index && tab.index <= toIndex) tab.index--;
      }
    }
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  })
);

chrome.tabs.onDetached.addListener((tabId, info) =>
  enqueueActivityUpdate(() => forgetWindowTab(info.oldWindowId, tabId, info.oldPosition))
);
chrome.tabs.onAttached.addListener(tabId =>
  enqueueActivityUpdate(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const summary = toTabSummary(tab, await loadKeptTabIds());
    if (summary) await cacheWindowTabs([summary], true);
  })
);

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
  await Promise.all([
    enqueueActivityUpdate(async () => {
      if (!info.isWindowClosing) await forgetWindowTab(info.windowId, tabId);
      const state = removeTrackedTab(await loadActivityState(), tabId);
      await saveActivityState(state);
    }),
    removeKeptTabId(tabId),
  ]);
});

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const closed = await enqueueActivityUpdate(async () => {
      const windows = await loadWindowTabs();
      const final = windows[windowId];
      delete windows[windowId];
      await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
      return final;
    });
    if (!closed || closed.tabs.length < 2 || isRestoreInFlight()) return;
    try {
      const config = await loadConfig();
      if (!config.enableSessionSnapshots) return;
      const activity = await loadActivityState();
      await captureSessionSnapshot(closed.tabs, {
        closedWindow: closed.window,
        groups: closed.groups,
        force: true,
        trigger: "window_closed",
        label: "Closed window",
        activity,
      });
    } catch {
      // Best-effort recovery point on window close.
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    await runSweep("sweep");
  }
});

chrome.bookmarks.onRemoved.addListener(async (bookmarkId) => {
  await handleBookmarkRemoved(bookmarkId);
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const matches = searchArchive(await loadArchive(), text).slice(0, 8);
  suggest(
    matches.map((item) => ({
      content: item.url,
      description: `${escapeXml(item.title)} — ${escapeXml(item.url)}`,
    })),
  );
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let targetUrl = text.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    const first = searchArchive(await loadArchive(), targetUrl)[0];
    if (!first) return;
    targetUrl = first.url;
  }
  if (disposition === "currentTab") {
    await chrome.tabs.update({ url: targetUrl });
  } else {
    await chrome.tabs.create({ url: targetUrl, active: disposition === "newForegroundTab" });
  }
  await removeArchivedByUrl(targetUrl);
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

async function handleMessage(message: BackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case "get_status":
      return buildStatus();
    case "get_archive":
      return searchArchive(await loadArchive(), message.query);
    case "restore_archived":
      return { ok: await restoreArchivedTab(message.id) };
    case "delete_archived":
      return { ok: await deleteArchivedTab(message.id) };
    case "discard_tab":
      try {
        const [raw, config, keptIds] = await Promise.all([
          chrome.tabs.get(message.tabId),
          loadConfig(),
          loadKeptTabIds(),
        ]);
        const summary = toTabSummary(raw, keptIds);
        if (!summary || !computeOpenTabActions(summary, config).canSleep) {
          return { ok: false };
        }
        await chrome.tabs.discard(message.tabId);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    case "toggle_keep_tab": {
      const kept = await toggleKeptTabId(message.tabId);
      if (kept) {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (tab.discarded) {
            await chrome.tabs.reload(message.tabId);
          }
        } catch {
          // Tab may have been closed concurrently.
        }
      }
      return { ok: true, kept };
    }
    case "archive_tab": {
      try {
        const [raw, config, activity, keptIds] = await Promise.all([
          chrome.tabs.get(message.tabId),
          loadConfig(),
          loadActivityState(),
          loadKeptTabIds(),
        ]);
        const summary = toTabSummary(raw, keptIds);
        if (!summary || !computeOpenTabActions(summary, config).canArchive) {
          return { ok: false };
        }
        const archived = await archiveTabs([summary], activity, config, Date.now());
        if (archived > 0) await removeKeptTabId(message.tabId);
        return { ok: archived > 0 };
      } catch {
        return { ok: false };
      }
    }
    case "close_tab": {
      try {
        const [raw, keptIds] = await Promise.all([chrome.tabs.get(message.tabId), loadKeptTabIds()]);
        if (raw.pinned || keptIds.has(message.tabId)) {
          return { ok: false };
        }
        await chrome.tabs.remove(message.tabId);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
    case "discard_idle_now":
      return runSweep("sweep");
    case "archive_old_now": {
      const config = await loadConfig();
      const tabs = await queryAllTabs();
      const activity = await loadActivityState();
      const now = Date.now();
      const breakdown = planArchivesWithBreakdown({ tabs, activity, config, now, forceDiscarded: true });
      const archived = await archiveTabs(breakdown.toArchive, activity, config, now);
      return {
        archived,
        skippedProtected: breakdown.skippedProtected,
        skippedNotDiscarded: breakdown.skippedNotDiscarded,
        skippedNonHttp: breakdown.skippedNonHttp,
        failed: Math.max(0, breakdown.toArchive.length - archived),
      };
    }
    case "save_config": {
      const saved = await enqueueConfigMutation(async () => {
        const next = await saveConfig(message.config);
        const identity = await loadDeviceIdentity();
        const previous = await getLocalConfigVersion();
        await setLocalConfigVersion({ updatedAt: Math.max(Date.now(), previous.updatedAt + 1), deviceId: identity.deviceId });
        return next;
      });
      void pushConfigToSync(loadConfig).catch(() => {});
      await runSweep("sweep");
      return { ok: true, config: saved };
    }
    case "get_snapshots":
      return listAllSnapshots();
    case "capture_snapshot_now": {
      const [tabs, activity] = await Promise.all([queryAllTabs(), loadActivityState()]);
      const snapshot = await captureSessionSnapshot(tabs, {
        force: true,
        trigger: "manual",
        label: message.label,
        activity,
      });
      return { ok: Boolean(snapshot), snapshot };
    }
    case "clear_snapshots": {
      await clearSnapshots();
      return { ok: true };
    }
    case "delete_snapshot": {
      const ok = await deleteSnapshot(message.id, message.syncDir);
      return { ok };
    }
    case "restore_snapshot": {
      const res = await restoreSessionSnapshot(message.id, {
        targetWindowId: message.targetWindowId,
        mode: message.mode,
        relPath: message.relPath,
      });
      return { ok: true, ...res };
    }
    case "test_native_host":
      return pingNativeHost();
    case "get_sync_status":
      return getSyncStatus();
    case "detect_sync_folders":
      return detectSyncFolders();
    case "pick_sync_folder":
      return pickSyncFolder();
    case "set_sync_folder": {
      const status = await setSyncFolder(message.path);
      if (status.ok && status.enabled) {
        await runPeriodicSync(true);
      }
      return status;
    }
    case "set_device_name": {
      const identity = await setDeviceName(message.deviceName);
      return { ok: true, ...identity };
    }
    case "sync_now": {
      const [tabs, activity] = await Promise.all([queryAllTabs(), loadActivityState()]);
      const config = await loadConfig();
      if (config.enableSessionSnapshots) {
        await captureSessionSnapshot(tabs, { force: false, activity, skipSync: true });
      }
      const res = await runPeriodicSync(true);
      const status = await getSyncStatus();
      return { ...res, ok: res.ok && status.hostConnected && status.enabled && status.writable, status };
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

void ensureAlarm();
void maybeReopenOptions();
