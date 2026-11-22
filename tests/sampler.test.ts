import { expect, test } from "bun:test";
import { checkTabHasUnsavedForm, loadCachedWeights, sampleTabWeights } from "../src/background/sampler.ts";

test("cached form protection follows live frame results while weight metrics keep their timestamp", async () => {
  const previous = globalThis.chrome;
  const tab = { id: 1, url: "https://editor.test/", title: "", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  const metrics = { jsHeapBytes: 2048, domNodes: 38, mediaNodes: 1, weightMultiplier: 1.01, sampledAt: 1000 };
  const cache = { "tabReaper.weightSamples": {
    1: { ...metrics, hasUnsavedForm: true }, 2: { ...metrics, hasUnsavedForm: false },
  } };
  const inspections: number[] = [];
  let dirty = true;
  let blocked = false;
  try {
    Object.assign(globalThis, { chrome: {
      permissions: { contains: async () => true },
      storage: { session: {
        get: async () => structuredClone(cache),
        set: async (update: typeof cache) => Object.assign(cache, structuredClone(update)),
      } },
      scripting: { executeScript: async ({ target, args }: { target: { tabId: number; allFrames: boolean }; args: boolean[] }) => {
        expect(target.allFrames).toBe(true);
        expect(args).toEqual([false]);
        inspections.push(target.tabId);
        if (blocked) throw new Error("Page unavailable");
        return [{ frameId: 0, result: false }, { frameId: 1, result: dirty }];
      } },
    } });
    // Revoked access still permits previously measured memory to be displayed.
    expect((await loadCachedWeights(1100)).get(1)).toEqual({ ...metrics, hasUnsavedForm: false });
    const sample = async () => (await sampleTabWeights([tab, { ...tab, id: 2 }], 1100)).get(1);
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true });
    blocked = true;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true });
    blocked = false;
    dirty = false;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: false });
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: false });
    dirty = true;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true });
    expect(inspections).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    inspections.length = 0;
    expect((await sampleTabWeights([tab], 1100, false)).get(1)).toEqual({ ...metrics, hasUnsavedForm: false });
    expect(inspections).toEqual([]);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("an unavailable live check preserves a recent observed edit before discard", async () => {
  const previous = globalThis.chrome;
  try {
    const sample = { sampledAt: Date.now(), hasUnsavedForm: true };
    Object.assign(globalThis, { chrome: {
      scripting: { executeScript: async () => { throw new Error("Frame unavailable"); } },
      permissions: { contains: async () => true },
      storage: { session: { get: async () => ({ "tabReaper.weightSamples": { 1: sample } }) } },
    } });
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
    sample.sampledAt -= 121_000;
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});
