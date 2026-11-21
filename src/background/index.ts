import { isInternalUrl, loadConfig, saveConfig } from "../shared/config.ts";
import type { BackgroundMessage, LoadedTabInfo, StatusPayload, TabSummary } from "../shared/types.ts";
import {
  archiveTabs,
  deleteArchivedTab,
  handleBookmarkRemoved,
  loadArchive,
  planArchives,
  planArchivesWithBreakdown,
  removeArchivedByUrl,
  restoreArchivedTab,
  searchArchive,
} from "./archive.ts";
import { updateActionBadge } from "./badge.ts";
import { getTabProtectedReason, isTabProtected, planEvictions } from "./eviction.ts";
import { getMemorySnapshot, hasNativeMessagingPermission, pingNativeHost } from "./memory.ts";
import { checkTabHasUnsavedForm, hasHostAccessPermission, loadCachedWeights, sampleTabWeights } from "./sampler.ts";
import {
  getTabLastActiveAt,
  loadActivityState,
  reconcileActivityOnStartup,
  recordTabVisit,
  removeTrackedTab,
  saveActivityState,
} from "./tracker.ts";

const SWEEP_ALARM = "tabReaper.sweep";
const REOPEN_OPTIONS_KEY = "tabReaper.reopenOptions";
let sweepInFlight = false;

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

function toTabSummary(tab: chrome.tabs.Tab): TabSummary | null {
  if (typeof tab.id !== "number") return null;
  return {
    id: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? tab.url ?? "",
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    pinned: Boolean(tab.pinned),
    discarded: Boolean(tab.discarded),
    status: tab.status,
    windowId: tab.windowId,
    groupId: tab.groupId,
    favIconUrl: tab.favIconUrl,
  };
}

async function queryAllTabs(): Promise<TabSummary[]> {
  const tabs = await chrome.tabs.query({});
  const summaries: TabSummary[] = [];
  for (const tab of tabs) {
    const summary = toTabSummary(tab);
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
  if (sweepInFlight) return { discarded: 0, archived: 0 };
  sweepInFlight = true;

  try {
    const now = Date.now();
    const config = await loadConfig();
    const tabs = await queryAllTabs();
    let activity = await loadActivityState();

    if (mode === "startup") {
      activity = reconcileActivityOnStartup(activity, tabs, now);
      await saveActivityState(activity);
    }

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
      const toArchive = planArchives({ tabs, activity, config, now });
      if (toArchive.length > 0) {
        archived = await archiveTabs(toArchive, activity, config, now);
      }
    }

    const loadedCount = Math.max(0, tabs.filter((t) => !t.discarded).length - discarded);
    await updateActionBadge(memory, loadedCount, online);

    return { discarded, archived };
  } finally {
    sweepInFlight = false;
  }
}

async function buildStatus(): Promise<StatusPayload> {
  const now = Date.now();
  const online = isBrowserOnline();
  const config = await loadConfig();
  const [tabs, windows, memory, archive, activity, nativeMessaging, hostAccess] = await Promise.all([
    queryAllTabs(),
    chrome.windows.getAll().catch(() => [] as chrome.windows.Window[]),
    getMemorySnapshot(config, now),
    loadArchive(),
    loadActivityState(),
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
  const loadedTabs: LoadedTabInfo[] = [];

  for (const tab of tabs) {
    const sample = weights.get(tab.id);
    const protectedReason = getTabProtectedReason(tab, config, sample);
    if (protectedReason !== null) {
      protectedCount++;
    }
    if (tab.discarded) {
      discardedCount++;
    } else {
      loadedCount++;
      const win = windowById.get(tab.windowId);
      const isPwa = win?.type === "app";
      const isFocusedActive = tab.active && win?.focused === true;
      const canDiscardManually = !isInternalUrl(tab.url) && !isFocusedActive && tab.status !== "loading";
      const lastActiveAt = getTabLastActiveAt(activity, tab, now);
      const idleMinutes = Math.max(0, Math.round((now - lastActiveAt) / 60_000));
      loadedTabs.push({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        idleMinutes,
        protectedReason,
        weightMultiplier: sample?.weightMultiplier ?? 1.0,
        jsHeapBytes: sample ? sample.jsHeapBytes : null,
        hasUnsavedForm: Boolean(sample?.hasUnsavedForm),
        isPwa,
        canDiscardManually,
      });
    }
  }

  loadedTabs.sort((a, b) => {
    const aHeap = a.jsHeapBytes ?? -1;
    const bHeap = b.jsHeapBytes ?? -1;
    if (aHeap !== bHeap) return bHeap - aHeap;
    const aProt = a.protectedReason ? 1 : 0;
    const bProt = b.protectedReason ? 1 : 0;
    if (aProt !== bProt) return aProt - bProt;
    return b.idleMinutes - a.idleMinutes;
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
    loadedTabs,
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
  const config = await loadConfig();
  if (config.startupSweep) {
    await runSweep("startup");
  } else {
    const tabs = await queryAllTabs();
    const activity = reconcileActivityOnStartup(await loadActivityState(), tabs, Date.now());
    await saveActivityState(activity);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? tab.pendingUrl;
    const state = recordTabVisit(await loadActivityState(), tabId, url, Date.now());
    await saveActivityState(state);
    if (url && !isInternalUrl(url)) {
      await removeArchivedByUrl(url);
    }
    await runSweep("sweep");
  } catch {
    // Tab closed before lookup.
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== "number") return;
  const url = tab.url ?? tab.pendingUrl;
  const state = recordTabVisit(await loadActivityState(), tab.id, url, Date.now());
  await saveActivityState(state);
  await runSweep("sweep");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && !isInternalUrl(changeInfo.url)) {
    if (tab.active) {
      const state = recordTabVisit(await loadActivityState(), tabId, changeInfo.url, Date.now());
      await saveActivityState(state);
    }
    await removeArchivedByUrl(changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = removeTrackedTab(await loadActivityState(), tabId);
  await saveActivityState(state);
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
  await removeArchivedByUrl(targetUrl);

  if (disposition === "currentTab") {
    await chrome.tabs.update({ url: targetUrl });
  } else {
    await chrome.tabs.create({ url: targetUrl, active: disposition === "newForegroundTab" });
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
    case "get_archive":
      return searchArchive(await loadArchive(), message.query);
    case "restore_archived":
      return { ok: await restoreArchivedTab(message.id) };
    case "delete_archived":
      return { ok: await deleteArchivedTab(message.id) };
    case "discard_tab":
      try {
        await chrome.tabs.discard(message.tabId);
        return { ok: true };
      } catch {
        return { ok: false };
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
