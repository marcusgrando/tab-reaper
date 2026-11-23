import { afterEach, describe, expect, test } from "bun:test";
import {
  attributeRendererMemory,
  measureTabProcessMemory,
  mergeProcessMemorySamples,
  type FrameProcessInfo,
} from "../src/background/process-memory.ts";
import type { TabSummary, TabWeightSample } from "../src/shared/types.ts";

const MiB = 1024 * 1024;
const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

function makeTab(id: number, overrides: Partial<TabSummary> = {}): TabSummary {
  return {
    id,
    url: `https://site${id}.example.test/`,
    title: `Tab ${id}`,
    active: false,
    audible: false,
    pinned: false,
    discarded: false,
    windowId: 1,
    ...overrides,
  };
}

describe("attributeRendererMemory", () => {
  test("attributes sole-owner renderer memory in full and marks it reclaimable", () => {
    const tabs = [makeTab(1), makeTab(2)];
    const framesByTab = new Map<number, FrameProcessInfo[]>([
      [1, [{ frameId: 0, processId: 9, documentLifecycle: "active" }]],
      [2, [{ frameId: 0, processId: 10, documentLifecycle: "active" }]],
    ]);
    const renderers = { "9": 1400 * MiB, "10": 60 * MiB };

    const result = attributeRendererMemory(tabs, framesByTab, renderers, new Set());
    expect(result.get(1)).toEqual({
      processMemoryBytes: 1400 * MiB,
      reclaimableProcessBytes: 1400 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 1400 * MiB,
      pinnedByProtectedPeer: false,
    });
    expect(result.get(2)).toEqual({
      processMemoryBytes: 60 * MiB,
      reclaimableProcessBytes: 60 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 60 * MiB,
      pinnedByProtectedPeer: false,
    });
  });

  test("splits a shared main-frame renderer equally and flags tabs pinned by a protected peer", () => {
    const tabs = [makeTab(1, { active: true }), makeTab(2), makeTab(3), makeTab(4)];
    const framesByTab = new Map<number, FrameProcessInfo[]>([
      // Tabs 1 (protected) and 2 (unprotected) share renderer 12 (600 MiB).
      [1, [{ frameId: 0, processId: 12, documentLifecycle: "active" }]],
      [2, [{ frameId: 0, processId: 12, documentLifecycle: "active" }]],
      // Tabs 3 and 4 (both unprotected) share renderer 20 (900 MiB).
      [3, [{ frameId: 0, processId: 20, documentLifecycle: "active" }]],
      [4, [{ frameId: 0, processId: 20, documentLifecycle: "active" }]],
    ]);
    const renderers = { "12": 600 * MiB, "20": 900 * MiB };

    const result = attributeRendererMemory(tabs, framesByTab, renderers, new Set([1]));

    // Protected tab 1 itself is not pinned by another protected peer.
    expect(result.get(1)).toEqual({
      processMemoryBytes: 300 * MiB,
      reclaimableProcessBytes: 300 * MiB,
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 600 * MiB,
      pinnedByProtectedPeer: false,
    });
    // Unprotected tab 2 cannot terminate renderer 12 while protected tab 1 holds it.
    expect(result.get(2)).toEqual({
      processMemoryBytes: 300 * MiB,
      reclaimableProcessBytes: 0,
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 600 * MiB,
      pinnedByProtectedPeer: true,
    });
    // Both tabs 3 and 4 are unprotected, so discarding them reclaims renderer 20.
    expect(result.get(3)).toEqual({
      processMemoryBytes: 450 * MiB,
      reclaimableProcessBytes: 450 * MiB,
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 900 * MiB,
      pinnedByProtectedPeer: false,
    });
    expect(result.get(4)).toEqual({
      processMemoryBytes: 450 * MiB,
      reclaimableProcessBytes: 450 * MiB,
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 900 * MiB,
      pinnedByProtectedPeer: false,
    });
  });

  test("gives top-frame owner full credit over another tab's cross-origin iframe, while attributing isolated OOPIFs to embedding tabs", () => {
    const tabs = [makeTab(1), makeTab(2), makeTab(3)];
    const framesByTab = new Map<number, FrameProcessInfo[]>([
      // Tab 1 is the top-level owner of renderer 9 (300 MiB).
      [1, [{ frameId: 0, processId: 9, documentLifecycle: "active" }]],
      // Tab 2 owns renderer 10 (40 MiB), embeds an iframe in renderer 9 (owned by Tab 1),
      // and embeds an isolated OOPIF in renderer 11 (200 MiB) shared with Tab 3.
      [2, [
        { frameId: 0, processId: 10, documentLifecycle: "active" },
        { frameId: 5, processId: 9, documentLifecycle: "active" },
        { frameId: 6, processId: 11, documentLifecycle: "active" },
      ]],
      // Tab 3 owns renderer 12 (50 MiB) and also embeds an iframe in isolated OOPIF renderer 11.
      [3, [
        { frameId: 0, processId: 12, documentLifecycle: "active" },
        { frameId: 7, processId: 11, documentLifecycle: "active" },
      ]],
    ]);
    const renderers = { "9": 300 * MiB, "10": 40 * MiB, "11": 200 * MiB, "12": 50 * MiB };

    const result = attributeRendererMemory(tabs, framesByTab, renderers, new Set([2]));

    // Tab 1 keeps all 300 MiB of renderer 9 and is not blocked by Tab 2's subframe.
    expect(result.get(1)).toEqual({
      processMemoryBytes: 300 * MiB,
      reclaimableProcessBytes: 300 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 300 * MiB,
      pinnedByProtectedPeer: false,
    });
    // Tab 2 gets its own 40 MiB + half (100 MiB) of isolated OOPIF 11, and zero from renderer 9.
    expect(result.get(2)).toEqual({
      processMemoryBytes: 140 * MiB,
      reclaimableProcessBytes: 140 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 40 * MiB,
      pinnedByProtectedPeer: false,
    });
    // Tab 3 gets its own 50 MiB (reclaimable) + 100 MiB from OOPIF 11 (pinned by protected Tab 2).
    expect(result.get(3)).toEqual({
      processMemoryBytes: 150 * MiB,
      reclaimableProcessBytes: 50 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 50 * MiB,
      pinnedByProtectedPeer: false,
    });
  });

  test("counts BFCache renderers only when no active frame owns them and ignores pending_deletion and discarded tabs", () => {
    const tabs = [makeTab(1), makeTab(2, { discarded: true })];
    const framesByTab = new Map<number, FrameProcessInfo[]>([
      [1, [
        { frameId: 0, processId: 15, documentLifecycle: "active" },
        { frameId: 0, processId: 16, documentLifecycle: "cached" },
        { frameId: 0, processId: 17, documentLifecycle: "pending_deletion" },
        { frameId: 0, processId: -1, documentLifecycle: "active" },
      ]],
      [2, [{ frameId: 0, processId: 18, documentLifecycle: "active" }]],
    ]);
    const renderers = { "15": 80 * MiB, "16": 120 * MiB, "17": 500 * MiB, "18": 90 * MiB };

    const result = attributeRendererMemory(tabs, framesByTab, renderers, new Set());
    expect(result.get(1)?.processMemoryBytes).toBe(200 * MiB);
    expect(result.get(1)?.reclaimableProcessBytes).toBe(200 * MiB);
    expect(result.has(2)).toBe(false);
  });
});

