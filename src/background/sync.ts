import { DEFAULT_CONFIG, normalizeUrl, sanitizeConfig } from "../shared/config.ts";
import type {
  ArchivedTab,
  DeviceIdentity,
  SessionSnapshot,
  SnapshotListItem,
  SnapshotTab,
  SnapshotTrigger,
  SyncFolderCandidate,
  SyncStatus,
  TabReaperConfig,
} from "../shared/types.ts";
import { hasNativeMessagingPermission, NATIVE_HOST_NAME } from "./memory.ts";

const DEVICE_IDENTITY_KEY = "tabReaper.deviceIdentity";
const CONFIG_VERSION_KEY = "tabReaper.configVersion";
const CONFIG_SYNCED_BY_DIR_KEY = "tabReaper.configSyncedByDir";
const ARCHIVE_TOMBSTONES_KEY = "tabReaper.archiveTombstones";
const ARCHIVE_SYNCED_REV_BY_DIR_KEY = "tabReaper.archiveSyncedRevByDir";
const ARCHIVE_REVISION_KEY = "tabReaper.archiveRevision";
const FOLDER_SYNC_OPTED_IN_KEY = "tabReaper.folderSyncOptedIn";
const ACTIVE_SYNC_DIR_KEY = "tabReaper.activeSyncDir";
const PENDING_SNAPSHOT_DELETES_BY_DIR_KEY = "tabReaper.pendingSnapshotDeletesByDir";
const PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY = "tabReaper.pendingSnapshotPrunesByDir";
const LAST_SYNC_AT_KEY = "tabReaper.lastSyncAt";

export const GFS_RECENT_LIMIT = 20;
export const GFS_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GFS_DAILY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ARCHIVE_CHUNK_MAX_BYTES = 500 * 1024; // True UTF-8 byte cap per shard, well under 800 KB host limit.

const textEncoder = new TextEncoder();

export function utf8ByteLength(str: string): number {
  return textEncoder.encode(str).byteLength;
}

export interface ConfigVersion {
  updatedAt: number;
  deviceId: string;
}

export interface SyncedConfigEnvelope {
  schemaVersion: 1;
  updatedAt: number;
  deviceId: string;
  config: TabReaperConfig;
}

export interface SyncedArchiveEnvelope {
  schemaVersion: 1;
  updatedAt: number;
  deviceId: string;
  items: ArchivedTab[];
  tombstones: Record<string, number>;
  partCount?: number;
  tombstonePartCount?: number;
  generation?: string;
}

interface SyncedArchivePart {
  schemaVersion: 1;
  updatedAt: number;
  deviceId: string;
  partIndex: number;
  items: ArchivedTab[];
}

interface SyncedTombstonePart {
  schemaVersion: 1;
  updatedAt: number;
  deviceId: string;
  partIndex: number;
  tombstones: Record<string, number>;
}

interface SyncedSnapshotEnvelope extends SessionSnapshot {
  partCount?: number;
}

interface SyncedSnapshotPart {
  schemaVersion: 2;
  snapshotId: string;
  partIndex: number;
  tabs: SnapshotTab[];
}

export interface DeviceMeta {
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  lastSeenAt: number;
}

export interface SnapshotIndexEntry {
  id: string;
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

interface NativeSyncFileEntry {
  relPath: string;
  sizeBytes: number;
  modifiedMs: number;
}

interface NativeHostResponse {
  ok: boolean;
  error?: string;
  version?: string;
  capabilities?: string[];
  enabled?: boolean;
  syncDir?: string | null;
  writable?: boolean;
  hostname?: string;
  candidates?: SyncFolderCandidate[];
  path?: string;
  cancelled?: boolean;
  exists?: boolean;
  content?: string;
  deleted?: boolean;
  files?: NativeSyncFileEntry[];
}

type SyncReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "error" };

type SyncListResult =
  | { ok: true; files: NativeSyncFileEntry[] }
  | { ok: false; files: [] };

let snapshotSyncQueue: Promise<unknown> = Promise.resolve();
let archiveMutationQueue: Promise<unknown> = Promise.resolve();
let archivePushQueue: Promise<unknown> = Promise.resolve();
let configMutationQueue: Promise<unknown> = Promise.resolve();

function enqueueSnapshotSync<T>(fn: () => Promise<T>): Promise<T> {
  const next = snapshotSyncQueue.then(fn, fn);
  snapshotSyncQueue = next.catch(() => {});
  return next;
}

export function enqueueArchiveMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = archiveMutationQueue.then(fn, fn);
  archiveMutationQueue = next.catch(() => {});
  return next;
}

function enqueueArchivePush<T>(fn: () => Promise<T>): Promise<T> {
  const next = archivePushQueue.then(fn, fn);
  archivePushQueue = next.catch(() => {});
  return next;
}

export function enqueueConfigMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = configMutationQueue.then(fn, fn);
  configMutationQueue = next.catch(() => {});
  return next;
}

function sanitizeDeviceId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "device-local";
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

function isValidHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function sendNativeCommand(payload: Record<string, unknown>): Promise<NativeHostResponse | null> {
  const allowed = await hasNativeMessagingPermission();
  if (!allowed || typeof chrome.runtime?.sendNativeMessage !== "function") {
    return null;
  }
  try {
    const resp = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload)) as NativeHostResponse;
    return resp ?? null;
  } catch {
    return null;
  }
}

export async function loadDeviceIdentity(fallbackHostname?: string): Promise<DeviceIdentity> {
  const stored = await chrome.storage.local.get(DEVICE_IDENTITY_KEY);
  const existing = stored[DEVICE_IDENTITY_KEY] as Partial<DeviceIdentity> | undefined;
  if (existing?.deviceId && existing?.deviceName) {
    return {
      deviceId: sanitizeDeviceId(existing.deviceId),
      deviceName: existing.deviceName,
    };
  }

  const deviceId = sanitizeDeviceId(existing?.deviceId ?? crypto.randomUUID());
  const deviceName = (existing?.deviceName || fallbackHostname || "This Computer").trim().slice(0, 64);
  const identity: DeviceIdentity = { deviceId, deviceName };
  await chrome.storage.local.set({ [DEVICE_IDENTITY_KEY]: identity });
  return identity;
}

