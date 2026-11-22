import type {
  DeviceIdentity,
  SessionSnapshot,
  SnapshotListItem,
  SnapshotTab,
  SnapshotTrigger,
} from "../../shared/types.ts";
import {
  UUID_PATTERN,
  UUID_RE,
  enqueueSnapshotSync,
  getActiveSyncDir,
  getPendingListForDir,
  getReadySyncDir,
  loadDeviceIdentity,
  shardByBytes,
  syncDeleteFileConfirmed,
  syncListFilesResult,
  syncReadJson,
  syncReadJsonResult,
  syncWriteJson,
  updatePendingListForDir,
  writeDeviceMeta,
  type SyncReadResult,
} from "./client.ts";

const PENDING_SNAPSHOT_DELETES_BY_DIR_KEY = "tabReaper.pendingSnapshotDeletesByDir";
const PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY = "tabReaper.pendingSnapshotPrunesByDir";

export const GFS_RECENT_LIMIT = 20;
export const GFS_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GFS_DAILY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const INDEX_PART_NAME_RE = new RegExp(`^${UUID_PATTERN}-p[1-9]\\d*\\.json$`);

interface SyncedSnapshotEnvelope extends SessionSnapshot {
  partCount?: number;
}

interface SyncedSnapshotPart {
  schemaVersion: 2;
  snapshotId: string;
  partIndex: number;
  tabs: SnapshotTab[];
}

export interface SnapshotIndexEntry {
  id: string;
  complete: boolean;
  capturedAt: number;
  tabCount: number;
  windowCount: number;
  trigger: SnapshotTrigger;
  label?: string;
  relPath: string;
  partCount?: number;
}

interface SnapshotIndexPart {
  generation: string;
  partIndex: number;
  snapshots: SnapshotIndexEntry[];
}

interface DeviceSnapshotIndex {
  generation?: string;
  partCount?: number;
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  updatedAt: number;
  snapshots: SnapshotIndexEntry[];
}

function isOwnedSnapshotRelPath(deviceId: string, relPath: string): boolean {
  const prefix = `devices/${deviceId}/snapshots/`;
  if (!relPath.startsWith(prefix) || !relPath.endsWith(".json")) return false;
  const filename = relPath.slice(prefix.length);
  return (
    filename.length > 5 &&
    !filename.includes("/") &&
    !filename.startsWith(".") &&
    /^[a-zA-Z0-9._-]+$/.test(filename)
  );
}

function snapshotPartRelPath(primaryRelPath: string, partIndex: number): string {
  return `${primaryRelPath.slice(0, -".json".length)}_p${partIndex}.json`;
}

function buildSnapshotFilename(snapshot: SessionSnapshot): string {
  const iso = new Date(snapshot.capturedAt)
    .toISOString()
    .replace(/[:.]/g, "-");
  const shortId = snapshot.id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
  return `${iso}_${shortId}.json`;
}

export async function loadPendingSnapshotDeletes(syncDir?: string | null): Promise<string[]> {
  const dir = syncDir === undefined ? await getActiveSyncDir() : syncDir;
  if (!dir) return [];
  return getPendingListForDir(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY, dir);
}

async function addPendingSnapshotDelete(syncDir: string, id: string): Promise<void> {
  await updatePendingListForDir(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY, syncDir, (list) => [...list, id]);
}

async function setPendingSnapshotDeletesForDir(syncDir: string, ids: string[]): Promise<void> {
  await updatePendingListForDir(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY, syncDir, () => ids);
}

async function addPendingPrunePaths(syncDir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await updatePendingListForDir(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY, syncDir, (list) => [...list, ...paths]);
}

async function getPendingPrunePaths(syncDir: string): Promise<string[]> {
  return getPendingListForDir(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY, syncDir);
}

async function setPendingPrunePaths(syncDir: string, paths: string[]): Promise<void> {
  await updatePendingListForDir(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY, syncDir, () => paths);
}

type RetentionEntry = Pick<SessionSnapshot, "id" | "capturedAt" | "trigger" | "complete">;

