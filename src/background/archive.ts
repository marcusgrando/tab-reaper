import { normalizeUrl } from "../shared/config.ts";
import type { ActivityState, ArchivedTab, TabReaperConfig, TabSummary, TabWeightSample } from "../shared/types.ts";
import { isTabProtected } from "./eviction.ts";
import { getTabLastActiveAt } from "./tracker.ts";

export const ARCHIVE_STORAGE_KEY = "tabReaper.archive";

export interface PlanArchivesInput {
  tabs: TabSummary[];
  activity: ActivityState;
  weights?: Map<number, TabWeightSample>;
  config: TabReaperConfig;
  now: number;
  forceDiscarded?: boolean;
}

export function isArchivableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

export interface ArchivePlanBreakdown {
  toArchive: TabSummary[];
  skippedProtected: number;
  skippedNotDiscarded: number;
  skippedNonHttp: number;
}

export function planArchivesWithBreakdown(input: PlanArchivesInput): ArchivePlanBreakdown {
  const { tabs, activity, weights, config, now, forceDiscarded = false } = input;
  const result: ArchivePlanBreakdown = {
    toArchive: [],
    skippedProtected: 0,
    skippedNotDiscarded: 0,
    skippedNonHttp: 0,
  };
  if (!forceDiscarded && config.archiveAfterHours <= 0) return result;

  const thresholdMs = config.archiveAfterHours * 60 * 60 * 1000;
  for (const tab of tabs) {
    if (!isArchivableUrl(tab.url)) {
      result.skippedNonHttp++;
      continue;
    }
    if (isTabProtected(tab, config, weights?.get(tab.id))) {
      result.skippedProtected++;
      continue;
    }
    if (forceDiscarded) {
      if (tab.discarded) {
        result.toArchive.push(tab);
      } else {
        result.skippedNotDiscarded++;
      }
      continue;
    }
    const lastActiveAt = getTabLastActiveAt(activity, tab, now);
    if (now - lastActiveAt >= thresholdMs) {
      result.toArchive.push(tab);
    }
  }
  return result;
}

export function planArchives(input: PlanArchivesInput): TabSummary[] {
  return planArchivesWithBreakdown(input).toArchive;
}

export function searchArchive(items: ArchivedTab[], query: string | undefined): ArchivedTab[] {
  const sorted = [...items].sort((a, b) => b.archivedAt - a.archivedAt);
  const trimmed = (query ?? "").trim().toLowerCase();
  if (!trimmed) return sorted;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const scored: Array<{ item: ArchivedTab; rank: number }> = [];

  for (const item of sorted) {
    const title = item.title.toLowerCase();
    const url = item.url.toLowerCase();
    const group = (item.groupTitle ?? "").toLowerCase();
    const haystack = `${title} ${url} ${group}`;

    if (!tokens.every((token) => haystack.includes(token))) continue;

    let rank = 0;
    if (title.includes(trimmed)) rank += 3;
    if (url.includes(trimmed)) rank += 2;
    if (group.includes(trimmed)) rank += 1;
    scored.push({ item, rank });
  }

  scored.sort((a, b) => b.rank - a.rank || b.item.archivedAt - a.item.archivedAt);
  return scored.map((entry) => entry.item);
}