export async function setDeviceName(rawName: string): Promise<DeviceIdentity> {
  const current = await loadDeviceIdentity();
  const trimmed = rawName.trim().slice(0, 64);
  const next: DeviceIdentity = {
    deviceId: current.deviceId,
    deviceName: trimmed || current.deviceName,
  };
  await chrome.storage.local.set({ [DEVICE_IDENTITY_KEY]: next });
  return next;
}

export async function isFolderSyncOptedIn(): Promise<boolean> {
  const res = await chrome.storage.local.get(FOLDER_SYNC_OPTED_IN_KEY);
  return Boolean(res[FOLDER_SYNC_OPTED_IN_KEY]);
}

async function setFolderSyncOptedIn(optedIn: boolean, syncDir: string | null): Promise<void> {
  await chrome.storage.local.set({
    [FOLDER_SYNC_OPTED_IN_KEY]: optedIn,
    [ACTIVE_SYNC_DIR_KEY]: syncDir,
  });
}

export async function getActiveSyncDir(): Promise<string | null> {
  const res = await chrome.storage.local.get(ACTIVE_SYNC_DIR_KEY);
  const dir = res[ACTIVE_SYNC_DIR_KEY];
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

export async function getLocalConfigVersion(): Promise<ConfigVersion> {
  const res = await chrome.storage.local.get(CONFIG_VERSION_KEY);
  const raw = res[CONFIG_VERSION_KEY] as Partial<ConfigVersion> | undefined;
  if (raw && typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && typeof raw.deviceId === "string") {
    return { updatedAt: raw.updatedAt, deviceId: raw.deviceId };
  }
  return { updatedAt: 0, deviceId: "" };
}

export async function setLocalConfigVersion(version: ConfigVersion): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_VERSION_KEY]: version });
}

async function getSyncedConfigVersionForDir(syncDir: string): Promise<ConfigVersion> {
  const res = await chrome.storage.local.get(CONFIG_SYNCED_BY_DIR_KEY);
  const map = (res[CONFIG_SYNCED_BY_DIR_KEY] as Record<string, ConfigVersion> | undefined) ?? {};
  const raw = map[syncDir];
  if (raw && typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && typeof raw.deviceId === "string") {
    return raw;
  }
  return { updatedAt: 0, deviceId: "" };
}

async function setSyncedConfigVersionForDir(syncDir: string, version: ConfigVersion): Promise<void> {
  const res = await chrome.storage.local.get(CONFIG_SYNCED_BY_DIR_KEY);
  const map = (res[CONFIG_SYNCED_BY_DIR_KEY] as Record<string, ConfigVersion> | undefined) ?? {};
  map[syncDir] = version;
  await chrome.storage.local.set({ [CONFIG_SYNCED_BY_DIR_KEY]: map });
}

export function compareConfigVersions(a: ConfigVersion, b: ConfigVersion): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return a.deviceId.localeCompare(b.deviceId);
}

export async function loadArchiveTombstones(): Promise<Record<string, number>> {
  const res = await chrome.storage.local.get(ARCHIVE_TOMBSTONES_KEY);
  const raw = (res[ARCHIVE_TOMBSTONES_KEY] as Record<string, number> | undefined) ?? {};
  const valid: Record<string, number> = {};
  for (const [url, ts] of Object.entries(raw)) {
    if (typeof ts === "number" && Number.isFinite(ts)) {
      valid[url] = ts;
    }
  }
  return valid;
}

export async function saveArchiveTombstones(tombstones: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ [ARCHIVE_TOMBSTONES_KEY]: tombstones });
}

