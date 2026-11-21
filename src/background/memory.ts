import { computeMemoryBudgetBytes } from "../shared/config.ts";
import type { MemorySnapshot, TabReaperConfig } from "../shared/types.ts";

export const NATIVE_HOST_NAME = "com.tabreaper.host";

interface NativeMemoryResponse {
  ok: boolean;
  chromeBytes?: number;
  processCount?: number;
  systemTotalBytes?: number;
  systemAvailableBytes?: number;
  metric?: string;
  error?: string;
}

interface NativePingResponse {
  ok: boolean;
  version?: string;
  platform?: string;
  error?: string;
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
  try {
    const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      cmd: "ping",
    })) as NativePingResponse;
    return response && response.ok ? response : { ok: false, error: response?.error ?? "Invalid host response" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getMemorySnapshot(config: TabReaperConfig, now = Date.now()): Promise<MemorySnapshot> {
  const nativeAllowed = await hasNativeMessagingPermission();
  if (nativeAllowed) {
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
        return {
          source: "native_host",
          usedBytes: response.chromeBytes,
          budgetBytes,
          systemTotalBytes: response.systemTotalBytes,
          systemAvailableBytes: response.systemAvailableBytes ?? 0,
          processCount: response.processCount,
          metric: response.metric,
          overBudget: response.chromeBytes > budgetBytes,
          checkedAt: now,
        };
      }
    } catch {
      // Fall back to chrome.system.memory when native host is unavailable.
    }
  }

  const info = await chrome.system.memory.getInfo();
  const systemTotalBytes = info.capacity;
  const systemAvailableBytes = info.availableCapacity;
  const osUsedBytes = Math.max(0, systemTotalBytes - systemAvailableBytes);
  const budgetBytes = computeMemoryBudgetBytes(config, systemTotalBytes);

  return {
    source: "system_memory",
    usedBytes: osUsedBytes,
    budgetBytes,
    systemTotalBytes,
    systemAvailableBytes,
    overBudget: osUsedBytes > budgetBytes,
    checkedAt: now,
  };
}
