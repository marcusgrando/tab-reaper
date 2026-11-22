import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../src/shared/types.ts";

async function worker() {
  type Listener = (...args: any[]) => Promise<void>;
  const listeners: Record<string, Listener> = {};
  const event = (name: string) => ({ addListener(fn: Listener) { listeners[name] = fn; } });
  const area = (data: Record<string, unknown>) => ({
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().map((key) => [key, data[key]])),
    set: async (changes: Record<string, unknown>) => Object.assign(data, changes),
    remove: async (key: string) => { delete data[key]; },
  });
  const tabs = [1, 2, 3].map(id => ({
    id, index: id - 1, url: `https://old.test/${id}`, title: String(id), windowId: 5, groupId: 7,
    active: false, discarded: false, audible: false, pinned: false,
  }));
  const localData: Record<string, unknown> = { "tabReaper.folderSyncOptedIn": true };
  const sessionData: Record<string, unknown> = { "tabReaper.windowTabsCache": { "5": { tabs } } };
  const session = area(sessionData);
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: {
    storage: { local: { ...area(localData), setAccessLevel: async () => {} }, session, onChanged: event("storageChanged") },
    permissions: { onAdded: event("permissionAdded"), onRemoved: event("permissionRemoved") },
    tabs: { onMoved: event("moved"), onDetached: event("detached"), onAttached: event("attached"), onUpdated: event("updated"), onRemoved: event("removed"), onCreated: event("created"), onActivated: event("activated") },
    tabGroups: { onUpdated: event("groupChanged"), query: async () => [{ id: 7, title: "Research", color: "green", collapsed: true, windowId: 5 }] },
    windows: { onBoundsChanged: event("bounds"), onRemoved: event("closed"), getAll: async () => [{ id: 5, state: "maximized", focused: true }] },
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    alarms: { get: async () => ({}), create: async () => {}, onAlarm: event("alarm") },
  } });
  // Each import registers fresh worker listeners against this test's Chrome API.
  await import(`../src/background/index.ts?instance=${crypto.randomUUID()}`);
  return { listeners, tabs, localData, sessionData, restore: () => Object.assign(globalThis, { chrome: previous }) };
}

test("a cold worker captures the last navigation when its window closes", async () => {
  const { listeners, tabs, localData, sessionData, restore } = await worker();
  try {
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

    // Without folderSyncOptedIn, closing a window must not save a snapshot.
    delete localData["tabReaper.sessionSnapshots"];
    localData["tabReaper.folderSyncOptedIn"] = false;
    sessionData["tabReaper.windowTabsCache"] = { "6": { tabs: tabs.map(t => ({ ...t, windowId: 6 })) } };
    await listeners.closed!(6);
    expect(localData["tabReaper.sessionSnapshots"]).toBeUndefined();
  } finally {
    restore();
  }
});

test("without optional permissions, successive memory checks discard down to the lower threshold", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  try {
    const now = Date.now();
    localData["tabReaper.folderSyncOptedIn"] = false;
    localData["tabReaper.config"] = { discardAfterMinutes: 0 };
    for (let id = 4; id <= 8; id++) tabs.push({ ...tabs[0]!, id, url: `https://old.test/${id}` });
    tabs[7]!.pinned = true;
    localData["tabReaper.activity"] = {
      byTabId: Object.fromEntries(tabs.map(tab => [tab.id, { url: tab.url, lastActiveAt: now - tab.id * 1000 }])),
      byUrl: {},
    };

    let used = 100;
    Object.assign(chrome, {
      permissions: { contains: async () => false },
      system: { memory: { getInfo: async () => ({ capacity: 200, availableCapacity: 200 - used }) } },
    });
    const discarded: number[] = [];
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { tabs[id - 1]!.discarded = true; discarded.push(id); },
    });
    const sweep = () => listeners.alarm!({ name: "tabReaper.sweep" });
    await sweep();
    expect(discarded).toEqual([7, 6]);
    used = 90;
    await sweep();
    expect(discarded).toEqual([7, 6, 5, 4]);
    used = 80;
    await sweep();
    expect(discarded).toEqual([7, 6, 5, 4, 3, 2]);
    used = 79;
    await sweep();
    expect(tabs.filter(tab => !tab.discarded).map(tab => tab.id)).toEqual([1, 8]);
  } finally {
    restore();
  }
});

test("an idle candidate used during form inspection stays open", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  const discarded: number[] = [];
  const page = tabs[0]!;
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, {}, resolve));
  try {
    localData["tabReaper.folderSyncOptedIn"] = false;
    for (const tab of tabs.slice(1)) tab.pinned = true;
    localData["tabReaper.activity"] = { byTabId: { 1: { url: page.url, lastActiveAt: 1 } }, byUrl: {} };
    Object.assign(chrome, { permissions: { contains: async () => true },
      system: { memory: { getInfo: async () => ({ capacity: 200, availableCapacity: 115 }) } },
      scripting: { executeScript: async () => {
        await listeners.activated!({ tabId: 1, windowId: 5 });
        await listeners.activated!({ tabId: 2, windowId: 5 });
        return [{ frameId: 0, result: false }];
      } },
    });
    Object.assign(chrome.tabs, { query: async () => tabs, get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => discarded.push(id) });
    expect(await message({ type: "discard_idle_now" })).toEqual({ discarded: 0 });
    expect(discarded).toEqual([]);
  } finally {
    restore();
  }
});

