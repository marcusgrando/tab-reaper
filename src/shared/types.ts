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
  status?: string;
  windowId: number;
  groupId?: number;
  favIconUrl?: string;
}

export interface LoadedTabInfo {
  id: number;
  url: string;
  title: string;
  idleMinutes: number;
  protectedReason: string | null;
  weightMultiplier: number;
  jsHeapBytes: number | null;
  hasUnsavedForm: boolean;
}

export interface EvictionCandidate {
  tab: TabSummary;
  idleMinutes: number;
  weightMultiplier: number;
  score: number;
  reason: "over_tab_cap" | "over_memory_budget" | "idle_timeout";
}

export interface StatusPayload {
  config: TabReaperConfig;
  memory: MemorySnapshot | null;
  online: boolean;
  loadedCount: number;
  discardedCount: number;
  protectedCount: number;
  archivedCount: number;
  loadedTabs: LoadedTabInfo[];
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
  | { type: "discard_idle_now" }
  | { type: "archive_old_now" }
  | { type: "save_config"; config: Partial<TabReaperConfig> }
  | { type: "test_native_host" };
