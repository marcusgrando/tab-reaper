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
import type {
  ActivityState,
  BackgroundMessage,
  OpenTabInfo,
  StatusPayload,
  TabCurbConfig,
  TabSummary,
  TabWeightSample,
} from "../shared/types.ts";
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
  bootstrapUploadObserver,
  checkTabHasActiveUpload,
  forgetTabUploads,
  getUploadingTabIds,
  hasLiveUploadProtectionForTab,
  hasUploadProtectionPermission,
  migrateTabUploads,
  reconcileUploadObserver,
} from "./upload-observer.ts";
import {
  getMemorySnapshot,
  hasNativeMessagingPermission,
  loadPressureEpisode,
  nextPressureEpisode,
  pingNativeHost,
  savePressureEpisode,
} from "./memory.ts";
import { measureTabProcessMemory, mergeProcessMemorySamples } from "./process-memory.ts";
import {
  checkTabLiveProtection,
  clearSampleCache,
  computeFallbackWeightBytes,
  hasHostAccessPermission,
  loadCachedWeights,
  sampleTabFormsOnly,
  sampleTabWeights,
} from "./sampler.ts";
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

const SWEEP_ALARM = "tabCurb.sweep";
const SWEEP_PERIOD_MINUTES = 0.5;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let sweepInFlight = false;
let sweepPromise: Promise<{ discarded: number }> | null = null;
const privateStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
const LAST_SYNC_ATTEMPT_KEY = "tabCurb.lastSyncAttempt";
const STARTUP_RECONCILED_KEY = "tabCurb.startupReconciled";
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
  config: TabCurbConfig,
  mode: "manual" | "automatic",
  plannedLastActiveAt?: number,
): Promise<boolean> {
  const [initialRaw, initialKeptIds] = await Promise.all([chrome.tabs.get(tabId), loadKeptTabIds()]);
  const initialLive = toTabSummary(initialRaw, initialKeptIds);
  if (!initialLive || initialLive.discarded) return false;
  if (
    (mode === "manual" ? !computeOpenTabActions(initialLive, config).canSleep : isTabProtected(initialLive, config)) ||
    hasLiveUploadProtectionForTab(tabId)
  ) {
    return false;
  }
  const liveProtection = await checkTabLiveProtection(tabId, config.protectUnsavedForms);
  // Fail closed when live inspection times out so a busy tab or slow third-party iframe
  // never loses unsaved forms, Picture-in-Picture, or screen sharing.
  if (liveProtection.timedOut) {
    return false;
  }
  const liveSample: TabWeightSample = {
    jsHeapBytes: 0,
    domNodes: 0,
    mediaNodes: 0,
    weightMultiplier: 1,
    sampledAt: Date.now(),
    hasUnsavedForm: liveProtection.hasUnsavedForm,
    isVisible: liveProtection.isVisible,
    hasPictureInPicture: liveProtection.hasPictureInPicture,
  };
  return enqueueActivityUpdate(async () => {
    const [raw, keptIds] = await Promise.all([chrome.tabs.get(tabId), loadKeptTabIds()]);
    const live = toTabSummary(raw, keptIds);
    if (!live || live.discarded) return false;
    if (
      mode === "manual"
        ? !computeOpenTabActions(live, config, liveSample).canSleep
        : isTabProtected(live, config, liveSample)
    ) {
      return false;
    }
    if (plannedLastActiveAt !== undefined) {
      // A tab used during form inspection must be ranked again on the next pass.
      const state = await loadActivityState({ includeUrlHistory: false });
      if (getTabLastActiveAt(state, live, 0) !== plannedLastActiveAt) return false;
    }
    // Always consult the live upload observer (not a snapshot config captured earlier in a sweep)
    // and re-check synchronous in-flight/cooldown protection immediately before chrome.tabs.discard.
    if ((await checkTabHasActiveUpload(tabId)) || hasLiveUploadProtectionForTab(tabId)) {
      return false;
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

async function refreshActionBadge(existingConfig?: TabCurbConfig): Promise<void> {
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
    const uploadingTabIds = config.protectActiveUploads ? await getUploadingTabIds(now) : new Set<number>();
    const eligibleLoaded = tabs.filter(
      (t) => !t.discarded && !isTabProtected(t, config, undefined, uploadingTabIds.has(t.id)),
    );
    const band = getMemoryBand(memory, config.idleEvictionPercent / 100, config.sizeEvictionPercent / 100);
    const atSizeBand = band === "size";
    const storedEpisode = memory ? await loadPressureEpisode() : null;
    const episode = memory ? nextPressureEpisode(storedEpisode, memory) : null;
    const passLimit = episode
      ? Math.min(MAX_MEMORY_EVICTIONS_PER_PASS, Math.max(0, MAX_DISCARDS_WITHOUT_RELIEF - episode.discards))
      : MAX_MEMORY_EVICTIONS_PER_PASS;
    const shouldSample =
      mode === "sweep" && online && eligibleLoaded.length > 1 && atSizeBand && passLimit > 0 && config.weightedEviction;
    // Prefer real per-renderer OS memory from the Local Companion + webNavigation (no JS injection needed).
    // Fall back to page JS/DOM/media sampling when the companion is absent, older, or cannot match tabs.
    let weights = new Map<number, TabWeightSample>();
    if (shouldSample) {
      if (memory?.renderers) {
        const protectedIds = new Set(
          tabs.filter((t) => isTabProtected(t, config, undefined, uploadingTabIds.has(t.id))).map((t) => t.id),
        );
        const processMemory = await measureTabProcessMemory(tabs, memory.renderers, protectedIds);
        if (eligibleLoaded.some((t) => processMemory.has(t.id))) {
          weights = mergeProcessMemorySamples(weights, processMemory, now);
        }
      }
      if (weights.size === 0) {
        // Size-band ranking only needs weights; discardTabSafely performs a fresh live form check before discarding.
        weights = await sampleTabWeights(eligibleLoaded, now, config.protectUnsavedForms, false);
      }
    }

    const evictions = planEvictions({
      tabs,
      activity,
      weights,
      uploadingTabIds,
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
  const [tabs, memory, nativeMessaging, hostAccess, uploadProtection, { updateAvailable, updateStatus }] = await Promise.all([
    queryAllTabs(false),
    getMemorySnapshot(config, now),
    hasNativeMessagingPermission(),
    hasHostAccessPermission(),
    hasUploadProtectionPermission(),
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
      permissions: { nativeMessaging, hostAccess, uploadProtection },
    };
  }

  const [windows, initialActivity, snapshots, uploadingTabIds] = await Promise.all([
    chrome.windows.getAll().catch(() => [] as chrome.windows.Window[]),
    loadActivityState({ includeUrlHistory: false }),
    loadSnapshots(),
    config.protectActiveUploads ? getUploadingTabIds(now) : Promise.resolve(new Set<number>()),
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
  let weights =
    hostAccess && config.weightedEviction && !memory?.renderers
      ? await sampleTabWeights(loadedSummaries, now, config.protectUnsavedForms)
      : hostAccess
        ? await sampleTabFormsOnly(loadedSummaries, now, config.protectUnsavedForms)
        : config.weightedEviction && !memory?.renderers
          ? await loadCachedWeights(now)
          : new Map<number, TabWeightSample>();
  if (memory?.renderers) {
    const protectedIds = new Set(
      tabs.filter((t) => isTabProtected(t, config, weights.get(t.id), uploadingTabIds.has(t.id))).map((t) => t.id),
    );
    const processMemory = await measureTabProcessMemory(tabs, memory.renderers, protectedIds);
    if (processMemory.size > 0) {
      weights = mergeProcessMemorySamples(weights, processMemory, now);
    }
  }

  let loadedCount = 0;
  let discardedCount = 0;
  let protectedCount = 0;
  const openTabs: OpenTabInfo[] = [];
  const fallbackWeightById = new Map<number, number>();

  for (const tab of tabs) {
    const sample = weights.get(tab.id);
    const win = windowById.get(tab.windowId);
    const isPwa = win?.type === "app";
    const isFocusedActive = tab.active && win?.focused === true;
    const hasActiveUpload = config.protectActiveUploads && uploadingTabIds.has(tab.id);
    const actions = computeOpenTabActions(tab, config, sample, isFocusedActive, hasActiveUpload);

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
    const hasProcessBytes = Boolean(sample?.processMemoryBytes && sample.processMemoryBytes > 0);
    const hasJsHeapBytes = Boolean(sample && sample.jsHeapBytes > 0);
    const memoryBytes = hasProcessBytes
      ? sample!.processMemoryBytes!
      : hasJsHeapBytes
        ? sample!.jsHeapBytes
        : null;
    const memorySource = hasProcessBytes ? "process" : hasJsHeapBytes ? "js_heap" : null;
    if (sample) {
      fallbackWeightById.set(tab.id, computeFallbackWeightBytes(sample));
    }

    openTabs.push({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      discarded: tab.discarded,
      kept: Boolean(tab.kept),
      idleMinutes,
      protectedReason: actions.protectedReason,
      weightMultiplier: sample?.weightMultiplier ?? 1.0,
      memoryBytes,
      memorySource,
      ...(hasProcessBytes ? {
        sharedProcessTabs: sample!.sharedProcessTabs,
        sharedProcessTotalBytes: sample!.sharedProcessTotalBytes,
      } : {}),
      jsHeapBytes: sample ? sample.jsHeapBytes : null,
      hasUnsavedForm: Boolean(sample?.hasUnsavedForm),
      hasActiveUpload,
      isPwa,
      canKeep: actions.canKeep,
      canSleep: actions.canSleep,
      canClose: actions.canClose,
    });
  }

  openTabs.sort((a, b) => {
    if (a.discarded !== b.discarded) return a.discarded ? 1 : -1;
    if (!a.discarded) {
      const aHasProcess = a.memorySource === "process";
      const bHasProcess = b.memorySource === "process";
      if (aHasProcess !== bHasProcess) return aHasProcess ? -1 : 1;
      if (aHasProcess && bHasProcess) {
        const memDiff = (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0);
        if (memDiff !== 0) return memDiff;
      } else {
        const aWeight = fallbackWeightById.get(a.id) ?? -1;
        const bWeight = fallbackWeightById.get(b.id) ?? -1;
        if (aWeight !== bWeight) return bWeight - aWeight;
      }
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
    permissions: { nativeMessaging, hostAccess, uploadProtection },
  };
}

function pageAccessChanged(change: chrome.permissions.Permissions) {
  const tasks: Promise<unknown>[] = [];
  if (change.permissions?.includes("scripting") || change.origins?.length) tasks.push(reconcileFormObserver(true));
  if (change.permissions?.includes("webRequest") || change.origins?.length) tasks.push(reconcileUploadObserver());
  if (tasks.length > 0) return Promise.all(tasks);
}

chrome.permissions.onAdded.addListener(pageAccessChanged);
chrome.permissions.onRemoved.addListener(pageAccessChanged);
chrome.storage.onChanged.addListener((changes, area) => {
  const entry = changes[CONFIG_STORAGE_KEY];
  if (area !== "local" || !entry) return;
  const tasks: Promise<unknown>[] = [];
  const beforeForms = entry.oldValue?.protectUnsavedForms ?? DEFAULT_CONFIG.protectUnsavedForms;
  const afterForms = entry.newValue?.protectUnsavedForms ?? DEFAULT_CONFIG.protectUnsavedForms;
  if (beforeForms !== afterForms) tasks.push(reconcileFormObserver(true));
  const beforeUploads = entry.oldValue?.protectActiveUploads ?? DEFAULT_CONFIG.protectActiveUploads;
  const afterUploads = entry.newValue?.protectActiveUploads ?? DEFAULT_CONFIG.protectActiveUploads;
  if (beforeUploads !== afterUploads) tasks.push(reconcileUploadObserver());
  if (tasks.length > 0) return Promise.all(tasks);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const isFreshInstall = details?.reason === "install";
  if (isFreshInstall) {
    await chrome.storage.local.set({ [SETUP_PENDING_KEY]: true });
  }
  await Promise.all([
    ensureAlarm(),
    reconcileFormObserver(await hasHostAccessPermission()),
    reconcileUploadObserver(),
  ]);
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
  await Promise.all([ensureAlarm(), reconcileFormObserver(), reconcileUploadObserver()]);
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
  void migrateTabUploads(removedTabId, addedTabId);
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
  void forgetTabUploads(tabId);
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

const TRUSTED_UI_PATHS = new Set(["/popup.html", "/options.html"]);

function isTrustedUiSender(sender: chrome.runtime.MessageSender): boolean {
  const extId = chrome.runtime?.id;
  if (!extId || sender.id !== extId) return false;
  const expectedOrigin = `chrome-extension://${extId}`;
  if (sender.origin !== expectedOrigin) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  if (typeof sender.url !== "string") return false;
  try {
    const parsed = new URL(sender.url);
    return (
      parsed.protocol === "chrome-extension:" &&
      parsed.hostname === extId &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      TRUSTED_UI_PATHS.has(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage | string, sender, sendResponse) => {
  if (message === "tabcurb-form-access") {
    if (!chrome.runtime?.id || sender.id !== chrome.runtime.id) return false;
    void Promise.all([loadConfig(), hasHostAccessPermission(), privateStorage])
      .then(([config, access]) => sendResponse(config.protectUnsavedForms && access))
      .catch(() => sendResponse(false));
    return true;
  }
  if (!isPlainRecord(message) || typeof message.type !== "string") return false;
  if (!isTrustedUiSender(sender)) return false;
  void handleMessage(message as unknown as BackgroundMessage)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

async function handleMessage(message: BackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case "get_status":
      return buildStatus(message.includeTabs !== false);
    case "discard_tab":
      if (!isPositiveInt(message.tabId)) return { ok: false, error: "Invalid tabId." };
      try {
        const config = await loadConfig();
        return { ok: await discardTabSafely(message.tabId, config, "manual") };
      } catch {
        return { ok: false };
      }
    case "toggle_keep_tab": {
      if (!isPositiveInt(message.tabId)) return { ok: false, error: "Invalid tabId." };
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
      if (!isPositiveInt(message.tabId)) return { ok: false, error: "Invalid tabId." };
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
      if (!isNonEmptyString(message.version)) return { ok: false, error: "Invalid version." };
      await dismissUpdateVersion(message.version);
      await refreshActionBadge();
      return { ok: true };
    }
    case "save_config": {
      if (!isPlainRecord(message.config)) return { ok: false, error: "Invalid config payload." };
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
      if (saved.protectUnsavedForms !== previousConfig.protectUnsavedForms) {
        await reconcileFormObserver(true);
      }
      if (!saved.weightedEviction && previousConfig.weightedEviction) {
        await clearSampleCache();
      }
      if (saved.protectActiveUploads !== previousConfig.protectActiveUploads) {
        await reconcileUploadObserver();
      }
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
      if (!isNonEmptyString(message.id)) return { ok: false, error: "Invalid snapshot id." };
      const relPath = typeof message.relPath === "string" ? message.relPath : undefined;
      const snapshot = await getSnapshotDetails(message.id, relPath);
      return snapshot ? { ok: true, snapshot } : { ok: false, error: "Snapshot unavailable." };
    }
    case "capture_snapshot_now": {
      if (!(await isFolderSyncOptedIn())) {
        return { ok: false, error: "Configure a sync folder first to save session snapshots." };
      }
      const label = typeof message.label === "string" ? message.label : undefined;
      const [tabs, activity] = await Promise.all([queryAllTabs(), loadActivityState()]);
      const snapshot = await captureSessionSnapshot(tabs, {
        force: true,
        trigger: "manual",
        label,
        activity,
      });
      return { ok: Boolean(snapshot), snapshot };
    }
    case "clear_snapshots": {
      await clearSnapshots();
      return { ok: true };
    }
    case "delete_snapshot": {
      if (!isNonEmptyString(message.id)) return { ok: false, error: "Invalid snapshot id." };
      const syncDir = message.syncDir === null || typeof message.syncDir === "string" ? message.syncDir : undefined;
      const ownerDeviceId = typeof message.ownerDeviceId === "string" ? message.ownerDeviceId : undefined;
      const ok = await deleteSnapshot(message.id, syncDir, ownerDeviceId);
      return { ok };
    }
    case "restore_snapshot": {
      if (!isNonEmptyString(message.id)) return { ok: false, error: "Invalid snapshot id." };
      const targetWindowId = isPositiveInt(message.targetWindowId) ? message.targetWindowId : undefined;
      const mode = message.mode === "windows" || message.mode === "current_window" ? message.mode : undefined;
      const relPath = typeof message.relPath === "string" ? message.relPath : undefined;
      const res = await restoreSessionSnapshot(message.id, { targetWindowId, mode, relPath });
      return { ok: true, ...res };
    }
    case "test_native_host":
      return pingNativeHost();
    case "get_sync_status":
      return getSyncStatus();
    case "get_synced_devices":
      return listSyncedDevices();
    case "remove_synced_device":
      if (!isNonEmptyString(message.targetDeviceId)) return { ok: false, error: "Invalid targetDeviceId." };
      return removeSyncedDevice(message.targetDeviceId);
    case "adopt_synced_device":
      if (!isNonEmptyString(message.targetDeviceId)) return { ok: false, error: "Invalid targetDeviceId." };
      return adoptDeviceHistory(message.targetDeviceId);
    case "detect_sync_folders":
      return detectSyncFolders();
    case "pick_sync_folder":
      return pickSyncFolder();
    case "set_sync_folder": {
      if (message.path !== null && typeof message.path !== "string") {
        return { ok: false, error: "Invalid sync folder path." };
      }
      const status = await setSyncFolder(message.path);
      if (status.ok && status.enabled) {
        await runPeriodicSync(true);
      }
      return status;
    }
    case "set_device_name": {
      if (typeof message.deviceName !== "string") return { ok: false, error: "Invalid deviceName." };
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
    default:
      return { ok: false, error: "Unknown message type." };
  }
}

bootstrapUploadObserver();
void ensureAlarm();
void maybeReopenOptions();
