import { createAsyncQueue, isInternalUrl, normalizeUrl } from "../shared/config.ts";
import type { ActivityState, TabSummary } from "../shared/types.ts";

export const ACTIVITY_STORAGE_KEY = "tabReaper.activity";
/**
 * URL history lives under its own key because it is only read to rebuild recency
 * after Chrome reassigns tab ids. Tab switches rewrite the small per-tab record;
 * the history is rewritten only when a tab closes or Chrome restarts.
 */
export const URL_HISTORY_STORAGE_KEY = "tabReaper.activityByUrl";
export const KEPT_TABS_STORAGE_KEY = "tabReaper.keptTabIds";
export const enqueueActivityUpdate = createAsyncQueue();
const MAX_TRACKED_URLS = 2000;
/** Hash-state URLs can reach megabytes. They rank as "now" after a restart instead of bloating storage. */
const MAX_TRACKED_URL_LENGTH = 4096;

export function createEmptyActivityState(): ActivityState {
  return { byTabId: {}, byUrl: {}, activeByWindow: {} };
}

function trackedUrl(url: string | undefined): string {
  if (!url) return "";
  if (url.length > MAX_TRACKED_URL_LENGTH) return "";
  return isInternalUrl(url) ? url : normalizeUrl(url);
}

function isRestorableUrl(url: string): boolean {
  return url !== "" && !isInternalUrl(url);
}

export function recordTabVisit(
  state: ActivityState,
  tabId: number,
  url: string | undefined,
  now: number,
  windowId?: number,
): ActivityState {
  const nextByTabId = { ...state.byTabId };
  const nextActiveByWindow = { ...(state.activeByWindow ?? {}) };

  if (typeof windowId === "number") {
    const winKey = String(windowId);
    const prevTabId = nextActiveByWindow[winKey];
    if (typeof prevTabId === "number" && prevTabId !== tabId) {
      const prevKey = String(prevTabId);
      const prevRecord = nextByTabId[prevKey];
      if (prevRecord) {
        nextByTabId[prevKey] = { ...prevRecord, lastActiveAt: now };
      }
    }
    nextActiveByWindow[winKey] = tabId;
  }

  nextByTabId[String(tabId)] = { url: trackedUrl(url), lastActiveAt: now };
  return { byTabId: nextByTabId, byUrl: state.byUrl, activeByWindow: nextActiveByWindow };
}

export function removeTrackedTab(state: ActivityState, tabId: number): ActivityState {
  const key = String(tabId);
  const record = state.byTabId[key];
  const activeByWindow = state.activeByWindow ?? {};
  const staleWindowKeys = Object.entries(activeByWindow)
    .filter(([, activeId]) => activeId === tabId)
    .map(([winKey]) => winKey);

  if (!record && staleWindowKeys.length === 0) return state;

  let nextByTabId = state.byTabId;
  let nextByUrl = state.byUrl;
  if (record) {
    nextByTabId = { ...state.byTabId };
    delete nextByTabId[key];
    // Closing a window fires onRemoved for each tab, and "reopen closed window"
    // brings them back with new ids, so their recency moves to the URL history.
    if (isRestorableUrl(record.url) && (nextByUrl[record.url] ?? 0) < record.lastActiveAt) {
      nextByUrl = { ...nextByUrl, [record.url]: record.lastActiveAt };
    }
  }

  let nextActiveByWindow = activeByWindow;
  if (staleWindowKeys.length > 0) {
    nextActiveByWindow = { ...activeByWindow };
    for (const winKey of staleWindowKeys) {
      delete nextActiveByWindow[winKey];
    }
  }

  return pruneUrlHistory({ byTabId: nextByTabId, byUrl: nextByUrl, activeByWindow: nextActiveByWindow });
}

/**
 * Drops window entries for closed tabs and bootstraps missing activeByWindow
 * entries and tab records (for example after an extension reload). It does not
 * restamp tracked active tabs: getTabLastActiveAt ranks an active tab as "now",
 * and recordTabVisit stamps it when the user leaves it. Returning the same state
 * when nothing changed lets periodic sweeps skip the storage write.
 * Never overwrites an already-tracked window entry so a stale tab snapshot
 * cannot clobber a concurrent tab switch.
 */
export function syncActiveTabs(
  state: ActivityState,
  openTabs: TabSummary[],
  now: number,
): ActivityState {
  const existingActiveByWindow = state.activeByWindow ?? {};
  const openTabIds = new Set(openTabs.map((t) => t.id));

  let changed = false;
  const nextByTabId = { ...state.byTabId };
  const nextActiveByWindow = { ...existingActiveByWindow };

  for (const [winKey, activeId] of Object.entries(nextActiveByWindow)) {
    if (!openTabIds.has(activeId)) {
      delete nextActiveByWindow[winKey];
      changed = true;
    }
  }

  for (const tab of openTabs) {
    if (!tab.active) continue;
    const winKey = String(tab.windowId);
    if (!(winKey in nextActiveByWindow)) {
      nextActiveByWindow[winKey] = tab.id;
      changed = true;
    }
    if (nextActiveByWindow[winKey] !== tab.id) continue;

    const url = trackedUrl(tab.url);
    const key = String(tab.id);
    const existing = nextByTabId[key];
    if (!existing || existing.url !== url) {
      nextByTabId[key] = { url, lastActiveAt: Math.max(existing?.lastActiveAt ?? 0, now) };
      changed = true;
    }
  }

  if (!changed) return state;
  return { byTabId: nextByTabId, byUrl: state.byUrl, activeByWindow: nextActiveByWindow };
}

/**
 * Reconciles open tabs against persisted URL timestamps after a browser restart
 * (when Chrome reassigns every tabId). Existing tabIds keep their timestamp;
 * newly assigned tabIds inherit their previous lastActiveAt by normalized URL.
 */
