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

export interface PlanEvictionsInput {
  tabs: TabSummary[];
  activity: ActivityState;
  weights: Map<number, TabWeightSample>;
  config: TabReaperConfig;
  memory: MemorySnapshot | null;
  now: number;
  mode: "sweep" | "startup";
  isOnline?: boolean;
}

export function planEvictions(input: PlanEvictionsInput): EvictionCandidate[] {
  const { tabs, activity, weights, config, memory, now, mode, isOnline = true } = input;

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
      reason: "over_tab_cap" as const,
    }));
  }

  const scored = eligibleLoaded
    .map((tab) => {
      const lastActiveAt = getTabLastActiveAt(activity, tab, now);
      const idleMinutes = Math.max(0.05, (now - lastActiveAt) / 60_000);
      const weightMultiplier = weights.get(tab.id)?.weightMultiplier ?? 1.0;
      const score = Number((idleMinutes * weightMultiplier).toFixed(4));
      return { tab, idleMinutes, weightMultiplier, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected: EvictionCandidate[] = [];
  const selectedIds = new Set<number>();

  // 1. Idle timeout evictions
  if (config.discardAfterMinutes > 0) {
    for (const item of scored) {
      if (item.idleMinutes >= config.discardAfterMinutes) {
        selected.push({ ...item, reason: "idle_timeout" });
        selectedIds.add(item.tab.id);
      }
    }
  }

  // 2. Hard loaded-tab count cap (maxActiveTabs)
  let remainingLoaded = eligibleLoaded.length - selectedIds.size;
  if (remainingLoaded > config.maxActiveTabs) {
    for (const item of scored) {
      if (remainingLoaded <= config.maxActiveTabs) break;
      if (selectedIds.has(item.tab.id)) continue;
      selected.push({ ...item, reason: "over_tab_cap" });
      selectedIds.add(item.tab.id);
      remainingLoaded--;
    }
  }

  // 3. Memory budget cap (bounded per pass to avoid over-discarding during teardown)
  if (memory?.overBudget && remainingLoaded > 0) {
    let memoryEvictions = 0;
    for (const item of scored) {
      if (memoryEvictions >= MAX_MEMORY_EVICTIONS_PER_PASS) break;
      if (selectedIds.has(item.tab.id)) continue;
      selected.push({ ...item, reason: "over_memory_budget" });
      selectedIds.add(item.tab.id);
      memoryEvictions++;
    }
  }

  return selected;
}