export function pruneSnapshotsGfs<T extends RetentionEntry>(
  snapshots: T[],
  now = Date.now(),
): { keep: T[]; drop: T[] } {
  const sorted = [...snapshots].sort((a, b) => b.capturedAt - a.capturedAt);
  const keep: T[] = [];
  const drop: T[] = [];

  const newestWhole = sorted.find(s => s.complete);
  let recentAutoCount = 0;
  const seenHours = new Set<number>();
  const seenDays = new Set<number>();

  for (const snap of sorted) {
    if (snap.trigger === "manual") {
      keep.push(snap);
      continue;
    }

    if (recentAutoCount < GFS_RECENT_LIMIT) {
      keep.push(snap);
      recentAutoCount++;
      seenHours.add(Math.floor(snap.capturedAt / (60 * 60 * 1000)));
      seenDays.add(Math.floor(snap.capturedAt / (24 * 60 * 60 * 1000)));
      continue;
    }

    const age = now - snap.capturedAt;
    if (age <= GFS_HOURLY_WINDOW_MS) {
      const hourBucket = Math.floor(snap.capturedAt / (60 * 60 * 1000));
      if (!seenHours.has(hourBucket)) {
        seenHours.add(hourBucket);
        seenDays.add(Math.floor(snap.capturedAt / (24 * 60 * 60 * 1000)));
        keep.push(snap);
        continue;
      }
    } else if (age <= GFS_DAILY_WINDOW_MS) {
      const dayBucket = Math.floor(snap.capturedAt / (24 * 60 * 60 * 1000));
      if (!seenDays.has(dayBucket)) {
        seenDays.add(dayBucket);
        keep.push(snap);
        continue;
      }
    }

    if (snap === newestWhole) keep.push(snap);
    else drop.push(snap);
  }

  return { keep, drop };
}

async function readSnapshotIndex(
  syncDir: string,
  readerId: string,
  ownerId = readerId,
): Promise<SyncReadResult<DeviceSnapshotIndex>> {
  const base = `devices/${ownerId}`;
  const result = await syncReadJsonResult<DeviceSnapshotIndex>(syncDir, readerId, `${base}/index.json`);
  if (result.status !== "ok") return result;
  const index = result.value;
  if (index?.deviceId !== ownerId || !Array.isArray(index.snapshots)) return { status: "error" };
  if (index.generation === undefined && index.partCount === undefined) return result;
  const { generation, partCount } = index;
  if (
    typeof generation !== "string" ||
    !UUID_RE.test(generation) ||
    typeof partCount !== "number" ||
    !Number.isSafeInteger(partCount) ||
    partCount < 2
  ) {
    return { status: "error" };
  }

  const snapshots = [...index.snapshots];
  for (let i = 1; i < partCount; i++) {
    const path: string = `${base}/index-parts/${generation}-p${i}.json`;
    const part: SnapshotIndexPart | null = await syncReadJson<SnapshotIndexPart>(syncDir, readerId, path);
    if (!part || part.generation !== generation || part.partIndex !== i || !Array.isArray(part.snapshots)) {
      return { status: "error" };
    }
    snapshots.push(...part.snapshots);
  }
  return { status: "ok", value: { ...index, snapshots } };
}

async function cleanIndexParts(syncDir: string, deviceId: string, generation?: string): Promise<boolean> {
  const dir = `devices/${deviceId}/index-parts`;
  const listing = await syncListFilesResult(syncDir, deviceId, dir);
  if (!listing.ok) return false;
  for (const { relPath } of listing.files) {
    const name = relPath.slice(dir.length + 1);
    if (!relPath.startsWith(`${dir}/`) || !INDEX_PART_NAME_RE.test(name)) continue;
    if (generation && name.startsWith(`${generation}-p`)) continue;
    if (!(await syncDeleteFileConfirmed(syncDir, deviceId, relPath))) return false;
  }
  return true;
}

