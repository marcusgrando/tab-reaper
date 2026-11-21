import { createAsyncQueue } from "../../shared/config.ts";
import type { DeviceIdentity, SyncFolderCandidate, SyncStatus } from "../../shared/types.ts";
import { hasNativeMessagingPermission, NATIVE_HOST_NAME } from "../memory.ts";

const DEVICE_IDENTITY_KEY = "tabReaper.deviceIdentity";
const FOLDER_SYNC_OPTED_IN_KEY = "tabReaper.folderSyncOptedIn";
const ACTIVE_SYNC_DIR_KEY = "tabReaper.activeSyncDir";
const LAST_SYNC_AT_KEY = "tabReaper.lastSyncAt";

const DEFAULT_DEVICE_NAME = "This Computer";

const SNAPSHOT_CHUNK_MAX_BYTES = 500 * 1024; // True UTF-8 byte cap per shard, well under 800 KB host limit.
export const UUID_PATTERN = "[0-9a-f-]{36}";
export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);

const textEncoder = new TextEncoder();

export function utf8ByteLength(str: string): number {
  return textEncoder.encode(str).byteLength;
}

export interface ShardOptions<T> {
  maxChunkBytes?: number;
  primaryOverheadBytes?: number;
  chunkOverheadBytes?: number;
  sizeOf?: (item: T) => number;
}

