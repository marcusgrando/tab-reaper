import { isHttpUrl } from "../shared/config.ts";
import type { SnapshotWindow, TabSummary } from "../shared/types.ts";
import {
  MAX_SNAPSHOT_FAVICON_LEN,
  MAX_SNAPSHOT_TITLE_LEN,
  MAX_SNAPSHOT_URL_LEN,
  captureWindowMetadata,
  isAutoSnapshotsActive,
  type CachedGroups,
} from "./session.ts";

export const WINDOW_TABS_SESSION_KEY = "tabCurb.windowTabsCache";
const WINDOW_ACTIVE_TABS_KEY = "tabCurb.windowActiveTabs";
const MAX_CACHED_GROUP_TITLE_LEN = 64;

function sanitizeCachedTab(tab: TabSummary): TabSummary | null {
  if (!isHttpUrl(tab.url) || tab.url.length > MAX_SNAPSHOT_URL_LEN) return null;
  const title = tab.title.length > MAX_SNAPSHOT_TITLE_LEN ? tab.title.slice(0, MAX_SNAPSHOT_TITLE_LEN) : tab.title;
  const favIconUrl =
    isHttpUrl(tab.favIconUrl) && tab.favIconUrl.length <= MAX_SNAPSHOT_FAVICON_LEN ? tab.favIconUrl : undefined;
  return { ...tab, title, favIconUrl };
}

function sanitizeCachedGroupTitle(title: string | undefined): string | undefined {
  if (!title) return title;
  return title.length > MAX_CACHED_GROUP_TITLE_LEN ? title.slice(0, MAX_CACHED_GROUP_TITLE_LEN) : title;
}

export interface CachedWindow {
  tabs: TabSummary[];
  groups?: CachedGroups;
  window?: SnapshotWindow;
}

export type WindowTabs = Record<string, CachedWindow>;

