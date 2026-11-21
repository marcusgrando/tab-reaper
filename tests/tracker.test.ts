import { describe, expect, test } from "bun:test";
import {
  createEmptyActivityState,
  getTabLastActiveAt,
  reconcileActivityOnStartup,
  recordTabVisit,
} from "../src/background/tracker.ts";
import type { TabSummary } from "../src/shared/types.ts";

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