export function shardByBytes<T>(items: T[], options: ShardOptions<T> = {}): T[][] {
  if (items.length === 0) return [[]];
  const maxChunkBytes = options.maxChunkBytes ?? SNAPSHOT_CHUNK_MAX_BYTES;
  const chunkOverheadBytes = options.chunkOverheadBytes ?? 512;
  const primaryOverheadBytes = Math.max(chunkOverheadBytes, options.primaryOverheadBytes ?? chunkOverheadBytes);
  const sizeOf = options.sizeOf ?? ((item: T) => utf8ByteLength(JSON.stringify(item)) + 1);

  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = primaryOverheadBytes;

  for (const item of items) {
    const itemBytes = sizeOf(item);
    if (current.length > 0 && currentBytes + itemBytes > maxChunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = chunkOverheadBytes;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface DeviceMeta {
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  lastSeenAt: number;
}

interface StoredDeviceIdentity extends DeviceIdentity {
  deviceNameSource: "hostname" | "custom";
}

export interface NativeSyncFileEntry {
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

export type SyncReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "error" };

export type SyncListResult =
  | { ok: true; files: NativeSyncFileEntry[] }
  | { ok: false; files: [] };

export const enqueueSnapshotSync = createAsyncQueue();
export const enqueueConfigMutation = createAsyncQueue();

function sanitizeDeviceId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "device-local";
}

export async function getDirMapValue<T>(key: string, syncDir: string): Promise<T | undefined> {
  const res = await chrome.storage.local.get(key);
  const map = res[key] as Record<string, T> | undefined;
  return map && typeof map === "object" ? map[syncDir] : undefined;
}

export async function updateDirMapValue<T>(
  key: string,
  syncDir: string,
  updater: (current: T | undefined) => T | undefined,
): Promise<void> {
  const res = await chrome.storage.local.get(key);
  const raw = res[key] as Record<string, T> | undefined;
  const map: Record<string, T> = raw && typeof raw === "object" ? { ...raw } : {};
  const nextVal = updater(map[syncDir]);
  if (nextVal === undefined) {
    delete map[syncDir];
  } else {
    map[syncDir] = nextVal;
  }
  if (Object.keys(map).length === 0) {
    await chrome.storage.local.remove(key);
  } else {
    await chrome.storage.local.set({ [key]: map });
  }
}

export async function getPendingListForDir(key: string, syncDir: string): Promise<string[]> {
  const list = await getDirMapValue<string[]>(key, syncDir);
  return Array.isArray(list) ? list : [];
}

export async function updatePendingListForDir(
  key: string,
  syncDir: string,
  updater: (current: string[]) => string[],
): Promise<void> {
  await updateDirMapValue<string[]>(key, syncDir, (current) => {
    const deduped = [...new Set(updater(Array.isArray(current) ? current : []))];
    return deduped.length > 0 ? deduped : undefined;
  });
}

export async function sendNativeCommand(payload: Record<string, unknown>): Promise<NativeHostResponse | null> {
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
  const existing = stored[DEVICE_IDENTITY_KEY] as Partial<StoredDeviceIdentity> | undefined;
  const hostName = typeof fallbackHostname === "string" ? fallbackHostname.trim().slice(0, 64) : "";

  const deviceId = sanitizeDeviceId(existing?.deviceId ?? crypto.randomUUID());
  const customName = existing?.deviceNameSource === "custom" ? existing.deviceName : undefined;
  const deviceNameSource = customName ? "custom" : "hostname";
  const deviceName = customName || hostName || existing?.deviceName || DEFAULT_DEVICE_NAME;

  if (existing?.deviceId !== deviceId || existing.deviceName !== deviceName || existing.deviceNameSource !== deviceNameSource) {
    await chrome.storage.local.set({ [DEVICE_IDENTITY_KEY]: { deviceId, deviceName, deviceNameSource } });
  }
  return { deviceId, deviceName };
}

export async function setDeviceName(rawName: string): Promise<DeviceIdentity> {
  const current = await loadDeviceIdentity();
  const trimmed = rawName.trim().slice(0, 64);
  if (!trimmed) {
    return current;
  }
  const next: StoredDeviceIdentity = {
    deviceId: current.deviceId,
    deviceName: trimmed,
    deviceNameSource: "custom",
  };
  await chrome.storage.local.set({ [DEVICE_IDENTITY_KEY]: next });
  return { deviceId: next.deviceId, deviceName: next.deviceName };
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

async function getLastSyncAt(): Promise<number | null> {
  const res = await chrome.storage.local.get(LAST_SYNC_AT_KEY);
  const ts = res[LAST_SYNC_AT_KEY];
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

export async function setLastSyncAt(ts: number): Promise<void> {
  await chrome.storage.local.set({ [LAST_SYNC_AT_KEY]: ts });
}

function buildDisabledSyncStatus(
  identity: DeviceIdentity,
  lastSyncAt: number | null,
  overrides: Partial<SyncStatus> = {},
): SyncStatus {
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
    ...overrides,
  };
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const [identity, lastSyncAt] = await Promise.all([loadDeviceIdentity(), getLastSyncAt()]);
  const resp = await sendNativeCommand({ cmd: "sync_get_status", deviceId: identity.deviceId });

  if (!resp) {
    return buildDisabledSyncStatus(identity, lastSyncAt);
  }

  if (!resp.ok) {
    return buildDisabledSyncStatus(identity, lastSyncAt, {
      lastError: resp.error ?? null,
    });
  }

  const supportsDestination = resp.capabilities?.includes("expected_dir") === true;
  const refreshedIdentity = await loadDeviceIdentity(resp.hostname);

  return buildDisabledSyncStatus(refreshedIdentity, lastSyncAt, {
    hostConnected: true,
    hostOutdated: !supportsDestination,
    hostVersion: resp.version ?? null,
    enabled: Boolean(resp.enabled),
    syncDir: resp.syncDir ?? null,
    writable: Boolean(resp.writable),
    lastError: supportsDestination ? null : "Update the Local Companion to sync this folder.",
  });
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
      ...buildDisabledSyncStatus(identity, lastSyncAt, {
        hostConnected: Boolean(resp),
      }),
    };
  }

  if (resp.enabled && resp.syncDir) {
    await setFolderSyncOptedIn(true, resp.syncDir);
  } else {
    await setFolderSyncOptedIn(false, null);
  }

  const refreshed = await loadDeviceIdentity(resp.hostname);
  return {
    ok: true,
    ...buildDisabledSyncStatus(refreshed, lastSyncAt, {
      hostConnected: true,
      hostVersion: resp.version ?? null,
      enabled: Boolean(resp.enabled),
      syncDir: resp.syncDir ?? null,
      writable: Boolean(resp.writable),
    }),
  };
}

export async function getReadySyncDir(requireWrite = true): Promise<string | null> {
  const status = await getSyncStatus();
  if (status.hostConnected && !status.hostOutdated && status.enabled && (!requireWrite || status.writable) && status.syncDir) {
    return status.syncDir;
  }
  return null;
}

export async function syncWriteJson(syncDir: string, deviceId: string, relPath: string, data: unknown): Promise<boolean> {
  const content = JSON.stringify(data);
  const resp = await sendNativeCommand({ cmd: "sync_write", expectedDir: syncDir, deviceId, relPath, content });
  return Boolean(resp?.ok);
}

export async function syncReadJsonResult<T>(syncDir: string, deviceId: string, relPath: string): Promise<SyncReadResult<T>> {
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

export async function syncReadJson<T>(syncDir: string, deviceId: string, relPath: string): Promise<T | null> {
  const res = await syncReadJsonResult<T>(syncDir, deviceId, relPath);
  return res.status === "ok" ? res.value : null;
}

export async function syncListFilesResult(syncDir: string, deviceId: string, relPrefix: string): Promise<SyncListResult> {
  const maxDepth = relPrefix === "devices" ? 1 : 0;
  const resp = await sendNativeCommand({ cmd: "sync_list", expectedDir: syncDir, deviceId, relPrefix, maxDepth });
  if (!resp?.ok || !Array.isArray(resp.files)) {
    return { ok: false, files: [] };
  }
  return { ok: true, files: resp.files };
}

export async function syncDeleteFileConfirmed(syncDir: string, deviceId: string, relPath: string): Promise<boolean> {
  const resp = await sendNativeCommand({ cmd: "sync_delete", expectedDir: syncDir, deviceId, relPath });
  return Boolean(resp?.ok);
}

export async function writeDeviceMeta(syncDir: string, identity: DeviceIdentity, now: number): Promise<void> {
  const meta: DeviceMeta = {
    schemaVersion: 1,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    lastSeenAt: now,
  };
  await syncWriteJson(syncDir, identity.deviceId, `devices/${identity.deviceId}/meta.json`, meta);
}
