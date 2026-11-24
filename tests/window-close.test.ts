import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../src/shared/types.ts";

async function worker() {
  type Listener = (...args: any[]) => any;
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
  const localData: Record<string, unknown> = { "tabCurb.folderSyncOptedIn": true };
  const sessionData: Record<string, unknown> = { "tabCurb.windowTabsCache": { "5": { tabs } } };
  const accessLevels: Array<{ area: string; accessLevel: string }> = [];
  const session = {
    ...area(sessionData),
    setAccessLevel: async (opts: { accessLevel: string }) => { accessLevels.push({ area: "session", ...opts }); },
  };
  const extId = "testextensionidabcdefghijklmnop";
  const trustedSender = {
    id: extId,
    origin: `chrome-extension://${extId}`,
    url: `chrome-extension://${extId}/popup.html`,
    frameId: 0,
  };
  const previous = globalThis.chrome;
  Object.assign(globalThis, { chrome: {
    storage: {
      local: {
        ...area(localData),
        setAccessLevel: async (opts: { accessLevel: string }) => { accessLevels.push({ area: "local", ...opts }); },
      },
      session,
      onChanged: event("storageChanged"),
    },
    permissions: { onAdded: event("permissionAdded"), onRemoved: event("permissionRemoved") },
    tabs: { onMoved: event("moved"), onDetached: event("detached"), onAttached: event("attached"), onUpdated: event("updated"), onRemoved: event("removed"), onCreated: event("created"), onActivated: event("activated") },
    tabGroups: { onUpdated: event("groupChanged"), query: async () => [{ id: 7, title: "Research", color: "green", collapsed: true, windowId: 5 }] },
    windows: { onBoundsChanged: event("bounds"), onRemoved: event("closed"), getAll: async () => [{ id: 5, state: "maximized", focused: true }] },
    runtime: {
      id: extId,
      getURL: (p: string) => `chrome-extension://${extId}/${p.replace(/^\//, "")}`,
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
    },
    alarms: { get: async () => ({}), create: async () => {}, onAlarm: event("alarm") },
  } });
  // Each import registers fresh worker listeners against this test's Chrome API.
  await import(`../src/background/index.ts?instance=${crypto.randomUUID()}`);
  return { listeners, tabs, localData, sessionData, accessLevels, trustedSender, restore: () => Object.assign(globalThis, { chrome: previous }) };
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
    const snapshots = localData["tabCurb.sessionSnapshots"] as SessionSnapshot[];
    expect(snapshots[0]?.windows?.[0]?.state).toBe("fullscreen");
    expect(snapshots[0]?.tabs.map(t => t.groupTitle)).toEqual(["Drafts", "Drafts"]);
    expect(snapshots[0]?.tabs.map(t => t.url)).toEqual([tabs[2]!.url, page.url]);

    // Without folderSyncOptedIn, closing a window must not save a snapshot.
    delete localData["tabCurb.sessionSnapshots"];
    localData["tabCurb.folderSyncOptedIn"] = false;
    sessionData["tabCurb.windowTabsCache"] = { "6": { tabs: tabs.map(t => ({ ...t, windowId: 6 })) } };
    await listeners.closed!(6);
    expect(localData["tabCurb.sessionSnapshots"]).toBeUndefined();
  } finally {
    restore();
  }
});

