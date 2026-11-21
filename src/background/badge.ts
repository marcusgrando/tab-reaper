import type { MemorySnapshot } from "../shared/types.ts";

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
): BadgeDisplay {
  if (!isOnline) {
    return { text: "OFF", color: COLOR_OFFLINE };
  }

  const ratio = memory && memory.budgetBytes > 0 ? memory.usedBytes / memory.budgetBytes : 0;
  let color = COLOR_OK;
  if (memory?.overBudget || ratio >= 0.95) {
    color = COLOR_OVER;
  } else if (ratio >= 0.75) {
    color = COLOR_WARN;
  }

  if (memory?.source === "native_host") {
    return { text: formatCompactBytes(memory.usedBytes), color };
  }

  return { text: String(loadedCount), color };
}

export async function updateActionBadge(
  memory: MemorySnapshot | null,
  loadedCount: number,
  isOnline: boolean,
): Promise<void> {
  if (!chrome.action?.setBadgeText) return;
  const badge = computeBadge(memory, loadedCount, isOnline);
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