describe("measureTabProcessMemory and mergeProcessMemorySamples", () => {
  test("queries chrome.webNavigation.getAllFrames for loaded tabs and tolerates per-tab failures", async () => {
    const tabs = [makeTab(1), makeTab(2), makeTab(3, { discarded: true })];
    const queried: number[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => {
          queried.push(tabId);
          if (tabId === 2) throw new Error("Tab closed");
          return [{ frameId: 0, processId: 7, documentLifecycle: "active" }];
        },
      },
    };

    const result = await measureTabProcessMemory(tabs, { "7": 250 * MiB }, new Set());
    expect(queried).toEqual([1, 2]);
    expect(result.get(1)?.processMemoryBytes).toBe(250 * MiB);
    expect(result.has(2)).toBe(false);
    expect(result.has(3)).toBe(false);
  });

  test("merges OS process memory onto existing JS/protection samples without dropping form or visibility flags", () => {
    const base = new Map<number, TabWeightSample>([
      [1, {
        jsHeapBytes: 40 * MiB,
        domNodes: 1000,
        mediaNodes: 2,
        weightMultiplier: 2.1,
        hasUnsavedForm: true,
        isVisible: true,
        hasPictureInPicture: false,
        sampledAt: 1000,
      }],
    ]);
    const processMap = new Map([
      [1, {
        processMemoryBytes: 800 * MiB,
        reclaimableProcessBytes: 800 * MiB,
        sharedProcessTabs: 1,
        sharedProcessTotalBytes: 800 * MiB,
        pinnedByProtectedPeer: false,
      }],
      [2, {
        processMemoryBytes: 300 * MiB,
        reclaimableProcessBytes: 0,
        sharedProcessTabs: 2,
        sharedProcessTotalBytes: 600 * MiB,
        pinnedByProtectedPeer: true,
      }],
    ]);

    const merged = mergeProcessMemorySamples(base, processMap, 2000);
    expect(merged.get(1)).toEqual({
      jsHeapBytes: 40 * MiB,
      domNodes: 1000,
      mediaNodes: 2,
      weightMultiplier: 2.1,
      hasUnsavedForm: true,
      isVisible: true,
      hasPictureInPicture: false,
      sampledAt: 1000,
      processMemoryBytes: 800 * MiB,
      reclaimableProcessBytes: 800 * MiB,
      sharedProcessTabs: 1,
      sharedProcessTotalBytes: 800 * MiB,
      pinnedByProtectedPeer: false,
    });
    expect(merged.get(2)).toEqual({
      jsHeapBytes: 0,
      domNodes: 0,
      mediaNodes: 0,
      weightMultiplier: 1,
      sampledAt: 2000,
      processMemoryBytes: 300 * MiB,
      reclaimableProcessBytes: 0,
      sharedProcessTabs: 2,
      sharedProcessTotalBytes: 600 * MiB,
      pinnedByProtectedPeer: true,
    });
  });
});
