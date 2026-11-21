import { describe, expect, test } from "bun:test";
import { computeBadge } from "../src/background/badge.ts";
import { MAX_MEMORY_EVICTIONS_PER_PASS, getTabProtectedReason, isTabProtected, planEvictions } from "../src/background/eviction.ts";
import { computeWeightMultiplier } from "../src/background/sampler.ts";
import { createEmptyActivityState, recordTabVisit } from "../src/background/tracker.ts";
import {
  DEFAULT_CONFIG,
  computeMemoryBudgetBytes,
  matchesAllowlist,
  normalizeUrl,
  sanitizeConfig,
} from "../src/shared/config.ts";
import type { MemorySnapshot, TabSummary, TabWeightSample } from "../src/shared/types.ts";

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

describe("config helpers", () => {
  test("default memory budget is system RAM / 2", () => {
    const total32Gb = 32 * 1024 ** 3;
    expect(computeMemoryBudgetBytes(DEFAULT_CONFIG, total32Gb)).toBe(16 * 1024 ** 3);
  });

  test("fixed_gb memory budget uses explicit GiB", () => {
    const cfg = sanitizeConfig({ memoryBudgetMode: "fixed_gb", memoryBudgetGb: 6 });
    expect(computeMemoryBudgetBytes(cfg, 32 * 1024 ** 3)).toBe(6 * 1024 ** 3);
  });

  test("normalizeUrl strips hash and root trailing slash", () => {
    expect(normalizeUrl("https://docs.example.com/#section")).toBe("https://docs.example.com");
    expect(normalizeUrl("https://docs.example.com/guide#top")).toBe("https://docs.example.com/guide");
  });

  test("matchesAllowlist supports exact host, subdomains, and globs", () => {
    const list = ["meet.google.com", "*.slack.com", "github.com/aziontech/*"];
    expect(matchesAllowlist("https://meet.google.com/abc", list)).toBe(true);
    expect(matchesAllowlist("https://app.slack.com/client", list)).toBe(true);
    expect(matchesAllowlist("https://github.com/aziontech/cells", list)).toBe(true);
    expect(matchesAllowlist("https://github.com/other/repo", list)).toBe(false);
  });
});

