import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  isInternalUrl,
  loadConfig,
  MAX_DISCARDS_WITHOUT_RELIEF,
  REOPEN_OPTIONS_KEY,
  SETUP_PENDING_KEY,
  saveConfig,
} from "../shared/config.ts";
import type { ActivityState, BackgroundMessage, OpenTabInfo, StatusPayload, TabReaperConfig, TabSummary } from "../shared/types.ts";
import { updateActionBadge } from "./badge.ts";
import {
  UPDATE_ALARM,
  UPDATE_CHECK_PERIOD_MINUTES,
  checkForUpdate,
  dismissUpdateVersion,
  getUpdateAvailable,
  getUpdateStatus,
} from "./update.ts";
import {
  computeOpenTabActions,
  getMemoryBand,
  isTabProtected,
  MAX_MEMORY_EVICTIONS_PER_PASS,
  planEvictions,
} from "./eviction.ts";
import { reconcileFormObserver } from "./form-observer.ts";
import {
  getMemorySnapshot,
  hasNativeMessagingPermission,
  loadPressureEpisode,
  nextPressureEpisode,
  pingNativeHost,
  savePressureEpisode,
} from "./memory.ts";
import { checkTabHasUnsavedForm, hasHostAccessPermission, loadCachedWeights, sampleTabWeights } from "./sampler.ts";
import {
  adoptDeviceHistory,
  captureSessionSnapshot,
  clearSnapshots,
  setSyncFolder,
  deleteSnapshot,
  findRecoverableSnapshot,
  getSnapshotDetails,
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
  listSyncedDevices,
  loadDeviceIdentity,
  pickSyncFolder,
  pullConfigFromSync,
  removeSyncedDevice,
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
  replaceKeptTabId,
  replaceTrackedTab,
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
let sweepPromise: Promise<{ discarded: number }> | null = null;
const privateStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const LAST_SYNC_ATTEMPT_KEY = "tabReaper.lastSyncAttempt";
const STARTUP_RECONCILED_KEY = "tabReaper.startupReconciled";
let startupReconciled = false;

async function isStartupReconciled(): Promise<boolean> {
  if (startupReconciled) return true;
  if (!chrome.storage?.session?.get) return true;
  const stored = await chrome.storage.session.get(STARTUP_RECONCILED_KEY);
  if (stored[STARTUP_RECONCILED_KEY]) {
    startupReconciled = true;
    return true;
  }
  return false;
}

async function markStartupReconciled(): Promise<void> {
  startupReconciled = true;
  if (chrome.storage?.session?.set) {
    await chrome.storage.session.set({ [STARTUP_RECONCILED_KEY]: true });
  }
}

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
  mode: "manual" | "automatic",
  plannedLastActiveAt?: number,
): Promise<boolean> {
  if (config.protectUnsavedForms && (await checkTabHasUnsavedForm(tabId))) {
    return false;
  }
  return enqueueActivityUpdate(async () => {
    const [raw, keptIds] = await Promise.all([chrome.tabs.get(tabId), loadKeptTabIds()]);
    const live = toTabSummary(raw, keptIds);
    if (!live || live.discarded) return false;
    if (mode === "manual" ? !computeOpenTabActions(live, config).canSleep : isTabProtected(live, config)) {
      return false;
    }
    if (plannedLastActiveAt !== undefined) {
      // A tab used during form inspection must be ranked again on the next pass.
      const state = await loadActivityState({ includeUrlHistory: false });
      if (getTabLastActiveAt(state, live, 0) !== plannedLastActiveAt) return false;
    }
    const discardedTab = await chrome.tabs.discard(tabId);
    const nextTabId = discardedTab?.id;
    if (typeof nextTabId === "number" && nextTabId !== tabId) {
      const state = await loadActivityState({ includeUrlHistory: false });
      const replaced = replaceTrackedTab(state, tabId, nextTabId);
      if (replaced !== state) await saveActivityState(replaced, state);
      await replaceKeptTabId(tabId, nextTabId);
    }
    return true;
  });
}

async function ensureAlarm(): Promise<void> {
  const [existingSweep, existingUpdate] = await Promise.all([
    chrome.alarms.get(SWEEP_ALARM),
    chrome.alarms.get(UPDATE_ALARM),
  ]);
  if (!existingSweep || existingSweep.periodInMinutes !== SWEEP_PERIOD_MINUTES) {
    await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
  }
  if (!existingUpdate || existingUpdate.periodInMinutes !== UPDATE_CHECK_PERIOD_MINUTES) {
    await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES });
  }
}

