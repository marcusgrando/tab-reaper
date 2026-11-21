export type MemoryBudgetMode = "fraction" | "fixed_gb";

export interface TabReaperConfig {
  memoryBudgetMode: MemoryBudgetMode;
  /** Fraction of total system RAM when memoryBudgetMode === "fraction" (0.1 to 0.9, default 0.5). */
  memoryBudgetFraction: number;
  /** Explicit Chrome RAM cap in GiB when memoryBudgetMode === "fixed_gb". */
  memoryBudgetGb: number;
  /** Maximum number of eligible loaded tabs kept in RAM (default 10). */
  maxActiveTabs: number;
  /** Idle minutes before a loaded eligible tab is discarded (0 disables time-based discard). */
  discardAfterMinutes: number;
  /** Idle hours before an eligible tab is closed and auto-bookmarked (0 disables auto-archive). */
  archiveAfterHours: number;
  /** Discard non-protected background tabs immediately on Chrome startup. */
  startupSweep: boolean;
  protectActive: boolean;
  protectAudible: boolean;
  protectPinned: boolean;
  protectUnsavedForms: boolean;
  skipWhenOffline: boolean;
  enableSessionSnapshots: boolean;
  bookmarkFolderName: string;
  /** Domain or glob patterns excluded from discard and archive. */
  allowlist: string[];
}

export interface TabActivityRecord {
  url: string;
  lastActiveAt: number;
}

export interface ActivityState {
  byTabId: Record<string, TabActivityRecord>;
  byUrl: Record<string, number>;
  /** Last known active tabId per windowId, so leaving a tab stamps its idle clock at deactivation. */
  activeByWindow?: Record<string, number>;
}

export interface TabWeightSample {
  jsHeapBytes: number;
  domNodes: number;
  mediaNodes: number;
  weightMultiplier: number;
  hasUnsavedForm?: boolean;
  sampledAt: number;
}

export type MemorySource = "native_host" | "system_memory";

export interface MemorySnapshot {
  source: MemorySource;
  /** Measured Chrome RAM (native_host) or OS used RAM (system_memory). */
  usedBytes: number;
  budgetBytes: number;
  systemTotalBytes: number;
  systemAvailableBytes: number;
  processCount?: number;
  metric?: string;
  overBudget: boolean;
  checkedAt: number;
}

export interface ArchivedTab {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string;
  favIconUrl?: string;
  groupTitle?: string;
  groupColor?: string;
  lastActiveAt: number;
  archivedAt: number;
  bookmarkId?: string;
}

export interface TabSummary {
  id: number;
  url: string;
  title: string;
  active: boolean;
  audible: boolean;
  pinned: boolean;
  discarded: boolean;
  kept?: boolean;
  status?: string;
  windowId: number;
  index?: number;
  groupId?: number;
  favIconUrl?: string;
}

export interface OpenTabInfo {
  id: number;
  url: string;
  title: string;
  discarded: boolean;
  kept: boolean;
  idleMinutes: number;
  protectedReason: string | null;
  weightMultiplier: number;
  jsHeapBytes: number | null;
  hasUnsavedForm: boolean;
  isPwa: boolean;
  canKeep: boolean;
  canSleep: boolean;
  canArchive: boolean;
  canClose: boolean;
}

export interface EvictionCandidate {
  tab: TabSummary;
  idleMinutes: number;
  weightMultiplier: number;
  score: number;
  reason: "over_tab_cap" | "over_memory_budget" | "idle_timeout";
}

export type SnapshotTrigger = "auto" | "manual" | "pre_restore" | "window_closed";
export type RestoreMode = "windows" | "current_window";

export interface SnapshotWindow {
  id: number;
  focused: boolean;
  state?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface SnapshotTab {
  url: string;
  title: string;
  pinned: boolean;
  kept: boolean;
  windowId: number;
  index?: number;
  active?: boolean;
  discarded?: boolean;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
  groupCollapsed?: boolean;
  lastActiveAt?: number;
  favIconUrl?: string;
}

export interface SessionSnapshot {
  id: string;
  schemaVersion?: number;
  capturedAt: number;
  tabCount: number;
  windowCount?: number;
  trigger?: SnapshotTrigger;
  label?: string;
  deviceId?: string;
  deviceName?: string;
  windows?: SnapshotWindow[];
  tabs: SnapshotTab[];
}

export interface SnapshotListItem {
  id: string;
  capturedAt: number;
  tabCount: number;
  windowCount: number;
  trigger: SnapshotTrigger;
  label?: string;
  deviceId?: string;
  deviceName?: string;
  source: "local" | "sync";
  syncDir?: string | null;
  relPath?: string;
}

export interface SyncFolderCandidate {
  provider: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface SyncStatus {
  hostConnected: boolean;
  hostOutdated?: boolean;
  hostVersion?: string | null;
  enabled: boolean;
  syncDir: string | null;
  writable: boolean;
  deviceId: string;
  deviceName: string;
  lastSyncAt: number | null;
  lastError?: string | null;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

export interface StatusPayload {
  config: TabReaperConfig;
  memory: MemorySnapshot | null;
  online: boolean;
  loadedCount: number;
  discardedCount: number;
  protectedCount: number;
  archivedCount: number;
  openTabs: OpenTabInfo[];
  recoverableSnapshot: { id: string; capturedAt: number; tabCount: number; windowCount?: number; relPath?: string } | null;
  permissions: {
    nativeMessaging: boolean;
    hostAccess: boolean;
  };
}

export type BackgroundMessage =
  | { type: "get_status" }
  | { type: "get_archive"; query?: string }
  | { type: "restore_archived"; id: string }
  | { type: "delete_archived"; id: string }
  | { type: "discard_tab"; tabId: number }
  | { type: "toggle_keep_tab"; tabId: number }
  | { type: "archive_tab"; tabId: number }
  | { type: "close_tab"; tabId: number }
  | { type: "discard_idle_now" }
  | { type: "archive_old_now" }
  | { type: "get_snapshots" }
  | { type: "capture_snapshot_now"; label?: string }
  | { type: "clear_snapshots" }
  | { type: "delete_snapshot"; id: string; syncDir?: string | null }
  | { type: "restore_snapshot"; id: string; targetWindowId?: number; mode?: RestoreMode; relPath?: string }
  | { type: "save_config"; config: Partial<TabReaperConfig> }
  | { type: "test_native_host" }
  | { type: "get_sync_status" }
  | { type: "detect_sync_folders" }
  | { type: "pick_sync_folder" }
  | { type: "set_sync_folder"; path: string | null }
  | { type: "set_device_name"; deviceName: string }
  | { type: "sync_now" };
