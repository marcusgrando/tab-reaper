import { beforeEach, describe, expect, test } from "bun:test";
import { computeBadge } from "../src/background/badge.ts";
import { buildQuickUpdateCommand } from "../src/shared/config.ts";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STATE_KEY,
  checkForUpdate,
  dismissUpdateVersion,
  getUpdateStatus,
  isNewerVersion,
  isSafeReleaseUrl,
  parseSemver,
  resolveUpdateAvailable,
} from "../src/background/update.ts";
import type { MemorySnapshot } from "../src/shared/types.ts";

const storage = new Map<string, unknown>();

beforeEach(() => {
  storage.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.9.0" }),
    },
  };
});

describe("update semver and resolution", () => {
  test("compares strict semver tags and rejects pre-releases", () => {
    expect(parseSemver("v0.9.0")).toEqual([0, 9, 0]);
    expect(parseSemver("v1.0.0-beta.1")).toBeNull();
    expect(isNewerVersion("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.9.1", "0.9.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.9.0", "0.9.0")).toBe(false);
    expect(isNewerVersion("0.8.9", "0.9.0")).toBe(false);
  });

  test("resolves available update unless disabled, older, dismissed, or unsafe URL", () => {
    const releaseUrl = "https://github.com/marcusgrando/tabcurb/releases/tag/v0.10.0";
    const state = { checkedAt: 1, latestVersion: "0.10.0", releaseUrl };

    expect(resolveUpdateAvailable(state, "0.9.0", true)).toEqual({
      latestVersion: "0.10.0",
      currentVersion: "0.9.0",
      releaseUrl,
    });
    expect(resolveUpdateAvailable(state, "0.9.0", false)).toBeNull();
    expect(resolveUpdateAvailable(state, "0.10.0", true)).toBeNull();
    expect(resolveUpdateAvailable({ ...state, dismissedVersion: "0.10.0" }, "0.9.0", true)).toBeNull();
    expect(resolveUpdateAvailable({ ...state, dismissedVersion: "0.9.5" }, "0.9.0", true)?.latestVersion).toBe("0.10.0");
    expect(resolveUpdateAvailable({ ...state, releaseUrl: "https://evil.example/v0.10.0" }, "0.9.0", true)).toBeNull();
    // Reject path traversal, encoded dot segments, backslashes, and userinfo spoofing.
    expect(isSafeReleaseUrl("https://github.com/marcusgrando/tabcurb/releases/../../../evil/repo")).toBe(false);
    expect(isSafeReleaseUrl("https://github.com/marcusgrando/tabcurb/releases/%2e%2e/%2e%2e/evil/repo")).toBe(false);
    expect(isSafeReleaseUrl("https://github.com/marcusgrando/tabcurb/releases/..\\..\\evil\\repo")).toBe(false);
    expect(isSafeReleaseUrl("https://user@github.com/marcusgrando/tabcurb/releases/tag/v0.10.0")).toBe(false);
    expect(isSafeReleaseUrl("https://github.com/marcusgrando/tabcurb/releases/tag/v0.10.0")).toBe(true);
  });

  test("pins quick update command to validated release tag when provided", () => {
    expect(buildQuickUpdateCommand("0.10.0", "Mozilla/5.0 (Macintosh)")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/marcusgrando/tabcurb/v0.10.0/install.sh | TABCURB_VERSION=v0.10.0 bash",
    );
    expect(buildQuickUpdateCommand("0.10.0", "Mozilla/5.0 (Windows NT 10.0)")).toBe(
      "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/marcusgrando/tabcurb/v0.10.0/install.ps1))) -Version v0.10.0",
    );
    // Rejects malformed/injected version strings and falls back safely.
    expect(buildQuickUpdateCommand("0.10.0; rm -rf /", "Mozilla/5.0 (Linux)")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/marcusgrando/tabcurb/main/install.sh | bash",
    );
  });
});