async function publishSnapshotIndex(syncDir: string, index: DeviceSnapshotIndex): Promise<boolean> {
  const { deviceId } = index;
  const base = `devices/${deviceId}`;
  const [first, ...overflow] = shardByBytes(index.snapshots);
  const generation = overflow.length ? crypto.randomUUID() : undefined;
  for (const [position, snapshots] of overflow.entries()) {
    const partIndex = position + 1;
    const path = `${base}/index-parts/${generation}-p${partIndex}.json`;
    if (!(await syncWriteJson(syncDir, deviceId, path, { generation, partIndex, snapshots }))) return false;
  }
  const manifest: DeviceSnapshotIndex = {
    ...index,
    snapshots: first!,
    generation,
    partCount: generation ? overflow.length + 1 : undefined,
  };
  if (!(await syncWriteJson(syncDir, deviceId, `${base}/index.json`, manifest))) return false;
  // The manifest is committed. Rotation still has to prune any expired bodies.
  if (!(await cleanIndexParts(syncDir, deviceId, generation))) {
    console.warn("Snapshot index cleanup will retry on the next sync");
  }
  return true;
}

function snapshotEntryPaths(entry: { relPath: string; partCount?: number }): string[] {
  const paths = [];
  for (let i = 1; i < (entry.partCount ?? 1); i++) paths.push(snapshotPartRelPath(entry.relPath, i));
  paths.push(entry.relPath);
  return paths;
}

async function deleteSnapshotPaths(syncDir: string, deviceId: string, paths: string[]): Promise<string[]> {
  const failed = [];
  for (const path of paths) {
    if (isOwnedSnapshotRelPath(deviceId, path) && !(await syncDeleteFileConfirmed(syncDir, deviceId, path))) {
      failed.push(path);
    }
  }
  return failed;
}

async function pruneUnpublishedPaths(syncDir: string, deviceId: string, entries: SnapshotIndexEntry[]): Promise<boolean> {
  const pending = await getPendingPrunePaths(syncDir);
  if (!pending.length) return true;
  // A host reply can be lost after the index was committed. Its files must survive a retry.
  const published = new Set(entries.flatMap(snapshotEntryPaths));
  const failed = await deleteSnapshotPaths(syncDir, deviceId, pending.filter((path) => !published.has(path)));
  await setPendingPrunePaths(syncDir, failed);
  return failed.length === 0;
}

async function pushSnapshotUnlocked(
  syncDir: string,
  identity: DeviceIdentity,
  snapshot: SessionSnapshot,
  now: number,
): Promise<boolean> {
  const indexRead = await readSnapshotIndex(syncDir, identity.deviceId);
  if (indexRead.status === "error") {
    return false;
  }

  const entries: SnapshotIndexEntry[] =
    indexRead.status === "ok" && Array.isArray(indexRead.value.snapshots) ? [...indexRead.value.snapshots] : [];

  const relPath = `devices/${identity.deviceId}/snapshots/${buildSnapshotFilename(snapshot)}`;
  const tabChunks = shardByBytes(snapshot.tabs);
  const partCount = tabChunks.length;
  const enriched: SyncedSnapshotEnvelope = {
    ...snapshot,
    schemaVersion: 2,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    tabs: tabChunks[0] ?? [],
    partCount: partCount > 1 ? partCount : undefined,
  };

  const nextEntry: SnapshotIndexEntry = {
    id: enriched.id,
    complete: enriched.complete,
    capturedAt: enriched.capturedAt,
    tabCount: enriched.tabCount,
    windowCount: enriched.windowCount ?? Math.max(1, new Set(snapshot.tabs.map((t) => t.windowId)).size),
    trigger: enriched.trigger ?? "auto",
    label: enriched.label,
    relPath,
    partCount: partCount > 1 ? partCount : undefined,
  };

  const deduped = [nextEntry, ...entries.filter((e) => e.id !== nextEntry.id)];
  const { keep, drop } = pruneSnapshotsGfs(deduped, now);

  const nextIndex: DeviceSnapshotIndex = {
    schemaVersion: 1,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    updatedAt: now,
    snapshots: keep,
  };

  // Either index can be live after an interruption. Keep cleanup candidates until the committed index identifies its files.
  await addPendingPrunePaths(syncDir, [...snapshotEntryPaths(nextEntry), ...drop.flatMap(snapshotEntryPaths)]);

  for (let i = 1; i < partCount; i++) {
    const part: SyncedSnapshotPart = {
      schemaVersion: 2,
      snapshotId: snapshot.id,
      partIndex: i,
      tabs: tabChunks[i]!,
    };
    const partOk = await syncWriteJson(syncDir, identity.deviceId, snapshotPartRelPath(relPath, i), part);
    if (!partOk) return false;
  }

  const written = await syncWriteJson(syncDir, identity.deviceId, relPath, enriched);
  if (!written) return false;

  if (!(await publishSnapshotIndex(syncDir, nextIndex))) return false;
  const pruned = await pruneUnpublishedPaths(syncDir, identity.deviceId, keep);
  await writeDeviceMeta(syncDir, identity, now);
  return pruned;
}

