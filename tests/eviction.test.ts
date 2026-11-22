import { describe, expect, test } from "bun:test";
import { computeBadge } from "../src/background/badge.ts";
import {
  IDLE_EVICTION_MEMORY_THRESHOLD,
  MAX_MEMORY_EVICTIONS_PER_PASS,
  SIZE_EVICTION_MEMORY_THRESHOLD,
  computeOpenTabActions,
  getTabProtectedReason,
  isTabProtected,
  planEvictions,
} from "../src/background/eviction.ts";
import { computeWeightMultiplier } from "../src/background/sampler.ts";
import { createEmptyActivityState, recordTabVisit } from "../src/background/tracker.ts";
import {
  DEFAULT_CONFIG,
  computeMemoryBudgetBytes,
  matchGlob,
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

function makeMemory(
  usageRatio: number,
  overrides: Partial<MemorySnapshot> = {},
): MemorySnapshot {
  const budgetBytes = 16 * 1024 ** 3;
  return {
    source: "native_host",
    usedBytes: Math.ceil(usageRatio * budgetBytes),
    budgetBytes,
    systemTotalBytes: 32 * 1024 ** 3,
    systemAvailableBytes: 8 * 1024 ** 3,
    overBudget: usageRatio >= 1.0,
    checkedAt: 1_700_000_000_000,
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

  test("ignores a retired idle timeout in stored settings and keeps custom memory thresholds", () => {
    const stored = { discardAfterMinutes: 1440, idleEvictionPercent: 62, sizeEvictionPercent: 92 };
    expect(sanitizeConfig(stored)).toEqual({ ...DEFAULT_CONFIG, idleEvictionPercent: 62, sizeEvictionPercent: 92 });
    expect(sanitizeConfig(stored)).not.toHaveProperty("discardAfterMinutes");
  });

  test("normalizeUrl preserves hash fragments and strips bare root trailing slash", () => {
    expect(normalizeUrl("https://docs.example.com/")).toBe("https://docs.example.com");
    expect(normalizeUrl("https://docs.example.com/#section")).toBe("https://docs.example.com/#section");
    expect(normalizeUrl("https://docs.example.com/guide#top")).toBe("https://docs.example.com/guide#top");
  });

  test("matchesAllowlist matches hostnames strictly and rejects cross-origin query/path spoofing", () => {
    const list = ["meet.google.com", "*.slack.com", "github.com/aziontech/*"];
    expect(matchesAllowlist("https://meet.google.com/abc", list)).toBe(true);
    expect(matchesAllowlist("https://app.slack.com/client", list)).toBe(true);
    expect(matchesAllowlist("https://github.com/aziontech/cells", list)).toBe(true);
    expect(matchesAllowlist("https://github.com/other/repo", list)).toBe(false);
    // Spoofing attempts via query string or path on an untrusted origin must never match.
    expect(matchesAllowlist("https://evil.com/?x=.slack.com", list)).toBe(false);
    expect(matchesAllowlist("https://evil.com/app.slack.com", list)).toBe(false);
    expect(matchesAllowlist("https://evil.com/?r=github.com/aziontech/cells", list)).toBe(false);
  });

  test("matchGlob runs in linear time without catastrophic ReDoS backtracking", () => {
    const start = performance.now();
    const evilPath = "/" + "a/".repeat(400) + "x";
    expect(matchGlob(evilPath, "/*/*/*/*/*/*/*/*/*z")).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  test("sanitizeConfig defaults and clamps snapshotIntervalMinutes (1..1440) and eviction percentages (10..100)", () => {
    const defaults = sanitizeConfig(undefined);
    expect(defaults.snapshotIntervalMinutes).toBe(5);
    expect(defaults.idleEvictionPercent).toBe(80);
    expect(defaults.sizeEvictionPercent).toBe(100);

    expect(sanitizeConfig({ snapshotIntervalMinutes: 0 }).snapshotIntervalMinutes).toBe(1);
    expect(sanitizeConfig({ snapshotIntervalMinutes: 5000 }).snapshotIntervalMinutes).toBe(1440);
    expect(sanitizeConfig({ snapshotIntervalMinutes: 30 }).snapshotIntervalMinutes).toBe(30);

    expect(sanitizeConfig({ idleEvictionPercent: 5 }).idleEvictionPercent).toBe(10);
    expect(sanitizeConfig({ idleEvictionPercent: 120 }).idleEvictionPercent).toBe(100);
    expect(sanitizeConfig({ idleEvictionPercent: 70, sizeEvictionPercent: 90 })).toMatchObject({
      idleEvictionPercent: 70,
      sizeEvictionPercent: 90,
    });
    // sizeEvictionPercent is clamped to at least idleEvictionPercent.
    expect(sanitizeConfig({ idleEvictionPercent: 85, sizeEvictionPercent: 60 })).toMatchObject({
      idleEvictionPercent: 85,
      sizeEvictionPercent: 85,
    });
  });
});

describe("eviction engine", () => {
  const now = 1_700_000_000_000;

  test("protects active, audible, pinned, kept, internal, and allowlisted tabs", () => {
    const cfg = sanitizeConfig({ allowlist: ["meet.google.com"] });
    expect(isTabProtected(makeTab(1, { active: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(2, { audible: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(3, { pinned: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(4, { url: "chrome://settings" }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(5, { url: "https://meet.google.com/xyz" }), cfg)).toBe(true);
    expect(getTabProtectedReason(makeTab(7, { kept: true }), cfg)).toBe("Kept");
    expect(isTabProtected(makeTab(7, { kept: true }), cfg)).toBe(true);
    expect(isTabProtected(makeTab(6), cfg)).toBe(false);
  });

  test("never discards below idleEvictionPercent memory budget even when tabs are idle", () => {
    const cfg = sanitizeConfig({ idleEvictionPercent: 80, sizeEvictionPercent: 100 });
    const tabs = [makeTab(1), makeTab(2), makeTab(3)];
    let activity = createEmptyActivityState();
    activity = recordTabVisit(activity, 1, tabs[0]!.url, now - 90 * 60_000);
    activity = recordTabVisit(activity, 2, tabs[1]!.url, now - 60 * 60_000);
    activity = recordTabVisit(activity, 3, tabs[2]!.url, now - 30 * 60_000);

    expect(
      planEvictions({
        tabs,
        activity,
        weights: new Map(),
        config: cfg,
        memory: makeMemory(IDLE_EVICTION_MEMORY_THRESHOLD - 0.01),
        now,
        mode: "sweep",
      }),
    ).toEqual([]);

    expect(
      planEvictions({
        tabs,
        activity,
        weights: new Map(),
        config: cfg,
        memory: null,
        now,
        mode: "sweep",
      }),
    ).toEqual([]);
  });

  test("between idleEvictionPercent and sizeEvictionPercent, discards idle tabs oldest-first ignoring heavier younger tabs, capped at 2 per pass", () => {
    const cfg = sanitizeConfig({ idleEvictionPercent: 80, sizeEvictionPercent: 100 });
    const tabs = [makeTab(1), makeTab(2), makeTab(3), makeTab(4)];
    let activity = createEmptyActivityState();
    // Tab 1 idle 45m (light), Tab 2 idle 20m (very heavy), Tab 3 idle 30m (light), Tab 4 idle 5m (most recent)
    activity = recordTabVisit(activity, 1, tabs[0]!.url, now - 45 * 60_000);
    activity = recordTabVisit(activity, 2, tabs[1]!.url, now - 20 * 60_000);
    activity = recordTabVisit(activity, 3, tabs[2]!.url, now - 30 * 60_000);
    activity = recordTabVisit(activity, 4, tabs[3]!.url, now - 5 * 60_000);

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
          jsHeapBytes: 300 * 1024 ** 2,
          domNodes: 8000,
          mediaNodes: 4,
          weightMultiplier: computeWeightMultiplier({ jsHeapBytes: 300 * 1024 ** 2, domNodes: 8000, mediaNodes: 4 }),
          sampledAt: now,
        },
      ],
    ]);

    const planned = planEvictions({
      tabs,
      activity,
      weights,
      config: cfg,
      memory: makeMemory(0.85),
      now,
      mode: "sweep",
    });

    expect(planned).toHaveLength(MAX_MEMORY_EVICTIONS_PER_PASS);
    expect(planned.map((p) => p.id)).toEqual([1, 3]);
  });

  test("honors custom idleEvictionPercent and sizeEvictionPercent thresholds", () => {
    const cfg = sanitizeConfig({ idleEvictionPercent: 60, sizeEvictionPercent: 85 });
    const tabs = [makeTab(1), makeTab(2)];
    let activity = createEmptyActivityState();
    // Tab 1 oldest idle (30m) and light; Tab 2 recent (2m) and heavy
    activity = recordTabVisit(activity, 1, tabs[0]!.url, now - 30 * 60_000);
    activity = recordTabVisit(activity, 2, tabs[1]!.url, now - 2 * 60_000);

    const weights = new Map<number, TabWeightSample>([
      [1, { jsHeapBytes: 10 * 1024 ** 2, domNodes: 200, mediaNodes: 0, weightMultiplier: 1.0, sampledAt: now }],
      [2, { jsHeapBytes: 300 * 1024 ** 2, domNodes: 6000, mediaNodes: 2, weightMultiplier: 3.0, sampledAt: now }],
    ]);

    expect(
      planEvictions({ tabs, activity, weights, config: cfg, memory: makeMemory(0.59), now, mode: "sweep" }),
    ).toEqual([]);

    const idleBand = planEvictions({ tabs, activity, weights, config: cfg, memory: makeMemory(0.65), now, mode: "sweep" });
    expect(idleBand.map(tab => tab.id)).toEqual([1, 2]);

    const sizeBand = planEvictions({ tabs, activity, weights, config: cfg, memory: makeMemory(0.85), now, mode: "sweep" });
    expect(sizeBand.map(tab => tab.id)).toEqual([2, 1]);
  });

  test("at >= sizeEvictionPercent with weight samples, discards heaviest tabs first capped at 2 per pass", () => {
    const cfg = DEFAULT_CONFIG;
    const tabs = [makeTab(1), makeTab(2), makeTab(3), makeTab(4)];
    let activity = createEmptyActivityState();
    // Tab 1 oldest idle (40m) but tiny; Tab 2 recent (2m) but heaviest heap;
    // Tab 3 recent (3m) with medium heap; Tab 4 medium idle (20m) with zero heap but high weightMultiplier.
    activity = recordTabVisit(activity, 1, tabs[0]!.url, now - 40 * 60_000);
    activity = recordTabVisit(activity, 2, tabs[1]!.url, now - 2 * 60_000);
    activity = recordTabVisit(activity, 3, tabs[2]!.url, now - 3 * 60_000);
    activity = recordTabVisit(activity, 4, tabs[3]!.url, now - 20 * 60_000);

    const weights = new Map<number, TabWeightSample>([
      [1, { jsHeapBytes: 10 * 1024 ** 2, domNodes: 200, mediaNodes: 0, weightMultiplier: 1.0, sampledAt: now }],
      [2, { jsHeapBytes: 400 * 1024 ** 2, domNodes: 2000, mediaNodes: 0, weightMultiplier: 2.5, sampledAt: now }],
      [3, { jsHeapBytes: 200 * 1024 ** 2, domNodes: 1500, mediaNodes: 0, weightMultiplier: 1.8, sampledAt: now }],
      [4, { jsHeapBytes: 0, domNodes: 9000, mediaNodes: 4, weightMultiplier: 3.5, sampledAt: now }],
    ]);

    const planned = planEvictions({
      tabs,
      activity,
      weights,
      config: cfg,
      memory: makeMemory(SIZE_EVICTION_MEMORY_THRESHOLD),
      now,
      mode: "sweep",
    });

    expect(planned).toHaveLength(MAX_MEMORY_EVICTIONS_PER_PASS);
    expect(planned.map((p) => p.id)).toEqual([2, 3]);

    // When jsHeapBytes are equal (e.g. 0), fall back to weightMultiplier descending, then idleMinutes descending.
    const zeroHeapWeights = new Map<number, TabWeightSample>([
      [1, { jsHeapBytes: 0, domNodes: 200, mediaNodes: 0, weightMultiplier: 1.2, sampledAt: now }],
      [2, { jsHeapBytes: 0, domNodes: 5000, mediaNodes: 2, weightMultiplier: 2.5, sampledAt: now }],
      [3, { jsHeapBytes: 0, domNodes: 5000, mediaNodes: 2, weightMultiplier: 2.5, sampledAt: now }],
    ]);
    const plannedByWeight = planEvictions({
      tabs: tabs.slice(0, 3),
      activity,
      weights: zeroHeapWeights,
      config: cfg,
      memory: makeMemory(1.05),
      now,
      mode: "sweep",
    });
    expect(plannedByWeight.map((p) => p.id)).toEqual([3, 2]);
  });

  test("at >= 100% RAM without weight samples, falls back to oldest-idle first capped at 2 per pass", () => {
    const cfg = DEFAULT_CONFIG;
    const tabs = [makeTab(1), makeTab(2), makeTab(3), makeTab(4), makeTab(5)];
    let activity = createEmptyActivityState();
    for (let i = 0; i < tabs.length; i++) {
      activity = recordTabVisit(activity, tabs[i]!.id, tabs[i]!.url, now - (i + 1) * 60_000);
    }

    const planned = planEvictions({
      tabs,
      activity,
      weights: new Map(),
      config: cfg,
      memory: makeMemory(1.125),
      now,
      mode: "sweep",
    });

    expect(planned).toHaveLength(MAX_MEMORY_EVICTIONS_PER_PASS);
    expect(planned.map((p) => p.id)).toEqual([5, 4]);
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

    expect(planned.map((p) => p.id)).toEqual([3, 5]);
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
      config: cfg,
      memory: makeMemory(0.85),
      now,
      mode: "sweep",
    });
    expect(planned.map(tab => tab.id)).toEqual([3]);
  });

  test("skips all evictions when offline and skipWhenOffline is enabled", () => {
    const cfg = sanitizeConfig({ skipWhenOffline: true });
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
      memory: makeMemory(1.1),
      now,
      mode: "sweep",
      isOnline: false,
    });
    expect(offlinePlanned).toEqual([]);
  });
});

describe("action badge", () => {
  test("formats Chrome RAM badge and color thresholds aligned with eviction bands", () => {
    const okMem: MemorySnapshot = {
      source: "native_host",
      usedBytes: Math.round(0.79 * 4 * 1024 ** 3),
      budgetBytes: 4 * 1024 ** 3,
      systemTotalBytes: 8 * 1024 ** 3,
      systemAvailableBytes: 2 * 1024 ** 3,
      overBudget: false,
      checkedAt: 0,
    };
    expect(computeBadge(okMem, 8, true)).toEqual({ text: "3.2G", color: "#16a34a" });

    const warn80Mem = { ...okMem, usedBytes: Math.round(0.8 * 4 * 1024 ** 3) };
    expect(computeBadge(warn80Mem, 8, true)).toEqual({ text: "3.2G", color: "#d97706" });

    const warn99Mem = { ...okMem, usedBytes: Math.round(0.99 * 4 * 1024 ** 3) };
    expect(computeBadge(warn99Mem, 8, true)).toEqual({ text: "4.0G", color: "#d97706" });

    const over100Mem = { ...okMem, usedBytes: 4 * 1024 ** 3, overBudget: false };
    expect(computeBadge(over100Mem, 8, true)).toEqual({ text: "4.0G", color: "#dc2626" });

    const overFlagMem = { ...okMem, usedBytes: 4.5 * 1024 ** 3, overBudget: true };
    expect(computeBadge(overFlagMem, 8, true)).toEqual({ text: "4.5G", color: "#dc2626" });

    expect(computeBadge(okMem, 8, false)).toEqual({ text: "OFF", color: "#64748b" });

    const sysMem: MemorySnapshot = { ...okMem, source: "system_memory" };
    expect(computeBadge(sysMem, 7, true)).toEqual({ text: "7", color: "#16a34a" });
  });
});

describe("open tab action coherence", () => {
  test("hides Keep and Sleep when tab is protected by config or loading", () => {
    const cfg = sanitizeConfig({ protectPinned: true, protectActive: true, protectAudible: true });
    expect(computeOpenTabActions(makeTab(1, { pinned: true }), cfg)).toEqual({
      protectedReason: "Pinned",
      canKeep: false,
      canSleep: false,
      canClose: false,
    });
    expect(computeOpenTabActions(makeTab(2, { active: true }), cfg)).toEqual({
      protectedReason: "Active",
      canKeep: false,
      canSleep: false,
      canClose: true,
    });
    expect(computeOpenTabActions(makeTab(3, { status: "loading" }), cfg)).toEqual({
      protectedReason: "Loading",
      canKeep: false,
      canSleep: false,
      canClose: true,
    });
  });

  test("exposes Keep and Sleep on pinned tab when protectPinned is disabled, but still hides Close", () => {
    const cfg = sanitizeConfig({ protectPinned: false });
    expect(computeOpenTabActions(makeTab(1, { pinned: true }), cfg)).toEqual({
      protectedReason: null,
      canKeep: true,
      canSleep: true,
      canClose: false,
    });
  });

  test("shows only Kept toggle when user locked a tab (no Close), and Keep + Close when sleeping", () => {
    const cfg = sanitizeConfig({});
    expect(computeOpenTabActions(makeTab(1, { kept: true }), cfg)).toEqual({
      protectedReason: "Kept",
      canKeep: true,
      canSleep: false,
      canClose: false,
    });
    expect(computeOpenTabActions(makeTab(2, { discarded: true }), cfg)).toEqual({
      protectedReason: null,
      canKeep: true,
      canSleep: false,
      canClose: true,
    });
  });
});
