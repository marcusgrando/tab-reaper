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

test("without page access, successive budget checks discard down to the lower threshold", async () => {
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
      permissions: { contains: async (p: { permissions?: string[] }) => Boolean(p.permissions?.includes("nativeMessaging")) },
    });
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({ ok: true, chromeBytes: used, systemTotalBytes: 200, systemAvailableBytes: 50 }),
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

test("without the Local Companion, sleeping tabs stops when it frees no memory until pressure ends", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  const MiB = 1024 ** 2;
  try {
    const now = Date.now();
    localData["tabReaper.folderSyncOptedIn"] = false;
    for (let id = 4; id <= 9; id++) tabs.push({ ...tabs[0]!, id, url: `https://old.test/${id}` });
    localData["tabReaper.activity"] = {
      byTabId: Object.fromEntries(tabs.map(tab => [tab.id, { url: tab.url, lastActiveAt: now - tab.id * 1000 }])),
    };
    let available = 700 * MiB;
    Object.assign(chrome, {
      permissions: { contains: async () => false },
      system: { memory: { getInfo: async () => ({ capacity: 8192 * MiB, availableCapacity: available }) } },
    });
    Object.assign(chrome.runtime, { getPlatformInfo: async () => ({ os: "mac" }) });
    const discarded: number[] = [];
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { tabs[id - 1]!.discarded = true; discarded.push(id); },
    });
    const sweep = () => listeners.alarm!({ name: "tabReaper.sweep" });

    available = 1200 * MiB;
    await sweep();
    expect(discarded).toEqual([]);

    available = 700 * MiB;
    for (let i = 0; i < 4; i++) await sweep();
    expect(discarded).toHaveLength(4);

    available = 1200 * MiB;
    await sweep();
    available = 700 * MiB;
    await sweep();
    expect(discarded).toHaveLength(6);
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
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({ ok: true, chromeBytes: 85, systemTotalBytes: 200, systemAvailableBytes: 50 }),
    });
    Object.assign(chrome, { permissions: { contains: async () => true },
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
    expect(alarms).toEqual([0.5, 1440]);
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

test("an upload starting while tabs.get is pending prevents discard", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  try {
    localData["tabReaper.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
    let onBeforeRequest: ((details: chrome.webRequest.WebRequestBodyDetails) => void) | undefined;
    const noopEvent = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });
    Object.assign(chrome.permissions, { contains: async () => true });
    Object.assign(chrome, {
      webRequest: {
        onBeforeRequest: {
          addListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => { onBeforeRequest = fn; },
          removeListener: () => { onBeforeRequest = undefined; },
          hasListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => onBeforeRequest === fn,
        },
        onBeforeSendHeaders: noopEvent(),
        onCompleted: noopEvent(),
        onErrorOccurred: noopEvent(),
      },
    });
    const discarded: number[] = [];
    let releaseGet!: () => void;
    let getEntered!: () => void;
    const getReached = new Promise<void>((resolve) => { getEntered = resolve; });
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => {
        getEntered();
        await new Promise<void>((resolve) => { releaseGet = resolve; });
        return tabs[id - 1];
      },
      discard: async (id: number) => { discarded.push(id); return { ...tabs[id - 1], discarded: true }; },
    });
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["<all_urls>"] });
    expect(onBeforeRequest).toBeDefined();

    const response = new Promise<{ ok?: boolean }>((resolve) => {
      listeners.message!({ type: "discard_tab", tabId: 2 }, {}, resolve);
    });
    await getReached;
    // Start an upload on tab 2 while tabs.get is still pending inside discardTabSafely.
    onBeforeRequest!({
      requestId: "race-1",
      tabId: 2,
      method: "POST",
      url: "https://upload.test/file",
      type: "xmlhttprequest",
      frameId: 0,
      parentFrameId: -1,
      timeStamp: Date.now(),
      requestBody: { raw: [{ file: "/tmp/video.mp4" }] },
    });
    releaseGet();
    expect(await response).toEqual({ ok: false });
    expect(discarded).toEqual([]);
  } finally {
    localData["tabReaper.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});

test("an upload starting while expired cooldown cleanup is awaiting prevents discard", async () => {
  const { listeners, tabs, localData, sessionData, restore } = await worker();
  try {
    localData["tabReaper.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
    sessionData["tabReaper.activeUploads"] = {
      inFlight: {},
      cooldownUntilByTabId: { "2": Date.now() - 1000 },
    };
    let onBeforeRequest: ((details: chrome.webRequest.WebRequestBodyDetails) => void) | undefined;
    const noopEvent = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });
    Object.assign(chrome.permissions, { contains: async () => true });
    Object.assign(chrome, {
      webRequest: {
        onBeforeRequest: {
          addListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => { onBeforeRequest = fn; },
          removeListener: () => { onBeforeRequest = undefined; },
          hasListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => onBeforeRequest === fn,
        },
        onBeforeSendHeaders: noopEvent(),
        onCompleted: noopEvent(),
        onErrorOccurred: noopEvent(),
      },
    });
    const discarded: number[] = [];
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { discarded.push(id); return { ...tabs[id - 1], discarded: true }; },
    });
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["<all_urls>"] });

    // Seed an expired cooldown in the hydrated state, then pause session.remove during checkTabHasActiveUpload.
    sessionData["tabReaper.activeUploads"] = {
      inFlight: {},
      cooldownUntilByTabId: { "2": Date.now() - 1000 },
    };
    // Re-hydrate with the expired cooldown via a fresh enable so cachedState holds it until checkTabHasActiveUpload prunes it.
    let releaseRemove!: () => void;
    let removeEntered!: () => void;
    const removeReached = new Promise<void>((resolve) => { removeEntered = resolve; });
    const origRemove = chrome.storage.session.remove;
    let interceptRemove = false;
    chrome.storage.session.remove = async (key: string | string[]) => {
      if (interceptRemove && key === "tabReaper.activeUploads") {
        interceptRemove = false;
        removeEntered();
        await new Promise<void>((resolve) => { releaseRemove = resolve; });
      }
      return origRemove(key);
    };

    // Put a short-lived upload through start -> finish, then advance past cooldown so checkTabHasActiveUpload prunes it.
    const realNow = Date.now;
    const base = 1_700_000_000_000;
    let fakeNow = base;
    Date.now = () => fakeNow;
    try {
      let onCompleted!: (details: chrome.webRequest.WebResponseCacheDetails) => void;
      chrome.webRequest.onCompleted.addListener = (fn: (details: chrome.webRequest.WebResponseCacheDetails) => void) => {
        onCompleted = fn;
      };
      // Re-attach so our onCompleted capture is registered.
      localData["tabReaper.config"] = { protectActiveUploads: false, protectUnsavedForms: false };
      await listeners.storageChanged!({ "tabReaper.config": { oldValue: { protectActiveUploads: true }, newValue: { protectActiveUploads: false } } }, "local");
      localData["tabReaper.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
      await listeners.storageChanged!({ "tabReaper.config": { oldValue: { protectActiveUploads: false }, newValue: { protectActiveUploads: true } } }, "local");

      onBeforeRequest!({
        requestId: "cool-1",
        tabId: 2,
        method: "POST",
        url: "https://upload.test/chunk1",
        type: "xmlhttprequest",
        frameId: 0,
        parentFrameId: -1,
        timeStamp: fakeNow,
        requestBody: { raw: [{ file: "/tmp/chunk1.bin" }] },
      });
      onCompleted({
        requestId: "cool-1",
        tabId: 2,
        method: "POST",
        url: "https://upload.test/chunk1",
        type: "xmlhttprequest",
        frameId: 0,
        parentFrameId: -1,
        timeStamp: fakeNow,
        fromCache: false,
        statusCode: 200,
        statusLine: "HTTP/1.1 200 OK",
      });
      await Bun.sleep(10);

      // Expire the cooldown so checkTabHasActiveUpload calls session.remove.
      fakeNow = base + 30_000;
      interceptRemove = true;
      const response = new Promise<{ ok?: boolean }>((resolve) => {
        listeners.message!({ type: "discard_tab", tabId: 2 }, {}, resolve);
      });
      await removeReached;
      // Start AND complete a brand-new chunk on tab 2 while session.remove is paused.
      onBeforeRequest!({
        requestId: "cool-2",
        tabId: 2,
        method: "POST",
        url: "https://upload.test/chunk2",
        type: "xmlhttprequest",
        frameId: 0,
        parentFrameId: -1,
        timeStamp: fakeNow,
        requestBody: { raw: [{ file: "/tmp/chunk2.bin" }] },
      });
      onCompleted({
        requestId: "cool-2",
        tabId: 2,
        method: "POST",
        url: "https://upload.test/chunk2",
        type: "xmlhttprequest",
        frameId: 0,
        parentFrameId: -1,
        timeStamp: fakeNow,
        fromCache: false,
        statusCode: 200,
        statusLine: "HTTP/1.1 200 OK",
      });
      releaseRemove();
      expect(await response).toEqual({ ok: false });
      expect(discarded).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  } finally {
    localData["tabReaper.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});

test("enabling upload protection while a sweep is awaiting memory prevents discarding an uploading tab", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  try {
    const now = Date.now();
    localData["tabReaper.folderSyncOptedIn"] = false;
    localData["tabReaper.config"] = { protectActiveUploads: false, protectUnsavedForms: false };
    localData["tabReaper.activity"] = {
      byTabId: Object.fromEntries(tabs.map((tab) => [tab.id, { url: tab.url, lastActiveAt: now - (10 - tab.id) * 60_000 }])),
      byUrl: {},
    };
    let webRequestPerm = false;
    let onBeforeRequest: ((details: chrome.webRequest.WebRequestBodyDetails) => void) | undefined;
    const noopEvent = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });
    Object.assign(chrome.permissions, {
      contains: async (p: { permissions?: string[] }) =>
        Boolean(p.permissions?.includes("nativeMessaging")) ||
        (Boolean(p.permissions?.includes("webRequest")) && webRequestPerm),
    });
    Object.assign(chrome, {
      webRequest: {
        onBeforeRequest: {
          addListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => { onBeforeRequest = fn; },
          removeListener: () => { onBeforeRequest = undefined; },
          hasListener: (fn: (details: chrome.webRequest.WebRequestBodyDetails) => void) => onBeforeRequest === fn,
        },
        onBeforeSendHeaders: noopEvent(),
        onCompleted: noopEvent(),
        onErrorOccurred: noopEvent(),
      },
    });
    let releaseMemory!: () => void;
    let memoryEntered!: () => void;
    const memoryReached = new Promise<void>((resolve) => { memoryEntered = resolve; });
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => {
        memoryEntered();
        await new Promise<void>((resolve) => { releaseMemory = resolve; });
        return { ok: true, chromeBytes: 180, systemTotalBytes: 200, systemAvailableBytes: 20 };
      },
    });
    const discarded: number[] = [];
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { discarded.push(id); return { ...tabs[id - 1], discarded: true }; },
    });

    // Start the sweep while protectActiveUploads is still false. Tab 1 is oldest and first candidate.
    const sweepDone = listeners.alarm!({ name: "tabReaper.sweep" });
    await memoryReached;

    // Enable upload protection and start an upload on tab 1 before memory reading completes.
    webRequestPerm = true;
    localData["tabReaper.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["<all_urls>"] });
    onBeforeRequest!({
      requestId: "mid-sweep-1",
      tabId: 1,
      method: "POST",
      url: "https://upload.test/archive",
      type: "xmlhttprequest",
      frameId: 0,
      parentFrameId: -1,
      timeStamp: Date.now(),
      requestBody: { raw: [{ file: "/tmp/archive.zip" }] },
    });
    releaseMemory();
    await sweepDone;

    expect(discarded).not.toContain(1);
    expect(discarded).toEqual([2, 3]);
  } finally {
    localData["tabReaper.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});