export async function pushSnapshotToSync(snapshot: SessionSnapshot, now = Date.now()): Promise<boolean> {
  return enqueueSnapshotSync(async () => {
    const syncDir = await getReadySyncDir();
    if (!syncDir) return false;
    const identity = await loadDeviceIdentity();
    return pushSnapshotUnlocked(syncDir, identity, snapshot, now);
  });
}

async function deleteSyncedSnapshotLocked(
  syncDir: string,
  identity: DeviceIdentity,
  id: string,
): Promise<"deleted" | "not_found" | "retry"> {
  const indexRead = await readSnapshotIndex(syncDir, identity.deviceId);
  if (indexRead.status === "error") return "retry";
  const entries = indexRead.status === "ok" ? indexRead.value.snapshots : [];
  const target = entries.find((s) => s.id === id);
  if (!target || indexRead.status !== "ok") {
    return (await pruneUnpublishedPaths(syncDir, identity.deviceId, entries)) ? "not_found" : "retry";
  }
  const idx = indexRead.value;
  if (!isOwnedSnapshotRelPath(identity.deviceId, target.relPath)) return "not_found";

  const failed = await deleteSnapshotPaths(syncDir, identity.deviceId, snapshotEntryPaths(target));
  if (failed.length > 0) return "retry";

  const remaining = idx.snapshots.filter((s) => s.id !== id);
  const indexWritten = await publishSnapshotIndex(syncDir, {
    ...idx,
    updatedAt: Date.now(),
    snapshots: remaining,
  });
  return indexWritten ? "deleted" : "retry";
}

export async function deleteSyncedSnapshot(id: string, folder?: string | null): Promise<boolean> {
  const targetDir = folder === undefined ? await getActiveSyncDir() : folder;
  if (!targetDir) return false;
  return enqueueSnapshotSync(async () => {
    if ((await getReadySyncDir()) !== targetDir) {
      await addPendingSnapshotDelete(targetDir, id);
      return false;
    }

    const identity = await loadDeviceIdentity();
    const outcome = await deleteSyncedSnapshotLocked(targetDir, identity, id);
    if (outcome === "retry") {
      await addPendingSnapshotDelete(targetDir, id);
      return false;
    }

    const pending = await loadPendingSnapshotDeletes(targetDir);
    if (pending.includes(id)) {
      await setPendingSnapshotDeletesForDir(
        targetDir,
        pending.filter((x) => x !== id),
      );
    }
    return outcome === "deleted";
  });
}

/**
 * Drains pending snapshot deletions and failed prunes for the CURRENT sync folder,
 * then re-reads fresh local snapshots inside the upload queue so a deleted snapshot
 * can never be re-uploaded.
 */
