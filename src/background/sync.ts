export {
  configureSyncFolder,
  detectSyncFolders,
  enqueueConfigMutation,
  getActiveSyncDir,
  getSyncStatus,
  isFolderSyncOptedIn,
  loadDeviceIdentity,
  pickSyncFolder,
  setDeviceName,
  setLastSyncAt,
  utf8ByteLength,
  type DeviceMeta,
} from "./sync/client.ts";

export {
  GFS_DAILY_WINDOW_MS,
  GFS_HOURLY_WINDOW_MS,
  GFS_RECENT_LIMIT,
  deleteSyncedSnapshot,
  findDeviceSnapshotEntry,
  listSyncedSnapshots,
  loadPendingSnapshotDeletes,
  loadPublishedSnapshotIds,
  pruneSnapshotsGfs,
  pushSnapshotToSync,
  readSyncedSnapshot,
  syncPendingLocalSnapshots,
  type SnapshotIndexEntry,
} from "./sync/snapshots.ts";

export {
  getLocalConfigVersion,
  pullConfigFromSync,
  resolveLatestConfig,
  setLocalConfigVersion,
  type SyncedConfigEnvelope,
} from "./sync/config.ts";