export async function getArchiveRevision(): Promise<number> {
  const res = await chrome.storage.local.get(ARCHIVE_REVISION_KEY);
  const v = res[ARCHIVE_REVISION_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function bumpArchiveRevision(): Promise<number> {
  const next = (await getArchiveRevision()) + 1;
  await chrome.storage.local.set({ [ARCHIVE_REVISION_KEY]: next });
  return next;
}

async function getSyncedArchiveRevForDir(syncDir: string): Promise<number> {
  const res = await chrome.storage.local.get(ARCHIVE_SYNCED_REV_BY_DIR_KEY);
  const map = (res[ARCHIVE_SYNCED_REV_BY_DIR_KEY] as Record<string, number> | undefined) ?? {};
  const v = map[syncDir];
  return typeof v === "number" && Number.isFinite(v) ? v : -1;
}

async function setSyncedArchiveRevForDir(syncDir: string, rev: number): Promise<void> {
  await enqueueArchiveMutation(async () => {
    const res = await chrome.storage.local.get(ARCHIVE_SYNCED_REV_BY_DIR_KEY);
    const map = (res[ARCHIVE_SYNCED_REV_BY_DIR_KEY] as Record<string, number> | undefined) ?? {};
    if ((map[syncDir] ?? -1) < rev) {
      map[syncDir] = rev;
      await chrome.storage.local.set({ [ARCHIVE_SYNCED_REV_BY_DIR_KEY]: map });
    }
  });
}

async function loadPendingMap(key: string): Promise<Record<string, string[]>> {
  const res = await chrome.storage.local.get(key);
  const raw = res[key] as Record<string, string[]> | undefined;
  return raw && typeof raw === "object" ? { ...raw } : {};
}

async function savePendingMap(key: string, map: Record<string, string[]>): Promise<void> {
  const cleaned: Record<string, string[]> = {};
  for (const [dir, list] of Object.entries(map)) {
    const deduped = [...new Set(list)];
    if (deduped.length > 0) cleaned[dir] = deduped;
  }
  if (Object.keys(cleaned).length === 0) {
    await chrome.storage.local.remove(key);
  } else {
    await chrome.storage.local.set({ [key]: cleaned });
  }
}

export async function loadPendingSnapshotDeletes(syncDir?: string | null): Promise<string[]> {
  const dir = syncDir === undefined ? await getActiveSyncDir() : syncDir;
  if (!dir) return [];
  const map = await loadPendingMap(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY);
  return Array.isArray(map[dir]) ? map[dir]! : [];
}

async function addPendingSnapshotDelete(syncDir: string, id: string): Promise<void> {
  const map = await loadPendingMap(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY);
  map[syncDir] = [...(map[syncDir] ?? []), id];
  await savePendingMap(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY, map);
}

async function setPendingSnapshotDeletesForDir(syncDir: string, ids: string[]): Promise<void> {
  const map = await loadPendingMap(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY);
  map[syncDir] = ids;
  await savePendingMap(PENDING_SNAPSHOT_DELETES_BY_DIR_KEY, map);
}

async function addPendingPrunePaths(syncDir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const map = await loadPendingMap(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY);
  map[syncDir] = [...(map[syncDir] ?? []), ...paths];
  await savePendingMap(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY, map);
}

async function getPendingPrunePaths(syncDir: string): Promise<string[]> {
  const map = await loadPendingMap(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY);
  return Array.isArray(map[syncDir]) ? map[syncDir]! : [];
}

async function setPendingPrunePaths(syncDir: string, paths: string[]): Promise<void> {
  const map = await loadPendingMap(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY);
  map[syncDir] = paths;
  await savePendingMap(PENDING_SNAPSHOT_PRUNES_BY_DIR_KEY, map);
}

async function getLastSyncAt(): Promise<number | null> {
  const res = await chrome.storage.local.get(LAST_SYNC_AT_KEY);
  const ts = res[LAST_SYNC_AT_KEY];
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

export async function setLastSyncAt(ts: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_SYNC_AT_KEY]: ts });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const [identity, lastSyncAt] = await Promise.all([loadDeviceIdentity(), getLastSyncAt()]);
  const resp = await sendNativeCommand({ cmd: "sync_get_status", deviceId: identity.deviceId });

  if (!resp) {
    return {
      hostConnected: false,
      hostOutdated: false,
      hostVersion: null,
      enabled: false,
      syncDir: null,
      writable: false,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      lastSyncAt,
      lastError: null,
    };
  }

  if (!resp.ok) {
    const ping = await sendNativeCommand({ cmd: "ping", deviceId: identity.deviceId });
    if (ping?.ok && !ping.capabilities?.includes("folder_sync")) {
      return {
        hostConnected: true,
        hostOutdated: true,
        hostVersion: ping.version ?? null,
        enabled: false,
        syncDir: null,
        writable: false,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        lastSyncAt,
        lastError: `Connected host v${ping.version ?? "unknown"} does not support Folder Sync. Re-run the install command above to upgrade.`,
      };
    }

    return {
      hostConnected: false,
      hostOutdated: false,
      hostVersion: null,
      enabled: false,
      syncDir: null,
      writable: false,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      lastSyncAt,
      lastError: resp.error ?? null,
    };
  }

  const supportsDestination = resp.capabilities?.includes("expected_dir") === true;

  const refreshedIdentity = await loadDeviceIdentity(resp.hostname);
  return {
    hostConnected: true,
    hostOutdated: !supportsDestination,
    hostVersion: resp.version ?? null,
    enabled: Boolean(resp.enabled),
    syncDir: resp.syncDir ?? null,
    writable: Boolean(resp.writable),
    deviceId: refreshedIdentity.deviceId,
    deviceName: refreshedIdentity.deviceName,
    lastSyncAt,
    lastError: supportsDestination ? null : "Update the Local Companion to sync this folder.",
  };
}

export async function detectSyncFolders(): Promise<SyncFolderCandidate[]> {
  const resp = await sendNativeCommand({ cmd: "sync_detect_folders" });
  if (!resp?.ok || !Array.isArray(resp.candidates)) {
    return [];
  }
  return resp.candidates;
}

export async function pickSyncFolder(): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> {
  const resp = await sendNativeCommand({ cmd: "sync_pick_folder" });
  if (!resp) {
    return { ok: false, error: "Native host is not connected" };
  }
  return {
    ok: resp.ok,
    path: resp.path,
    cancelled: resp.cancelled,
    error: resp.error,
  };
}

export async function configureSyncFolder(path: string | null): Promise<SyncStatus & { ok: boolean; error?: string }> {
  const [identity, lastSyncAt] = await Promise.all([loadDeviceIdentity(), getLastSyncAt()]);
  const resp = await sendNativeCommand({ cmd: "sync_set_folder", deviceId: identity.deviceId, path });

  if (!resp || !resp.ok) {
    return {
      ok: false,
      error: resp?.error ?? "Native host is not connected",
      hostConnected: Boolean(resp),
      hostOutdated: false,
      hostVersion: null,
      enabled: false,
      syncDir: null,
      writable: false,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      lastSyncAt,
    };
  }

  // Serialize folder enable/disable with archive mutations so an in-flight pull
  // can never write tombstones back after Folder Sync is disabled.
  await enqueueArchiveMutation(async () => {
    if (resp.enabled && resp.syncDir) {
      await setFolderSyncOptedIn(true, resp.syncDir);
    } else {
      await setFolderSyncOptedIn(false, null);
      await chrome.storage.local.remove(ARCHIVE_TOMBSTONES_KEY);
    }
  });

  const refreshed = await loadDeviceIdentity(resp.hostname);
  return {
    ok: true,
    hostConnected: true,
    hostOutdated: false,
    hostVersion: resp.version ?? null,
    enabled: Boolean(resp.enabled),
    syncDir: resp.syncDir ?? null,
    writable: Boolean(resp.writable),
    deviceId: refreshed.deviceId,
    deviceName: refreshed.deviceName,
    lastSyncAt,
  };
}

