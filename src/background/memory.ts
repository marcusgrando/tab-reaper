import { MAX_DISCARDS_WITHOUT_RELIEF, computeMemoryBudgetBytes } from "../shared/config.ts";
import type { MemoryPressure, MemorySnapshot, TabCurbConfig } from "../shared/types.ts";

export const NATIVE_HOST_NAME = "com.tabcurb.host";

const MiB = 1024 * 1024;
/** Free memory must rise by this much over the episode's baseline to count as relief. One discarded tab usually frees more. */
const RELIEF_BYTES = 128 * MiB;
const PRESSURE_EPISODE_KEY = "tabCurb.pressureEpisode";

/**
 * Free-memory thresholds for chrome.system.memory availableCapacity, which reports
 * a different metric per OS. Windows matches Chrome's default memory pressure
 * evaluator on the same value (1000/400 MiB). macOS excludes compressible and
 * inactive pages, so it sits below 1 GiB on a healthy 8 GiB Mac. Its thresholds
 * are an approximation of the kernel pressure levels, which only native code can read.
 * Linux follows Firefox's critical rule (5% or 200 MiB). ChromeOS discards tabs
 * under pressure itself, so TabCurb leaves it alone.
 */
export function systemPressureThresholds(
  os: string,
  totalBytes: number,
): { moderateBytes: number; criticalBytes: number } | null {
  switch (os) {
    case "cros":
      return null;
    case "win":
      return { moderateBytes: 1000 * MiB, criticalBytes: 400 * MiB };
    case "mac":
      return { moderateBytes: 800 * MiB, criticalBytes: 400 * MiB };
    default:
      return {
        moderateBytes: Math.round(totalBytes * 0.1),
        criticalBytes: Math.max(200 * MiB, Math.round(totalBytes * 0.05)),
      };
  }
}

function pressureLevel(
  availableBytes: number,
  thresholds: { moderateBytes: number; criticalBytes: number } | null,
): MemoryPressure {
  if (!thresholds) return "normal";
  if (availableBytes <= thresholds.criticalBytes) return "critical";
  if (availableBytes <= thresholds.moderateBytes) return "moderate";
  return "normal";
}

async function getPlatformOs(): Promise<string> {
  try {
    return (await chrome.runtime.getPlatformInfo()).os;
  } catch {
    // Unknown platforms use the RAM-relative thresholds.
    return "unknown";
  }
}

export interface PressureEpisode {
  baselineAvailableBytes: number;
  discards: number;
}

/** Returns the episode that applies to this reading, or null outside system memory pressure. */
export function nextPressureEpisode(episode: PressureEpisode | null, memory: MemorySnapshot): PressureEpisode | null {
  if (memory.source !== "system_memory" || !memory.pressure || memory.pressure === "normal") return null;
  if (!episode || memory.systemAvailableBytes >= episode.baselineAvailableBytes + RELIEF_BYTES) {
    return { baselineAvailableBytes: memory.systemAvailableBytes, discards: 0 };
  }
  return episode;
}

export async function loadPressureEpisode(): Promise<PressureEpisode | null> {
  const stored = (await chrome.storage.session.get(PRESSURE_EPISODE_KEY))[PRESSURE_EPISODE_KEY] as
    | Partial<PressureEpisode>
    | undefined;
  if (typeof stored?.baselineAvailableBytes !== "number" || typeof stored.discards !== "number") return null;
  return { baselineAvailableBytes: stored.baselineAvailableBytes, discards: stored.discards };
}

export async function savePressureEpisode(episode: PressureEpisode | null): Promise<void> {
  if (episode) {
    await chrome.storage.session.set({ [PRESSURE_EPISODE_KEY]: episode });
  } else {
    await chrome.storage.session.remove(PRESSURE_EPISODE_KEY);
  }
}

interface NativeMemoryResponse {
  ok: boolean;
  chromeBytes?: number;
  processCount?: number;
  systemTotalBytes?: number;
  systemAvailableBytes?: number;
  metric?: string;
  renderers?: Record<string, number>;
  error?: string;
}

function parseRenderers(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const renderers: Record<string, number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    renderers[key] = value;
    count++;
  }
  return count > 0 ? renderers : undefined;
}

interface NativePingResponse {
  ok: boolean;
  version?: string;
  platform?: string;
  error?: string;
  needsReload?: boolean;
}

export async function hasNativeMessagingPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  } catch {
    return false;
  }
}

export async function pingNativeHost(): Promise<NativePingResponse> {
  const granted = await hasNativeMessagingPermission();
  if (!granted) {
    return { ok: false, error: "nativeMessaging permission not granted" };
  }
  // Chrome MV3 does not attach sendNativeMessage to an already-running service worker
  // when nativeMessaging is granted as an optional permission until the extension reloads.
  if (typeof chrome.runtime.sendNativeMessage !== "function") {
    return {
      ok: false,
      error: "Extension reload required to activate native messaging.",
      needsReload: true,
    };
  }
  try {
    const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      cmd: "ping",
    })) as NativePingResponse;
    return response && response.ok ? response : { ok: false, error: response?.error ?? "Invalid host response" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getMemorySnapshot(config: TabCurbConfig, now = Date.now()): Promise<MemorySnapshot> {
  const nativeAllowed = await hasNativeMessagingPermission();
  if (nativeAllowed && typeof chrome.runtime.sendNativeMessage === "function") {
    try {
      const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
        cmd: "chrome_memory",
      })) as NativeMemoryResponse;

      if (
        response &&
        response.ok &&
        typeof response.chromeBytes === "number" &&
        typeof response.systemTotalBytes === "number" &&
        response.systemTotalBytes > 0
      ) {
        const budgetBytes = computeMemoryBudgetBytes(config, response.systemTotalBytes);
        const renderers = parseRenderers(response.renderers);
        return {
          source: "native_host",
          usedBytes: response.chromeBytes,
          budgetBytes,
          systemTotalBytes: response.systemTotalBytes,
          systemAvailableBytes: response.systemAvailableBytes ?? 0,
          processCount: response.processCount,
          metric: response.metric,
          ...(renderers ? { renderers } : {}),
          overBudget: response.chromeBytes > budgetBytes,
          checkedAt: now,
        };
      }
    } catch {
      // Fall back to chrome.system.memory when native host is unavailable.
    }
  }

  const [info, os] = await Promise.all([chrome.system.memory.getInfo(), getPlatformOs()]);
  const systemTotalBytes = info.capacity;
  const systemAvailableBytes = info.availableCapacity;
  const pressureThresholds = systemPressureThresholds(os, systemTotalBytes);

  return {
    source: "system_memory",
    usedBytes: Math.max(0, systemTotalBytes - systemAvailableBytes),
    budgetBytes: computeMemoryBudgetBytes(config, systemTotalBytes),
    systemTotalBytes,
    systemAvailableBytes,
    overBudget: false,
    pressure: pressureLevel(systemAvailableBytes, pressureThresholds),
    pressureThresholds,
    checkedAt: now,
  };
}