describe("eviction engine", () => {
  const now = 1_700_000_000_000;

  test("protects active, audible, pinned, internal, and allowlisted tabs", () => {
    const cfg = sanitizeConfig({ allowlist: ["meet.google.com"] });
    expect(isTabProtected(makeTab(1, { active: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(2, { audible: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(3, { pinned: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(4, { url: "chrome://settings" }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(5, { url: "https://meet.google.com/xyz" }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(6), cfg)).toBe(false);
  });

  test("enforces maxActiveTabs and evicts heaviest-weighted tab first", () => {
    const cfg = sanitizeConfig({ maxActiveTabs: 2, discardAfterMinutes: 60 });
    const tabs = [makeTab(1), makeTab(2), makeTab(3)];
    let activity = createEmptyActivityState();
    // Tab 1 idle 8 min (lightweight), Tab 2 idle 5 min (very heavy), Tab 3 idle 1 min (lightweight)
    activity = recordTabVisit(activity, 1, tabs[0]!.url, now - 8 * 60_000);
    activity = recordTabVisit(activity, 2, tabs[1]!.url, now - 5 * 60_000);
    activity = recordTabVisit(activity, 3, tabs[2]!.url, now - 1 * 60_000);

    const weights = new Map<number, TabWeightSample>([
      [
        1,
        {
          jsHeapBytes: 10 * 1024 ** 2,
          domNodes: 300,
          mediaNodes: 0,
          weightMultiplier: computeWeightMultiplier({ jsHeapBytes: 10 * 1024 ** 2, domNodes: 300, mediaNodes: 0 }),
          sampledAt: now,
        },
      ],
      [
        2,
        {
          jsHeapBytes: 250 * 1024 ** 2,
          domNodes: 8000,
          mediaNodes: 4,
          weightMultiplier: computeWeightMultiplier({ jsHeapBytes: 250 * 1024 ** 2, domNodes: 8000, mediaNodes: 4 }),
          sampledAt: now,
        },
      ],
    ]);

    const planned = planEvictions({
      tabs,
      activity,
      weights,
      config: cfg,
      memory: null,
      now,
      mode: "sweep",
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]!.tab.id).toBe(2);
    expect(planned[0]!.reason).toBe("over_tab_cap");
  });

  test("caps memory-pressure evictions per pass to avoid over-discarding", () => {
    const cfg = sanitizeConfig({ maxActiveTabs: 10, discardAfterMinutes: 60 });
    const tabs = [makeTab(1), makeTab(2), makeTab(3), makeTab(4), makeTab(5)];
    let activity = createEmptyActivityState();
    for (let i = 0; i < tabs.length; i++) {
      activity = recordTabVisit(activity, tabs[i]!.id, tabs[i]!.url, now - (i + 1) * 60_000);
    }

    const overBudgetMemory: MemorySnapshot = {
      source: "native_host",
      usedBytes: 18 * 1024 ** 3,
      budgetBytes: 16 * 1024 ** 3,
      systemTotalBytes: 32 * 1024 ** 3,
      systemAvailableBytes: 8 * 1024 ** 3,
      overBudget: true,
      checkedAt: now,
    };

    const planned = planEvictions({
      tabs,
      activity,
      weights: new Map(),
      config: cfg,
      memory: overBudgetMemory,
      now,
      mode: "sweep",
    });

    expect(planned).toHaveLength(MAX_MEMORY_EVICTIONS_PER_PASS);
    expect(planned.every((p) => p.reason === "over_memory_budget")).toBe(true);
    expect(planned.map((p) => p.tab.id)).toEqual([5, 4]);
  });

  test("startup sweep discards all non-protected background tabs", () => {
    const cfg = sanitizeConfig({});
    const tabs = [
      makeTab(1, { active: true }),
      makeTab(2, { pinned: true }),
      makeTab(3),
      makeTab(4, { discarded: true }),
      makeTab(5),
    ];

    const planned = planEvictions({
      tabs,
      activity: createEmptyActivityState(),
      weights: new Map(),
      config: cfg,
      memory: null,
      now,
      mode: "startup",
    });

    expect(planned.map((p) => p.tab.id)).toEqual([3, 5]);
  });

  test("protects loading tabs and tabs with unsaved form input", () => {
    const cfg = sanitizeConfig({ protectUnsavedForms: true });
    expect(getTabProtectedReason(makeTab(1, { status: "loading" }), cfg)).toBe("Loading");
    expect(isTabProtected(makeTab(1, { status: "loading" }), cfg)).toBe(true);

    const formSample: TabWeightSample = {
      jsHeapBytes: 20 * 1024 ** 2,
      domNodes: 500,
      mediaNodes: 0,
      weightMultiplier: 1.4,
      hasUnsavedForm: true,
      sampledAt: now,
    };
    expect(getTabProtectedReason(makeTab(2), cfg, formSample)).toBe("Form");

    const planned = planEvictions({
      tabs: [makeTab(1, { status: "loading" }), makeTab(2), makeTab(3)],
      activity: createEmptyActivityState(),
      weights: new Map([[2, formSample]]),
      config: sanitizeConfig({ maxActiveTabs: 1, discardAfterMinutes: 0 }),
      memory: null,
      now,
      mode: "sweep",
    });
    expect(planned).toEqual([]);
  });

  test("skips all evictions when offline and skipWhenOffline is enabled", () => {
    const cfg = sanitizeConfig({ maxActiveTabs: 1, discardAfterMinutes: 1, skipWhenOffline: true });
    const tabs = [makeTab(1), makeTab(2), makeTab(3)];
    let activity = createEmptyActivityState();
    for (const tab of tabs) {
      activity = recordTabVisit(activity, tab.id, tab.url, now - 30 * 60_000);
    }

    const offlinePlanned = planEvictions({
      tabs,
      activity,
      weights: new Map(),
      config: cfg,
      memory: null,
      now,
      mode: "sweep",
      isOnline: false,
    });
    expect(offlinePlanned).toEqual([]);
  });
});

describe("action badge", () => {
  test("formats Chrome RAM badge and color thresholds", () => {
    const okMem: MemorySnapshot = {
      source: "native_host",
      usedBytes: 2.6 * 1024 ** 3,
      budgetBytes: 4 * 1024 ** 3,
      systemTotalBytes: 8 * 1024 ** 3,
      systemAvailableBytes: 2 * 1024 ** 3,
      overBudget: false,
      checkedAt: 0,
    };
    expect(computeBadge(okMem, 8, true)).toEqual({ text: "2.6G", color: "#16a34a" });

    const warnMem = { ...okMem, usedBytes: 3.2 * 1024 ** 3 };
    expect(computeBadge(warnMem, 8, true)).toEqual({ text: "3.2G", color: "#d97706" });

    const overMem = { ...okMem, usedBytes: 4.5 * 1024 ** 3, overBudget: true };
    expect(computeBadge(overMem, 8, true)).toEqual({ text: "4.5G", color: "#dc2626" });

    expect(computeBadge(okMem, 8, false)).toEqual({ text: "OFF", color: "#64748b" });

    const sysMem: MemorySnapshot = { ...okMem, source: "system_memory" };
    expect(computeBadge(sysMem, 7, true)).toEqual({ text: "7", color: "#16a34a" });
  });
});