async function getReadySyncDir(requireWrite = true): Promise<string | null> {
  const status = await getSyncStatus();
  if (status.hostConnected && !status.hostOutdated && status.enabled && (!requireWrite || status.writable) && status.syncDir) {
    return status.syncDir;
  }
  return null;
}

async function syncWriteJson(syncDir: string, deviceId: string, relPath: string, data: unknown): Promise<boolean> {
  const content = JSON.stringify(data);
  const resp = await sendNativeCommand({ cmd: "sync_write", expectedDir: syncDir, deviceId, relPath, content });
  return Boolean(resp?.ok);
}

async function syncReadJsonResult<T>(syncDir: string, deviceId: string, relPath: string): Promise<SyncReadResult<T>> {
  const resp = await sendNativeCommand({ cmd: "sync_read", expectedDir: syncDir, deviceId, relPath });
  if (!resp || !resp.ok) {
    return { status: "error" };
  }
  if (!resp.exists) {
    return { status: "missing" };
  }
  if (typeof resp.content !== "string") {
    return { status: "error" };
  }
  try {
    return { status: "ok", value: JSON.parse(resp.content) as T };
  } catch {
    return { status: "error" };
  }
}

async function syncReadJson<T>(syncDir: string, deviceId: string, relPath: string): Promise<T | null> {
  const res = await syncReadJsonResult<T>(syncDir, deviceId, relPath);
  return res.status === "ok" ? res.value : null;
}

async function syncListFilesResult(syncDir: string, deviceId: string, relPrefix: string): Promise<SyncListResult> {
  const maxDepth = relPrefix === "devices" ? 1 : 0;
  const resp = await sendNativeCommand({ cmd: "sync_list", expectedDir: syncDir, deviceId, relPrefix, maxDepth });
  if (!resp?.ok || !Array.isArray(resp.files)) {
    return { ok: false, files: [] };
  }
  return { ok: true, files: resp.files };
}

async function syncDeleteFileConfirmed(syncDir: string, deviceId: string, relPath: string): Promise<boolean> {
  const resp = await sendNativeCommand({ cmd: "sync_delete", expectedDir: syncDir, deviceId, relPath });
  return Boolean(resp?.ok);
}

export function pruneSnapshotsGfs<T extends { id: string; capturedAt: number; trigger?: SnapshotTrigger }>(
  snapshots: T[],
  now = Date.now(),
): { keep: T[]; drop: T[] } {
  const sorted = [...snapshots].sort((a, b) => b.capturedAt - a.capturedAt);
  const keep: T[] = [];
  const drop: T[] = [];

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

    drop.push(snap);
  }

  return { keep, drop };
}

export function resolveLatestConfig(envelopes: SyncedConfigEnvelope[]): SyncedConfigEnvelope | null {
  if (envelopes.length === 0) return null;
  const sorted = [...envelopes].sort((a, b) => compareConfigVersions(b, a));
  return sorted[0] ?? null;
}

function sanitizeRemoteArchivedTab(raw: unknown): ArchivedTab | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Partial<ArchivedTab>;
  if (!isValidHttpUrl(rec.url)) return null;
  if (typeof rec.archivedAt !== "number" || !Number.isFinite(rec.archivedAt)) return null;

  const normalizedUrl = normalizeUrl(rec.url);
  const title =
    typeof rec.title === "string" && rec.title.trim().length > 0 ? rec.title.slice(0, 256) : rec.url;
  const lastActiveAt =
    typeof rec.lastActiveAt === "number" && Number.isFinite(rec.lastActiveAt) ? rec.lastActiveAt : rec.archivedAt;
  const id = typeof rec.id === "string" && rec.id.trim().length > 0 ? rec.id.slice(0, 64) : crypto.randomUUID();
  const favIconUrl =
    typeof rec.favIconUrl === "string" && /^https?:\/\//i.test(rec.favIconUrl) && rec.favIconUrl.length <= 512
      ? rec.favIconUrl
      : undefined;

  return {
    id,
    url: rec.url,
    normalizedUrl,
    title,
    favIconUrl,
    groupTitle: typeof rec.groupTitle === "string" ? rec.groupTitle.slice(0, 64) : undefined,
    groupColor: typeof rec.groupColor === "string" ? rec.groupColor.slice(0, 32) : undefined,
    lastActiveAt,
    archivedAt: rec.archivedAt,
    bookmarkId: undefined,
  };
}

