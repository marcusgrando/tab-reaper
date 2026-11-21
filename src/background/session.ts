import { normalizeUrl } from "../shared/config.ts";
import type { SessionSnapshot, SnapshotTab, TabSummary } from "../shared/types.ts";
import { isArchivableUrl } from "./archive.ts";
import { loadActivityState, loadKeptTabIds, recordTabVisit, saveActivityState, saveKeptTabIds } from "./tracker.ts";

export const SNAPSHOTS_STORAGE_KEY = "tabReaper.sessionSnapshots";
export const MAX_SNAPSHOTS = 5;
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_SNAPSHOT_URL_LEN = 4096;
export const MAX_SNAPSHOT_TITLE_LEN = 256;
export const MAX_SNAPSHOTS_TOTAL_BYTES = 1_000_000; // 1 MB cap, well under chrome.storage.local 10 MB quota
const RECOVERY_MAX_CURRENT_TABS = 2;
const RECOVERY_MIN_SNAPSHOT_TABS = 5;
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let restoreInFlight = false;

export function isRestoreInFlight(): boolean {
  return restoreInFlight;
}

export async function loadSnapshots(): Promise<SessionSnapshot[]> {
  const result = await chrome.storage.local.get(SNAPSHOTS_STORAGE_KEY);
  const raw = result[SNAPSHOTS_STORAGE_KEY] as SessionSnapshot[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export async function clearSnapshots(): Promise<void> {
  await chrome.storage.local.remove(SNAPSHOTS_STORAGE_KEY);
}

function trimSnapshotsToBudget(snapshots: SessionSnapshot[]): SessionSnapshot[] {
  const kept: SessionSnapshot[] = [];
  let totalBytes = 2; // "[]"
  for (const snap of snapshots.slice(0, MAX_SNAPSHOTS)) {
    const size = JSON.stringify(snap).length + 1;
    if (kept.length > 0 && totalBytes + size > MAX_SNAPSHOTS_TOTAL_BYTES) {
      break;
    }
    if (kept.length === 0 && size > MAX_SNAPSHOTS_TOTAL_BYTES) {
      // Single snapshot still too large; trim its tab list to fit budget.
      const trimmedTabs: SnapshotTab[] = [];
      let running = 128;
      for (const tab of snap.tabs) {
        const tabSize = JSON.stringify(tab).length + 1;
        if (running + tabSize > MAX_SNAPSHOTS_TOTAL_BYTES) break;
        trimmedTabs.push(tab);
        running += tabSize;
      }
      if (trimmedTabs.length > 0) {
        kept.push({ ...snap, tabCount: trimmedTabs.length, tabs: trimmedTabs });
      }
      break;
    }
    kept.push(snap);
    totalBytes += size;
  }
  return kept;
}

export async function saveSnapshots(snapshots: SessionSnapshot[]): Promise<void> {
  let bounded = trimSnapshotsToBudget(snapshots);
  while (bounded.length > 0) {
    try {
      await chrome.storage.local.set({ [SNAPSHOTS_STORAGE_KEY]: bounded });
      return;
    } catch {
      // Drop oldest snapshot on QuotaExceededError so settings/archive storage stays healthy.
      bounded = bounded.slice(0, -1);
    }
  }
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
    // Skip pathological mega-URLs (e.g., 2 MB hash-state URLs) to protect storage quota.
    if (tab.url.length > MAX_SNAPSHOT_URL_LEN) continue;

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

    const rawTitle = tab.title || tab.url;
    out.push({
      url: tab.url,
      title: rawTitle.length > MAX_SNAPSHOT_TITLE_LEN ? rawTitle.slice(0, MAX_SNAPSHOT_TITLE_LEN) : rawTitle,
      pinned: tab.pinned,
      kept: Boolean(tab.kept),
      windowId: tab.windowId,
      groupTitle: groupMeta.title?.slice(0, 64),
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
 * Protects existing snapshots against being overwritten by a post-crash 1-2 tab session
 * or mid-restore partial state.
 */
export async function captureSessionSnapshot(
  tabs: TabSummary[],
  options: CaptureOptions = {},
): Promise<SessionSnapshot | null> {
  if (restoreInFlight) return null;

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

  await saveSnapshots([snapshot, ...existing]);
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
  if (restoreInFlight) return { restored: 0, skippedExisting: 0 };
  restoreInFlight = true;

  try {
    const snapshots = await loadSnapshots();
    const snapshot = snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) return { restored: 0, skippedExisting: 0 };

    const currentTabs = await chrome.tabs.query({});
    const openUrls = new Set<string>();
    for (const tab of currentTabs) {
      if (tab.incognito) continue;
      const url = tab.url ?? tab.pendingUrl;
      if (url && isArchivableUrl(url)) {
        openUrls.add(normalizeUrl(url));
      }
    }

    const newlyKeptIds: number[] = [];
    const createdRecords: Array<{ id: number; url: string }> = [];
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
          createdRecords.push({ id: created.id, url: item.url });
          if (item.kept) {
            newlyKeptIds.push(created.id);
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

    // Merge restored kept IDs and fresh activity timestamps BEFORE releasing restoreInFlight
    // so subsequent sweeps never discard kept tabs or auto-archive restored tabs via stale byUrl entries.
    if (newlyKeptIds.length > 0) {
      const keptIds = await loadKeptTabIds();
      for (const id of newlyKeptIds) keptIds.add(id);
      await saveKeptTabIds(keptIds);
    }

    if (createdRecords.length > 0) {
      const now = Date.now();
      let activity = await loadActivityState();
      for (const rec of createdRecords) {
        activity = recordTabVisit(activity, rec.id, rec.url, now);
      }
      await saveActivityState(activity);
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
  } finally {
    restoreInFlight = false;
  }
}
