import { afterEach, describe, expect, test } from "bun:test";
import { getMemorySnapshot, pingNativeHost } from "../src/background/memory.ts";
import { DEFAULT_CONFIG } from "../src/shared/config.ts";

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