export function mergeSyncedArchives(
  localItems: ArchivedTab[],
  localTombstones: Record<string, number>,
  remoteEnvelopes: SyncedArchiveEnvelope[],
  now = Date.now(),
  allowTombstoneCompaction = true,
): { items: ArchivedTab[]; tombstones: Record<string, number>; changed: boolean; invalidItems: number } {
  let invalidItems = 0;
  const bestItemByUrl = new Map<string, ArchivedTab>();
  const bestTombstoneByUrl = new Map<string, number>();
  const remotePresentUrls = new Set<string>();

  const considerItem = (item: ArchivedTab) => {
    const norm = item.normalizedUrl || normalizeUrl(item.url);
    const existing = bestItemByUrl.get(norm);
    if (!existing || item.archivedAt > existing.archivedAt) {
      bestItemByUrl.set(norm, { ...item, normalizedUrl: norm });
    }
  };

  const considerTombstone = (url: string, ts: number) => {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return;
    const norm = normalizeUrl(url);
    const existing = bestTombstoneByUrl.get(norm);
    if (!existing || ts > existing) {
      bestTombstoneByUrl.set(norm, ts);
    }
  };

  for (const item of localItems) considerItem(item);
  for (const [url, ts] of Object.entries(localTombstones)) considerTombstone(url, ts);

  for (const env of remoteEnvelopes) {
    if (Array.isArray(env.items)) {
      for (const rawItem of env.items) {
        const sanitized = sanitizeRemoteArchivedTab(rawItem);
        if (!sanitized) {
          invalidItems++;
          continue;
        }
        remotePresentUrls.add(sanitized.normalizedUrl);
        considerItem(sanitized);
      }
    }
    if (env.tombstones && typeof env.tombstones === "object") {
      for (const [url, ts] of Object.entries(env.tombstones)) {
        considerTombstone(url, ts);
      }
    }
  }

  const localBookmarkByUrl = new Map<string, string>();
  for (const item of localItems) {
    if (item.bookmarkId) {
      localBookmarkByUrl.set(item.normalizedUrl || normalizeUrl(item.url), item.bookmarkId);
    }
  }

  const mergedItems: ArchivedTab[] = [];
  for (const [norm, item] of bestItemByUrl.entries()) {
    const deletedAt = bestTombstoneByUrl.get(norm) ?? 0;
    if (deletedAt > item.archivedAt) {
      continue;
    }
    mergedItems.push({
      ...item,
      bookmarkId: localBookmarkByUrl.get(norm) ?? item.bookmarkId,
    });
  }

  mergedItems.sort((a, b) => b.archivedAt - a.archivedAt);

  const mergedTombstones: Record<string, number> = {};
  for (const [norm, ts] of bestTombstoneByUrl.entries()) {
    if (allowTombstoneCompaction && !invalidItems && now - ts > TOMBSTONE_TTL_MS && !remotePresentUrls.has(norm)) {
      continue;
    }
    mergedTombstones[norm] = ts;
  }

  const prevSig = localItems
    .map((i) => `${i.normalizedUrl}:${i.archivedAt}`)
    .sort()
    .join("|");
  const nextSig = mergedItems
    .map((i) => `${i.normalizedUrl}:${i.archivedAt}`)
    .sort()
    .join("|");
  const changed = prevSig !== nextSig;

  return { items: mergedItems, tombstones: mergedTombstones, changed, invalidItems };
}

function buildSnapshotFilename(snapshot: SessionSnapshot): string {
  const iso = new Date(snapshot.capturedAt)
    .toISOString()
    .replace(/[:.]/g, "-");
  const shortId = snapshot.id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
  return `${iso}_${shortId}.json`;
}

function shardRecords<T>(records: T[], maxChunkBytes = ARCHIVE_CHUNK_MAX_BYTES): T[][] {
  if (records.length === 0) return [[]];
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 512;

  for (const record of records) {
    const recordBytes = utf8ByteLength(JSON.stringify(record)) + 1;
    if (current.length > 0 && currentBytes + recordBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 512;
    }
    current.push(record);
    currentBytes += recordBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
  if (typeof generation !== "string" || !/^[0-9a-f-]{36}$/.test(generation) ||
      typeof partCount !== "number" || !Number.isSafeInteger(partCount) || partCount < 2) return { status: "error" };

  const snapshots = [...index.snapshots];
  for (let i = 1; i < partCount; i++) {
    const path: string = `${base}/index-parts/${generation}-p${i}.json`;
    const part: SnapshotIndexPart | null = await syncReadJson<SnapshotIndexPart>(syncDir, readerId, path);
    if (!part || part.generation !== generation || part.partIndex !== i || !Array.isArray(part.snapshots)) return { status: "error" };
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
    if (!relPath.startsWith(`${dir}/`) || !/^[0-9a-f-]{36}-p[1-9]\d*\.json$/.test(name)) continue;
    if (generation && name.startsWith(`${generation}-p`)) continue;
    if (!(await syncDeleteFileConfirmed(syncDir, deviceId, relPath))) return false;
  }
  return true;
}

async function publishSnapshotIndex(syncDir: string, index: DeviceSnapshotIndex): Promise<boolean> {
  const { deviceId } = index;
  const base = `devices/${deviceId}`;
  const [first, ...overflow] = shardRecords(index.snapshots);
  const generation = overflow.length ? crypto.randomUUID() : undefined;
  for (const [position, snapshots] of overflow.entries()) {
    const partIndex = position + 1;
    const path = `${base}/index-parts/${generation}-p${partIndex}.json`;
    if (!(await syncWriteJson(syncDir, deviceId, path, { generation, partIndex, snapshots }))) return false;
  }
  const manifest: DeviceSnapshotIndex = {
    ...index, snapshots: first!, generation, partCount: generation ? overflow.length + 1 : undefined,
  };
  if (!(await syncWriteJson(syncDir, deviceId, `${base}/index.json`, manifest))) return false;
  // The manifest is committed. Rotation still has to prune any expired bodies.
  if (!(await cleanIndexParts(syncDir, deviceId, generation))) {
    console.warn("Snapshot index cleanup will retry on the next sync");
  }
  return true;
}

async function writeDeviceMeta(syncDir: string, identity: DeviceIdentity, now: number): Promise<void> {
  const meta: DeviceMeta = {
    schemaVersion: 1,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    lastSeenAt: now,
  };
  await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/meta.json`, meta);
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
  const failed = await deleteSnapshotPaths(syncDir, deviceId, pending.filter(path => !published.has(path)));
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
  const tabChunks = shardRecords(snapshot.tabs);
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
  const target = entries.find(s => s.id === id);
  if (!target || indexRead.status !== "ok") {
    return await pruneUnpublishedPaths(syncDir, identity.deviceId, entries) ? "not_found" : "retry";
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
    if (await getReadySyncDir() !== targetDir) {
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
    let pruneOk = await pruneUnpublishedPaths(syncDir, identity.deviceId, indexRead.status === "ok" ? indexRead.value.snapshots : []);
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

    let uploaded = 0;
    let uploadOk = true;
    const ordered = [...freshLocal].sort((a, b) => a.capturedAt - b.capturedAt);
    for (const snap of ordered) {
      // Re-verify membership right before writing so a concurrent deletion is never resurrected.
      const currentLocalIds = new Set((await loadLocalSnapshots()).map((s) => s.id));
      if (!currentLocalIds.has(snap.id)) continue;
      if (stillPendingDeleteSet.has(snap.id)) continue;
      const indexed = presentInFolder.get(snap.id);
      if (indexed && await hasCompleteSnapshot(syncDir, identity.deviceId, indexed, snap)) continue;
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

async function hasCompleteSnapshot(syncDir: string, deviceId: string, indexed: SnapshotIndexEntry, local: SessionSnapshot): Promise<boolean> {
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
  const entries = new Map(index.value.snapshots.map(entry => [entry.id, entry]));
  for (const local of manuals) {
    const entry = entries.get(local.id);
    if (entry && await hasCompleteSnapshot(syncDir, deviceId, entry, local)) published.add(local.id);
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

export async function listDeviceSnapshotEntries(): Promise<SnapshotIndexEntry[]> {
  const syncDir = await getReadySyncDir(false);
  if (!syncDir) return [];
  const { deviceId } = await loadDeviceIdentity();
  const index = await readSnapshotIndex(syncDir, deviceId);
  if (index.status !== "ok") return [];
  const pending = new Set(await loadPendingSnapshotDeletes(syncDir));
  return index.value.snapshots.filter(s => !pending.has(s.id) && isOwnedSnapshotRelPath(deviceId, s.relPath));
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

/**
 * Publishes the CURRENT local config & version inside configMutationQueue so a queued upload
 * can never publish stale settings or rewind localConfigVersion.
 */
export async function pushConfigToSync(
  loadLatestConfig: () => Promise<TabReaperConfig>,
  now = Date.now(),
): Promise<boolean> {
  return enqueueConfigMutation(async () => {
    const syncDir = await getReadySyncDir();
    if (!syncDir) return false;
    const [identity, config, currentVer] = await Promise.all([
      loadDeviceIdentity(),
      loadLatestConfig(),
      getLocalConfigVersion(),
    ]);
    const version: ConfigVersion =
      currentVer.updatedAt > 0
        ? currentVer
        : { updatedAt: now, deviceId: identity.deviceId };
    if (currentVer.updatedAt === 0) {
      await setLocalConfigVersion(version);
    }

    const envelope: SyncedConfigEnvelope = {
      schemaVersion: 1,
      updatedAt: version.updatedAt,
      deviceId: version.deviceId,
      config,
    };
    const ok = await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/config.json`, envelope);
    if (ok) {
      await setSyncedConfigVersionForDir(syncDir, version);
      await writeDeviceMeta(syncDir, identity, now);
    }
    return ok;
  });
}