const EVENT_SWEEP_COOLDOWN_MS = 5_000;
let lastEventSweepAt = 0;

async function maybeCheckForUpdate(force = false): Promise<void> {
  if (!isBrowserOnline()) return;
  const config = await loadConfig();
  if (!config.checkForUpdates) return;
  await checkForUpdate({ force });
}

async function refreshActionBadge(existingConfig?: TabReaperConfig): Promise<void> {
  const config = existingConfig ?? (await loadConfig());
  const online = isBrowserOnline();
  const [tabs, memory, updateAvailable] = await Promise.all([
    queryAllTabs(false),
    getMemorySnapshot(config, Date.now()),
    getUpdateAvailable(config.checkForUpdates),
  ]);
  const loadedCount = tabs.filter((t) => !t.discarded).length;
  await updateActionBadge(
    memory,
    loadedCount,
    online,
    {
      idleRatio: config.idleEvictionPercent / 100,
      sizeRatio: config.sizeEvictionPercent / 100,
    },
    updateAvailable,
  );
}

async function maybeRunEventSweep(): Promise<void> {
  const now = Date.now();
  if (now >= lastEventSweepAt && now - lastEventSweepAt < EVENT_SWEEP_COOLDOWN_MS) return;
  lastEventSweepAt = now;
  await runSweep("sweep", { periodic: false });
}

async function runSweep(
  mode: "sweep" | "startup" = "sweep",
  options: { periodic?: boolean } = {},
): Promise<{ discarded: number }> {
  if (mode === "startup" && sweepPromise) {
    await sweepPromise;
  }
  if (sweepInFlight || isRestoreInFlight()) return { discarded: 0 };
  sweepInFlight = true;
  const periodic = options.periodic ?? true;

  const task = (async (): Promise<{ discarded: number }> => {
  try {
    const now = Date.now();
    const config = await loadConfig();
    const tabs = await queryAllTabs(periodic || mode === "startup");
    let activity!: ActivityState;

    await enqueueActivityUpdate(async () => {
      const loaded = await loadActivityState({ includeUrlHistory: mode === "startup" });
      activity =
        mode === "startup"
          ? reconcileActivityOnStartup(loaded, tabs, now)
          : syncActiveTabs(loaded, tabs, now);
      if (mode === "startup" || activity !== loaded) {
        await saveActivityState(activity, loaded);
      }
    });

    const memory = mode === "startup" ? null : await getMemorySnapshot(config, now);
    const online = isBrowserOnline();

    // Sample eligible loaded tabs in the size band to sort by weight; in the idle band, unsaved-form check runs per candidate.
    const eligibleLoaded = tabs.filter((t) => !t.discarded && !isTabProtected(t, config));
    const band = getMemoryBand(memory, config.idleEvictionPercent / 100, config.sizeEvictionPercent / 100);
    const atSizeBand = band === "size";
    const storedEpisode = memory ? await loadPressureEpisode() : null;
    const episode = memory ? nextPressureEpisode(storedEpisode, memory) : null;
    const passLimit = episode
      ? Math.min(MAX_MEMORY_EVICTIONS_PER_PASS, Math.max(0, MAX_DISCARDS_WITHOUT_RELIEF - episode.discards))
      : MAX_MEMORY_EVICTIONS_PER_PASS;
    const shouldSample = mode === "sweep" && online && eligibleLoaded.length > 1 && atSizeBand && passLimit > 0;
    // Size-band ranking only needs weights; discardTabSafely performs a fresh live form check before discarding.
    const weights = shouldSample ? await sampleTabWeights(eligibleLoaded, now, config.protectUnsavedForms, false) : new Map();

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
    for (const tab of evictions) {
      if (mode === "sweep" && discarded >= passLimit) break;
      try {
        const plannedLastActiveAt = mode === "sweep" && !atSizeBand ? getTabLastActiveAt(activity, tab, 0) : undefined;
        if (await discardTabSafely(tab.id, config, "automatic", plannedLastActiveAt)) {
          discarded++;
        }
      } catch {
        // Tab may have become active, closed, or non-discardable concurrently.
      }
    }

    const nextEpisode = episode && { ...episode, discards: episode.discards + discarded };
    if (mode === "sweep" && JSON.stringify(nextEpisode) !== JSON.stringify(storedEpisode)) {
      await savePressureEpisode(nextEpisode);
    }

    const loadedCount = Math.max(0, tabs.filter((t) => !t.discarded).length - discarded);
    const badgeThresholds = {
      idleRatio: config.idleEvictionPercent / 100,
      sizeRatio: config.sizeEvictionPercent / 100,
    };
    const updateAvailable = await getUpdateAvailable(config.checkForUpdates);
    await updateActionBadge(memory, loadedCount, online, badgeThresholds, updateAvailable);

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
    sweepPromise = null;
  }
  })();
  sweepPromise = task;
  return task;
}

