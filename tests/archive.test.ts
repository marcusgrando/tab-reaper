import { beforeEach, describe, expect, test } from "bun:test";
import {
  archiveTabs,
  handleBookmarkRemoved,
  loadArchive,
  planArchives,
  removeArchivedByUrl,
  restoreArchivedTab,
  searchArchive,
} from "../src/background/archive.ts";
import { createEmptyActivityState, recordTabVisit } from "../src/background/tracker.ts";
import { sanitizeConfig } from "../src/shared/config.ts";
import type { TabSummary } from "../src/shared/types.ts";

interface MockBookmark {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  children?: MockBookmark[];
}

describe("auto-bookmark dual archive", () => {
  let storageData: Record<string, unknown>;
  let bookmarks: Map<string, MockBookmark>;
  let nextBookmarkId: number;
  let removedTabIds: number[];
  let createdTabUrls: string[];

  beforeEach(() => {
    storageData = {};
    bookmarks = new Map<string, MockBookmark>([
      ["0", { id: "0", title: "", children: [{ id: "1", title: "Bookmarks Bar" }, { id: "2", title: "Other Bookmarks" }] }],
      ["1", { id: "1", parentId: "0", title: "Bookmarks Bar" }],
      ["2", { id: "2", parentId: "0", title: "Other Bookmarks" }],
    ]);
    nextBookmarkId = 10;
    removedTabIds = [];
    createdTabUrls = [];

    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storageData[key] }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(storageData, obj);
          },
        },
      },
      bookmarks: {
        getTree: async () => [bookmarks.get("0")],
        getChildren: async (parentId: string) =>
          [...bookmarks.values()].filter((b) => b.parentId === parentId),
        create: async (details: { parentId?: string; title?: string; url?: string }) => {
          const id = String(nextBookmarkId++);
          const node: MockBookmark = {
            id,
            parentId: details.parentId ?? "2",
            title: details.title ?? "",
            url: details.url,
          };
          bookmarks.set(id, node);
          return node;
        },
        update: async (id: string, changes: { title?: string; url?: string }) => {
          const node = bookmarks.get(id);
          if (!node) throw new Error("not found");
          Object.assign(node, changes);
          return node;
        },
        remove: async (id: string) => {
          bookmarks.delete(id);
        },
      },
      tabGroups: {
        get: async () => ({ title: "Research", color: "blue" }),
      },
      tabs: {
        remove: async (tabId: number) => {
          removedTabIds.push(tabId);
        },
        create: async (props: { url: string }) => {
          createdTabUrls.push(props.url);
          return { id: 999 };
        },
      },
    };
  });

  test("archives idle tabs into both storage and Chrome bookmarks, deduplicates, and restores cleanly", async () => {
    const now = 1_700_000_000_000;
    const oldTime = now - 80 * 60 * 60 * 1000;
    const cfg = sanitizeConfig({ archiveAfterHours: 72 });

    const tab: TabSummary = {
      id: 42,
      url: "https://example.com/rfc#top",
      title: "RFC Design Doc",
      active: false,
      audible: false,
      pinned: false,
      discarded: true,
      windowId: 1,
      groupId: 7,
    };

    const activity = recordTabVisit(createEmptyActivityState(), tab.id, tab.url, oldTime);
    const toArchive = planArchives({ tabs: [tab], activity, config: cfg, now });
    expect(toArchive).toHaveLength(1);

    const count = await archiveTabs(toArchive, activity, cfg, now);
    expect(count).toBe(1);
    expect(removedTabIds).toEqual([42]);

    const archive = await loadArchive();
    expect(archive).toHaveLength(1);
    expect(archive[0]!.groupTitle).toBe("Research");
    expect(archive[0]!.bookmarkId).toBeDefined();
    expect(bookmarks.has(archive[0]!.bookmarkId!)).toBe(true);

    // Re-archiving the same URL updates instead of duplicating.
    await archiveTabs([{ ...tab, id: 43, url: "https://example.com/rfc" }], activity, cfg, now + 1000);
    expect(await loadArchive()).toHaveLength(1);

    // Fuzzy search matches title and group name.
    expect(searchArchive(await loadArchive(), "research rfc")).toHaveLength(1);
    expect(searchArchive(await loadArchive(), "unrelated")).toHaveLength(0);

    // Restoring opens the tab and removes both index entry and bookmark.
    const entry = (await loadArchive())[0]!;
    const restored = await restoreArchivedTab(entry.id);
    expect(restored).toBe(true);
    expect(createdTabUrls).toEqual(["https://example.com/rfc"]);
    expect(await loadArchive()).toHaveLength(0);
    expect(bookmarks.has(entry.bookmarkId!)).toBe(false);
  });

  test("manual bookmark deletion and URL revisit stay in sync", async () => {
    const now = 1_700_000_000_000;
    const cfg = sanitizeConfig({});
    const t1: TabSummary = {
      id: 1,
      url: "https://alpha.dev/a",
      title: "Alpha",
      active: false,
      audible: false,
      pinned: false,
      discarded: true,
      windowId: 1,
    };
    const t2: TabSummary = {
      id: 2,
      url: "https://beta.dev/b",
      title: "Beta",
      active: false,
      audible: false,
      pinned: false,
      discarded: true,
      windowId: 1,
    };

    await archiveTabs([t1, t2], createEmptyActivityState(), cfg, now);
    const items = await loadArchive();
    expect(items).toHaveLength(2);

    // Deleting bookmark removes it from storage index.
    const alpha = items.find((i) => i.title === "Alpha")!;
    await handleBookmarkRemoved(alpha.bookmarkId!);
    expect((await loadArchive()).map((i) => i.title)).toEqual(["Beta"]);

    // Visiting Beta's URL removes it from both storage and bookmarks.
    const beta = (await loadArchive())[0]!;
    await removeArchivedByUrl("https://beta.dev/b#hash");
    expect(await loadArchive()).toHaveLength(0);
    expect(bookmarks.has(beta.bookmarkId!)).toBe(false);
  });

  test("continues archiving and persists succeeded tabs when a single bookmark create fails", async () => {
    const now = 1_700_000_000_000;
    const cfg = sanitizeConfig({});
    const origCreate = chrome.bookmarks.create;
    chrome.bookmarks.create = (async (details: { parentId?: string; title?: string; url?: string }) => {
      if (details.url?.includes("bad.example")) {
        throw new Error("Invalid URL");
      }
      return origCreate(details);
    }) as typeof chrome.bookmarks.create;

    const tabs: TabSummary[] = [
      { id: 10, url: "https://ok1.example/a", title: "OK 1", active: false, audible: false, pinned: false, discarded: true, windowId: 1 },
      { id: 11, url: "https://bad.example/b", title: "Bad", active: false, audible: false, pinned: false, discarded: true, windowId: 1 },
      { id: 12, url: "https://ok2.example/c", title: "OK 2", active: false, audible: false, pinned: false, discarded: true, windowId: 1 },
    ];

    const archived = await archiveTabs(tabs, createEmptyActivityState(), cfg, now);
    expect(archived).toBe(2);
    expect(removedTabIds).toEqual([10, 12]);
    const saved = await loadArchive();
    expect(saved.map((i) => i.title).sort()).toEqual(["OK 1", "OK 2"]);
  });

  test("auto-archive defaults to 7 days (168h) and can be disabled with 0", () => {
    const now = 1_700_000_000_000;
    const defaultCfg = sanitizeConfig({});
    expect(defaultCfg.archiveAfterHours).toBe(168);

    const disabledCfg = sanitizeConfig({ archiveAfterHours: 0 });
    const tab: TabSummary = {
      id: 50,
      url: "https://old.example/page",
      title: "Old",
      active: false,
      audible: false,
      pinned: false,
      discarded: true,
      windowId: 1,
    };
    const activity = recordTabVisit(createEmptyActivityState(), 50, tab.url, now - 200 * 60 * 60 * 1000);
    expect(planArchives({ tabs: [tab], activity, config: defaultCfg, now })).toHaveLength(1);
    expect(planArchives({ tabs: [tab], activity, config: disabledCfg, now })).toEqual([]);
  });
});