export async function loadWindowTabs(): Promise<WindowTabs> {
  const stored = await chrome.storage.session.get(WINDOW_TABS_SESSION_KEY);
  return (stored[WINDOW_TABS_SESSION_KEY] as WindowTabs | undefined) ?? {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let sessionCacheKnownEmpty = false;

export async function cacheWindowTabs(tabs: TabSummary[], inserted = false): Promise<void> {
  if (!(await isAutoSnapshotsActive())) {
    if (!sessionCacheKnownEmpty) {
      await chrome.storage.session.remove(WINDOW_TABS_SESSION_KEY);
      await chrome.storage.session.remove(WINDOW_ACTIVE_TABS_KEY);
      sessionCacheKnownEmpty = true;
    }
    return;
  }
  sessionCacheKnownEmpty = false;
  const [windows, metadata, groups] = await Promise.all([
    loadWindowTabs(),
    captureWindowMetadata(new Set(tabs.map((t) => t.windowId))),
    chrome.tabGroups.query({}).catch(() => []),
  ]);
  const previousSerialized = stableStringify(windows);
  // Chrome can report an already partially closed window during a sweep. Only
  // individual tab-removal events may discard its cached tabs before onRemoved.
  const byWindow = new Map<number, Map<number, TabSummary>>();
  for (const tab of tabs) {
    const known = byWindow.get(tab.windowId) ?? new Map((windows[tab.windowId]?.tabs ?? []).map((t) => [t.id, t]));
    const sanitized = sanitizeCachedTab(tab);
    if (!sanitized) {
      known.delete(tab.id);
      byWindow.set(tab.windowId, known);
      continue;
    }
    if (inserted && sanitized.index !== undefined && !known.has(sanitized.id)) {
      for (const other of known.values()) {
        if (other.index !== undefined && other.index >= sanitized.index) other.index++;
      }
    }
    if (sanitized.active) {
      for (const other of known.values()) {
        if (other.id !== sanitized.id && other.active) other.active = false;
      }
    }
    known.set(sanitized.id, sanitized);
    byWindow.set(tab.windowId, known);
  }
  for (const [id, known] of byWindow) {
    const previous = windows[id];
    const cachedGroups = { ...previous?.groups };
    for (const group of groups) {
      if (group.windowId === id) {
        cachedGroups[group.id] = {
          title: sanitizeCachedGroupTitle(group.title),
          color: group.color,
          collapsed: group.collapsed,
        };
      }
    }
    windows[id] = {
      tabs: [...known.values()],
      groups: cachedGroups,
      window: metadata.find((w) => w.id === id) ?? previous?.window,
    };
  }
  if (stableStringify(windows) === previousSerialized) {
    return;
  }
  try {
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  } catch (error) {
    console.warn("Window recovery cache update failed", error);
  }
}

async function loadActiveTabIds(): Promise<Record<string, number>> {
  const stored = await chrome.storage.session.get(WINDOW_ACTIVE_TABS_KEY);
  const raw = stored[WINDOW_ACTIVE_TABS_KEY] as Record<string, number> | undefined;
  return raw && typeof raw === "object" ? { ...raw } : {};
}

export async function updateCachedActiveTab(windowId: number, activeTabId: number): Promise<void> {
  if (!(await isAutoSnapshotsActive())) return;
  sessionCacheKnownEmpty = false;
  const activeByWindow = await loadActiveTabIds();
  if (activeByWindow[String(windowId)] === activeTabId) return;
  activeByWindow[String(windowId)] = activeTabId;
  await chrome.storage.session.set({ [WINDOW_ACTIVE_TABS_KEY]: activeByWindow });
}

export async function updateCachedTabKept(tabId: number, kept: boolean): Promise<void> {
  const windows = await loadWindowTabs();
  let changed = false;
  for (const cached of Object.values(windows)) {
    for (const tab of cached.tabs) {
      if (tab.id === tabId && Boolean(tab.kept) !== kept) {
        tab.kept = kept;
        changed = true;
      }
    }
  }
  if (changed) {
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
}

export async function forgetWindowTab(windowId: number, tabId: number, oldIndex?: number): Promise<void> {
  const windows = await loadWindowTabs();
  const cached = windows[windowId];
  if (!cached) return;
  const index = oldIndex ?? cached.tabs.find((t) => t.id === tabId)?.index;
  cached.tabs = cached.tabs.filter((t) => t.id !== tabId);
  if (index !== undefined) {
    for (const tab of cached.tabs) {
      if (tab.index !== undefined && tab.index > index) tab.index--;
    }
  }
  await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
}

export async function updateCachedTabGroup(group: chrome.tabGroups.TabGroup): Promise<void> {
  const windows = await loadWindowTabs();
  const cached = windows[group.windowId];
  if (cached) {
    (cached.groups ??= {})[group.id] = {
      title: sanitizeCachedGroupTitle(group.title),
      color: group.color,
      collapsed: group.collapsed,
    };
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
}

export async function updateCachedWindowBounds(win: chrome.windows.Window): Promise<void> {
  if (!win.id || win.incognito) return;
  const windows = await loadWindowTabs();
  const cached = windows[win.id];
  if (cached) {
    const { id, focused, state, left, top, width, height } = win;
    cached.window = { id, focused, state, left, top, width, height };
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
}

export async function updateCachedTabMoved(
  tabId: number,
  windowId: number,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
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
}

export async function popClosedWindow(windowId: number): Promise<CachedWindow | undefined> {
  const [windows, activeByWindow] = await Promise.all([loadWindowTabs(), loadActiveTabIds()]);
  const final = windows[windowId];
  delete windows[windowId];
  const activeTabId = activeByWindow[String(windowId)];
  if (final && typeof activeTabId === "number") {
    for (const tab of final.tabs) {
      tab.active = tab.id === activeTabId;
    }
  }
  if (String(windowId) in activeByWindow) {
    delete activeByWindow[String(windowId)];
    await chrome.storage.session.set({
      [WINDOW_TABS_SESSION_KEY]: windows,
      [WINDOW_ACTIVE_TABS_KEY]: activeByWindow,
    });
  } else {
    await chrome.storage.session.set({ [WINDOW_TABS_SESSION_KEY]: windows });
  }
  return final;
}