async function buildStatus(includeTabs = true): Promise<StatusPayload> {
  const now = Date.now();
  const online = isBrowserOnline();
  const config = await loadConfig();
  const [tabs, memory, nativeMessaging, hostAccess, { updateAvailable, updateStatus }] = await Promise.all([
    queryAllTabs(false),
    getMemorySnapshot(config, now),
    hasNativeMessagingPermission(),
    hasHostAccessPermission(),
    getUpdateStatus(config.checkForUpdates),
  ]);

  if (!includeTabs) {
    let loadedCount = 0;
    let discardedCount = 0;
    for (const tab of tabs) {
      if (tab.discarded) discardedCount++;
      else loadedCount++;
    }
    await updateActionBadge(
      memory,
      loadedCount,
      online,
      {
        idleRatio: config.idleEvictionPercent / 100,
        sizeRatio: config.sizeEvictionPercent / 100,
      },
      updateAvailable,
    );
    return {
      config,
      memory,
      online,
      loadedCount,
      discardedCount,
      protectedCount: 0,
      openTabs: [],
      recoverableSnapshot: null,
      updateAvailable,
      updateStatus,
      permissions: { nativeMessaging, hostAccess },
    };
  }

  const [windows, initialActivity, snapshots] = await Promise.all([
    chrome.windows.getAll().catch(() => [] as chrome.windows.Window[]),
    loadActivityState({ includeUrlHistory: false }),
    loadSnapshots(),
  ]);
  const hasUntrackedTab = tabs.some((t) => !t.active && !(String(t.id) in initialActivity.byTabId));
  const activity = hasUntrackedTab ? await loadActivityState({ includeUrlHistory: true }) : initialActivity;

  const windowById = new Map<number, chrome.windows.Window>();
  for (const win of windows) {
    if (typeof win.id === "number") {
      windowById.set(win.id, win);
    }
  }

  const loadedSummaries = tabs.filter((t) => !t.discarded);
  const weights = hostAccess ? await sampleTabWeights(loadedSummaries, now, config.protectUnsavedForms) : await loadCachedWeights(now);

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

  await updateActionBadge(
    memory,
    loadedCount,
    online,
    {
      idleRatio: config.idleEvictionPercent / 100,
      sizeRatio: config.sizeEvictionPercent / 100,
    },
    updateAvailable,
  );

  return {
    config,
    memory,
    online,
    loadedCount,
    discardedCount,
    protectedCount,
    openTabs,
    recoverableSnapshot: await findRecoverableSnapshot(tabs, snapshots, now),
    updateAvailable,
    updateStatus,
    permissions: { nativeMessaging, hostAccess },
  };
}

function pageAccessChanged(change: chrome.permissions.Permissions) {
  if (change.permissions?.includes("scripting") || change.origins?.length) return reconcileFormObserver(true);
}

