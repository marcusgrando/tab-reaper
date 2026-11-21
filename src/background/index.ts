import {
  isInternalUrl,
  loadConfig,
  REOPEN_OPTIONS_KEY,
  saveConfig,
} from "../shared/config.ts";
import type { ActivityState, BackgroundMessage, OpenTabInfo, StatusPayload, TabReaperConfig, TabSummary } from "../shared/types.ts";
import { updateActionBadge } from "./badge.ts";
import { computeOpenTabActions, isTabProtected, MAX_MEMORY_EVICTIONS_PER_PASS, planEvictions } from "./eviction.ts";
import { getMemorySnapshot, hasNativeMessagingPermission, pingNativeHost } from "./memory.ts";
import { checkTabHasUnsavedForm, hasHostAccessPermission, loadCachedWeights, sampleTabWeights } from "./sampler.ts";
import {
  captureSessionSnapshot,
  clearSnapshots,
  setSyncFolder,
  deleteSnapshot,
  findRecoverableSnapshot,
  isRestoreInFlight,
  listAllSnapshots,
  loadSnapshots,
  restoreSessionSnapshot,
  runSerializedWithSnapshots,
} from "./session.ts";
import {
  detectSyncFolders,
  enqueueConfigMutation,
  getSyncStatus,
  getLocalConfigVersion,
  isFolderSyncOptedIn,
  loadDeviceIdentity,
  pickSyncFolder,
  pullConfigFromSync,
  setDeviceName,
  setLocalConfigVersion,
  syncPendingLocalSnapshots,
  setLastSyncAt,
} from "./sync.ts";
import {
  clearKeptTabIds,
  enqueueActivityUpdate,
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
import {
  cacheWindowTabs,
  forgetWindowTab,
  popClosedWindow,
  updateCachedActiveTab,
  updateCachedTabGroup,
  updateCachedTabKept,
  updateCachedTabMoved,
  updateCachedWindowBounds,
} from "./window-cache.ts";

const SWEEP_ALARM = "tabReaper.sweep";
const SWEEP_PERIOD_MINUTES = 0.5;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let sweepInFlight = false;
const LAST_SYNC_ATTEMPT_KEY = "tabReaper.lastSyncAttempt";

function syncConfig() {
  return pullConfigFromSync(loadConfig, async remote => {
    await runSerializedWithSnapshots(() => saveConfig(remote));
  });
}

async function runPeriodicSync(
  force = false,
): Promise<{ ok: boolean; configUpdated: boolean }> {
  const now = Date.now();
  try {
    if (!(await isFolderSyncOptedIn())) return { ok: true, configUpdated: false };
    if (!force) {
      const stored = await chrome.storage.session.get(LAST_SYNC_ATTEMPT_KEY);
      const last = stored[LAST_SYNC_ATTEMPT_KEY];
      if (typeof last === "number" && now >= last && now - last < SYNC_INTERVAL_MS) {
        return { ok: true, configUpdated: false };
      }
    }
    await chrome.storage.session.set({ [LAST_SYNC_ATTEMPT_KEY]: now });
    const configRes = await syncConfig();
    const snapRes = await syncPendingLocalSnapshots(loadSnapshots, now);
    const ok = configRes.ok && snapRes.ok;
    if (ok) await setLastSyncAt(now);
    return {
      ok,
      configUpdated: configRes.updated,
    };
  } catch {
    return { ok: false, configUpdated: false };
  }
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

async function queryAllTabs(updateCache = true): Promise<TabSummary[]> {
  return enqueueActivityUpdate(async () => {
    const [tabs, keptIds] = await Promise.all([chrome.tabs.query({}), loadKeptTabIds()]);
    const summaries: TabSummary[] = [];
    for (const tab of tabs) {
      const summary = toTabSummary(tab, keptIds);
      if (summary) summaries.push(summary);
    }
    if (updateCache) {
      await cacheWindowTabs(summaries);
    }
    return summaries;
  });
}

async function discardTabSafely(
  tabId: number,
  config: TabReaperConfig,
  reason: "manual" | "startup" | "idle_timeout" | "over_memory_budget",
): Promise<boolean> {
  if (config.protectUnsavedForms && (await checkTabHasUnsavedForm(tabId))) {
    return false;
  }
  return enqueueActivityUpdate(async () => {
    const [raw, keptIds] = await Promise.all([chrome.tabs.get(tabId), loadKeptTabIds()]);
    const live = toTabSummary(raw, keptIds);
    if (!live || live.discarded) return false;
    if (reason === "manual" ? !computeOpenTabActions(live, config).canSleep : isTabProtected(live, config)) {
      return false;
    }
    if (reason === "idle_timeout") {
      const state = await loadActivityState();
      const now = Date.now();
      if (now - getTabLastActiveAt(state, live, now) < config.discardAfterMinutes * 60_000) return false;
    }
    await chrome.tabs.discard(tabId);
    return true;
  });
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (!existing || existing.periodInMinutes !== SWEEP_PERIOD_MINUTES) {
    await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
  }
}

async function runSweep(
  mode: "sweep" | "startup" = "sweep",
  options: { periodic?: boolean } = {},
): Promise<{ discarded: number }> {
  if (sweepInFlight || isRestoreInFlight()) return { discarded: 0 };
  sweepInFlight = true;
  const periodic = options.periodic ?? true;

  try {
    const now = Date.now();
    const config = await loadConfig();
    const tabs = await queryAllTabs(periodic || mode === "startup");
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

    // Sample eligible loaded tabs at >= sizeEvictionPercent RAM to sort by weight; in the idle band, unsaved-form check runs per candidate.
    const eligibleLoaded = tabs.filter((t) => !t.discarded && !isTabProtected(t, config));
    const sizeThreshold = Math.max(config.idleEvictionPercent, config.sizeEvictionPercent) / 100;
    const atSizeBand = Boolean(
      memory && (memory.overBudget || (memory.budgetBytes > 0 && memory.usedBytes / memory.budgetBytes >= sizeThreshold)),
    );
    const shouldSample = mode === "sweep" && online && eligibleLoaded.length > 1 && atSizeBand;
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
      maxEvictions: mode === "sweep" ? Infinity : undefined,
    });

    let discarded = 0;
    for (const candidate of evictions) {
      if (mode === "sweep" && discarded >= MAX_MEMORY_EVICTIONS_PER_PASS) break;
      try {
        if (await discardTabSafely(candidate.tab.id, config, candidate.reason)) {
          discarded++;
        }
      } catch {
        // Tab may have become active, closed, or non-discardable concurrently.
      }
    }

    const loadedCount = Math.max(0, tabs.filter((t) => !t.discarded).length - discarded);
    const badgeThresholds = {
      idleRatio: config.idleEvictionPercent / 100,
      sizeRatio: config.sizeEvictionPercent / 100,
    };
    await updateActionBadge(memory, loadedCount, online, badgeThresholds);

    if (mode === "sweep" && periodic && config.enableSessionSnapshots && (await isFolderSyncOptedIn())) {
      try {
        await captureSessionSnapshot(tabs, { now, activity, intervalMinutes: config.snapshotIntervalMinutes });
      } catch {
        // Snapshot persistence is best-effort and must never fail a sweep.
      }
    }

    if (mode === "sweep" && periodic) {
      void runPeriodicSync(false);
    }

    return { discarded };
  } finally {
    sweepInFlight = false;
  }
}

