import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../src/shared/types.ts";

test("a cold worker captures the last navigation when its window closes", async () => {
  type Listener = (...args: any[]) => Promise<void>;
  const listeners: Record<string, Listener> = {};
  const event = (name: string) => ({ addListener(fn: Listener) { listeners[name] = fn; } });
  const area = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (changes: Record<string, unknown>) => Object.assign(data, changes),
    remove: async (key: string) => { delete data[key]; },
  });
  const tabs = [1, 2, 3].map(id => ({
    id, index: id - 1, url: `https://old.test/${id}`, title: String(id), windowId: 5, groupId: 7,
    active: false, discarded: false, audible: false, pinned: false,
  }));
  const localData: Record<string, unknown> = {};
  const session = area({ "tabReaper.windowTabsCache": { "5": tabs } });
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: {
    storage: { local: area(localData), session },
    tabs: { onMoved: event("moved"), onDetached: event("detached"), onAttached: event("attached"), onUpdated: event("updated"), onRemoved: event("removed"), onCreated: event("created"), onActivated: event("activated") },
    tabGroups: { onUpdated: event("groupChanged"), query: async () => [{ id: 7, title: "Research", color: "green", collapsed: true, windowId: 5 }] },
    windows: { onBoundsChanged: event("bounds"), onRemoved: event("closed"), getAll: async () => [{ id: 5, state: "maximized", focused: true }] },
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    alarms: { get: async () => ({}), create: async () => {}, onAlarm: event("alarm") },
    bookmarks: { onRemoved: event("bookmark") },
    omnibox: { onInputChanged: event("input"), onInputEntered: event("enter") },
  } });
  try {
    await import("../src/background/index.ts");
    const page = { ...tabs[0]!, url: "https://new.test/" };
    await listeners.updated!(1, { url: page.url }, page);
    await listeners.groupChanged!({ windowId: 5, id: 7, title: "Drafts", color: "red", collapsed: false });
    await listeners.bounds!({ id: 5, state: "fullscreen", focused: true });
    await listeners.detached!(2, { oldWindowId: 5, oldPosition: 1 });
    await listeners.moved!(1, { windowId: 5, fromIndex: 0, toIndex: 1 });
    Object.assign(chrome.windows, { getAll: async () => [] });
    Object.assign(chrome.tabGroups, { query: async () => [] });
    const removed = listeners.removed!(1, { isWindowClosing: true, windowId: 5 });
    await Promise.all([removed, listeners.closed!(5)]);
    const snapshots = localData["tabReaper.sessionSnapshots"] as SessionSnapshot[];
    expect(snapshots[0]?.windows?.[0]?.state).toBe("fullscreen");
    expect(snapshots[0]?.tabs.map(t => t.groupTitle)).toEqual(["Drafts", "Drafts"]);
    expect(snapshots[0]?.tabs.map(t => t.url)).toEqual([tabs[2]!.url, page.url]);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});
