import { loadConfig, normalizeUrl } from "../shared/config.ts";
import type { ActivityState, ArchivedTab, TabReaperConfig, TabSummary, TabWeightSample } from "../shared/types.ts";
import { isTabProtected } from "./eviction.ts";
import {
  bumpArchiveRevision,
  enqueueArchiveMutation,
  isFolderSyncOptedIn,
  loadArchiveTombstones,
  pullAndMergeArchive,
  saveArchiveTombstones,
} from "./sync.ts";
import { checkTabHasUnsavedForm } from "./sampler.ts";
import { getTabLastActiveAt, loadKeptTabIds, toTabSummary } from "./tracker.ts";

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
    const title = (item.title ?? "").toLowerCase();
    const url = (item.url ?? "").toLowerCase();
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

export async function syncArchive(now = Date.now()) {
  const { bookmarkFolderName } = await loadConfig();
  return pullAndMergeArchive({
    loadLocal: loadArchive,
    saveMergedLocal: (items, previous) => saveMergedArchiveWithBookmarks(items, previous, bookmarkFolderName),
  }, now);
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

async function canStillArchive(tab: TabSummary, config: TabReaperConfig): Promise<boolean> {
  try {
    if (!tab.discarded && config.protectUnsavedForms && await checkTabHasUnsavedForm(tab.id)) return false;
    const kept = await loadKeptTabIds();
    const raw = await chrome.tabs.get(tab.id);
    const live = toTabSummary(raw, kept);
    if (!live || live.url !== tab.url || raw.pendingUrl && raw.pendingUrl !== tab.url) return false;
    if (tab.discarded && !live.discarded || isTabProtected(live, config)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function archiveTabs(
  tabs: TabSummary[],
  activity: ActivityState,
  config: TabReaperConfig,
  now = Date.now(),
): Promise<number> {
  if (tabs.length === 0) return 0;

  let archivedCount = 0;
  let finalArchive: ArchivedTab[] | null = null;

  await enqueueArchiveMutation(async () => {
    const folderId = await ensureBookmarkFolder(config.bookmarkFolderName);
    const groupCache = new Map<number, { title?: string; color?: string }>();
    const archive = await loadArchive();
    const tombstones = await loadArchiveTombstones();
    let changed = false;

    try {
      for (const tab of tabs) {
        if (!isArchivableUrl(tab.url) || !(await canStillArchive(tab, config))) continue;

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
        const archivedAt = Math.max(now, (archive[existingIdx]?.archivedAt ?? 0) + 1, (tombstones[normalizedUrl] ?? 0) + 1);
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
              archivedAt,
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
              archivedAt,
              bookmarkId,
            });
          }
        } catch {
          // Never close a tab if creating/updating its bookmark failed; continue with the rest.
          continue;
        }

        changed = true;
        try {
          if (!(await canStillArchive(tab, config))) continue;
          await chrome.tabs.remove(tab.id);
          archivedCount++;
        } catch {
          // Tab may have been closed concurrently.
        }
      }
    } finally {
      if (changed) {
        await saveArchive(archive);
        await bumpArchiveRevision();
        finalArchive = archive;
      }
    }
  });

  if (finalArchive) {
    void syncArchive(now).catch(() => {});
  }

  return archivedCount;
}

async function commitArchiveDeletionLocked(
  archive: ArchivedTab[],
  removedItems: ArchivedTab[],
  now = Date.now(),
): Promise<void> {
  await saveArchive(archive);
  await bumpArchiveRevision();
  // Only persist deletion tombstones for profiles that opted into Folder Sync.
  if (await isFolderSyncOptedIn()) {
    const tombstones = await loadArchiveTombstones();
    for (const item of removedItems) {
      const url = normalizeUrl(item.url);
      tombstones[url] = Math.max(now, item.archivedAt + 1, (tombstones[url] ?? 0) + 1);
    }
    await saveArchiveTombstones(tombstones);
  }
}

export async function restoreArchivedTab(id: string): Promise<boolean> {
  let removedEntry: ArchivedTab | null = null;
  let updatedArchive: ArchivedTab[] | null = null;

  await enqueueArchiveMutation(async () => {
    const archive = await loadArchive();
    const idx = archive.findIndex((item) => item.id === id);
    if (idx < 0) return;

    const entry = archive[idx]!;
    // Create the tab first so a failure never deletes the archived entry or bookmark.
    await chrome.tabs.create({ url: entry.url, active: true });

    archive.splice(idx, 1);
    await commitArchiveDeletionLocked(archive, [entry]);
    removedEntry = entry;
    updatedArchive = archive;
  });

  if (!removedEntry) return false;
  const entry = removedEntry as ArchivedTab;

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Bookmark may have been removed manually.
    }
  }
  if (updatedArchive) {
    void syncArchive().catch(() => {});
  }
  return true;
}

