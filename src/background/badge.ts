import type { MemorySnapshot } from "../shared/types.ts";
import { IDLE_EVICTION_MEMORY_THRESHOLD, SIZE_EVICTION_MEMORY_THRESHOLD, getMemoryBand } from "./eviction.ts";

export interface BadgeDisplay {
  text: string;
  color: string;
}

const COLOR_OK = "#16a34a";
const COLOR_WARN = "#d97706";
const COLOR_OVER = "#dc2626";
const COLOR_OFFLINE = "#64748b";

export function formatCompactBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 10) return `${Math.round(gib)}G`;
  if (gib >= 1) return `${gib.toFixed(1)}G`;
  const mib = Math.max(1, Math.round(bytes / (1024 * 1024)));
  return `${mib}M`;
}

export function computeBadge(
  memory: MemorySnapshot | null,
  loadedCount: number,
  isOnline: boolean,
  thresholds?: { idleRatio?: number; sizeRatio?: number },
): BadgeDisplay {
  if (!isOnline) {
    return { text: "OFF", color: COLOR_OFFLINE };
  }

  const band = getMemoryBand(
    memory,
    thresholds?.idleRatio ?? IDLE_EVICTION_MEMORY_THRESHOLD,
    thresholds?.sizeRatio ?? SIZE_EVICTION_MEMORY_THRESHOLD,
  );
  const color = band === "size" ? COLOR_OVER : band === "idle" ? COLOR_WARN : COLOR_OK;

  if (memory?.source === "native_host") {
    return { text: formatCompactBytes(memory.usedBytes), color };
  }

  return { text: String(loadedCount), color };
}

export async function updateActionBadge(
  memory: MemorySnapshot | null,
  loadedCount: number,
  isOnline: boolean,
  thresholds?: { idleRatio?: number; sizeRatio?: number },
): Promise<void> {
  if (!chrome.action?.setBadgeText) return;
  const badge = computeBadge(memory, loadedCount, isOnline, thresholds);
  try {
    await Promise.all([
      chrome.action.setBadgeText({ text: badge.text }),
      chrome.action.setBadgeBackgroundColor({ color: badge.color }),
      chrome.action.setBadgeTextColor?.({ color: "#ffffff" }),
    ]);
  } catch {
    // Ignore transient badge update failures during browser shutdown.
  }
}
