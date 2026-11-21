import { isInternalUrl, loadConfig, saveConfig } from "../shared/config.ts";
import type { ActivityState, BackgroundMessage, OpenTabInfo, StatusPayload, TabSummary } from "../shared/types.ts";
import {
  archiveTabs,
  deleteArchivedTab,
  handleBookmarkRemoved,
  isArchivableUrl,
  loadArchive,
  planArchives,
  planArchivesWithBreakdown,
  removeArchivedByUrl,
  restoreArchivedTab,
  searchArchive,
} from "./archive.ts";
import { updateActionBadge } from "./badge.ts";
import { computeOpenTabActions, isTabProtected, planEvictions } from "./eviction.ts";
import { getMemorySnapshot, hasNativeMessagingPermission, pingNativeHost } from "./memory.ts";
import { checkTabHasUnsavedForm, hasHostAccessPermission, loadCachedWeights, sampleTabWeights } from "./sampler.ts";
import {
  captureSessionSnapshot,
  clearSnapshots,
  findRecoverableSnapshot,
  isRestoreInFlight,
  loadSnapshots,
  restoreSessionSnapshot,
} from "./session.ts";
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
} from "./tracker.ts";

const SWEEP_ALARM = "tabReaper.sweep";
const REOPEN_OPTIONS_KEY = "tabReaper.reopenOptions";
let sweepInFlight = false;
let activityQueue: Promise<void> = Promise.resolve();

function enqueueActivityUpdate(fn: () => Promise<void>): Promise<void> {
  const next = activityQueue.then(fn, fn);
  activityQueue = next.catch(() => {});
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

function toTabSummary(tab: chrome.tabs.Tab, keptIds?: ReadonlySet<number>): TabSummary | null {
  if (typeof tab.id !== "number" || tab.incognito) return null;
  return {
    id: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? tab.url ?? "",
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    pinned: Boolean(tab.pinned),
    discarded: Boolean(tab.discarded),
    kept: keptIds?.has(tab.id) ?? false,
    status: tab.status,
    windowId: tab.windowId,
    groupId: tab.groupId,
    favIconUrl: tab.favIconUrl,
  };
}

async function queryAllTabs(): Promise<TabSummary[]> {
  const [tabs, keptIds] = await Promise.all([chrome.tabs.query({}), loadKeptTabIds()]);
  const summaries: TabSummary[] = [];
  for (const tab of tabs) {
    const summary = toTabSummary(tab, keptIds);
    if (summary) summaries.push(summary);
  }
  return summaries;
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
      if (toArchive.length > 0) {
        const keptIds = await loadKeptTabIds();
        const verifiedToArchive: TabSummary[] = [];
        for (const candidate of toArchive) {
          try {
            const raw = await chrome.tabs.get(candidate.id);
            const live = toTabSummary(raw, keptIds);
            if (!live || live.url !== candidate.url || isTabProtected(live, config, weights.get(live.id))) {
              continue;
            }
            if (!live.discarded && config.protectUnsavedForms) {
              const hasForm = await checkTabHasUnsavedForm(live.id);
              if (hasForm) continue;
            }
            verifiedToArchive.push(live);
          } catch {
            // Tab closed concurrently.
          }
        }
        if (verifiedToArchive.length > 0) {
          archived = await archiveTabs(verifiedToArchive, activity, config, now);
        }
      }
    }

    const loadedCount = Math.max(0, tabs.filter((t) => !t.discarded).length - discarded);
    await updateActionBadge(memory, loadedCount, online);

    if (mode === "sweep" && config.enableSessionSnapshots) {
      try {
        await captureSessionSnapshot(tabs, { now });
      } catch {
        // Snapshot persistence is best-effort and must never fail a sweep.
      }
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
    recoverableSnapshot: findRecoverableSnapshot(tabs, snapshots, now),
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await Promise.all([
    enqueueActivityUpdate(async () => {
      const state = removeTrackedTab(await loadActivityState(), tabId);
      await saveActivityState(state);
    }),
    removeKeptTabId(tabId),
  ]);
});

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
        await removeKeptTabId(message.tabId);
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
      const saved = await saveConfig(message.config);
      await runSweep("sweep");
      return { ok: true, config: saved };
    }
    case "get_snapshots":
      return loadSnapshots();
    case "capture_snapshot_now": {
      const tabs = await queryAllTabs();
      const snapshot = await captureSessionSnapshot(tabs, { force: true });
      return { ok: Boolean(snapshot), snapshot };
    }
    case "clear_snapshots": {
      await clearSnapshots();
      return { ok: true };
    }
    case "restore_snapshot": {
      const res = await restoreSessionSnapshot(message.id);
      return { ok: true, ...res };
    }
    case "test_native_host":
      return pingNativeHost();
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
