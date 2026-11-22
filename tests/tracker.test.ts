import { describe, expect, test } from "bun:test";
import { planEvictions } from "../src/background/eviction.ts";
import {
  ACTIVITY_STORAGE_KEY,
  URL_HISTORY_STORAGE_KEY,
  createEmptyActivityState,
  getTabLastActiveAt,
  loadActivityState,
  reconcileActivityOnStartup,
  recordTabVisit,
  removeTrackedTab,
  saveActivityState,
  syncActiveTabs,
} from "../src/background/tracker.ts";
import { sanitizeConfig } from "../src/shared/config.ts";
import type { MemorySnapshot, TabSummary } from "../src/shared/types.ts";

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

describe("activity tracker across restarts", () => {
  test("preserves multi-day idle timestamps when Chrome reassigns tabIds on restart", () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = 1_700_000_000_000;
    const fourDaysLater = t0 + 4 * day;

    let state = createEmptyActivityState();
    state = recordTabVisit(state, 10, "https://news.ycombinator.com/item?id=123#comments", t0);

    // After restart, Chrome assigns a completely different tabId (99) to the same URL.
    const reopenedTabs: TabSummary[] = [
      {
        id: 99,
        url: "https://news.ycombinator.com/item?id=123#comments",
        title: "HN",
        active: false,
        audible: false,
        pinned: false,
        discarded: true,
        windowId: 1,
      },
      {
        id: 100,
        url: "https://mail.google.com/",
        title: "Mail",
        active: true,
        audible: false,
        pinned: false,
        discarded: false,
        windowId: 1,
      },
    ];

    const reconciled = reconcileActivityOnStartup(state, reopenedTabs, fourDaysLater);
    expect(getTabLastActiveAt(reconciled, reopenedTabs[0]!, fourDaysLater)).toBe(t0);
    expect(getTabLastActiveAt(reconciled, reopenedTabs[1]!, fourDaysLater)).toBe(fourDaysLater);
  });
});