chrome.permissions.onAdded.addListener(pageAccessChanged);
chrome.permissions.onRemoved.addListener(pageAccessChanged);
chrome.storage.onChanged.addListener((changes, area) => {
  const entry = changes[CONFIG_STORAGE_KEY];
  if (area !== "local" || !entry) return;
  const before = entry.oldValue?.protectUnsavedForms ?? DEFAULT_CONFIG.protectUnsavedForms;
  const after = entry.newValue?.protectUnsavedForms ?? DEFAULT_CONFIG.protectUnsavedForms;
  if (before !== after) return reconcileFormObserver(true);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const isFreshInstall = details?.reason === "install";
  if (isFreshInstall) {
    await chrome.storage.local.set({ [SETUP_PENDING_KEY]: true });
  }
  await Promise.all([ensureAlarm(), reconcileFormObserver(await hasHostAccessPermission())]);
  const tabs = await queryAllTabs();
  const activity = reconcileActivityOnStartup(await loadActivityState(), tabs, Date.now());
  await saveActivityState(activity);
  await markStartupReconciled();
  if (isFreshInstall) {
    await chrome.runtime.openOptionsPage();
  }
  void maybeCheckForUpdate().then(() => refreshActionBadge()).catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await Promise.all([ensureAlarm(), reconcileFormObserver()]);
  await clearKeptTabIds();
  const config = await loadConfig();
  if (config.startupSweep) {
    await runSweep("startup");
  } else {
    const tabs = await queryAllTabs();
    const activity = reconcileActivityOnStartup(await loadActivityState(), tabs, Date.now());
    await saveActivityState(activity);
  }
  await markStartupReconciled();
  void runPeriodicSync(true);
  void maybeCheckForUpdate().then(() => refreshActionBadge()).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const activeCacheUpdate = enqueueActivityUpdate(() => updateCachedActiveTab(windowId, tabId));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return;
    const url = tab.url ?? tab.pendingUrl;
    await activeCacheUpdate;
    await enqueueActivityUpdate(async () => {
      const loaded = await loadActivityState({ includeUrlHistory: false });
      await saveActivityState(recordTabVisit(loaded, tabId, url, Date.now(), windowId), loaded);
    });
    await maybeRunEventSweep();
  } catch {
    // Tab closed before lookup.
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== "number" || tab.incognito || isRestoreInFlight()) return;
  const tabId = tab.id;
  const url = tab.url ?? tab.pendingUrl;
  const activeWindowId = tab.active ? tab.windowId : undefined;
  const preferHistory = !tab.active && (Boolean(tab.discarded) || tab.status === "unloaded" || !(await isStartupReconciled()));
  await enqueueActivityUpdate(async () => {
    const [activity, keptIds] = await Promise.all([
      loadActivityState({ includeUrlHistory: preferHistory }),
      loadKeptTabIds(),
    ]);
    const state = recordTabVisit(activity, tabId, url, Date.now(), activeWindowId, preferHistory);
    await saveActivityState(state, activity);
    const summary = toTabSummary(tab, keptIds);
    if (summary) await cacheWindowTabs([summary], true);
  });
  await maybeRunEventSweep();
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  void enqueueActivityUpdate(async () => {
    const state = await loadActivityState({ includeUrlHistory: false });
    const replaced = replaceTrackedTab(state, removedTabId, addedTabId);
    if (replaced !== state) await saveActivityState(replaced, state);
    await replaceKeptTabId(removedTabId, addedTabId);
  });
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
        const loaded = await loadActivityState({ includeUrlHistory: false });
        await saveActivityState(recordTabVisit(loaded, tabId, nextUrl, Date.now(), tab.windowId), loaded);
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
    const loaded = await loadActivityState();
    const state = removeTrackedTab(loaded, tabId);
    if (state !== loaded) await saveActivityState(state, loaded);
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
  } else if (alarm.name === UPDATE_ALARM) {
    await maybeCheckForUpdate(true);
    await refreshActionBadge();
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage | string, sender, sendResponse) => {
  if (message === "tab-reaper-form-access") {
    void Promise.all([loadConfig(), hasHostAccessPermission(), privateStorage])
      .then(([config, access]) => sendResponse(config.protectUnsavedForms && access))
      .catch(() => sendResponse(false));
    return true;
  }
  if (typeof message === "string") return false;
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  void handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

async function handleMessage(message: BackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case "get_status":
      return buildStatus(message.includeTabs !== false);
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
    case "dismiss_update": {
      await dismissUpdateVersion(message.version);
      await refreshActionBadge();
      return { ok: true };
    }
    case "save_config": {
      const previousConfig = await loadConfig();
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
      if (saved.checkForUpdates && !previousConfig.checkForUpdates) {
        await maybeCheckForUpdate();
      }
      const changedKeys = Object.keys(message.config);
      if (changedKeys.length === 1 && changedKeys[0] === "checkForUpdates") {
        await refreshActionBadge(saved);
      } else {
        await runSweep("sweep");
      }
      return { ok: true, config: saved };
    }
    case "get_snapshots":
      return listAllSnapshots();
    case "get_snapshot_details": {
      const snapshot = await getSnapshotDetails(message.id, message.relPath);
      return snapshot ? { ok: true, snapshot } : { ok: false, error: "Snapshot unavailable." };
    }
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
      const ok = await deleteSnapshot(message.id, message.syncDir, message.ownerDeviceId);
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
    case "get_synced_devices":
      return listSyncedDevices();
    case "remove_synced_device":
      return removeSyncedDevice(message.targetDeviceId);
    case "adopt_synced_device":
      return adoptDeviceHistory(message.targetDeviceId);
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