describe("checkForUpdate caching and network handling", () => {
  test("fetches release metadata, respects 24h cache, uses ETag, and persists dismissal", async () => {
    let calls = 0;
    const seenEtags: Array<string | null> = [];
    const seenInits: Array<RequestInit | undefined> = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      seenEtags.push((init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null);
      seenInits.push(init);
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.10.0",
            html_url: "https://github.com/marcusgrando/tabcurb/releases/tag/v0.10.0",
            draft: false,
            prerelease: false,
          }),
          { status: 200, headers: { etag: '"abc123"' } },
        );
      }
      return new Response(null, { status: 304 });
    }) as typeof fetch;

    const t0 = 1_000_000;
    const first = await checkForUpdate({ now: t0, fetchImpl: fakeFetch });
    expect(calls).toBe(1);
    expect(seenInits[0]?.credentials).toBe("omit");
    expect(seenInits[0]?.referrerPolicy).toBe("no-referrer");
    expect(first?.latestVersion).toBe("0.10.0");
    expect(first?.etag).toBe('"abc123"');

    // Within 24h: no network call.
    await checkForUpdate({ now: t0 + UPDATE_CHECK_INTERVAL_MS - 1000, fetchImpl: fakeFetch });
    expect(calls).toBe(1);

    // After 24h: sends ETag and handles 304.
    const second = await checkForUpdate({ now: t0 + UPDATE_CHECK_INTERVAL_MS + 1000, fetchImpl: fakeFetch });
    expect(calls).toBe(2);
    expect(seenEtags[1]).toBe('"abc123"');
    expect(second?.latestVersion).toBe("0.10.0");

    await dismissUpdateVersion("0.10.0");
    const saved = storage.get(UPDATE_STATE_KEY) as { dismissedVersion?: string };
    expect(saved.dismissedVersion).toBe("0.10.0");

    // Settings still sees the known newer release even after popup banner dismissal.
    const status = await getUpdateStatus(true, "0.9.0");
    expect(status.updateAvailable).toBeNull();
    expect(status.updateStatus.latestVersion).toBe("0.10.0");
    expect(status.updateStatus.dismissed).toBe(true);

    // Backward clock jump does not stall update checks.
    await checkForUpdate({ now: t0 - 60_000, fetchImpl: fakeFetch });
    expect(calls).toBe(3);
  });

  test("getUpdateStatus reports checkedAt null before any check succeeds", async () => {
    const status = await getUpdateStatus(true, "0.9.0");
    expect(status.updateAvailable).toBeNull();
    expect(status.updateStatus).toEqual({
      checkedAt: null,
      latestVersion: null,
      releaseUrl: null,
      dismissed: false,
    });
  });
});

describe("toolbar badge with update available", () => {
  const makeMem = (usedGb: number, budgetGb = 8): MemorySnapshot => ({
    source: "native_host",
    usedBytes: usedGb * 1024 ** 3,
    budgetBytes: budgetGb * 1024 ** 3,
    systemTotalBytes: 16 * 1024 ** 3,
    systemAvailableBytes: 4 * 1024 ** 3,
    overBudget: usedGb >= budgetGb,
    checkedAt: Date.now(),
  });

  const update = {
    latestVersion: "0.10.0",
    currentVersion: "0.9.0",
    releaseUrl: "https://github.com/marcusgrando/tabcurb/releases/tag/v0.10.0",
  };

  test("replaces memory text with UP while keeping memory-band colors", () => {
    const okNormal = computeBadge(makeMem(4), 5, true, undefined, null);
    const okUpdate = computeBadge(makeMem(4), 5, true, undefined, update);
    expect(okNormal.text).toBe("4.0G");
    expect(okUpdate.text).toBe("UP");
    expect(okUpdate.color).toBe(okNormal.color);

    const warnNormal = computeBadge(makeMem(7), 5, true, undefined, null);
    const warnUpdate = computeBadge(makeMem(7), 5, true, undefined, update);
    expect(warnUpdate.text).toBe("UP");
    expect(warnUpdate.color).toBe(warnNormal.color);

    const overNormal = computeBadge(makeMem(8.5), 5, true, undefined, null);
    const overUpdate = computeBadge(makeMem(8.5), 5, true, undefined, update);
    expect(overUpdate.text).toBe("UP");
    expect(overUpdate.color).toBe(overNormal.color);

    const offline = computeBadge(makeMem(4), 5, false, undefined, update);
    expect(offline.text).toBe("OFF");
  });
});