export function reconcileActivityOnStartup(
  state: ActivityState,
  openTabs: TabSummary[],
  now: number,
): ActivityState {
  const nextByTabId: ActivityState["byTabId"] = {};
  const nextByUrl: ActivityState["byUrl"] = { ...state.byUrl };
  const nextActiveByWindow: Record<string, number> = {};

  // Chrome can quit without tabs.onRemoved, leaving the last session's recency only in byTabId.
  for (const record of Object.values(state.byTabId)) {
    if (isRestorableUrl(record.url) && (nextByUrl[record.url] ?? 0) < record.lastActiveAt) {
      nextByUrl[record.url] = record.lastActiveAt;
    }
  }

  for (const tab of openTabs) {
    const url = trackedUrl(tab.url);
    const existingById = state.byTabId[String(tab.id)];

    let lastActiveAt: number;
    if (tab.active) {
      lastActiveAt = now;
      nextActiveByWindow[String(tab.windowId)] = tab.id;
    } else if (existingById && existingById.url === url) {
      lastActiveAt = existingById.lastActiveAt;
    } else if (isRestorableUrl(url) && url in nextByUrl) {
      lastActiveAt = nextByUrl[url]!;
    } else {
      lastActiveAt = now;
    }

    nextByTabId[String(tab.id)] = { url, lastActiveAt };
    if (isRestorableUrl(url)) {
      nextByUrl[url] = lastActiveAt;
    }
  }

  return pruneUrlHistory({ byTabId: nextByTabId, byUrl: nextByUrl, activeByWindow: nextActiveByWindow });
}

export function getTabLastActiveAt(
  state: ActivityState,
  tab: Pick<TabSummary, "id" | "url" | "active">,
  now: number,
): number {
  if (tab.active) return now;
  const byId = state.byTabId[String(tab.id)];
  if (byId) return byId.lastActiveAt;
  const url = trackedUrl(tab.url);
  if (isRestorableUrl(url)) {
    const byUrl = state.byUrl[url];
    if (typeof byUrl === "number") return byUrl;
  }
  return now;
}

function pruneUrlHistory(state: ActivityState): ActivityState {
  const entries = Object.entries(state.byUrl);
  if (entries.length <= MAX_TRACKED_URLS) return state;

  entries.sort((a, b) => b[1] - a[1]);
  const kept = Object.fromEntries(entries.slice(0, MAX_TRACKED_URLS));
  return { byTabId: state.byTabId, byUrl: kept, activeByWindow: state.activeByWindow };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadActivityState(): Promise<ActivityState> {
  const result = await chrome.storage.local.get([ACTIVITY_STORAGE_KEY, URL_HISTORY_STORAGE_KEY]);
  const raw = result[ACTIVITY_STORAGE_KEY] as Partial<ActivityState> | undefined;
  const storedByUrl = result[URL_HISTORY_STORAGE_KEY];
  const byUrl = isRecord(storedByUrl) ? storedByUrl : {};
  if (!isRecord(raw)) {
    return { ...createEmptyActivityState(), byUrl: byUrl as ActivityState["byUrl"] };
  }
  const rawActiveByWindow = isRecord(raw.activeByWindow) ? raw.activeByWindow : {};
  const activeByWindow: Record<string, number> = {};
  for (const [winKey, tabId] of Object.entries(rawActiveByWindow)) {
    if (typeof tabId === "number" && Number.isFinite(tabId)) {
      activeByWindow[winKey] = tabId;
    }
  }
  return {
    byTabId: isRecord(raw.byTabId) ? (raw.byTabId as ActivityState["byTabId"]) : {},
    byUrl: byUrl as ActivityState["byUrl"],
    activeByWindow,
  };
}

/**
 * Persists the per-tab records, and the URL history only when it differs from
 * `previous` (the state this one was derived from). Without `previous` both are written.
 */
export async function saveActivityState(state: ActivityState, previous?: ActivityState): Promise<void> {
  const items: Record<string, unknown> = {
    [ACTIVITY_STORAGE_KEY]: { byTabId: state.byTabId, activeByWindow: state.activeByWindow ?? {} },
  };
  if (!previous || previous.byUrl !== state.byUrl) {
    items[URL_HISTORY_STORAGE_KEY] = state.byUrl;
  }
  await chrome.storage.local.set(items);
}

export async function loadKeptTabIds(): Promise<Set<number>> {
  const result = await chrome.storage.local.get(KEPT_TABS_STORAGE_KEY);
  const raw = result[KEPT_TABS_STORAGE_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is number => typeof id === "number" && Number.isFinite(id)));
}

export async function saveKeptTabIds(ids: Set<number>): Promise<void> {
  await chrome.storage.local.set({ [KEPT_TABS_STORAGE_KEY]: [...ids] });
}

export async function toggleKeptTabId(tabId: number): Promise<boolean> {
  const ids = await loadKeptTabIds();
  let kept: boolean;
  if (ids.has(tabId)) {
    ids.delete(tabId);
    kept = false;
  } else {
    ids.add(tabId);
    kept = true;
  }
  await saveKeptTabIds(ids);
  return kept;
}

export async function removeKeptTabId(tabId: number): Promise<void> {
  const ids = await loadKeptTabIds();
  if (ids.delete(tabId)) {
    await saveKeptTabIds(ids);
  }
}

export async function clearKeptTabIds(): Promise<void> {
  await chrome.storage.local.remove(KEPT_TABS_STORAGE_KEY);
}

export function toTabSummary(tab: chrome.tabs.Tab, keptIds?: ReadonlySet<number>): TabSummary | null {
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
    index: tab.index,
    groupId: tab.groupId,
    favIconUrl: tab.favIconUrl,
  };
}
