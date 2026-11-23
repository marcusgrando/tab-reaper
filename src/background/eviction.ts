import { isInternalUrl, matchesAllowlist } from "../shared/config.ts";
import type {
  ActivityState,
  MemorySnapshot,
  TabReaperConfig,
  TabSummary,
  TabWeightSample,
} from "../shared/types.ts";
import { getTabLastActiveAt } from "./tracker.ts";

export const IDLE_EVICTION_MEMORY_THRESHOLD = 0.8;
export const SIZE_EVICTION_MEMORY_THRESHOLD = 1.0;

/**
 * Cap memory-triggered discards per sweep so Chrome has time (~200-500ms)
 * to tear down renderer processes before the next memory reading.
 */
export const MAX_MEMORY_EVICTIONS_PER_PASS = 2;

/** "idle" sleeps least recently used tabs. "size" sleeps the heaviest tabs first when weights exist. */
export type MemoryBand = "normal" | "idle" | "size";

/**
 * With the Local Companion, bands come from Chrome's RAM against the budget.
 * Without it, system-wide use says nothing about Chrome, so bands follow system
 * memory pressure and the budget percentages do not apply.
 */
export function getMemoryBand(memory: MemorySnapshot | null, idleRatio: number, sizeRatio: number): MemoryBand {
  if (!memory) return "normal";
  if (memory.source === "system_memory") {
    if (memory.pressure === "critical") return "size";
    return memory.pressure === "moderate" ? "idle" : "normal";
  }
  const usageRatio = memory.budgetBytes > 0 ? memory.usedBytes / memory.budgetBytes : 0;
  if (memory.overBudget || usageRatio >= Math.max(idleRatio, sizeRatio)) return "size";
  return usageRatio >= idleRatio ? "idle" : "normal";
}

export function getTabProtectedReason(
  tab: TabSummary,
  config: TabReaperConfig,
  sample?: TabWeightSample,
  hasActiveUpload = false,
): string | null {
  if (isInternalUrl(tab.url)) return "Internal";
  if (tab.status === "loading") return "Loading";
  if (tab.kept) return "Kept";
  if (config.protectActive && tab.active) return "Active";
  if (config.protectAudible && tab.audible) return "Audio";
  if (config.protectPinned && tab.pinned) return "Pinned";
  if (matchesAllowlist(tab.url, config.allowlist)) return "Allowlist";
  if (config.protectActiveUploads && hasActiveUpload) return "Upload";
  if (config.protectUnsavedForms && sample?.hasUnsavedForm) return "Form";
  return null;
}

export function isTabProtected(
  tab: TabSummary,
  config: TabReaperConfig,
  sample?: TabWeightSample,
  hasActiveUpload = false,
): boolean {
  return getTabProtectedReason(tab, config, sample, hasActiveUpload) !== null;
}

export interface OpenTabActions {
  protectedReason: string | null;
  canKeep: boolean;
  canSleep: boolean;
  canClose: boolean;
}

/**
 * Single source of truth for which manual actions (Keep, Sleep, Close) are coherent
 * with the user's protection settings for a given open tab.
 */
export function computeOpenTabActions(
  tab: TabSummary,
  config: TabReaperConfig,
  sample?: TabWeightSample,
  isFocusedActive = false,
  hasActiveUpload = false,
): OpenTabActions {
  const protectedReason = getTabProtectedReason(tab, config, sample, hasActiveUpload);
  const canClose = !tab.pinned && !tab.kept;

  // Protected by a config rule or browser state (Internal, Loading, Active, Audio, Pinned, Allowlist, Form):
  // hide Keep/Sleep so manual actions never contradict active protection settings.
  if (protectedReason !== null && protectedReason !== "Kept") {
    return {
      protectedReason,
      canKeep: false,
      canSleep: false,
      canClose,
    };
  }

  // Explicitly kept by the user: only allow toggling Kept off until released.
  if (protectedReason === "Kept") {
    return {
      protectedReason,
      canKeep: true,
      canSleep: false,
      canClose: false,
    };
  }

  // Unprotected tab: Keep is always available; Sleep when loaded (and not focused active).
  return {
    protectedReason: null,
    canKeep: true,
    canSleep: !tab.discarded && !isFocusedActive,
    canClose,
  };
}

export interface PlanEvictionsInput {
  tabs: TabSummary[];
  activity: ActivityState;
  weights: Map<number, TabWeightSample>;
  uploadingTabIds?: ReadonlySet<number>;
  config: TabReaperConfig;
  memory: MemorySnapshot | null;
  now: number;
  mode: "sweep" | "startup";
  isOnline?: boolean;
  /** Maximum candidates returned (default MAX_MEMORY_EVICTIONS_PER_PASS; pass Infinity when caller filters live forms). */
  maxEvictions?: number;
}

export function planEvictions(input: PlanEvictionsInput): TabSummary[] {
  const {
    tabs,
    activity,
    weights,
    uploadingTabIds,
    config,
    memory,
    now,
    mode,
    isOnline = true,
    maxEvictions = MAX_MEMORY_EVICTIONS_PER_PASS,
  } = input;

  if (config.skipWhenOffline && !isOnline) {
    return [];
  }

  const eligibleLoaded = tabs.filter(
    (tab) => !tab.discarded && !isTabProtected(tab, config, weights.get(tab.id), uploadingTabIds?.has(tab.id) ?? false),
  );
  if (eligibleLoaded.length === 0) return [];

  if (mode === "startup") {
    return eligibleLoaded;
  }

  const band = getMemoryBand(memory, config.idleEvictionPercent / 100, config.sizeEvictionPercent / 100);
  if (band === "normal") return [];

  const bySize = band === "size" && weights.size > 0;
  const candidates = eligibleLoaded.map(tab => ({
    tab,
    lastActiveAt: getTabLastActiveAt(activity, tab, now),
    sample: weights.get(tab.id),
  }));
  candidates.sort((a, b) => {
    if (bySize) {
      const heapDifference = (b.sample?.jsHeapBytes ?? 0) - (a.sample?.jsHeapBytes ?? 0);
      if (heapDifference) return heapDifference;
      const weightDifference = (b.sample?.weightMultiplier ?? 1) - (a.sample?.weightMultiplier ?? 1);
      if (weightDifference) return weightDifference;
    }
    return a.lastActiveAt - b.lastActiveAt;
  });
  return candidates.slice(0, maxEvictions).map(candidate => candidate.tab);
}
