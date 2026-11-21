import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_SNAPSHOTS,
  MAX_SNAPSHOT_URL_LEN,
  SNAPSHOT_INTERVAL_MS,
  captureSessionSnapshot,
  clearSnapshots,
  findRecoverableSnapshot,
  loadSnapshots,
  restoreSessionSnapshot,
} from "../src/background/session.ts";
import { loadKeptTabIds } from "../src/background/tracker.ts";
import type { TabSummary } from "../src/shared/types.ts";

function makeTab(id: number, overrides: Partial<TabSummary> = {}): TabSummary {
  return {
    id,
    url: `https://example${id}.com/page`,
    title: `Tab ${id}`,
    active: false,
    audible: false,
    pinned: false,
    discarded: false,
    windowId: 1,
    ...overrides,
  };
}

describe("session snapshots and recovery", () => {
  let storageData: Record<string, unknown>;
  let openChromeTabs: Array<{ id: number; url: string; pinned?: boolean }>;
  let createdTabs: Array<{ id: number; url: string; pinned?: boolean }>;
  let groupedCalls: Array<{ tabIds: number[]; title?: string; color?: string; collapsed?: boolean }>;
  let nextTabId: number;

  beforeEach(() => {
    storageData = { "tabReaper.folderSyncOptedIn": true };
    openChromeTabs = [];
    createdTabs = [];
    groupedCalls = [];
    nextTabId = 100;

    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storageData[key] }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(storageData, obj);
          },
          remove: async (key: string) => {
            delete storageData[key];
          },
        },
      },
      windows: { getLastFocused: async () => ({ id: 31 }) },
      tabGroups: {
        get: async (groupId: number) => ({
          title: groupId === 7 ? "Work" : "Other",
          color: groupId === 7 ? "blue" : "grey",
        }),
        update: async (groupId: number, props: { title?: string; color?: string; collapsed?: boolean }) => {
          const entry = groupedCalls[groupId - 1];
          if (entry) {
            entry.title = props.title;
            entry.color = props.color;
            entry.collapsed = props.collapsed;
          }
        },
      },
      tabs: {
        query: async () => openChromeTabs,
        create: async (opts: { url: string; pinned?: boolean }) => {
          const tab = { id: nextTabId++, url: opts.url, pinned: opts.pinned };
          createdTabs.push(tab);
          openChromeTabs.push(tab);
          return tab;
        },
        discard: async () => {},
        group: async (opts: { tabIds: number[] }) => {
          groupedCalls.push({ tabIds: opts.tabIds });
          return groupedCalls.length;
        },
      },
    };
  });

  test("captures snapshots with pinned/kept/group metadata, deduplicates, and protects against post-crash overwrite", async () => {
    const t0 = 1_700_000_000_000;
    const tabs = [
      makeTab(1, { pinned: true }),
      makeTab(2, { kept: true, groupId: 7 }),
      makeTab(3, { groupId: 7 }),
      makeTab(4),
      makeTab(5),
      makeTab(6, { url: "chrome://extensions" }),
    ];

    const snap1 = await captureSessionSnapshot(tabs, { now: t0 });
    expect(snap1).not.toBeNull();
    expect(snap1!.tabCount).toBe(5);
    expect(snap1!.tabs[0]!.pinned).toBe(true);
    expect(snap1!.tabs[1]!.kept).toBe(true);
    expect(snap1!.tabs[1]!.groupTitle).toBe("Work");

    // Within throttle window -> skipped
    expect(await captureSessionSnapshot(tabs, { now: t0 + 10_000 })).toBeNull();

    // Identical tabs after interval -> deduplicated
    expect(await captureSessionSnapshot(tabs, { now: t0 + SNAPSHOT_INTERVAL_MS + 1000 })).toBeNull();

    // Simulated post-crash 1-tab startup -> must NOT overwrite saved 5-tab session
    expect(await captureSessionSnapshot([makeTab(99)], { now: t0 + SNAPSHOT_INTERVAL_MS * 2 })).toBeNull();

    const stored = await loadSnapshots();
    expect(stored).toHaveLength(1);

    // Recovery banner triggers when current browser has <= 2 http tabs
    const recoverable = await findRecoverableSnapshot([makeTab(99)], stored, t0 + SNAPSHOT_INTERVAL_MS * 2);
    expect(recoverable?.id).toBe(snap1!.id);
    expect(recoverable?.tabCount).toBe(5);

    // Does NOT trigger during normal browsing
    expect(await findRecoverableSnapshot(tabs, stored, t0 + SNAPSHOT_INTERVAL_MS * 2)).toBeNull();
  });

  test("caps retained snapshots at MAX_SNAPSHOTS", async () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) {
      await captureSessionSnapshot(
        [makeTab(1), makeTab(2), makeTab(3), makeTab(10 + i)],
        { now: t0 + i * (SNAPSHOT_INTERVAL_MS + 1000) },
      );
    }
    expect(await loadSnapshots()).toHaveLength(MAX_SNAPSHOTS);
  });

  test("restores missing tabs with pinned, kept, and tab groups without duplicating already-open URLs", async () => {
    const t0 = 1_700_000_000_000;
    const tabs = [
      makeTab(1, { pinned: true }),
      makeTab(2, { kept: true, groupId: 7 }),
      makeTab(3, { groupId: 7 }),
    ];
    const snap = await captureSessionSnapshot(tabs, { force: true, now: t0 });

    // Tab 1 is already open; tabs 2 and 3 should be restored.
    openChromeTabs = [{ id: 1, url: "https://example1.com/page", pinned: true }];

    const res = await restoreSessionSnapshot(snap!.id);
    expect(res).toEqual({ restored: 2, skippedExisting: 1, windowsCreated: 0 });
    expect(createdTabs.map((t) => t.url)).toEqual([
      "https://example2.com/page",
      "https://example3.com/page",
    ]);

    const keptIds = await loadKeptTabIds();
    expect(keptIds.has(createdTabs[0]!.id)).toBe(true);
    expect(keptIds.has(createdTabs[1]!.id)).toBe(false);

    expect(groupedCalls).toHaveLength(1);
    expect(groupedCalls[0]!.title).toBe("Work");
    expect(groupedCalls[0]!.color).toBe("blue");
    expect(groupedCalls[0]!.tabIds).toEqual([createdTabs[0]!.id, createdTabs[1]!.id]);
  });

  test("current-window restore keeps tabs and groups in the selected window when focus moves", async () => {
    const snap = await captureSessionSnapshot([1, 2, 3].map(id => makeTab(id, { groupId: 7, active: id === 1 })), { force: true });
    let focused = 31;
    const destinations: number[] = [];
    const active: boolean[] = [];
    const groups: number[] = [];
    Object.assign(chrome.tabs, {
      create: async (opts: chrome.tabs.CreateProperties) => {
        destinations.push(opts.windowId ?? focused);
        active.push(Boolean(opts.active));
        focused = 44;
        return { id: nextTabId++ };
      },
      group: async (opts: chrome.tabs.GroupOptions) => {
        groups.push(opts.createProperties?.windowId ?? focused);
        return 1;
      },
    });
    const result = await restoreSessionSnapshot(snap!.id, { mode: "current_window", targetWindowId: 31 });
    expect(result.restored).toBe(3);
    expect(destinations).toEqual([31, 31, 31]);
    expect(groups).toEqual([31]);
    expect(active).toEqual([false, false, false]);
  });

  test("skips mega-URLs, prunes on QuotaExceededError, and clears snapshots cleanly", async () => {
    const t0 = 1_700_000_000_000;
    const hugeUrl = `https://mermaid.live/edit#${"a".repeat(MAX_SNAPSHOT_URL_LEN + 100)}`;
    const snap = await captureSessionSnapshot(
      [makeTab(1), makeTab(2, { url: hugeUrl })],
      { force: true, trigger: "auto", now: t0 },
    );
    expect(snap?.tabCount).toBe(1);
    expect(snap?.tabs[0]!.url).toBe("https://example1.com/page");

    // Simulate QuotaExceededError when storing more than 1 snapshot
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = (async (obj: Record<string, unknown>) => {
      const snaps = obj["tabReaper.sessionSnapshots"];
      if (Array.isArray(snaps) && snaps.length > 1) {
        throw new Error("QuotaExceededError");
      }
      return origSet(obj);
    }) as typeof chrome.storage.local.set;

    await captureSessionSnapshot([makeTab(3), makeTab(4)], { force: true, now: t0 + 1000 });
    const afterQuota = await loadSnapshots();
    expect(afterQuota).toHaveLength(1);
    expect(afterQuota[0]!.tabs[0]!.url).toBe("https://example3.com/page");

    await clearSnapshots();
    expect(await loadSnapshots()).toEqual([]);
  });

  test("refuses an offline manual save that would evict an unpublished manual snapshot", async () => {
    storageData["tabReaper.folderSyncOptedIn"] = true;
    const tabs = Array.from({ length: 170 }, (_, i) =>
      makeTab(i, { url: `https://example.org/${i}/${"a".repeat(3000)}` })
    );
    const first = await captureSessionSnapshot(tabs, { force: true, skipSync: true });
    expect(first).not.toBeNull();
    await expect(captureSessionSnapshot(tabs, { force: true, skipSync: true })).rejects.toThrow(/space/i);
    expect((await loadSnapshots()).map(s => s.id)).toEqual([first!.id]);
  });

  test("restore honors disabled automatic snapshots and reports a missing recovery file", async () => {
    const snap = await captureSessionSnapshot([makeTab(1)], { force: true, skipSync: true });
    storageData["tabReaper.config"] = { enableSessionSnapshots: false };
    openChromeTabs = [2, 3, 4].map(id => ({ id, url: makeTab(id).url }));
    await restoreSessionSnapshot(snap!.id);
    expect((await loadSnapshots()).map(s => s.id)).toEqual([snap!.id]);
    await expect(restoreSessionSnapshot("absent", { relPath: "devices/b/snapshots/missing.json" })).rejects.toThrow(/try again/i);
  });

  test("retains a bounded automatic recovery copy of an oversized offline session", async () => {
    const tabs = Array.from({ length: 400 }, (_, i) => makeTab(i, { url: `https://docs.test/${i}/${"x".repeat(2990)}` }));
    const snap = await captureSessionSnapshot(tabs);
    expect(snap!.tabCount).toBeGreaterThan(300);
    expect(snap!.tabCount).toBeLessThan(tabs.length);
    expect(snap!.tabs.length).toBe(snap!.tabCount);
    expect(new TextEncoder().encode(JSON.stringify(await loadSnapshots())).length).toBeLessThanOrEqual(1_000_000);
  });

  test("a quota-limited capture keeps the last complete local session", async () => {
    const now = Date.now();
    const tabs = Array.from({ length: 400 }, (_, i) => makeTab(i, { url: `https://docs.test/${i}/${"x".repeat(2990)}` }));
    const whole = await captureSessionSnapshot(tabs.slice(0, 5), { now });
    const partial = await captureSessionSnapshot(tabs, { now: now + 400_000 });
    expect(partial?.complete).toBe(false);
    const stored = await loadSnapshots();
    expect(stored.find(s => s.id === whole!.id)?.tabs).toEqual(whole!.tabs);
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThanOrEqual(1_000_000);
  });

  test("a closed window cannot evict the only recoverable session from a full local cache", async () => {
    const tabs = Array.from({ length: 400 }, (_, id) => makeTab(id, { url: `https://docs.test/${id}/${"x".repeat(2990)}` }));
    const latest = await captureSessionSnapshot(tabs);
    expect(latest!.tabCount).toBeGreaterThan(300);
    await captureSessionSnapshot(tabs.slice(0, 2), { force: true, trigger: "window_closed" });
    const recovery = await findRecoverableSnapshot([], await loadSnapshots());
    expect(recovery?.id).toBe(latest!.id);
    expect(recovery?.tabCount).toBe(latest!.tabCount);
  });

  test("pre-restore capture preserves kept tabs", async () => {
    const snap = await captureSessionSnapshot([makeTab(1)], { force: true });
    storageData["tabReaper.keptTabIds"] = [3];
    openChromeTabs = [2, 3, 4].map(id => ({ id, url: makeTab(id).url, windowId: 10 }));
    await restoreSessionSnapshot(snap!.id);
    const pre = (await loadSnapshots()).find(s => s.trigger === "pre_restore");
    expect(pre?.tabs.filter(t => t.kept).map(t => t.url)).toEqual([makeTab(3).url]);
  });

  test("restores distinct unnamed groups with identical colors", async () => {
    Object.assign(chrome.tabGroups, { get: async (id: number) => ({ title: "", color: "blue", collapsed: id === 7 }) });
    const tabs = [makeTab(1, { groupId: 7 }), makeTab(2, { groupId: 8 }), makeTab(3, { groupId: 7 })];
    const snap = (await captureSessionSnapshot(tabs, { force: true }))!;
    await restoreSessionSnapshot(snap.id);
    expect(groupedCalls.map(g => [g.tabIds, g.collapsed])).toEqual([[[100, 102], true], [[101], false]]);
  });

  test.each(["maximized", "fullscreen"] as const)("restores separate windows and saved focus with a %s background window", async state => {
    const createdWindows: Array<{ id: number; url?: string; state?: string }> = [];
    let nextWinId = 500;
    let focused = 31;
    const chromeMock = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    chromeMock.windows = {
      getLastFocused: async () => ({ id: 31 }),
      getAll: async () => [
        { id: 1, focused: true, state: "normal", width: 1400, height: 900 },
        { id: 2, focused: false, state, width: 1600, height: 1000 },
      ],
      update: async (id: number, options: { focused?: boolean }) => {
        if (options.focused) focused = id;
      },
      create: async (opts: chrome.windows.CreateData) => {
        if (opts.focused === false && (opts.state === "maximized" || opts.state === "fullscreen")) {
          throw new Error("Invalid window state with focused: false");
        }
        const winId = nextWinId++;
        if (opts.focused !== false) focused = winId;
        const url = String(opts.url);
        const firstTab = { id: nextTabId++, url };
        createdTabs.push(firstTab);
        openChromeTabs.push(firstTab);
        createdWindows.push({ id: winId, url, state: opts.state });
        return { id: winId, tabs: [firstTab] };
      },
    };

    const tabs = [
      makeTab(1, { windowId: 1, index: 0, pinned: true, favIconUrl: "https://example1.com/fav.ico" }),
      makeTab(2, { windowId: 1, index: 1, favIconUrl: "data:image/png;base64,AAAA" }),
      // Duplicate URL across two saved windows must preserve both windows in "windows" mode.
      makeTab(3, { windowId: 2, index: 0, url: "https://example1.com/page", active: true }),
      makeTab(4, { windowId: 2, index: 1 }),
    ];

    const snap = await captureSessionSnapshot(tabs, { force: true, label: "Two windows", now: 1_700_000_000_000 });
    expect(snap).not.toBeNull();
    expect(snap!.windowCount).toBe(2);
    expect(snap!.label).toBe("Two windows");
    expect(snap!.tabs[0]!.favIconUrl).toBe("https://example1.com/fav.ico");
    expect(snap!.tabs[1]!.favIconUrl).toBeUndefined(); // data: URI stripped

    const res = await restoreSessionSnapshot(snap!.id, { mode: "windows" });
    expect(res).toEqual({ restored: 4, skippedExisting: 0, windowsCreated: 2 });
    expect(createdWindows).toHaveLength(2);
    expect(createdWindows[1]!.state).toBe(state);
    expect(focused).toBe(createdWindows[0]!.id);
  });

  test("findRecoverableSnapshot returns null when folder sync is not opted in", async () => {
    const t0 = 1_700_000_000_000;
    const tabs = [1, 2, 3, 4, 5].map((id) => makeTab(id));
    const snap = await captureSessionSnapshot(tabs, { now: t0 });
    expect(snap).not.toBeNull();
    const stored = await loadSnapshots();
    expect(await findRecoverableSnapshot([makeTab(99)], stored, t0 + SNAPSHOT_INTERVAL_MS)).not.toBeNull();

    storageData["tabReaper.folderSyncOptedIn"] = false;
    expect(await findRecoverableSnapshot([makeTab(99)], stored, t0 + SNAPSHOT_INTERVAL_MS)).toBeNull();
  });

  test("honors configurable intervalMinutes when throttling automatic captures", async () => {
    const t0 = 1_700_000_000_000;
    const snap1 = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(3)], {
      now: t0,
      intervalMinutes: 60,
    });
    expect(snap1).not.toBeNull();

    // 30 minutes later -> still within 60-minute interval, must be skipped
    const skipped = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(4)], {
      now: t0 + 30 * 60_000,
      intervalMinutes: 60,
    });
    expect(skipped).toBeNull();

    // 61 minutes later -> interval elapsed, must capture
    const snap2 = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(4)], {
      now: t0 + 61 * 60_000,
      intervalMinutes: 60,
    });
    expect(snap2).not.toBeNull();
    expect(await loadSnapshots()).toHaveLength(2);
  });

  test("partial window_closed captures do not postpone whole-session backups", async () => {
    const t0 = 1_700_000_000_000;
    const hour = 60 * 60_000;
    const snap1 = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(3), makeTab(4)], {
      now: t0,
      intervalMinutes: 24 * 60,
    });
    expect(snap1).not.toBeNull();

    // Closing a small 2-tab window 12 hours later creates a window_closed snapshot
    const partial = await captureSessionSnapshot([makeTab(10), makeTab(11)], {
      now: t0 + 12 * hour,
      force: true,
      trigger: "window_closed",
      label: "Closed window",
    });
    expect(partial).not.toBeNull();

    // At 25 hours from snap1 (only 13h from partial), whole-session backup MUST still run
    const snap2 = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(3), makeTab(5)], {
      now: t0 + 25 * hour,
      intervalMinutes: 24 * 60,
    });
    expect(snap2).not.toBeNull();
    expect(snap2!.trigger).toBe("auto");
  });

  test("captureSessionSnapshot refuses to persist when folder sync opt-in is disabled or auto snapshots disabled", async () => {
    storageData["tabReaper.folderSyncOptedIn"] = false;
    const snap = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(3)], {
      now: 1_700_000_000_000,
    });
    expect(snap).toBeNull();
    expect(await loadSnapshots()).toEqual([]);

    // Forced window_closed capture must also be skipped when enableSessionSnapshots is false
    storageData["tabReaper.folderSyncOptedIn"] = true;
    storageData["tabReaper.config"] = { enableSessionSnapshots: false };
    const closedSnap = await captureSessionSnapshot([makeTab(1), makeTab(2), makeTab(3)], {
      now: 1_700_000_000_000,
      force: true,
      trigger: "window_closed",
    });
    expect(closedSnap).toBeNull();
    expect(await loadSnapshots()).toEqual([]);
  });
});