async function buildStatus(): Promise<StatusPayload> {
  const now = Date.now();
  const online = isBrowserOnline();
  const config = await loadConfig();
  const [tabs, windows, memory, activity, snapshots, nativeMessaging, hostAccess] = await Promise.all([
    queryAllTabs(false),
    chrome.windows.getAll().catch(() => [] as chrome.windows.Window[]),
    getMemorySnapshot(config, now),
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

  await updateActionBadge(memory, loadedCount, online, {
    idleRatio: config.idleEvictionPercent / 100,
    sizeRatio: config.sizeEvictionPercent / 100,
  });

  return {
    config,
    memory,
    online,
    loadedCount,
    discardedCount,
    protectedCount,
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
  const activeCacheUpdate = enqueueActivityUpdate(() => updateCachedActiveTab(windowId, tabId));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return;
    const url = tab.url ?? tab.pendingUrl;
    await activeCacheUpdate;
    await enqueueActivityUpdate(async () => {
      const state = recordTabVisit(await loadActivityState(), tabId, url, Date.now(), windowId);
      await saveActivityState(state);
    });
    await runSweep("sweep", { periodic: false });
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
    const [activity, keptIds] = await Promise.all([loadActivityState(), loadKeptTabIds()]);
    const state = recordTabVisit(activity, tabId, url, Date.now(), activeWindowId);
    await saveActivityState(state);
    const summary = toTabSummary(tab, keptIds);
    if (summary) await cacheWindowTabs([summary], true);
  });
  await runSweep("sweep", { periodic: false });
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

chrome.tabGroups.onUpdated.addListener((group) => enqueueActivityUpdate(() => updateCachedTabGroup(group)));

chrome.windows.onBoundsChanged.addListener((win) => enqueueActivityUpdate(() => updateCachedWindowBounds(win)));

chrome.tabs.onMoved.addListener((tabId, { windowId, fromIndex, toIndex }) =>
  enqueueActivityUpdate(() => updateCachedTabMoved(tabId, windowId, fromIndex, toIndex)),
);

chrome.tabs.onDetached.addListener((tabId, info) =>
  enqueueActivityUpdate(() => forgetWindowTab(info.oldWindowId, tabId, info.oldPosition)),
);
chrome.tabs.onAttached.addListener((tabId) =>
  enqueueActivityUpdate(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const summary = toTabSummary(tab, await loadKeptTabIds());
    if (summary) await cacheWindowTabs([summary], true);
  }),
);

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
  await enqueueActivityUpdate(async () => {
    if (!info.isWindowClosing) await forgetWindowTab(info.windowId, tabId);
    const state = removeTrackedTab(await loadActivityState(), tabId);
    await saveActivityState(state);
    await removeKeptTabId(tabId);
  });
});

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const closed = await enqueueActivityUpdate(() => popClosedWindow(windowId));
    if (!closed || closed.tabs.length < 2 || isRestoreInFlight()) return;
    try {
      const config = await loadConfig();
      if (!config.enableSessionSnapshots || !(await isFolderSyncOptedIn())) return;
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
    case "discard_tab":
      try {
        const config = await loadConfig();
        return { ok: await discardTabSafely(message.tabId, config, "manual") };
      } catch {
        return { ok: false };
      }
    case "toggle_keep_tab": {
      const kept = await enqueueActivityUpdate(async () => {
        const nextKept = await toggleKeptTabId(message.tabId);
        await updateCachedTabKept(message.tabId, nextKept);
        return nextKept;
      });
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
    case "save_config": {
      // Maintain identical lock order (configMutationQueue -> localSnapshotQueue) as pullConfigFromSync.
      const saved = await enqueueConfigMutation(async () => {
        const apply = async () => {
          const next = await saveConfig(message.config);
          const identity = await loadDeviceIdentity();
          const previous = await getLocalConfigVersion();
          const nextVer = { updatedAt: Math.max(Date.now(), previous.updatedAt + 1), deviceId: identity.deviceId };
          await setLocalConfigVersion(nextVer);
          return next;
        };
        return message.config.enableSessionSnapshots !== undefined
          ? runSerializedWithSnapshots(apply)
          : apply();
      });
      if (await isFolderSyncOptedIn()) void syncConfig().catch(() => {});
      await runSweep("sweep");
      return { ok: true, config: saved };
    }
    case "get_snapshots":
      return listAllSnapshots();
    case "capture_snapshot_now": {
      if (!(await isFolderSyncOptedIn())) {
        return { ok: false, error: "Configure a sync folder first to save session snapshots." };
      }
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
      if (config.enableSessionSnapshots && (await isFolderSyncOptedIn())) {
        await captureSessionSnapshot(tabs, {
          force: false,
          activity,
          skipSync: true,
          intervalMinutes: config.snapshotIntervalMinutes,
        });
      }
      const res = await runPeriodicSync(true);
      const status = await getSyncStatus();
      return { ...res, ok: res.ok && status.hostConnected && status.enabled && status.writable, status };
    }
  }
}

void ensureAlarm();
void maybeReopenOptions();
