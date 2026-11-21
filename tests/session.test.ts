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
  let groupedCalls: Array<{ tabIds: number[]; title?: string; color?: string }>;
  let nextTabId: number;

  beforeEach(() => {
    storageData = {};
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
      tabGroups: {
        get: async (groupId: number) => ({
          title: groupId === 7 ? "Work" : "Other",
          color: groupId === 7 ? "blue" : "grey",
        }),
        update: async (groupId: number, props: { title?: string; color?: string }) => {
          const entry = groupedCalls[groupId - 1];
          if (entry) {
            entry.title = props.title;
            entry.color = props.color;
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
    const recoverable = findRecoverableSnapshot([makeTab(99)], stored, t0 + SNAPSHOT_INTERVAL_MS * 2);
    expect(recoverable?.id).toBe(snap1!.id);
    expect(recoverable?.tabCount).toBe(5);

    // Does NOT trigger during normal browsing
    expect(findRecoverableSnapshot(tabs, stored, t0 + SNAPSHOT_INTERVAL_MS * 2)).toBeNull();
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
    expect(res).toEqual({ restored: 2, skippedExisting: 1 });
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

  test("skips mega-URLs, prunes on QuotaExceededError, and clears snapshots cleanly", async () => {
    const t0 = 1_700_000_000_000;
    const hugeUrl = `https://mermaid.live/edit#${"a".repeat(MAX_SNAPSHOT_URL_LEN + 100)}`;
    const snap = await captureSessionSnapshot(
      [makeTab(1), makeTab(2, { url: hugeUrl })],
      { force: true, now: t0 },
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
});