export async function pullConfigFromSync(
  loadCurrentConfig: () => Promise<TabReaperConfig>,
  applyConfig: (cfg: TabReaperConfig) => Promise<void>,
): Promise<{ ok: boolean; updated: boolean }> {
  const syncDir = await getReadySyncDir();
  if (!syncDir) return { ok: false, updated: false };
  const identity = await loadDeviceIdentity();
  const listRes = await syncListFilesResult(syncDir, identity.deviceId, "devices");
  if (!listRes.ok) return { ok: false, updated: false };

  const configFiles = listRes.files.filter((f) => /^devices\/[^/]+\/config\.json$/.test(f.relPath));
  const remoteEnvelopes: SyncedConfigEnvelope[] = [];
  let allReadsOk = true;

  for (const file of configFiles) {
    const readRes = await syncReadJsonResult<SyncedConfigEnvelope>(syncDir, identity.deviceId, file.relPath);
    if (readRes.status === "error") {
      allReadsOk = false;
      continue;
    }
    if (
      readRes.status === "ok" &&
      typeof readRes.value.updatedAt === "number" &&
      typeof readRes.value.deviceId === "string" &&
      readRes.value.config
    ) {
      remoteEnvelopes.push({
        ...readRes.value,
        config: sanitizeConfig(readRes.value.config),
      });
    }
  }

  return enqueueConfigMutation(async () => {
    if (await getActiveSyncDir() !== syncDir) return { ok: false, updated: false };
    const [currentConfig, localVersion, syncedVersionForDir] = await Promise.all([
      loadCurrentConfig(),
      getLocalConfigVersion(),
      getSyncedConfigVersionForDir(syncDir),
    ]);
    // Legacy profiles have no edit timestamp. Rank their customized settings above
    // untouched defaults while allowing timestamped edits to retain precedence.
    if (!localVersion.updatedAt && JSON.stringify(sanitizeConfig(currentConfig)) !== JSON.stringify(sanitizeConfig(DEFAULT_CONFIG))) {
      localVersion.updatedAt = 1;
      localVersion.deviceId = identity.deviceId;
      await setLocalConfigVersion(localVersion);
    }
    const localEffectiveVersion: ConfigVersion = {
      updatedAt: localVersion.updatedAt,
      deviceId: localVersion.deviceId || identity.deviceId,
    };

    const winner = resolveLatestConfig([
      {
        schemaVersion: 1,
        updatedAt: localEffectiveVersion.updatedAt,
        deviceId: localEffectiveVersion.deviceId,
        config: currentConfig,
      },
      ...remoteEnvelopes,
    ]);

    if (winner && compareConfigVersions(winner, localEffectiveVersion) > 0) {
      await applyConfig(winner.config);
      const winVer: ConfigVersion = { updatedAt: winner.updatedAt, deviceId: winner.deviceId };
      await setLocalConfigVersion(winVer);
      const published = await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/config.json`, {
        schemaVersion: 1,
        updatedAt: winVer.updatedAt,
        deviceId: winVer.deviceId,
        config: winner.config,
      });
      if (published) {
        await setSyncedConfigVersionForDir(syncDir, winVer);
      }
      return { ok: allReadsOk && published, updated: true };
    }

    // Never publish an unedited default config while any remote read failed (prevents clobbering existing settings).
    if (!allReadsOk && localVersion.updatedAt === 0) {
      return { ok: false, updated: false };
    }

    const hasOwnFile = configFiles.some((f) => f.relPath === `devices/${identity.deviceId}/config.json`);
    const hasUnpublishedForDir = compareConfigVersions(localEffectiveVersion, syncedVersionForDir) > 0;
    if (!hasOwnFile || hasUnpublishedForDir) {
      // Preserve updatedAt: 0 for unedited defaults so they never outrank real edited settings on other devices.
      const ver: ConfigVersion = {
        updatedAt: localVersion.updatedAt,
        deviceId: localEffectiveVersion.deviceId,
      };
      const published = await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/config.json`, {
        schemaVersion: 1,
        updatedAt: ver.updatedAt,
        deviceId: ver.deviceId,
        config: currentConfig,
      });
      if (published) {
        await setSyncedConfigVersionForDir(syncDir, ver);
        await writeDeviceMeta(syncDir, identity, Date.now());
      }
      return { ok: allReadsOk && published, updated: false };
    }

    return { ok: allReadsOk, updated: false };
  });
}

