import { describe, expect, test } from "bun:test";
import { planEvictions } from "../src/background/eviction.ts";
import {
  createEmptyActivityState,
  getTabLastActiveAt,
  reconcileActivityOnStartup,
  recordTabVisit,
  removeTrackedTab,
  syncActiveTabs,
} from "../src/background/tracker.ts";
import { sanitizeConfig } from "../src/shared/config.ts";
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

  test("does not immediately discard a tab that was active during an idle period when switching away", () => {
    const cfg = sanitizeConfig({ discardAfterMinutes: 15, maxActiveTabs: 10 });
    const tabA = makeTab(1, { url: "https://app.example.com/work", active: true });
    const tabB = makeTab(2, { url: "https://docs.example.com/ref", active: false });

    let state = createEmptyActivityState();
    state = recordTabVisit(state, tabB.id, tabB.url, t0, 1);
    state = recordTabVisit(state, tabA.id, tabA.url, t0 + 1 * min, 1);

    // User leaves the browser untouched for 30 minutes while Tab A stays active,
    // then switches from Tab A to Tab B.
    const tSwitch = t0 + 31 * min;
    state = recordTabVisit(state, tabB.id, tabB.url, tSwitch, 1);

    const tabsAfterSwitch = [
      { ...tabA, active: false },
      { ...tabB, active: true },
    ];

    // Tab A's idle clock must start when the user left it, not when they first opened it.
    expect(getTabLastActiveAt(state, tabsAfterSwitch[0]!, tSwitch)).toBe(tSwitch);

    const evictions = planEvictions({
      tabs: tabsAfterSwitch,
      activity: state,
      weights: new Map(),
      config: cfg,
      memory: null,
      now: tSwitch,
      mode: "sweep",
    });
    expect(evictions).toEqual([]);
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

  test("syncActiveTabs bootstraps missing activeByWindow entries and refreshes active tab timestamps", () => {
    // Simulate legacy stored state without activeByWindow (e.g. after extension update).
    const legacyState = {
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
    const synced = syncActiveTabs(legacyState, tabs, tSweep);
    expect(synced.activeByWindow?.["1"]).toBe(1);
    expect(synced.byTabId["1"]?.lastActiveAt).toBe(tSweep);
    expect(synced.byTabId["2"]?.lastActiveAt).toBe(t0);
  });
});