test("without page access, successive budget checks discard down to the lower threshold", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  try {
    const now = Date.now();
    localData["tabCurb.folderSyncOptedIn"] = false;
    localData["tabCurb.config"] = { discardAfterMinutes: 0 };
    for (let id = 4; id <= 8; id++) tabs.push({ ...tabs[0]!, id, url: `https://old.test/${id}` });
    tabs[7]!.pinned = true;
    localData["tabCurb.activity"] = {
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
    const sweep = () => listeners.alarm!({ name: "tabCurb.sweep" });
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
    localData["tabCurb.folderSyncOptedIn"] = false;
    for (let id = 4; id <= 9; id++) tabs.push({ ...tabs[0]!, id, url: `https://old.test/${id}` });
    localData["tabCurb.activity"] = {
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
    const sweep = () => listeners.alarm!({ name: "tabCurb.sweep" });

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
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  const discarded: number[] = [];
  const page = tabs[0]!;
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, trustedSender, resolve));
  try {
    localData["tabCurb.folderSyncOptedIn"] = false;
    for (const tab of tabs.slice(1)) tab.pinned = true;
    localData["tabCurb.activity"] = { byTabId: { 1: { url: page.url, lastActiveAt: 1 } }, byUrl: {} };
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({ ok: true, chromeBytes: 85, systemTotalBytes: 200, systemAvailableBytes: 50 }),
    });
    Object.assign(chrome, { permissions: { contains: async () => true },
      scripting: { executeScript: async () => {
        await listeners.activated!({ tabId: 1, windowId: 5 });
        await listeners.activated!({ tabId: 2, windowId: 5 });
        return [{ frameId: 0, result: { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } }];
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
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, trustedSender, resolve));
  const key = "tabCurb.keptTabIds";
  try {
    localData["tabCurb.folderSyncOptedIn"] = false;
    localData["tabCurb.sessionSnapshots"] = [{ id: "backup", capturedAt: 1, tabCount: 1,
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
    localData["tabCurb.folderSyncOptedIn"] = false;
    Object.assign(chrome, { permissions: { ...chrome.permissions, contains: async () => true }, scripting: {
      getRegisteredContentScripts: async () => [{ id: "tabcurb-form-observer" }],
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
    await listeners.alarm!({ name: "tabCurb.sweep" });
    await Bun.sleep(0);
    expect(alarms).toEqual([0.5, 1440]);
    expect(calls).toEqual(["chrome_memory"]);

    // Re-register listeners as Chrome does when it wakes a new service worker.
    localData["tabCurb.folderSyncOptedIn"] = true;
    localData["tabCurb.config"] = { enableSessionSnapshots: false };
    await listeners.alarm!({ name: "tabCurb.sweep" });
    await Bun.sleep(0);
    expect(calls).toContain("sync_get_status");
    calls.length = 0;
    await import(`../src/background/index.ts?instance=${crypto.randomUUID()}`);
    await listeners.alarm!({ name: "tabCurb.sweep" });
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
      getRegisteredContentScripts: async () => registered ? [{ id: "tabcurb-form-observer" }] : [],
      registerContentScripts: async () => { registered = true; },
      executeScript: async ({ target }: { target: { tabId: number } }) => attached.push(target.tabId),
    } });
    await listeners.permissionAdded!({ permissions: ["scripting"], origins: ["http://*/*", "https://*/*"] });
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
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  try {
    localData["tabCurb.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
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
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["http://*/*", "https://*/*"] });
    expect(onBeforeRequest).toBeDefined();

    const response = new Promise<{ ok?: boolean }>((resolve) => {
      listeners.message!({ type: "discard_tab", tabId: 2 }, trustedSender, resolve);
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
    localData["tabCurb.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});

test("an upload starting while expired cooldown cleanup is awaiting prevents discard", async () => {
  const { listeners, tabs, localData, sessionData, trustedSender, restore } = await worker();
  try {
    localData["tabCurb.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
    sessionData["tabCurb.activeUploads"] = {
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
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["http://*/*", "https://*/*"] });

    // Seed an expired cooldown in the hydrated state, then pause session.remove during checkTabHasActiveUpload.
    sessionData["tabCurb.activeUploads"] = {
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
      if (interceptRemove && key === "tabCurb.activeUploads") {
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
      localData["tabCurb.config"] = { protectActiveUploads: false, protectUnsavedForms: false };
      await listeners.storageChanged!({ "tabCurb.config": { oldValue: { protectActiveUploads: true }, newValue: { protectActiveUploads: false } } }, "local");
      localData["tabCurb.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
      await listeners.storageChanged!({ "tabCurb.config": { oldValue: { protectActiveUploads: false }, newValue: { protectActiveUploads: true } } }, "local");

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
        listeners.message!({ type: "discard_tab", tabId: 2 }, trustedSender, resolve);
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
    localData["tabCurb.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});

test("enabling upload protection while a sweep is awaiting memory prevents discarding an uploading tab", async () => {
  const { listeners, tabs, localData, restore } = await worker();
  try {
    const now = Date.now();
    localData["tabCurb.folderSyncOptedIn"] = false;
    localData["tabCurb.config"] = { protectActiveUploads: false, protectUnsavedForms: false };
    localData["tabCurb.activity"] = {
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
    const sweepDone = listeners.alarm!({ name: "tabCurb.sweep" });
    await memoryReached;

    // Enable upload protection and start an upload on tab 1 before memory reading completes.
    webRequestPerm = true;
    localData["tabCurb.config"] = { protectActiveUploads: true, protectUnsavedForms: false };
    await listeners.permissionAdded!({ permissions: ["webRequest"], origins: ["http://*/*", "https://*/*"] });
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
    localData["tabCurb.config"] = { protectActiveUploads: false };
    await listeners.permissionRemoved!({ permissions: ["webRequest"] });
    restore();
  }
});

test("protects screen-shared, picture-in-picture, and non-auto-discardable tabs across sweeps even with form protection off", async () => {
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  const discarded: number[] = [];
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, trustedSender, resolve));
  try {
    const now = Date.now();
    localData["tabCurb.folderSyncOptedIn"] = false;
    // Form protection disabled must still protect screen-shared and PiP tabs when page access is granted.
    localData["tabCurb.config"] = { protectUnsavedForms: false };
    tabs.push(
      { ...tabs[0]!, id: 4, index: 3, url: "https://old.test/4", title: "4" },
      { ...tabs[0]!, id: 5, index: 4, url: "https://old.test/5", title: "5" },
    );
    // Tab 1: screen-shared (background tab kept visible by Chromium's visible capturer)
    // Tab 2: Picture-in-Picture video
    // Tab 3: autoDiscardable === false (protected without page access)
    // Tab 4: normal background tab (should be discarded)
    // Tab 5: active tab
    (tabs[2] as { autoDiscardable?: boolean }).autoDiscardable = false;
    tabs[4]!.active = true;
    localData["tabCurb.activity"] = {
      byTabId: Object.fromEntries(tabs.map(tab => [tab.id, { url: tab.url, lastActiveAt: now - (6 - tab.id) * 60_000 }])),
      byUrl: {},
    };
    let sharingTab1 = true;
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({ ok: true, chromeBytes: 90, systemTotalBytes: 200, systemAvailableBytes: 50 }),
    });
    Object.assign(chrome, {
      permissions: { contains: async () => true },
      scripting: {
        executeScript: async ({ target }: { target: { tabId: number } }) => {
          if (target.tabId === 1) {
            return [{ frameId: 0, result: { hasUnsavedForm: false, isVisible: sharingTab1, hasPictureInPicture: false } }];
          }
          if (target.tabId === 2) {
            return [
              { frameId: 0, result: { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } },
              { frameId: 1, result: { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: true } },
            ];
          }
          return [{ frameId: 0, result: { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } }];
        },
      },
    });
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { tabs[id - 1]!.discarded = true; discarded.push(id); },
    });

    // Tab switch event sweep discards only normal background tab 4, keeping tabs 1, 2, 3 alive.
    await listeners.activated!({ tabId: 5, windowId: 5 });
    expect(discarded).toEqual([4]);

    // Manual sleep also refuses tabs 1, 2, and 3 while protected.
    expect(await message({ type: "discard_tab", tabId: 1 })).toEqual({ ok: false });
    expect(await message({ type: "discard_tab", tabId: 2 })).toEqual({ ok: false });
    expect(await message({ type: "discard_tab", tabId: 3 })).toEqual({ ok: false });

    // Once screen sharing stops on tab 1, the next sweep can discard it.
    sharingTab1 = false;
    await listeners.alarm!({ name: "tabCurb.sweep" });
    expect(discarded).toEqual([4, 1]);
  } finally {
    restore();
  }
});

test("size-band eviction and status use real OS renderer RAM via webNavigation without page access", async () => {
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  const MiB = 1024 ** 2;
  const discarded: number[] = [];
  const message = (body: unknown) => new Promise<any>(resolve => listeners.message!(body, trustedSender, resolve));
  try {
    const now = Date.now();
    localData["tabCurb.folderSyncOptedIn"] = false;
    tabs.push({ ...tabs[0]!, id: 4, index: 3, url: "https://meet.google.com/abc", title: "Meet" });
    // Tab 1 is active and shares renderer 10 (1000 MiB) with Tab 2.
    // Tab 3 owns renderer 11 (200 MiB).
    // Tab 4 (Meet) owns renderer 12 (1400 MiB).
    tabs[0]!.active = true;
    localData["tabCurb.activity"] = {
      byTabId: Object.fromEntries(tabs.map(tab => [tab.id, { url: tab.url, lastActiveAt: now - (5 - tab.id) * 60_000 }])),
      byUrl: {},
    };
    const framesByTab: Record<number, Array<{ frameId: number; processId: number; documentLifecycle: string }>> = {
      1: [{ frameId: 0, processId: 10, documentLifecycle: "active" }],
      2: [{ frameId: 0, processId: 10, documentLifecycle: "active" }],
      3: [{ frameId: 0, processId: 11, documentLifecycle: "active" }],
      4: [{ frameId: 0, processId: 12, documentLifecycle: "active" }],
    };
    Object.assign(chrome, {
      // Only nativeMessaging granted; NO scripting / <all_urls> permission.
      permissions: { contains: async (p: { permissions?: string[] }) => Boolean(p.permissions?.includes("nativeMessaging")) },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => framesByTab[tabId] ?? [],
      },
    });
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({
        ok: true,
        chromeBytes: 2600 * MiB,
        systemTotalBytes: 4000 * MiB,
        systemAvailableBytes: 1000 * MiB,
        metric: "pss",
        renderers: {
          "10": 1000 * MiB,
          "11": 200 * MiB,
          "12": 1400 * MiB,
        },
      }),
    });
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { tabs[id - 1]!.discarded = true; discarded.push(id); },
    });

    // Status exposes real OS process memory, shared renderer info, and sorts heaviest first.
    const status = await message({ type: "get_status" });
    const byId = new Map<number, any>(status.openTabs.map((t: any) => [t.id, t]));
    expect(status.openTabs.map((t: any) => t.id)).toEqual([4, 1, 2, 3]);
    expect(byId.get(4)).toMatchObject({ memoryBytes: 1400 * MiB, memorySource: "process", sharedProcessTabs: 1 });
    expect(byId.get(2)).toMatchObject({
      memoryBytes: 500 * MiB,
      memorySource: "process",
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 1000 * MiB,
    });

    // Size-band sweep discards sole-owner renderers (Tab 4 = 1400 MiB, Tab 3 = 200 MiB)
    // before Tab 2 whose shared renderer is pinned alive by active Tab 1.
    await listeners.alarm!({ name: "tabCurb.sweep" });
    expect(discarded).toEqual([4, 3]);
  } finally {
    restore();
  }
});

test("onMessage enforces fail-closed UI sender allowlist, validates payloads, and restricts both storage areas", async () => {
  const { listeners, accessLevels, trustedSender, restore } = await worker();
  try {
    expect(accessLevels).toEqual([
      { area: "local", accessLevel: "TRUSTED_CONTEXTS" },
      { area: "session", accessLevel: "TRUSTED_CONTEXTS" },
    ]);

    const sendRaw = (body: unknown, sender: unknown) => {
      let replied = false;
      let reply: unknown;
      const keepOpen = listeners.message!(body, sender, (res: unknown) => {
        replied = true;
        reply = res;
      });
      return { keepOpen, replied, reply };
    };

    // Fail-closed: missing sender.tab with missing/foreign URL or origin must be rejected.
    expect(sendRaw({ type: "clear_snapshots" }, {}).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { id: trustedSender.id }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { id: trustedSender.id, origin: "https://evil.test", url: "https://evil.test/" }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { ...trustedSender, id: "otherextensionidabcdefghijklmnop" }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { ...trustedSender, origin: "https://evil.test" }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { ...trustedSender, frameId: 1 }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { ...trustedSender, url: `chrome-extension://${trustedSender.id}/background.js` }).keepOpen).toBe(false);
    expect(sendRaw({ type: "clear_snapshots" }, { ...trustedSender, url: `chrome-extension://${trustedSender.id}/popup.html/evil` }).keepOpen).toBe(false);
    expect(sendRaw(null, trustedSender).keepOpen).toBe(false);
    expect(sendRaw([], trustedSender).keepOpen).toBe(false);

    // Valid options.html with query string + hash and popup.html are accepted.
    const optionsSender = {
      ...trustedSender,
      tab: { id: 99 },
      url: `chrome-extension://${trustedSender.id}/options.html?setup=1#protections`,
    };
    const clearRes = await new Promise((resolve) => listeners.message!({ type: "clear_snapshots" }, optionsSender, resolve));
    expect(clearRes).toEqual({ ok: true });

    // Invalid payload fields from a trusted sender fail cleanly instead of forwarding bad types.
    const badTabId = await new Promise((resolve) => listeners.message!({ type: "close_tab", tabId: "1" }, trustedSender, resolve));
    expect(badTabId).toMatchObject({ ok: false });
    const badConfig = await new Promise((resolve) => listeners.message!({ type: "save_config", config: null }, trustedSender, resolve));
    expect(badConfig).toMatchObject({ ok: false });

    // Content script form-access probe requires matching extension id.
    expect(sendRaw("tabcurb-form-access", { id: "wrong-id" }).keepOpen).toBe(false);
    Object.assign(chrome.permissions, { contains: async () => true });
    const accessOk = await new Promise((resolve) =>
      listeners.message!("tabcurb-form-access", { id: trustedSender.id, tab: { id: 1 }, url: "https://site.test/" }, resolve),
    );
    expect(accessOk).toBe(true);
  } finally {
    restore();
  }
});

test("window-cache sanitizes oversized URLs, titles, group titles, and data: favicons", async () => {
  const { listeners, sessionData, restore } = await worker();
  try {
    const bigDataFavicon = "data:image/svg+xml;base64," + "A".repeat(10_000);
    const hugeTitle = "T".repeat(1000);
    const hugeGroupTitle = "G".repeat(200);
    const hugeUrl = `https://huge.test/#${"x".repeat(5000)}`;
    const normalTab = {
      id: 1, index: 0, url: "https://clean.test/page", title: hugeTitle,
      favIconUrl: bigDataFavicon, windowId: 5, groupId: 7,
      active: true, discarded: false, audible: false, pinned: false,
    };
    const hugeUrlTab = {
      id: 2, index: 1, url: hugeUrl, title: "Mega URL",
      favIconUrl: "https://clean.test/icon.png", windowId: 5, groupId: -1,
      active: false, discarded: false, audible: false, pinned: false,
    };

    Object.assign(chrome.tabGroups, {
      query: async () => [{ id: 7, title: hugeGroupTitle, color: "blue", collapsed: false, windowId: 5 }],
    });
    await listeners.updated!(1, { url: normalTab.url }, normalTab);
    await listeners.updated!(2, { url: hugeUrlTab.url }, hugeUrlTab);
    await listeners.groupChanged!({ windowId: 5, id: 7, title: hugeGroupTitle, color: "blue", collapsed: false });

    const cached = (sessionData["tabCurb.windowTabsCache"] as Record<string, { tabs: any[]; groups?: Record<number, { title?: string }> }>)["5"]!;
    const cachedNormal = cached.tabs.find((t) => t.id === 1);
    expect(cachedNormal).toBeDefined();
    expect(cachedNormal.title.length).toBeLessThanOrEqual(256);
    expect(cachedNormal.favIconUrl).toBeUndefined();
    // Tab 2 navigated to an oversized URL (> 4096 chars): keep only a minimal index placeholder with stripped URL/title/favicon.
    const cachedHuge = cached.tabs.find((t) => t.id === 2);
    expect(cachedHuge).toBeDefined();
    expect(cachedHuge.url).toBe("");
    expect(cachedHuge.title).toBe("");
    expect(cachedHuge.favIconUrl).toBeUndefined();
    expect(cachedHuge.index).toBe(1);
    expect(cached.groups?.[7]?.title?.length).toBeLessThanOrEqual(64);
  } finally {
    restore();
  }
});

test("window-cache preserves tab order across middle insertions and removals of uncacheable tabs", async () => {
  const { listeners, tabs, localData, sessionData, restore } = await worker();
  try {
    // Allow onCreated's background event sweep to exit cleanly without rescanning window 5.
    Object.assign(chrome.tabs, { query: async () => [] });
    Object.assign(chrome, {
      permissions: { contains: async () => false },
      system: { memory: { getInfo: async () => ({ capacity: 8192 * 1024 ** 2, availableCapacity: 4096 * 1024 ** 2 }) } },
    });
    Object.assign(chrome.runtime, { getPlatformInfo: async () => ({ os: "linux" }) });
    // Initial window 5 has tabs [1@0, 2@1, 3@2].
    // Create tab 4 in the middle (index 1) with empty url + pendingUrl (like Chrome onCreated for a new tab link).
    const insertedTab = {
      id: 4, index: 1, url: "", pendingUrl: "https://middle.test/", title: "",
      windowId: 5, groupId: -1, active: false, discarded: false, audible: false, pinned: false,
    };
    await listeners.created!(insertedTab);
    // Tab 4 navigates to its final URL.
    await listeners.updated!(4, { url: "https://middle.test/" }, { ...insertedTab, url: "https://middle.test/", title: "Middle" });
    // Create and immediately remove a chrome://newtab at index 2; remaining order must stay intact.
    const ntp = {
      id: 5, index: 2, url: "chrome://newtab/", title: "New Tab",
      windowId: 5, groupId: -1, active: false, discarded: false, audible: false, pinned: false,
    };
    await listeners.created!(ntp);
    await listeners.removed!(5, { isWindowClosing: false, windowId: 5 });

    Object.assign(chrome.windows, { getAll: async () => [] });
    Object.assign(chrome.tabGroups, { query: async () => [] });
    await listeners.closed!(5);

    const snapshots = localData["tabCurb.sessionSnapshots"] as SessionSnapshot[];
    expect(snapshots[0]?.tabs.map((t) => t.url)).toEqual([
      tabs[0]!.url,
      "https://middle.test/",
      tabs[1]!.url,
      tabs[2]!.url,
    ]);

    // A window with only 1 HTTP tab + 1 uncacheable placeholder must not trigger a closed-window snapshot.
    delete localData["tabCurb.sessionSnapshots"];
    sessionData["tabCurb.windowTabsCache"] = {
      "8": {
        tabs: [
          { ...tabs[0]!, id: 81, windowId: 8, index: 0 },
          { id: 82, windowId: 8, index: 1, url: "", title: "", active: false, audible: false, pinned: false, discarded: false },
        ],
      },
    };
    await listeners.closed!(8);
    expect(localData["tabCurb.sessionSnapshots"]).toBeUndefined();
  } finally {
    restore();
  }
});

test("discardTabSafely fails closed on inspection timeout while automatic sweeps still discard other healthy tabs", async () => {
  const { listeners, tabs, localData, trustedSender, restore } = await worker();
  const discarded: number[] = [];
  const message = (body: unknown) => new Promise(resolve => listeners.message!(body, trustedSender, resolve));
  try {
    const now = Date.now();
    localData["tabCurb.folderSyncOptedIn"] = false;
    localData["tabCurb.activity"] = {
      byTabId: Object.fromEntries(tabs.map((tab) => [tab.id, { url: tab.url, lastActiveAt: now - (4 - tab.id) * 60_000 }])),
      byUrl: {},
    };
    tabs[2]!.active = true;
    Object.assign(chrome.runtime, {
      sendNativeMessage: async () => ({ ok: true, chromeBytes: 90, systemTotalBytes: 200, systemAvailableBytes: 50 }),
    });
    Object.assign(chrome, {
      permissions: { contains: async () => true },
      scripting: {
        executeScript: ({ target }: { target: { tabId: number; allFrames?: boolean; frameIds?: number[] } }) => {
          // Tab 1 has a slow cross-origin iframe that stalls allFrames: true while its top frame is responsive.
          if (target.tabId === 1 && target.allFrames) return new Promise(() => {});
          return Promise.resolve([
            { frameId: 0, result: { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } },
          ]);
        },
      },
    });
    Object.assign(chrome.tabs, {
      query: async () => tabs,
      get: async (id: number) => tabs[id - 1],
      discard: async (id: number) => { tabs[id - 1]!.discarded = true; discarded.push(id); },
    });

    // Manual discard refuses tab 1 because allFrames inspection timed out.
    expect(await message({ type: "discard_tab", tabId: 1 })).toEqual({ ok: false });
    expect(discarded).toEqual([]);

    // Automatic sweep skips timed-out tab 1 and still discards healthy candidate tab 2.
    await listeners.alarm!({ name: "tabCurb.sweep" });
    expect(discarded).toEqual([2]);
  } finally {
    restore();
  }
});