describe("active tab deactivation tracking", () => {
  const min = 60_000;
  const t0 = 1_700_000_000_000;

  test("ranks the tab just left after older background tabs", () => {
    const cfg = sanitizeConfig({});
    const tabA = makeTab(1, { url: "https://app.example.com/work", active: true });
    const tabB = makeTab(2, { url: "https://docs.example.com/ref", active: false });

    let state = createEmptyActivityState();
    state = recordTabVisit(state, tabB.id, tabB.url, t0, 1);
    state = recordTabVisit(state, tabA.id, tabA.url, t0 + 1 * min, 1);

    // User leaves the browser untouched for 30 minutes while Tab A stays active,
    // then switches from Tab A to Tab B.
    const tSwitch = t0 + 31 * min;
    state = recordTabVisit(state, tabB.id, tabB.url, tSwitch, 1);

    const older = makeTab(3);
    state = recordTabVisit(state, older.id, older.url, tSwitch - min);
    const tabsAfterSwitch = [
      { ...tabA, active: false },
      { ...tabB, active: true },
      older,
    ];

    // Tab A's idle clock must start when the user left it, not when they first opened it.
    expect(getTabLastActiveAt(state, tabsAfterSwitch[0]!, tSwitch)).toBe(tSwitch);

    const warnMemory: MemorySnapshot = {
      source: "native_host",
      usedBytes: Math.round(0.85 * 16 * 1024 ** 3),
      budgetBytes: 16 * 1024 ** 3,
      systemTotalBytes: 32 * 1024 ** 3,
      systemAvailableBytes: 8 * 1024 ** 3,
      overBudget: false,
      checkedAt: tSwitch,
    };

    const evictions = planEvictions({
      tabs: tabsAfterSwitch,
      activity: state,
      weights: new Map(),
      config: cfg,
      memory: warnMemory,
      now: tSwitch,
      mode: "sweep",
    });
    expect(evictions.map(tab => tab.id)).toEqual([older.id, tabA.id]);
  });

  test("background tab creation does not clobber the window's active tab", () => {
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, "https://a.example.com", t0, 1);
    // Background tab opened without windowId (tab.active === false)
    state = recordTabVisit(state, 2, "https://b.example.com", t0 + 5 * min);

    // Switching to tab 2 at t0 + 30m should still stamp tab 1 as last active at t0 + 30m.
    const tSwitch = t0 + 30 * min;
    state = recordTabVisit(state, 2, "https://b.example.com", tSwitch, 1);
    expect(getTabLastActiveAt(state, makeTab(1, { url: "https://a.example.com" }), tSwitch)).toBe(tSwitch);
  });

  test("tracks active tabs independently per window and cleans up on tab removal", () => {
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, "https://w1-a.example.com", t0, 1);
    state = recordTabVisit(state, 10, "https://w2-a.example.com", t0, 2);

    // Switch tab in window 2 at t0 + 20m: only window 2's previous tab is stamped.
    const tW2 = t0 + 20 * min;
    state = recordTabVisit(state, 11, "https://w2-b.example.com", tW2, 2);
    expect(getTabLastActiveAt(state, makeTab(10, { url: "https://w2-a.example.com", windowId: 2 }), tW2)).toBe(tW2);
    expect(state.activeByWindow?.["1"]).toBe(1);
    expect(state.activeByWindow?.["2"]).toBe(11);

    state = removeTrackedTab(state, 1);
    expect(state.activeByWindow?.["1"]).toBeUndefined();
    expect(state.activeByWindow?.["2"]).toBe(11);
  });

  test("syncActiveTabs bootstraps missing activeByWindow entries without restamping tracked tabs", () => {
    const state = {
      activeByWindow: {},
      byTabId: {
        "1": { url: "https://a.example.com", lastActiveAt: t0 },
        "2": { url: "https://b.example.com", lastActiveAt: t0 },
      },
      byUrl: {
        "https://a.example.com": t0,
        "https://b.example.com": t0,
      },
    };

    const tabs = [
      makeTab(1, { url: "https://a.example.com", active: true, windowId: 1 }),
      makeTab(2, { url: "https://b.example.com", active: false, windowId: 1 }),
    ];

    const tSweep = t0 + 20 * min;
    const synced = syncActiveTabs(state, tabs, tSweep);
    expect(synced.activeByWindow?.["1"]).toBe(1);
    // The active tab ranks as "now" through getTabLastActiveAt and is stamped when the user leaves it.
    expect(synced.byTabId["1"]?.lastActiveAt).toBe(t0);
    expect(getTabLastActiveAt(synced, tabs[0]!, tSweep)).toBe(tSweep);
    expect(synced.byUrl).toBe(state.byUrl);
  });

  test("syncActiveTabs returns the same state when only time has passed, so an idle sweep writes nothing", () => {
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, "https://a.example.com", t0, 1);
    state = recordTabVisit(state, 2, "https://b.example.com", t0 + min);

    const tabs = [
      makeTab(1, { url: "https://a.example.com", active: true, windowId: 1 }),
      makeTab(2, { url: "https://b.example.com", windowId: 1 }),
    ];
    expect(syncActiveTabs(state, tabs, t0 + 60 * min)).toBe(state);
  });

  test("tab visits leave the URL history untouched until the tab closes", () => {
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, "https://a.example.com", t0, 1);
    const byUrlBeforeSwitch = state.byUrl;
    state = recordTabVisit(state, 2, "https://b.example.com", t0 + 5 * min, 1);
    expect(state.byUrl).toBe(byUrlBeforeSwitch);

    state = removeTrackedTab(state, 1);
    expect(state.byUrl["https://a.example.com"]).toBe(t0 + 5 * min);
  });

  test("restart reconciliation keeps recency for tabs that were open when Chrome quit", () => {
    // Chrome quits without tabs.onRemoved, so the previous session's records are only in byTabId.
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, "https://old.example.com", t0, 1);
    state = recordTabVisit(state, 2, "https://recent.example.com", t0 + 10 * min, 1);
    state = recordTabVisit(state, 3, "https://current.example.com", t0 + 20 * min, 1);

    const restartAt = t0 + 24 * 60 * min;
    const restored = [
      makeTab(101, { url: "https://old.example.com" }),
      makeTab(102, { url: "https://recent.example.com" }),
      makeTab(103, { url: "https://current.example.com", active: true }),
    ];
    const reconciled = reconcileActivityOnStartup(state, restored, restartAt);
    expect(getTabLastActiveAt(reconciled, restored[0]!, restartAt)).toBe(t0 + 10 * min);
    expect(getTabLastActiveAt(reconciled, restored[1]!, restartAt)).toBe(t0 + 20 * min);
    expect(getTabLastActiveAt(reconciled, restored[2]!, restartAt)).toBe(restartAt);
  });

  test("does not persist oversized URLs", () => {
    const huge = `https://app.example.com/#${"x".repeat(10_000)}`;
    let state = createEmptyActivityState();
    state = recordTabVisit(state, 1, huge, t0, 1);
    state = recordTabVisit(state, 2, "https://b.example.com", t0 + min, 1);
    state = removeTrackedTab(state, 1);
    expect(JSON.stringify(state).length).toBeLessThan(1_000);
  });
});

describe("activity persistence", () => {
  const t0 = 1_700_000_000_000;

  function installStorage(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial };
    const writes: string[][] = [];
    const previous = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) =>
            Object.fromEntries(
              [keys].flat().filter((key) => key in data).map((key) => [key, structuredClone(data[key])]),
            ),
          set: async (items: Record<string, unknown>) => {
            writes.push(Object.keys(items));
            Object.assign(data, structuredClone(items));
          },
        },
      },
    };
    return { data, writes, restore: () => ((globalThis as { chrome?: unknown }).chrome = previous) };
  }

  test("writes the URL history only when it changed", async () => {
    const storage = installStorage();
    try {
      const loaded = await loadActivityState();
      const visited = recordTabVisit(loaded, 1, "https://a.example.com", t0, 1);
      await saveActivityState(visited, loaded);
      expect(storage.writes.at(-1)).toEqual([ACTIVITY_STORAGE_KEY]);

      const closed = removeTrackedTab(visited, 1);
      await saveActivityState(closed, visited);
      expect(storage.writes.at(-1)?.sort()).toEqual([ACTIVITY_STORAGE_KEY, URL_HISTORY_STORAGE_KEY].sort());

      const reloaded = await loadActivityState();
      expect(reloaded.byUrl["https://a.example.com"]).toBe(t0);
    } finally {
      storage.restore();
    }
  });
});
