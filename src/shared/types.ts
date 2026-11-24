export type MemoryBudgetMode = "fraction" | "fixed_gb";

export interface TabCurbConfig {
  memoryBudgetMode: MemoryBudgetMode;
  /** Fraction of total system RAM when memoryBudgetMode === "fraction" (0.1 to 0.9, default 0.5). */
  memoryBudgetFraction: number;
  /** Explicit Chrome RAM cap in GiB when memoryBudgetMode === "fixed_gb". */
  memoryBudgetGb: number;
  /** Budget percentage at which idle-tab eviction starts (10 to 100, default 80). */
  idleEvictionPercent: number;
  /** Budget percentage at which size-based eviction starts (10 to 100, default 100, >= idleEvictionPercent). */
  sizeEvictionPercent: number;
  /** Discard non-protected background tabs immediately on Chrome startup. */
  startupSweep: boolean;
  /** Rank heaviest tabs first at the size threshold using page access. Kept per device. */
  weightedEviction: boolean;
  protectActive: boolean;
  protectAudible: boolean;
  protectPinned: boolean;
  protectUnsavedForms: boolean;
  /** Opt-in webRequest heuristic that pauses sleeping while a tab has an active upload. Off by default. */
  protectActiveUploads: boolean;
  skipWhenOffline: boolean;
  /** Automatic session snapshots (active only when Folder Sync is configured). */
  enableSessionSnapshots: boolean;
  /** Interval in minutes between automatic session snapshots (1 to 1440, default 5). */
  snapshotIntervalMinutes: number;
  /** Domain or glob patterns excluded from discard. */
  allowlist: string[];
  /** Check GitHub Releases daily for a newer TabCurb version. */
  checkForUpdates: boolean;
}

export interface UpdateAvailableInfo {
  latestVersion: string;
  currentVersion: string;
  releaseUrl: string;
}

export interface UpdateCheckStatus {
  checkedAt: number | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  dismissed: boolean;
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

export type TabMemorySource = "process" | "js_heap";

export interface TabWeightSample {
  jsHeapBytes: number;
  domNodes: number;
  mediaNodes: number;
  weightMultiplier: number;
  /** Live-only (never cached): attributed OS renderer memory in bytes from Local Companion. */
  processMemoryBytes?: number;
  /** Live-only (never cached): OS renderer memory not pinned alive by a protected peer tab. */
  reclaimableProcessBytes?: number;
  /** Live-only (never cached): number of tabs sharing this tab's main-frame renderer process. */
  sharedProcessTabs?: number;
  /** Live-only (never cached): total OS memory of the tab's main-frame renderer process before splitting. */
  sharedProcessTotalBytes?: number;
  /** Live-only (never cached): another protected tab shares this tab's main-frame renderer process. */
  pinnedByProtectedPeer?: boolean;
  hasUnsavedForm?: boolean;
  /** Live-only (never cached): top frame reports visibilityState === "visible". */
  isVisible?: boolean;
  /** Live-only (never cached): a frame has an active video or document Picture-in-Picture window. */
  hasPictureInPicture?: boolean;
  sampledAt: number;
}

export type MemorySource = "native_host" | "system_memory";
export type MemoryPressure = "normal" | "moderate" | "critical";

export interface MemorySnapshot {
  source: MemorySource;
  /** Measured Chrome RAM (native_host) or OS used RAM (system_memory). */
  usedBytes: number;
  budgetBytes: number;
  systemTotalBytes: number;
  systemAvailableBytes: number;
  processCount?: number;
  metric?: string;
  /** Per-renderer OS memory in bytes keyed by Chromium --renderer-client-id (matches webNavigation frame.processId). */
  renderers?: Record<string, number>;
  overBudget: boolean;
  /**
   * Set only for system_memory. Without the Local Companion, eviction follows
   * system memory pressure instead of the budget. Thresholds are free bytes at or
   * below which each level starts. Null thresholds mean memory-based eviction is off.
   */
  pressure?: MemoryPressure;
  pressureThresholds?: { moderateBytes: number; criticalBytes: number } | null;
  checkedAt: number;
}

export interface TabSummary {
  id: number;
  url: string;
  title: string;
  active: boolean;
  audible: boolean;
  pinned: boolean;
  discarded: boolean;
  autoDiscardable?: boolean;
  kept?: boolean;
  status?: string;
  windowId: number;
  index?: number;
  groupId?: number;
  splitViewId?: number;
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
  /** Best available tab memory measurement in bytes (OS renderer RAM when available, else JS heap). */
  memoryBytes: number | null;
  memorySource: TabMemorySource | null;
  sharedProcessTabs?: number;
  sharedProcessTotalBytes?: number;
  jsHeapBytes: number | null;
  hasUnsavedForm: boolean;
  hasActiveUpload: boolean;
  isPwa: boolean;
  canKeep: boolean;
  canSleep: boolean;
  canClose: boolean;
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
  /** Whole session with all eligible tabs. */
  complete: boolean;
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
  supportsDeviceManagement?: boolean;
  enabled: boolean;
  syncDir: string | null;
  writable: boolean;
  deviceId: string;
  deviceName: string;
  hostname?: string | null;
  lastSyncAt: number | null;
  lastError?: string | null;
}

export interface SyncedDeviceInfo {
  deviceId: string;
  deviceName: string;
  hostname?: string;
  lastSeenAt: number | null;
  snapshotCount: number;
  isCurrent: boolean;
  isSameComputer: boolean;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  hostname?: string;
}

export interface StatusPayload {
  config: TabCurbConfig;
  memory: MemorySnapshot | null;
  online: boolean;
  loadedCount: number;
  discardedCount: number;
  protectedCount: number;
  openTabs: OpenTabInfo[];
  recoverableSnapshot: { id: string; capturedAt: number; tabCount: number; windowCount?: number; relPath?: string } | null;
  updateAvailable: UpdateAvailableInfo | null;
  updateStatus?: UpdateCheckStatus;
  permissions: {
    nativeMessaging: boolean;
    hostAccess: boolean;
    uploadProtection: boolean;
  };
}

export type BackgroundMessage =
  | { type: "get_status"; includeTabs?: boolean }
  | { type: "discard_tab"; tabId: number }
  | { type: "toggle_keep_tab"; tabId: number }
  | { type: "close_tab"; tabId: number }
  | { type: "discard_idle_now" }
  | { type: "get_snapshots" }
  | { type: "get_snapshot_details"; id: string; relPath?: string }
  | { type: "capture_snapshot_now"; label?: string }
  | { type: "clear_snapshots" }
  | { type: "delete_snapshot"; id: string; syncDir?: string | null; ownerDeviceId?: string }
  | { type: "restore_snapshot"; id: string; targetWindowId?: number; mode?: RestoreMode; relPath?: string }
  | { type: "save_config"; config: Partial<TabCurbConfig> }
  | { type: "test_native_host" }
  | { type: "get_sync_status" }
  | { type: "get_synced_devices" }
  | { type: "remove_synced_device"; targetDeviceId: string }
  | { type: "adopt_synced_device"; targetDeviceId: string }
  | { type: "detect_sync_folders" }
  | { type: "pick_sync_folder" }
  | { type: "set_sync_folder"; path: string | null }
  | { type: "set_device_name"; deviceName: string }
  | { type: "sync_now" }
  | { type: "dismiss_update"; version: string };