export async function syncPendingLocalSnapshots(
  loadLocalSnapshots: () => Promise<SessionSnapshot[]>,
  now = Date.now(),
): Promise<{ ok: boolean; uploaded: number; deleted: number }> {
  return enqueueSnapshotSync(async () => {
    const syncDir = await getReadySyncDir();
    if (!syncDir) return { ok: false, uploaded: 0, deleted: 0 };
    const identity = await loadDeviceIdentity();

    // 1. Drain pending snapshot deletions for THIS folder only (preserving other folders' pending queues).
    let deleted = 0;
    let deleteOk = true;
    const pendingDeletes = await loadPendingSnapshotDeletes(syncDir);
    if (pendingDeletes.length > 0) {
      const stillPending: string[] = [];
      for (const id of pendingDeletes) {
        const outcome = await deleteSyncedSnapshotLocked(syncDir, identity, id);
        if (outcome === "deleted") {
          deleted++;
        } else if (outcome === "retry") {
          stillPending.push(id);
          deleteOk = false;
        }
      }
      await setPendingSnapshotDeletesForDir(syncDir, stillPending);
    }

    const indexRead = await readSnapshotIndex(syncDir, identity.deviceId);
    if (indexRead.status === "error") {
      return { ok: false, uploaded: 0, deleted };
    }
    let pruneOk = await pruneUnpublishedPaths(
      syncDir,
      identity.deviceId,
      indexRead.status === "ok" ? indexRead.value.snapshots : [],
    );
    if (indexRead.status === "ok" && !(await cleanIndexParts(syncDir, identity.deviceId, indexRead.value.generation))) {
      pruneOk = false;
    }
    const presentInFolder = new Map(
      indexRead.status === "ok" && Array.isArray(indexRead.value.snapshots)
        ? indexRead.value.snapshots.map((s) => [s.id, s] as const)
        : [],
    );

    const freshLocal = await loadLocalSnapshots();
    const stillPendingDeleteSet = new Set(await loadPendingSnapshotDeletes(syncDir));
    const listedPaths = presentInFolder.size > 0 ? await listSnapshotPaths(syncDir, identity.deviceId) : null;

    let uploaded = 0;
    let uploadOk = true;
    const ordered = [...freshLocal].sort((a, b) => a.capturedAt - b.capturedAt);
    for (const snap of ordered) {
      if (stillPendingDeleteSet.has(snap.id)) continue;
      const indexed = presentInFolder.get(snap.id);
      if (indexed && (await isSnapshotPublished(syncDir, identity.deviceId, indexed, snap, listedPaths))) continue;
      // Re-verify membership right before writing so a concurrent deletion is never resurrected.
      const currentLocalIds = new Set((await loadLocalSnapshots()).map((s) => s.id));
      if (!currentLocalIds.has(snap.id)) continue;
      const ok = await pushSnapshotUnlocked(syncDir, identity, snap, now);
      if (ok) {
        uploaded++;
      } else {
        uploadOk = false;
      }
    }
    return { ok: deleteOk && pruneOk && uploadOk, uploaded, deleted };
  });
}

/** Non-empty snapshot files, or null when the listing exceeds Chrome's native message limit. */
async function listSnapshotPaths(syncDir: string, deviceId: string): Promise<Set<string> | null> {
  const listing = await syncListFilesResult(syncDir, deviceId, `devices/${deviceId}/snapshots`);
  if (!listing.ok) return null;
  return new Set(listing.files.filter(file => file.sizeBytes > 0).map(file => file.relPath));
}

function hasListedFiles(entry: SnapshotIndexEntry, paths: Set<string>): boolean {
  const count = entry.partCount ?? 1;
  return Number.isSafeInteger(count) && count >= 1 && count <= paths.size &&
    snapshotEntryPaths(entry).every(path => paths.has(path));
}

/**
 * Periodic sync runs every few minutes, so it trusts the listing instead of
 * reading every published snapshot back from a cloud folder. A missing or empty
 * part still triggers a re-upload.
 */
async function isSnapshotPublished(
  syncDir: string,
  deviceId: string,
  indexed: SnapshotIndexEntry,
  local: SessionSnapshot,
  listedPaths: Set<string> | null,
): Promise<boolean> {
  if (!listedPaths) return hasCompleteSnapshot(syncDir, deviceId, indexed, local);
  return isOwnedSnapshotRelPath(deviceId, indexed.relPath) && indexed.tabCount === local.tabs.length &&
    hasListedFiles(indexed, listedPaths);
}

async function hasCompleteSnapshot(
  syncDir: string,
  deviceId: string,
  indexed: SnapshotIndexEntry,
  local: SessionSnapshot,
): Promise<boolean> {
  if (!isOwnedSnapshotRelPath(deviceId, indexed.relPath)) return false;
  const saved = await readSnapshotFiles(syncDir, deviceId, indexed.relPath);
  return saved?.id === local.id && saved.tabs.length === local.tabs.length;
}

export async function loadPublishedSnapshotIds(manuals: SessionSnapshot[]): Promise<Set<string>> {
  const published = new Set<string>();
  const syncDir = await getReadySyncDir(false);
  if (!syncDir) return published;
  const { deviceId } = await loadDeviceIdentity();
  const index = await readSnapshotIndex(syncDir, deviceId);
  if (index.status !== "ok") return published;
  const entries = new Map(index.value.snapshots.map((entry) => [entry.id, entry]));
  for (const local of manuals) {
    const entry = entries.get(local.id);
    if (entry && (await hasCompleteSnapshot(syncDir, deviceId, entry, local))) published.add(local.id);
  }
  return published;
}