export async function loadArchive(): Promise<ArchivedTab[]> {
  const result = await chrome.storage.local.get(ARCHIVE_STORAGE_KEY);
  const raw = result[ARCHIVE_STORAGE_KEY] as ArchivedTab[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export async function saveArchive(items: ArchivedTab[]): Promise<void> {
  await chrome.storage.local.set({ [ARCHIVE_STORAGE_KEY]: items });
}

export async function ensureBookmarkFolder(folderName: string): Promise<string> {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const otherBookmarks = root?.children?.find((node) => node.id === "2") ?? root?.children?.[1] ?? root?.children?.[0];
  const parentId = otherBookmarks?.id ?? "2";

  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((node) => !node.url && node.title === folderName);
  if (existing) return existing.id;

  const created = await chrome.bookmarks.create({ parentId, title: folderName });
  return created.id;
}

export async function archiveTabs(
  tabs: TabSummary[],
  activity: ActivityState,
  config: TabReaperConfig,
  now = Date.now(),
): Promise<number> {
  if (tabs.length === 0) return 0;

  const folderId = await ensureBookmarkFolder(config.bookmarkFolderName);
  const groupCache = new Map<number, { title?: string; color?: string }>();
  const archive = await loadArchive();
  let archivedCount = 0;

  try {
    for (const tab of tabs) {
      if (!isArchivableUrl(tab.url)) continue;

      const normalizedUrl = normalizeUrl(tab.url);
      const lastActiveAt = getTabLastActiveAt(activity, tab, now);

      let groupMeta: { title?: string; color?: string } = {};
      if (typeof tab.groupId === "number" && tab.groupId >= 0) {
        if (!groupCache.has(tab.groupId)) {
          try {
            const group = await chrome.tabGroups.get(tab.groupId);
            groupCache.set(tab.groupId, { title: group.title || undefined, color: group.color });
          } catch {
            groupCache.set(tab.groupId, {});
          }
        }
        groupMeta = groupCache.get(tab.groupId) ?? {};
      }

      const existingIdx = archive.findIndex((item) => item.normalizedUrl === normalizedUrl);
      let bookmarkId: string | undefined;

      try {
        if (existingIdx >= 0) {
          const existing = archive[existingIdx]!;
          bookmarkId = existing.bookmarkId;
          if (bookmarkId) {
            try {
              await chrome.bookmarks.update(bookmarkId, { title: tab.title || tab.url, url: tab.url });
            } catch {
              const bm = await chrome.bookmarks.create({ parentId: folderId, title: tab.title || tab.url, url: tab.url });
              bookmarkId = bm.id;
            }
          } else {
            const bm = await chrome.bookmarks.create({ parentId: folderId, title: tab.title || tab.url, url: tab.url });
            bookmarkId = bm.id;
          }

          archive[existingIdx] = {
            ...existing,
            url: tab.url,
            title: tab.title || tab.url,
            favIconUrl: tab.favIconUrl ?? existing.favIconUrl,
            groupTitle: groupMeta.title ?? existing.groupTitle,
            groupColor: groupMeta.color ?? existing.groupColor,
            lastActiveAt,
            archivedAt: now,
            bookmarkId,
          };
        } else {
          const bm = await chrome.bookmarks.create({
            parentId: folderId,
            title: tab.title || tab.url,
            url: tab.url,
          });
          bookmarkId = bm.id;

          archive.unshift({
            id: crypto.randomUUID(),
            url: tab.url,
            normalizedUrl,
            title: tab.title || tab.url,
            favIconUrl: tab.favIconUrl,
            groupTitle: groupMeta.title,
            groupColor: groupMeta.color,
            lastActiveAt,
            archivedAt: now,
            bookmarkId,
          });
        }
      } catch {
        // Never close a tab if creating/updating its bookmark failed; continue with the rest.
        continue;
      }

      try {
        await chrome.tabs.remove(tab.id);
        archivedCount++;
      } catch {
        // Tab may have been closed concurrently.
      }
    }
  } finally {
    if (archivedCount > 0) {
      await saveArchive(archive);
    }
  }

  return archivedCount;
}

export async function restoreArchivedTab(id: string): Promise<boolean> {
  const archive = await loadArchive();
  const idx = archive.findIndex((item) => item.id === id);
  if (idx < 0) return false;

  const entry = archive[idx]!;
  // Create the tab first so a failure never deletes the archived entry or bookmark.
  await chrome.tabs.create({ url: entry.url, active: true });

  archive.splice(idx, 1);
  await saveArchive(archive);

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Bookmark may have been removed manually.
    }
  }

  return true;
}

export async function deleteArchivedTab(id: string): Promise<boolean> {
  const archive = await loadArchive();
  const idx = archive.findIndex((item) => item.id === id);
  if (idx < 0) return false;

  const entry = archive[idx]!;
  archive.splice(idx, 1);
  await saveArchive(archive);

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Bookmark already gone.
    }
  }
  return true;
}

export async function removeArchivedByUrl(rawUrl: string): Promise<boolean> {
  const normalized = normalizeUrl(rawUrl);
  const archive = await loadArchive();
  const idx = archive.findIndex((item) => item.normalizedUrl === normalized);
  if (idx < 0) return false;

  const entry = archive[idx]!;
  archive.splice(idx, 1);
  await saveArchive(archive);

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Ignore if already removed.
    }
  }
  return true;
}

export async function handleBookmarkRemoved(bookmarkId: string): Promise<void> {
  const archive = await loadArchive();
  const filtered = archive.filter((item) => item.bookmarkId !== bookmarkId);
  if (filtered.length !== archive.length) {
    await saveArchive(filtered);
  }
}