test("Keep acknowledged during restore survives the merge of restored tab IDs", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, {}, resolve));
  const key = "tabReaper.keptTabIds";
  try {
    localData["tabReaper.folderSyncOptedIn"] = false;
    localData["tabReaper.sessionSnapshots"] = [{ id: "backup", capturedAt: 1, tabCount: 1,
      tabs: [{ url: "https://new.test/", title: "Recovered", pinned: false, kept: true, windowId: 5 }] }];
    Object.assign(chrome.tabs, { query: async () => tabs, create: async () => ({ id: 100 }), get: async (id: number) => tabs[id-1] });
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    let reads = 0;
    let toggle: Promise<unknown> | undefined;
    Object.assign(chrome.storage.local, { get: async (k: string | string[]) => {
      const snapshot = await get(k);
      if (k === key && ++reads === 2) {
        toggle = message({ type: "toggle_keep_tab", tabId: 2 });
        await Bun.sleep(0);
      }
      return snapshot;
    } });
    expect(await message({ type: "restore_snapshot", id: "backup", targetWindowId: 5 })).toMatchObject({ restored: 1 });
    expect(await toggle).toMatchObject({ kept: true });
    expect((localData[key] as number[]).sort((a, b) => a - b)).toEqual([2, 100]);
  } finally {
    restore();
  }
});

test("the 30-second alarm skips page sampling and folder I/O below the idle band with sync off", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  const calls: string[] = [];
  try {
    localData["tabReaper.folderSyncOptedIn"] = false;
    Object.assign(chrome, { permissions: { ...chrome.permissions, contains: async () => true }, scripting: {
      getRegisteredContentScripts: async () => [{ id: "tab-reaper-form-observer" }],
      executeScript: async () => { calls.push("script"); return []; },
    } });
    Object.assign(chrome.tabs, { query: async () => tabs });
    Object.assign(chrome.runtime, { sendNativeMessage: async (_host: string, req: { cmd: string }) => {
      calls.push(req.cmd);
      return { ok: true, systemTotalBytes: 1000, chromeBytes: 100 };
    } });
    const alarms: number[] = [];
    Object.assign(chrome.alarms, { get: async () => ({ periodInMinutes: 1 }),
      create: async (_name: string, spec: { periodInMinutes: number }) => alarms.push(spec.periodInMinutes) });
    await listeners.installed!();
    calls.length = 0;
    await listeners.alarm!({ name: "tabReaper.sweep" });
    await Bun.sleep(0);
    expect(alarms).toEqual([0.5]);
    expect(calls).toEqual(["chrome_memory"]);

    // Re-register listeners as Chrome does when it wakes a new service worker.
    localData["tabReaper.folderSyncOptedIn"] = true;
    localData["tabReaper.config"] = { enableSessionSnapshots: false };
    await listeners.alarm!({ name: "tabReaper.sweep" });
    await Bun.sleep(0);
    expect(calls).toContain("sync_get_status");
    calls.length = 0;
    await import(`../src/background/index.ts?instance=${crypto.randomUUID()}`);
    await listeners.alarm!({ name: "tabReaper.sweep" });
    await Bun.sleep(0);
    expect(calls).toEqual(["chrome_memory"]);
  } finally {
    restore();
  }
});

test("granting page access attaches to already loaded tabs and revocation stops them", async () => {
  const { listeners, tabs, restore } = await worker();
  try {
    let access = true;
    let registered = false;
    const attached: number[] = [];
    const stopped: number[] = [];
    tabs[1]!.discarded = true;
    tabs[2]!.url = "chrome://extensions/";
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      sendMessage: async (tabId: number) => stopped.push(tabId),
    });
    Object.assign(chrome.permissions, { contains: async () => access });
    Object.assign(chrome, { scripting: {
      getRegisteredContentScripts: async () => registered ? [{ id: "tab-reaper-form-observer" }] : [],
      registerContentScripts: async () => { registered = true; },
      executeScript: async ({ target }: { target: { tabId: number } }) => attached.push(target.tabId),
    } });
    await listeners.permissionAdded!({ permissions: ["scripting"], origins: ["<all_urls>"] });
    expect(registered).toBe(true);
    expect(attached).toEqual([1]);
    access = false;
    await listeners.permissionRemoved!({ permissions: ["scripting"] });
    expect(stopped).toEqual([1]);
  } finally {
    restore();
  }
});
