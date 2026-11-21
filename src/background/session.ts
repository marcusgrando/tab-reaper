import { normalizeUrl } from "../shared/config.ts";
import type { SessionSnapshot, SnapshotTab, TabSummary } from "../shared/types.ts";
import { isArchivableUrl } from "./archive.ts";
import { loadKeptTabIds, saveKeptTabIds } from "./tracker.ts";

export const SNAPSHOTS_STORAGE_KEY = "tabReaper.sessionSnapshots";
export const MAX_SNAPSHOTS = 5;
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_MAX_CURRENT_TABS = 2;
const RECOVERY_MIN_SNAPSHOT_TABS = 5;
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadSnapshots(): Promise<SessionSnapshot[]> {
  const result = await chrome.storage.local.get(SNAPSHOTS_STORAGE_KEY);
  const raw = result[SNAPSHOTS_STORAGE_KEY] as SessionSnapshot[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export async function saveSnapshots(snapshots: SessionSnapshot[]): Promise<void> {
  await chrome.storage.local.set({ [SNAPSHOTS_STORAGE_KEY]: snapshots.slice(0, MAX_SNAPSHOTS) });
}

function snapshotSignature(tabs: SnapshotTab[]): string {
  return tabs
    .map((t) => `${normalizeUrl(t.url)}|${t.pinned ? 1 : 0}|${t.kept ? 1 : 0}|${t.groupTitle ?? ""}`)
    .sort()
    .join("\n");
}

export async function buildSnapshotTabs(tabs: TabSummary[]): Promise<SnapshotTab[]> {
  const groupCache = new Map<number, { title?: string; color?: string }>();
  const out: SnapshotTab[] = [];

  for (const tab of tabs) {
    if (!isArchivableUrl(tab.url)) continue;

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

    out.push({
      url: tab.url,
      title: tab.title || tab.url,
      pinned: tab.pinned,
      kept: Boolean(tab.kept),
      windowId: tab.windowId,
      groupTitle: groupMeta.title,
      groupColor: groupMeta.color,
    });
  }

  return out;
}

export interface CaptureOptions {
  force?: boolean;
  now?: number;
}

/**
 * Captures a local session snapshot when enough time has elapsed and tabs changed.
 * Protects existing snapshots against being overwritten by a post-crash 1-2 tab session.
 */
export async function captureSessionSnapshot(
  tabs: TabSummary[],
  options: CaptureOptions = {},
): Promise<SessionSnapshot | null> {
  const now = options.now ?? Date.now();
  const force = Boolean(options.force);
  const snapshotTabs = await buildSnapshotTabs(tabs);
  if (snapshotTabs.length === 0) return null;

  const existing = await loadSnapshots();
  const latest = existing[0];

  if (!force && latest) {
    if (now - latest.capturedAt < SNAPSHOT_INTERVAL_MS) {
      return null;
    }
    // Never let a crashed/blank startup session push out a larger saved session automatically.
    if (snapshotTabs.length <= RECOVERY_MAX_CURRENT_TABS && latest.tabCount >= RECOVERY_MIN_SNAPSHOT_TABS) {
      return null;
    }
    if (snapshotSignature(snapshotTabs) === snapshotSignature(latest.tabs)) {
      return null;
    }
  }

  const snapshot: SessionSnapshot = {
    id: crypto.randomUUID(),
    capturedAt: now,
    tabCount: snapshotTabs.length,
    tabs: snapshotTabs,
  };

  await saveSnapshots([snapshot, ...existing].slice(0, MAX_SNAPSHOTS));
  return snapshot;
}

export function findRecoverableSnapshot(
  currentTabs: TabSummary[],
  snapshots: SessionSnapshot[],
  now = Date.now(),
): { id: string; capturedAt: number; tabCount: number } | null {
  const currentHttpCount = currentTabs.filter((t) => isArchivableUrl(t.url)).length;
  if (currentHttpCount > RECOVERY_MAX_CURRENT_TABS) return null;

  const candidate = snapshots.find(
    (s) => s.tabCount >= RECOVERY_MIN_SNAPSHOT_TABS && now - s.capturedAt <= RECOVERY_MAX_AGE_MS,
  );
  if (!candidate) return null;

  return {
    id: candidate.id,
    capturedAt: candidate.capturedAt,
    tabCount: candidate.tabCount,
  };
}

export interface RestoreResult {
  restored: number;
  skippedExisting: number;
}

export async function restoreSessionSnapshot(snapshotId: string): Promise<RestoreResult> {
  const snapshots = await loadSnapshots();
  const snapshot = snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) return { restored: 0, skippedExisting: 0 };

  const currentTabs = await chrome.tabs.query({});
  const openUrls = new Set<string>();
  for (const tab of currentTabs) {
    const url = tab.url ?? tab.pendingUrl;
    if (url && isArchivableUrl(url)) {
      openUrls.add(normalizeUrl(url));
    }
  }

  const keptIds = await loadKeptTabIds();
  let keptChanged = false;
  let restored = 0;
  let skippedExisting = 0;

  const groupBuckets = new Map<string, { title?: string; color?: string; tabIds: number[] }>();

  for (const item of snapshot.tabs) {
    if (!isArchivableUrl(item.url)) continue;
    const norm = normalizeUrl(item.url);
    if (openUrls.has(norm)) {
      skippedExisting++;
      continue;
    }

    try {
      const created = await chrome.tabs.create({
        url: item.url,
        active: false,
        pinned: item.pinned,
      });
      openUrls.add(norm);
      restored++;

      if (typeof created.id === "number") {
        if (item.kept) {
          keptIds.add(created.id);
          keptChanged = true;
        }
        if (item.groupTitle || item.groupColor) {
          const gKey = `${item.windowId}|${item.groupTitle ?? ""}|${item.groupColor ?? ""}`;
          let bucket = groupBuckets.get(gKey);
          if (!bucket) {
            bucket = { title: item.groupTitle, color: item.groupColor, tabIds: [] };
            groupBuckets.set(gKey, bucket);
          }
          bucket.tabIds.push(created.id);
        }
        if (!item.pinned && !item.kept) {
          try {
            await chrome.tabs.discard(created.id);
          } catch {
            // Some Chrome versions reject discarding a brand-new tab before initial navigation; next sweep handles it.
          }
        }
      }
    } catch {
      // Skip individual tab creation errors.
    }
  }

  if (keptChanged) {
    await saveKeptTabIds(keptIds);
  }

  for (const bucket of groupBuckets.values()) {
    if (bucket.tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: bucket.tabIds as [number, ...number[]] });
      const updateProps: chrome.tabGroups.UpdateProperties = {};
      if (bucket.title) updateProps.title = bucket.title;
      if (bucket.color) updateProps.color = bucket.color as chrome.tabGroups.UpdateProperties["color"];
      if (updateProps.title || updateProps.color) {
        await chrome.tabGroups.update(groupId, updateProps);
      }
    } catch {
      // Best-effort group restoration.
    }
  }

  return { restored, skippedExisting };
}
