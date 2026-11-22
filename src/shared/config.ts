import type { TabReaperConfig } from "./types.ts";

export const CONFIG_STORAGE_KEY = "tabReaper.config";
export const REOPEN_OPTIONS_KEY = "tabReaper.reopenOptions";
export const SETUP_PENDING_KEY = "tabReaper.setupPending";

export const DEFAULT_CONFIG: TabReaperConfig = {
  memoryBudgetMode: "fraction",
  memoryBudgetFraction: 0.5,
  memoryBudgetGb: 4,
  idleEvictionPercent: 80,
  sizeEvictionPercent: 100,
  startupSweep: true,
  protectActive: true,
  protectAudible: true,
  protectPinned: true,
  protectUnsavedForms: true,
  skipWhenOffline: true,
  enableSessionSnapshots: true,
  snapshotIntervalMinutes: 5,
  allowlist: [],
};

const INTERNAL_SCHEMES = [
  "chrome://",
  "chrome-extension://",
  "chrome-search://",
  "devtools://",
  "edge://",
  "about:",
];

export function sanitizeConfig(raw: Partial<TabReaperConfig> | undefined): TabReaperConfig {
  const merged = { ...DEFAULT_CONFIG, ...raw };

  const memoryBudgetMode = merged.memoryBudgetMode === "fixed_gb" ? "fixed_gb" : "fraction";
  const memoryBudgetFraction = clampNumber(merged.memoryBudgetFraction, 0.1, 0.9, DEFAULT_CONFIG.memoryBudgetFraction);
  const memoryBudgetGb = clampNumber(merged.memoryBudgetGb, 0.5, 512, DEFAULT_CONFIG.memoryBudgetGb);
  const idleEvictionPercent = Math.round(
    clampNumber(merged.idleEvictionPercent, 10, 100, DEFAULT_CONFIG.idleEvictionPercent),
  );
  const rawSizeEvictionPercent = Math.round(
    clampNumber(merged.sizeEvictionPercent, 10, 100, DEFAULT_CONFIG.sizeEvictionPercent),
  );
  const sizeEvictionPercent = Math.max(idleEvictionPercent, rawSizeEvictionPercent);
  const snapshotIntervalMinutes = Math.round(
    clampNumber(merged.snapshotIntervalMinutes, 1, 1440, DEFAULT_CONFIG.snapshotIntervalMinutes),
  );

  const allowlist = Array.isArray(merged.allowlist)
    ? merged.allowlist
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    memoryBudgetMode,
    memoryBudgetFraction,
    memoryBudgetGb,
    idleEvictionPercent,
    sizeEvictionPercent,
    startupSweep: Boolean(merged.startupSweep),
    protectActive: Boolean(merged.protectActive),
    protectAudible: Boolean(merged.protectAudible),
    protectPinned: Boolean(merged.protectPinned),
    protectUnsavedForms: Boolean(merged.protectUnsavedForms),
    skipWhenOffline: Boolean(merged.skipWhenOffline),
    enableSessionSnapshots: Boolean(merged.enableSessionSnapshots),
    snapshotIntervalMinutes,
    allowlist: [...new Set(allowlist)],
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Without the Local Companion, sleeping tabs may not relieve system pressure when
 * other apps hold the memory, so a pressure episode allows this many discards
 * without relief before waiting for pressure to end.
 */
export const MAX_DISCARDS_WITHOUT_RELIEF = 4;

export function computeMemoryBudgetBytes(config: TabReaperConfig, systemTotalBytes: number): number {
  if (config.memoryBudgetMode === "fixed_gb") {
    return Math.round(config.memoryBudgetGb * 1024 * 1024 * 1024);
  }
  return Math.round(systemTotalBytes * config.memoryBudgetFraction);
}

export function isInternalUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

export function isHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

export function createAsyncQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Preserve #fragment because SPAs use it to identify distinct documents/views.
    // Normalize trailing slash on bare root URLs only.
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Linear-time wildcard matcher supporting `*` without regex backtracking (ReDoS-safe).
 */
export function matchGlob(text: string, pattern: string): boolean {
  let ti = 0;
  let pi = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === text[ti]) {
      ti++;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === "*") {
    pi++;
  }
  return pi === pattern.length;
}

function matchesHostPattern(host: string, hostPattern: string): boolean {
  if (!host || !hostPattern) return false;
  if (hostPattern.includes("*")) {
    return matchGlob(host, hostPattern);
  }
  return host === hostPattern || host.endsWith(`.${hostPattern}`);
}

export function matchesAllowlist(url: string | undefined, allowlist: string[]): boolean {
  if (!url || allowlist.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();

  for (const rawPattern of allowlist) {
    let pattern = rawPattern.trim().toLowerCase();
    if (!pattern) continue;
    pattern = pattern.replace(/^https?:\/\//, "");

    const slashIdx = pattern.indexOf("/");
    if (slashIdx === -1) {
      if (matchesHostPattern(host, pattern)) {
        return true;
      }
      continue;
    }

    const hostPattern = pattern.slice(0, slashIdx);
    const pathPattern = pattern.slice(slashIdx);
    if (!matchesHostPattern(host, hostPattern)) {
      continue;
    }
    if (pathPattern.includes("*")) {
      if (matchGlob(pathAndSearch, pathPattern)) {
        return true;
      }
    } else if (pathAndSearch.startsWith(pathPattern)) {
      return true;
    }
  }

  return false;
}

export async function loadConfig(): Promise<TabReaperConfig> {
  const result = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  return sanitizeConfig(result[CONFIG_STORAGE_KEY] as Partial<TabReaperConfig> | undefined);
}

export async function saveConfig(partial: Partial<TabReaperConfig>): Promise<TabReaperConfig> {
  const next = sanitizeConfig({ ...await loadConfig(), ...partial });
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
  return next;
}
