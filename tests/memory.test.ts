import { afterEach, describe, expect, test } from "bun:test";
import {
  getMemorySnapshot,
  nextPressureEpisode,
  pingNativeHost,
  systemPressureThresholds,
} from "../src/background/memory.ts";
import type { MemorySnapshot } from "../src/shared/types.ts";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
import { DEFAULT_CONFIG, MAX_DISCARDS_WITHOUT_RELIEF } from "../src/shared/config.ts";

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("native messaging optional permission binding", () => {
  test("pingNativeHost reports needsReload when sendNativeMessage is not yet bound", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      permissions: {
        contains: async () => true,
      },
      runtime: {},
    };

    const res = await pingNativeHost();
    expect(res.ok).toBe(false);
    expect(res.needsReload).toBe(true);
  });

  test("getMemorySnapshot falls back to system.memory when sendNativeMessage is unbound", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      permissions: {
        contains: async () => true,
      },
      runtime: {},
      system: {
        memory: {
          getInfo: async () => ({
            capacity: 16 * 1024 ** 3,
            availableCapacity: 10 * 1024 ** 3,
          }),
        },
      },
    };

    const snap = await getMemorySnapshot(DEFAULT_CONFIG, 1_000);
    expect(snap.source).toBe("system_memory");
    expect(snap.usedBytes).toBe(6 * 1024 ** 3);
    expect(snap.overBudget).toBe(false);
  });
});

function systemMemory(os: string, totalBytes: number, availableBytes: number) {
  (globalThis as { chrome?: unknown }).chrome = {
    permissions: { contains: async () => false },
    runtime: { getPlatformInfo: async () => ({ os }) },
    system: { memory: { getInfo: async () => ({ capacity: totalBytes, availableCapacity: availableBytes }) } },
  };
  return getMemorySnapshot(DEFAULT_CONFIG, 1_000);
}

describe("system memory pressure without the Local Companion", () => {
  test("an 8 GiB Mac using 85% of RAM but with 1.2 GiB free is not under pressure", async () => {
    // Regression: comparing system-wide use with half of RAM put almost every background tab to sleep.
    const snap = await systemMemory("mac", 8 * GiB, 1.2 * GiB);
    expect(snap.pressure).toBe("normal");
    expect(snap.pressureThresholds).toEqual({ moderateBytes: 800 * MiB, criticalBytes: 400 * MiB });
  });

  test("uses Chrome's Windows thresholds on the same available-memory metric", async () => {
    expect((await systemMemory("win", 16 * GiB, 1001 * MiB)).pressure).toBe("normal");
    expect((await systemMemory("win", 16 * GiB, 1000 * MiB)).pressure).toBe("moderate");
    expect((await systemMemory("win", 16 * GiB, 400 * MiB)).pressure).toBe("critical");
  });

  test("scales Linux thresholds with RAM and keeps a 200 MiB critical floor", async () => {
    expect((await systemMemory("linux", 16 * GiB, 1.7 * GiB)).pressure).toBe("normal");
    expect((await systemMemory("linux", 16 * GiB, 1.5 * GiB)).pressure).toBe("moderate");
    expect((await systemMemory("linux", 16 * GiB, 0.7 * GiB)).pressure).toBe("critical");
    expect(systemPressureThresholds("linux", 2 * GiB)?.criticalBytes).toBe(200 * MiB);
  });

  test("leaves memory-based eviction to ChromeOS", async () => {
    const snap = await systemMemory("cros", 8 * GiB, 50 * MiB);
    expect(snap.pressure).toBe("normal");
    expect(snap.pressureThresholds).toBeNull();
  });

  test("the Local Companion keeps budget mode without pressure levels", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      permissions: { contains: async () => true },
      runtime: {
        getPlatformInfo: async () => ({ os: "mac" }),
        sendNativeMessage: async () => ({ ok: true, chromeBytes: 3 * GiB, systemTotalBytes: 8 * GiB, systemAvailableBytes: 0.1 * GiB }),
      },
    };
    const snap = await getMemorySnapshot(DEFAULT_CONFIG, 1_000);
    expect(snap.source).toBe("native_host");
    expect(snap.pressure).toBeUndefined();
  });
});

describe("pressure episodes", () => {
  const pressured = (availableBytes: number, pressure: MemorySnapshot["pressure"] = "moderate"): MemorySnapshot => ({
    source: "system_memory", usedBytes: 0, budgetBytes: 0, systemTotalBytes: 8 * GiB,
    systemAvailableBytes: availableBytes, overBudget: false, pressure, checkedAt: 0,
  });

  test("stops after the cap when sleeping tabs frees no memory, until pressure ends", () => {
    let episode = nextPressureEpisode(null, pressured(700 * MiB));
    expect(episode).toEqual({ baselineAvailableBytes: 700 * MiB, discards: 0 });
    episode = { ...episode!, discards: MAX_DISCARDS_WITHOUT_RELIEF };
    expect(nextPressureEpisode(episode, pressured(720 * MiB))).toBe(episode);
    expect(nextPressureEpisode(episode, pressured(2 * GiB, "normal"))).toBeNull();
  });

  test("a discard that frees memory starts a new allowance", () => {
    const episode = { baselineAvailableBytes: 700 * MiB, discards: MAX_DISCARDS_WITHOUT_RELIEF };
    expect(nextPressureEpisode(episode, pressured(900 * MiB))).toEqual({ baselineAvailableBytes: 900 * MiB, discards: 0 });
  });

  test("budget mode has no episodes", () => {
    expect(nextPressureEpisode(null, { ...pressured(0), source: "native_host", pressure: undefined })).toBeNull();
  });
});
