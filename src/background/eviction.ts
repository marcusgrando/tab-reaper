import { isInternalUrl, matchesAllowlist } from "../shared/config.ts";
import type {
  ActivityState,
  EvictionCandidate,
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

export function getTabProtectedReason(
  tab: TabSummary,
  config: TabReaperConfig,
  sample?: TabWeightSample,
): string | null {
  if (isInternalUrl(tab.url)) return "Internal";
  if (tab.status === "loading") return "Loading";
  if (tab.kept) return "Kept";
  if (config.protectActive && tab.active) return "Active";
  if (config.protectAudible && tab.audible) return "Audio";
  if (config.protectPinned && tab.pinned) return "Pinned";
  if (matchesAllowlist(tab.url, config.allowlist)) return "Allowlist";
  if (config.protectUnsavedForms && sample?.hasUnsavedForm) return "Form";
  return null;
}

export function isTabProtected(tab: TabSummary, config: TabReaperConfig, sample?: TabWeightSample): boolean {
  return getTabProtectedReason(tab, config, sample) !== null;
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
): OpenTabActions {
  const protectedReason = getTabProtectedReason(tab, config, sample);
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
  config: TabReaperConfig;
  memory: MemorySnapshot | null;
  now: number;
  mode: "sweep" | "startup";
  isOnline?: boolean;
  /** Maximum candidates returned (default MAX_MEMORY_EVICTIONS_PER_PASS; pass Infinity when caller filters live forms). */
  maxEvictions?: number;
}

export function planEvictions(input: PlanEvictionsInput): EvictionCandidate[] {
  const {
    tabs,
    activity,
    weights,
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

  const eligibleLoaded = tabs.filter((tab) => !tab.discarded && !isTabProtected(tab, config, weights.get(tab.id)));
  if (eligibleLoaded.length === 0) return [];

  if (mode === "startup") {
    return eligibleLoaded.map((tab) => ({
      tab,
      idleMinutes: 0,
      weightMultiplier: 1.0,
      score: 1.0,
      reason: "startup" as const,
    }));
  }

  const idleThreshold = config.idleEvictionPercent / 100;
  const sizeThreshold = Math.max(idleThreshold, config.sizeEvictionPercent / 100);
  const usageRatio = memory && memory.budgetBytes > 0 ? memory.usedBytes / memory.budgetBytes : 0;

  // Below idleEvictionPercent of memory budget: never discard tabs.
  if (!memory?.overBudget && usageRatio < idleThreshold) {
    return [];
  }

  const metrics = eligibleLoaded.map((tab) => {
    const lastActiveAt = getTabLastActiveAt(activity, tab, now);
    const idleMinutes = Math.max(0.05, (now - lastActiveAt) / 60_000);
    const sample = weights.get(tab.id);
    const weightMultiplier = sample?.weightMultiplier ?? 1.0;
    const jsHeapBytes = sample?.jsHeapBytes ?? 0;
    const score = Number((idleMinutes * weightMultiplier).toFixed(4));
    return { tab, idleMinutes, weightMultiplier, jsHeapBytes, score };
  });

  // At or above sizeEvictionPercent (or overBudget): discard heaviest tabs first when samples exist, otherwise oldest idle.
  if (Boolean(memory?.overBudget) || usageRatio >= sizeThreshold) {
    const ordered = [...metrics].sort((a, b) => {
      if (weights.size > 0) {
        if ((a.jsHeapBytes > 0 || b.jsHeapBytes > 0) && b.jsHeapBytes !== a.jsHeapBytes) {
          return b.jsHeapBytes - a.jsHeapBytes;
        }
        if (b.weightMultiplier !== a.weightMultiplier) {
          return b.weightMultiplier - a.weightMultiplier;
        }
      }
      return b.idleMinutes - a.idleMinutes;
    });

    return ordered.slice(0, maxEvictions).map(({ tab, idleMinutes, weightMultiplier, score }) => ({
      tab,
      idleMinutes,
      weightMultiplier,
      score,
      reason: "over_memory_budget" as const,
    }));
  }

  // Between idleEvictionPercent and sizeEvictionPercent: discard oldest idle tabs first.
  if (config.discardAfterMinutes <= 0) {
    return [];
  }

  const byOldestIdle = [...metrics].sort((a, b) => b.idleMinutes - a.idleMinutes);
  return byOldestIdle
    .filter((item) => item.idleMinutes >= config.discardAfterMinutes)
    .slice(0, maxEvictions)
    .map(({ tab, idleMinutes, weightMultiplier, score }) => ({
      tab,
      idleMinutes,
      weightMultiplier,
      score,
      reason: "idle_timeout" as const,
    }));
}