export async function listSyncedSnapshots(): Promise<SnapshotListItem[]> {
  const syncDir = await getReadySyncDir(false);
  if (!syncDir) return [];
  const [identity, pendingDeletes] = await Promise.all([loadDeviceIdentity(), loadPendingSnapshotDeletes(syncDir)]);
  const pendingSet = new Set(pendingDeletes);
  const listRes = await syncListFilesResult(syncDir, identity.deviceId, "devices");
  if (!listRes.ok) return [];

  const indexFiles = listRes.files.filter((f) => /^devices\/[^/]+\/index\.json$/.test(f.relPath));
  const results: SnapshotListItem[] = [];
  for (const file of indexFiles) {
    const owner = file.relPath.split("/")[1]!;
    const index = await readSnapshotIndex(syncDir, identity.deviceId, owner);
    if (index.status !== "ok") continue;
    const idx = index.value;
    for (const entry of idx.snapshots) {
      if (idx.deviceId === identity.deviceId && pendingSet.has(entry.id)) continue;
      results.push({
        id: entry.id,
        capturedAt: entry.capturedAt,
        tabCount: entry.tabCount,
        windowCount: entry.windowCount || 1,
        trigger: entry.trigger ?? "auto",
        label: entry.label,
        deviceId: idx.deviceId,
        deviceName: idx.deviceName,
        source: "sync",
        syncDir,
        relPath: entry.relPath,
      });
    }
  }

  results.sort((a, b) => b.capturedAt - a.capturedAt);
  return results;
}

export async function findDeviceSnapshotEntry(
  matches: (entry: SnapshotIndexEntry) => boolean,
): Promise<SnapshotIndexEntry | undefined> {
  const syncDir = await getReadySyncDir(false);
  if (!syncDir) return;
  const { deviceId } = await loadDeviceIdentity();
  const index = await readSnapshotIndex(syncDir, deviceId);
  if (index.status !== "ok") return;
  const pending = new Set(await loadPendingSnapshotDeletes(syncDir));
  const candidates = index.value.snapshots.filter(entry =>
    !pending.has(entry.id) && isOwnedSnapshotRelPath(deviceId, entry.relPath) && matches(entry)
  ).sort((a, b) => b.capturedAt - a.capturedAt);
  if (!candidates.length) return;

  // The index and the snapshot parts can arrive independently in a cloud folder.
  const paths = await listSnapshotPaths(syncDir, deviceId);
  if (paths) return candidates.find(entry => hasListedFiles(entry, paths));
  for (const entry of candidates) {
    const saved = await readSnapshotFiles(syncDir, deviceId, entry.relPath);
    if (saved?.id === entry.id && saved.tabCount === entry.tabCount) return entry;
  }
}

export async function readSyncedSnapshot(relPath: string): Promise<SessionSnapshot | null> {
  const syncDir = await getReadySyncDir(false);
  if (!syncDir) return null;
  const { deviceId } = await loadDeviceIdentity();
  return readSnapshotFiles(syncDir, deviceId, relPath);
}

async function readSnapshotFiles(syncDir: string, deviceId: string, relPath: string): Promise<SessionSnapshot | null> {
  const primary = await syncReadJson<SyncedSnapshotEnvelope>(syncDir, deviceId, relPath);
  if (!primary || !Array.isArray(primary.tabs)) return null;

  const partCount = typeof primary.partCount === "number" && primary.partCount > 1 ? primary.partCount : 1;
  if (partCount === 1) return primary.tabs.length === primary.tabCount ? primary : null;

  const allTabs = [...primary.tabs];
  for (let i = 1; i < partCount; i++) {
    const part = await syncReadJson<SyncedSnapshotPart>(syncDir, deviceId, snapshotPartRelPath(relPath, i));
    if (!part || part.snapshotId !== primary.id || part.partIndex !== i || !Array.isArray(part.tabs)) {
      return null;
    }
    allTabs.push(...part.tabs);
  }
  return allTabs.length === primary.tabCount ? { ...primary, tabs: allTabs } : null;
}