export async function deleteArchivedTab(id: string): Promise<boolean> {
  let removedEntry: ArchivedTab | null = null;
  let updatedArchive: ArchivedTab[] | null = null;

  await enqueueArchiveMutation(async () => {
    const archive = await loadArchive();
    const idx = archive.findIndex((item) => item.id === id);
    if (idx < 0) return;

    const entry = archive[idx]!;
    archive.splice(idx, 1);
    await commitArchiveDeletionLocked(archive, [entry]);
    removedEntry = entry;
    updatedArchive = archive;
  });

  if (!removedEntry) return false;
  const entry = removedEntry as ArchivedTab;

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Bookmark already gone.
    }
  }
  if (updatedArchive) {
    void syncArchive().catch(() => {});
  }
  return true;
}

export async function removeArchivedByUrl(rawUrl: string): Promise<boolean> {
  const normalized = normalizeUrl(rawUrl);
  let removedEntry: ArchivedTab | null = null;
  let updatedArchive: ArchivedTab[] | null = null;

  await enqueueArchiveMutation(async () => {
    const archive = await loadArchive();
    const idx = archive.findIndex((item) => item.normalizedUrl === normalized);
    if (idx < 0) return;

    const entry = archive[idx]!;
    archive.splice(idx, 1);
    await commitArchiveDeletionLocked(archive, [entry]);
    removedEntry = entry;
    updatedArchive = archive;
  });

  if (!removedEntry) return false;
  const entry = removedEntry as ArchivedTab;

  if (entry.bookmarkId) {
    try {
      await chrome.bookmarks.remove(entry.bookmarkId);
    } catch {
      // Ignore if already removed.
    }
  }
  if (updatedArchive) {
    void syncArchive().catch(() => {});
  }
  return true;
}

export async function handleBookmarkRemoved(bookmarkId: string): Promise<void> {
  let updatedArchive: ArchivedTab[] | null = null;

  await enqueueArchiveMutation(async () => {
    const archive = await loadArchive();
    const removed = archive.filter((item) => item.bookmarkId === bookmarkId);
    if (removed.length === 0) return;
    const filtered = archive.filter((item) => item.bookmarkId !== bookmarkId);
    await commitArchiveDeletionLocked(filtered, removed);
    updatedArchive = filtered;
  });

  if (updatedArchive) {
    void syncArchive().catch(() => {});
  }
}

/**
 * Reconciles Chrome bookmarks after a cross-device archive merge:
 * reuses matching bookmarks already synced via Chrome Sync, creates missing ones,
 * and deletes bookmarks for remote removals.
 */
export async function saveMergedArchiveWithBookmarks(
  mergedItems: ArchivedTab[],
  previousItems: ArchivedTab[],
  bookmarkFolderName: string,
): Promise<ArchivedTab[]> {
  const reconciled = mergedItems.map((item) => ({ ...item }));

  if (typeof chrome.bookmarks?.create === "function") {
    try {
      const mergedUrls = new Set(reconciled.map((i) => i.normalizedUrl));
      for (const prev of previousItems) {
        if (prev.bookmarkId && !mergedUrls.has(prev.normalizedUrl)) {
          try {
            await chrome.bookmarks.remove(prev.bookmarkId);
          } catch {
            // Bookmark may already be absent.
          }
        }
      }

      const needsBookmark = reconciled.some((item) => !item.bookmarkId);
      if (needsBookmark) {
        const folderId = await ensureBookmarkFolder(bookmarkFolderName);
        const existingChildren = await chrome.bookmarks.getChildren(folderId).catch(() => []);
        const existingByUrl = new Map<string, string>();
        for (const child of existingChildren) {
          if (child.url) {
            existingByUrl.set(normalizeUrl(child.url), child.id);
          }
        }

        for (const item of reconciled) {
          if (item.bookmarkId) continue;
          const reusedId = existingByUrl.get(item.normalizedUrl);
          if (reusedId) {
            item.bookmarkId = reusedId;
            continue;
          }
          try {
            const bm = await chrome.bookmarks.create({
              parentId: folderId,
              title: item.title || item.url,
              url: item.url,
            });
            item.bookmarkId = bm.id;
            existingByUrl.set(item.normalizedUrl, bm.id);
          } catch {
            // Keep synced item even if bookmark creation fails.
          }
        }
      }
    } catch {
      // Best-effort bookmark reconciliation.
    }
  }

  await saveArchive(reconciled);
  return reconciled;
}
