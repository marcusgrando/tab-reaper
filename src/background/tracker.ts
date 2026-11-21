import { isInternalUrl, normalizeUrl } from "../shared/config.ts";
import type { ActivityState, TabSummary } from "../shared/types.ts";

export const ACTIVITY_STORAGE_KEY = "tabReaper.activity";
export const KEPT_TABS_STORAGE_KEY = "tabReaper.keptTabIds";
const MAX_TRACKED_URLS = 2000;

export function createEmptyActivityState(): ActivityState {
  return { byTabId: {}, byUrl: {} };
}

export function recordTabVisit(
  state: ActivityState,
  tabId: number,
  url: string | undefined,
  now: number,
): ActivityState {
  const normalized = url && !isInternalUrl(url) ? normalizeUrl(url) : url ?? "";
  const nextByTabId = {
    ...state.byTabId,
    [String(tabId)]: { url: normalized, lastActiveAt: now },
  };
  const nextByUrl = { ...state.byUrl };
  if (normalized && !isInternalUrl(normalized)) {
    nextByUrl[normalized] = now;
  }
  return pruneUrlHistory({ byTabId: nextByTabId, byUrl: nextByUrl });
}

export function removeTrackedTab(state: ActivityState, tabId: number): ActivityState {
  const key = String(tabId);
  if (!(key in state.byTabId)) return state;
  const nextByTabId = { ...state.byTabId };
  delete nextByTabId[key];
  return { byTabId: nextByTabId, byUrl: state.byUrl };
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

  for (const tab of openTabs) {
    const normalized = tab.url && !isInternalUrl(tab.url) ? normalizeUrl(tab.url) : tab.url ?? "";
    const existingById = state.byTabId[String(tab.id)];

    let lastActiveAt: number;
    if (tab.active) {
      lastActiveAt = now;
    } else if (existingById && existingById.url === normalized) {
      lastActiveAt = existingById.lastActiveAt;
    } else if (normalized && normalized in state.byUrl) {
      lastActiveAt = state.byUrl[normalized]!;
    } else {
      lastActiveAt = now;
    }

    nextByTabId[String(tab.id)] = { url: normalized, lastActiveAt };
    if (normalized && !isInternalUrl(normalized)) {
      nextByUrl[normalized] = lastActiveAt;
    }
  }

  return pruneUrlHistory({ byTabId: nextByTabId, byUrl: nextByUrl });
}

export function getTabLastActiveAt(
  state: ActivityState,
  tab: Pick<TabSummary, "id" | "url" | "active">,
  now: number,
): number {
  if (tab.active) return now;
  const byId = state.byTabId[String(tab.id)];
  if (byId) return byId.lastActiveAt;
  if (tab.url && !isInternalUrl(tab.url)) {
    const byUrl = state.byUrl[normalizeUrl(tab.url)];
    if (typeof byUrl === "number") return byUrl;
  }
  return now;
}

function pruneUrlHistory(state: ActivityState): ActivityState {
  const entries = Object.entries(state.byUrl);
  if (entries.length <= MAX_TRACKED_URLS) return state;

  entries.sort((a, b) => b[1] - a[1]);
  const kept = Object.fromEntries(entries.slice(0, MAX_TRACKED_URLS));
  return { byTabId: state.byTabId, byUrl: kept };
}

export async function loadActivityState(): Promise<ActivityState> {
  const result = await chrome.storage.local.get(ACTIVITY_STORAGE_KEY);
  const raw = result[ACTIVITY_STORAGE_KEY] as ActivityState | undefined;
  if (!raw || typeof raw !== "object") {
    return createEmptyActivityState();
  }
  return {
    byTabId: raw.byTabId && typeof raw.byTabId === "object" ? raw.byTabId : {},
    byUrl: raw.byUrl && typeof raw.byUrl === "object" ? raw.byUrl : {},
  };
}

export async function saveActivityState(state: ActivityState): Promise<void> {
  await chrome.storage.local.set({ [ACTIVITY_STORAGE_KEY]: state });
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
