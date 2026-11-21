import type { TabReaperConfig } from "./types.ts";

export const CONFIG_STORAGE_KEY = "tabReaper.config";

export const DEFAULT_CONFIG: TabReaperConfig = {
  memoryBudgetMode: "fraction",
  memoryBudgetFraction: 0.5,
  memoryBudgetGb: 4,
  maxActiveTabs: 10,
  discardAfterMinutes: 15,
  archiveAfterHours: 168,
  startupSweep: true,
  protectActive: true,
  protectAudible: true,
  protectPinned: true,
  protectUnsavedForms: true,
  skipWhenOffline: true,
  bookmarkFolderName: "Auto-Archived Tabs",
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
  const maxActiveTabs = Math.round(clampNumber(merged.maxActiveTabs, 1, 200, DEFAULT_CONFIG.maxActiveTabs));
  const discardAfterMinutes = clampNumber(merged.discardAfterMinutes, 0, 10080, DEFAULT_CONFIG.discardAfterMinutes);
  const archiveAfterHours = clampNumber(merged.archiveAfterHours, 0, 8760, DEFAULT_CONFIG.archiveAfterHours);
  const bookmarkFolderName =
    typeof merged.bookmarkFolderName === "string" && merged.bookmarkFolderName.trim().length > 0
      ? merged.bookmarkFolderName.trim()
      : DEFAULT_CONFIG.bookmarkFolderName;

  const allowlist = Array.isArray(merged.allowlist)
    ? merged.allowlist
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    memoryBudgetMode,
    memoryBudgetFraction,
    memoryBudgetGb,
    maxActiveTabs,
    discardAfterMinutes,
    archiveAfterHours,
    startupSweep: Boolean(merged.startupSweep),
    protectActive: Boolean(merged.protectActive),
    protectAudible: Boolean(merged.protectAudible),
    protectPinned: Boolean(merged.protectPinned),
    protectUnsavedForms: Boolean(merged.protectUnsavedForms),
    skipWhenOffline: Boolean(merged.skipWhenOffline),
    bookmarkFolderName,
    allowlist: [...new Set(allowlist)],
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

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

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesHostPattern(host: string, hostPattern: string): boolean {
  if (!host || !hostPattern) return false;
  if (hostPattern.includes("*")) {
    return globToRegExp(hostPattern).test(host);
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
      if (globToRegExp(pathPattern).test(pathAndSearch)) {
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
  const current = await loadConfig();
  const next = sanitizeConfig({ ...current, ...partial });
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
  return next;
}
