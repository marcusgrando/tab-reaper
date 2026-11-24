import type { UpdateAvailableInfo, UpdateCheckStatus } from "../shared/types.ts";

export const UPDATE_STATE_KEY = "tabReaper.updateState";
export const UPDATE_ALARM = "tab-reaper-update-check";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_PERIOD_MINUTES = 24 * 60;
export const LATEST_RELEASE_API_URL = "https://api.github.com/repos/marcusgrando/tab-reaper/releases/latest";
const ALLOWED_RELEASE_URL_PREFIX = "https://github.com/marcusgrando/tab-reaper/releases/";

export interface UpdateCheckState {
  checkedAt: number;
  etag?: string;
  latestVersion?: string;
  releaseUrl?: string;
  dismissedVersion?: string;
}

export function parseSemver(raw: string | undefined | null): [number, number, number] | null {
  if (!raw) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeVersion(raw: string): string | null {
  const parsed = parseSemver(raw);
  return parsed ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export function isSafeReleaseUrl(url: string | undefined | null): url is string {
  if (typeof url !== "string" || url.includes("\\")) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://github.com") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (/(?:^|\/)(?:\.\.?|%2e(?:%2e|\.)?|\.%2e)(?:\/|$)/i.test(parsed.pathname)) return false;
    return parsed.href.startsWith(ALLOWED_RELEASE_URL_PREFIX);
  } catch {
    return false;
  }
}

export function resolveUpdateAvailable(
  state: UpdateCheckState | null | undefined,
  currentVersion: string,
  enabled: boolean,
): UpdateAvailableInfo | null {
  if (!enabled || !state?.latestVersion || !isSafeReleaseUrl(state.releaseUrl)) return null;
  const latest = normalizeVersion(state.latestVersion);
  const current = normalizeVersion(currentVersion);
  if (!latest || !current) return null;
  if (!isNewerVersion(latest, current)) return null;
  if (state.dismissedVersion && normalizeVersion(state.dismissedVersion) === latest) return null;
  return {
    latestVersion: latest,
    currentVersion: current,
    releaseUrl: state.releaseUrl,
  };
}

export async function loadUpdateState(): Promise<UpdateCheckState | null> {
  if (!chrome.storage?.local?.get) return null;
  const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
  const raw = stored[UPDATE_STATE_KEY];
  if (!raw || typeof raw !== "object") return null;
  return raw as UpdateCheckState;
}

export async function saveUpdateState(state: UpdateCheckState): Promise<void> {
  if (!chrome.storage?.local?.set) return;
  await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
}

export function getInstalledVersion(): string {
  return chrome.runtime?.getManifest?.()?.version ?? "0.0.0";
}

export async function getUpdateAvailable(enabled: boolean, currentVersion = getInstalledVersion()): Promise<UpdateAvailableInfo | null> {
  if (!enabled) return null;
  const state = await loadUpdateState();
  return resolveUpdateAvailable(state, currentVersion, enabled);
}

export async function getUpdateStatus(
  enabled: boolean,
  currentVersion = getInstalledVersion(),
): Promise<{ updateAvailable: UpdateAvailableInfo | null; updateStatus: UpdateCheckStatus }> {
  const state = await loadUpdateState();
  const updateAvailable = resolveUpdateAvailable(state, currentVersion, enabled);
  const latest = state?.latestVersion ? normalizeVersion(state.latestVersion) : null;
  const current = normalizeVersion(currentVersion);
  const hasNewer = Boolean(latest && current && isNewerVersion(latest, current) && isSafeReleaseUrl(state?.releaseUrl));
  const dismissed = Boolean(
    hasNewer && state?.dismissedVersion && normalizeVersion(state.dismissedVersion) === latest,
  );
  return {
    updateAvailable,
    updateStatus: {
      checkedAt: typeof state?.checkedAt === "number" ? state.checkedAt : null,
      latestVersion: hasNewer ? latest : null,
      releaseUrl: hasNewer ? (state?.releaseUrl ?? null) : null,
      dismissed,
    },
  };
}

export async function dismissUpdateVersion(version: string): Promise<void> {
  const normalized = normalizeVersion(version);
  if (!normalized) return;
  const current = (await loadUpdateState()) ?? { checkedAt: Date.now() };
  await saveUpdateState({ ...current, dismissedVersion: normalized });
}

export async function checkForUpdate(options?: {
  force?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<UpdateCheckState | null> {
  const now = options?.now ?? Date.now();
  const existing = await loadUpdateState();
  if (!options?.force && existing && now >= existing.checkedAt && now - existing.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    return existing;
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return existing;

  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (existing?.etag) headers["If-None-Match"] = existing.etag;

  try {
    const response = await fetchFn(LATEST_RELEASE_API_URL, {
      headers,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 304) {
      const refreshed: UpdateCheckState = { ...(existing ?? { checkedAt: now }), checkedAt: now };
      await saveUpdateState(refreshed);
      return refreshed;
    }
    if (!response.ok) return existing;

    const payload = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    const next: UpdateCheckState = {
      ...(existing ?? { checkedAt: now }),
      checkedAt: now,
      etag: response.headers.get("etag") ?? existing?.etag,
    };

    if (!payload.draft && !payload.prerelease) {
      const latest = payload.tag_name ? normalizeVersion(payload.tag_name) : null;
      if (latest && isSafeReleaseUrl(payload.html_url)) {
        next.latestVersion = latest;
        next.releaseUrl = payload.html_url;
      }
    }

    await saveUpdateState(next);
    return next;
  } catch {
    return existing;
  }
}