function shardTombstones(
  tombstones: Record<string, number>,
  maxChunkBytes = ARCHIVE_CHUNK_MAX_BYTES,
): Array<Record<string, number>> {
  const entries = Object.entries(tombstones);
  if (entries.length === 0) return [{}];
  const chunks: Array<Record<string, number>> = [];
  let current: Record<string, number> = {};
  let currentBytes = 256;

  for (const [url, ts] of entries) {
    const entryBytes = utf8ByteLength(JSON.stringify(url)) + 20;
    if (Object.keys(current).length > 0 && currentBytes + entryBytes > maxChunkBytes) {
      chunks.push(current);
      current = {};
      currentBytes = 256;
    }
    current[url] = ts;
    currentBytes += entryBytes;
  }
  if (Object.keys(current).length > 0) chunks.push(current);
  return chunks;
}

function shardArchiveItems(
  items: ArchivedTab[],
  primaryOverheadBytes: number,
  maxChunkBytes = ARCHIVE_CHUNK_MAX_BYTES,
): ArchivedTab[][] {
  const stripped = items.map(({ bookmarkId: _bm, ...rest }) => rest);
  if (stripped.length === 0) return [[]];

  const chunks: ArchivedTab[][] = [];
  let current: ArchivedTab[] = [];
  let currentBytes = Math.max(256, primaryOverheadBytes);

  for (const item of stripped) {
    const itemBytes = utf8ByteLength(JSON.stringify(item)) + 1;
    if (current.length > 0 && currentBytes + itemBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 256;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function pushArchiveToSync(
  loadLatestItems: () => Promise<ArchivedTab[]>,
  now = Date.now(),
  expectedDir?: string,
): Promise<boolean> {
  return enqueueArchivePush(async () => {
    const syncDir = expectedDir ?? await getReadySyncDir();
    if (!syncDir) return false;

    const [identity, snapshot] = await Promise.all([
      loadDeviceIdentity(),
      enqueueArchiveMutation(async () => {
        const [items, tombstones, rev] = await Promise.all([
          loadLatestItems(),
          loadArchiveTombstones(),
          getArchiveRevision(),
        ]);
        return { items, tombstones, rev };
      }),
    ]);

    // Size both tombstones and items in true UTF-8 bytes so the complete primary envelope always fits.
    const tombstoneChunks = shardTombstones(snapshot.tombstones, Math.floor(ARCHIVE_CHUNK_MAX_BYTES / 2));
    const primaryTombstones = tombstoneChunks[0] ?? {};
    const primaryTombstoneBytes = utf8ByteLength(JSON.stringify(primaryTombstones)) + 512;
    const itemChunks = shardArchiveItems(snapshot.items, primaryTombstoneBytes, ARCHIVE_CHUNK_MAX_BYTES);

    const partCount = itemChunks.length;
    const tombstonePartCount = tombstoneChunks.length;

    const generation = crypto.randomUUID();
    const partPrefix = `devices/${identity.deviceId}/archive-${generation}`;
    // Write overflow item shards (p1..N-1) and tombstone shards (t1..M-1) BEFORE updating primary archive.json.
    for (let i = 1; i < partCount; i++) {
      const part: SyncedArchivePart = {
        schemaVersion: 1,
        updatedAt: now,
        deviceId: identity.deviceId,
        partIndex: i,
        items: itemChunks[i]!,
      };
      const ok = await syncWriteJson(syncDir, identity.deviceId, `${partPrefix}-p${i}.json`, part);
      if (!ok) return false;
    }

    for (let i = 1; i < tombstonePartCount; i++) {
      const tpart: SyncedTombstonePart = {
        schemaVersion: 1,
        updatedAt: now,
        deviceId: identity.deviceId,
        partIndex: i,
        tombstones: tombstoneChunks[i]!,
      };
      const ok = await syncWriteJson(syncDir, identity.deviceId, `${partPrefix}-t${i}.json`, tpart);
      if (!ok) return false;
    }

    const primary: SyncedArchiveEnvelope = {
      schemaVersion: 1,
      updatedAt: now,
      deviceId: identity.deviceId,
      items: itemChunks[0] ?? [],
      tombstones: primaryTombstones,
      partCount,
      generation,
      tombstonePartCount: tombstonePartCount > 1 ? tombstonePartCount : undefined,
    };
    const primaryOk = await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/archive.json`, primary);
    if (!primaryOk) return false;

    const listRes = await syncListFilesResult(syncDir, identity.deviceId, `devices/${identity.deviceId}`);
    if (!listRes.ok) return false;
    for (const { relPath } of listRes.files) {
      const name = relPath.slice(`devices/${identity.deviceId}/`.length);
      if (!/^archive-(?:[0-9a-f-]{36}-)?[pt]\d+\.json$/.test(name)) continue;
      if (relPath.startsWith(`${partPrefix}-`)) continue;
      if (!(await syncDeleteFileConfirmed(syncDir, identity.deviceId, relPath))) return false;
    }

    await setSyncedArchiveRevForDir(syncDir, snapshot.rev);
    await writeDeviceMeta(syncDir, identity, now);
    return true;
  });
}

export interface ArchiveSyncHooks {
  loadLocal: () => Promise<ArchivedTab[]>;
  saveMergedLocal: (items: ArchivedTab[], previousItems: ArchivedTab[]) => Promise<ArchivedTab[]>;
}

export async function pullAndMergeArchive(
  hooks: ArchiveSyncHooks,
  now = Date.now(),
): Promise<{ ok: boolean; changed: boolean; count: number }> {
  const syncDir = await getReadySyncDir();
  if (!syncDir) {
    const local = await hooks.loadLocal();
    return { ok: false, changed: false, count: local.length };
  }

  const identity = await loadDeviceIdentity();
  const listRes = await syncListFilesResult(syncDir, identity.deviceId, "devices");
  if (!listRes.ok) {
    const local = await hooks.loadLocal();
    return { ok: false, changed: false, count: local.length };
  }

  const archiveFiles = listRes.files.filter((f) => /^devices\/[^/]+\/archive\.json$/.test(f.relPath));
  const remotes: SyncedArchiveEnvelope[] = [];
  let remoteScanComplete = true;

  for (const file of archiveFiles) {
    const own = file.relPath === `devices/${identity.deviceId}/archive.json`;
    const readRes = await syncReadJsonResult<SyncedArchiveEnvelope>(syncDir, identity.deviceId, file.relPath);
    if (readRes.status === "error") {
      remoteScanComplete = false;
      continue;
    }
    if (readRes.status === "missing" || !Array.isArray(readRes.value.items)) {
      remoteScanComplete = false;
      continue;
    }
    let allPartsPresent = true;

    const env = readRes.value;
    const allItems = [...env.items];
    const allTombstones: Record<string, number> = { ...(env.tombstones ?? {}) };
    const partCount = typeof env.partCount === "number" && env.partCount > 1 ? env.partCount : 1;
    const tombstonePartCount =
      typeof env.tombstonePartCount === "number" && env.tombstonePartCount > 1 ? env.tombstonePartCount : 1;
    if (env.generation !== undefined && (typeof env.generation !== "string" || !/^[0-9a-f-]{36}$/.test(env.generation))) {
      remoteScanComplete = false;
      continue;
    }
    const prefix = file.relPath.slice(0, -".json".length) + (env.generation ? `-${env.generation}` : "");

    for (let i = 1; !own && i < partCount; i++) {
      const partRes = await syncReadJsonResult<SyncedArchivePart>(syncDir, identity.deviceId, `${prefix}-p${i}.json`);
      // Require EVERY declared part to be present, valid, and from the exact same archive version.
      if (partRes.status !== "ok" || partRes.value.updatedAt !== env.updatedAt || !Array.isArray(partRes.value.items)) {
        allPartsPresent = false;
        break;
      }
      allItems.push(...partRes.value.items);
    }

    for (let i = 1; i < tombstonePartCount; i++) {
      const tRes = await syncReadJsonResult<SyncedTombstonePart>(syncDir, identity.deviceId, `${prefix}-t${i}.json`);
      if (tRes.status !== "ok" || tRes.value.updatedAt !== env.updatedAt || !tRes.value.tombstones) {
        allPartsPresent = false;
        break;
      }
      Object.assign(allTombstones, tRes.value.tombstones);
    }

    if (allPartsPresent) remotes.push({ ...env, items: own ? [] : allItems, tombstones: allTombstones });
    else remoteScanComplete = false;
  }

  if (!remoteScanComplete) {
    return { ok: false, changed: false, count: (await hooks.loadLocal()).length };
  }

  let changed = false;
  let needsPush = false;
  let finalCount = 0;
  let abortedDueToDisable = false;

  await enqueueArchiveMutation(async () => {
    // Re-check that Folder Sync is still opted in and pointing at the same destination
    // so an in-flight pull can never write tombstones after disable or folder switch.
    const [stillOptedIn, currentDir] = await Promise.all([isFolderSyncOptedIn(), getActiveSyncDir()]);
    if (!stillOptedIn || currentDir !== syncDir) {
      abortedDueToDisable = true;
      return;
    }

    const [localItems, localTombstones, currentRev, syncedRevForDir] = await Promise.all([
      hooks.loadLocal(),
      loadArchiveTombstones(),
      getArchiveRevision(),
      getSyncedArchiveRevForDir(syncDir),
    ]);

    const merged = mergeSyncedArchives(localItems, localTombstones, remotes, now, remoteScanComplete);
    if (merged.invalidItems) remoteScanComplete = false;
    changed = merged.changed;
    needsPush = changed || currentRev > syncedRevForDir;

    let finalItems = merged.items;
    if (merged.changed) {
      finalItems = await hooks.saveMergedLocal(merged.items, localItems);
      await bumpArchiveRevision();
    }
    finalCount = finalItems.length;
    await saveArchiveTombstones(merged.tombstones);
  });

  if (abortedDueToDisable) {
    const local = await hooks.loadLocal();
    return { ok: false, changed: false, count: local.length };
  }

  const hasOwnFile = archiveFiles.some((f) => f.relPath === `devices/${identity.deviceId}/archive.json`);
  let pushOk = true;
  if (needsPush || !hasOwnFile) {
    pushOk = await pushArchiveToSync(hooks.loadLocal, now, syncDir);
  }

  return { ok: remoteScanComplete && pushOk, changed, count: finalCount };
}
