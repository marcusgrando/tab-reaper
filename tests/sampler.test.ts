import { expect, test } from "bun:test";
import { checkTabHasUnsavedForm, checkTabLiveProtection, loadCachedWeights, sampleTabFormsOnly, sampleTabWeights } from "../src/background/sampler.ts";

test("cached form, sharing, and PiP protection follow live frame results without caching transient visibility", async () => {
  const previous = globalThis.chrome;
  const tab = { id: 1, url: "https://editor.test/", title: "", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  const metrics = { jsHeapBytes: 2048, domNodes: 38, mediaNodes: 1, weightMultiplier: 1.01, sampledAt: 1000 };
  const cache = { "tabCurb.weightSamples": {
    1: { ...metrics, hasUnsavedForm: true }, 2: { ...metrics, hasUnsavedForm: false },
  } };
  const inspections: Array<{ tabId: number; args: boolean[] }> = [];
  let dirty = true;
  let visible = false;
  let pip = false;
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
        expect(args[0]).toBe(false);
        inspections.push({ tabId: target.tabId, args });
        if (blocked) throw new Error("Page unavailable");
        const protectForms = args[1] !== false;
        return [
          { frameId: 0, result: { hasUnsavedForm: false, isVisible: target.tabId === 1 ? visible : false, hasPictureInPicture: false } },
          { frameId: 1, result: { hasUnsavedForm: protectForms && dirty, isVisible: false, hasPictureInPicture: target.tabId === 1 ? pip : false } },
        ];
      } },
    } });
    // Revoked access still permits previously measured memory to be displayed.
    expect((await loadCachedWeights(1100)).get(1)).toEqual({ ...metrics, hasUnsavedForm: false });
    const sample = async () => (await sampleTabWeights([tab, { ...tab, id: 2 }], 1100)).get(1);
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false });
    blocked = true;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false });
    blocked = false;
    dirty = false;
    visible = true;
    pip = true;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: false, isVisible: true, hasPictureInPicture: true });
    // Transient visibility and PiP flags must never be persisted in the 2-minute weight cache.
    expect(cache["tabCurb.weightSamples"][1]).toEqual({ ...metrics, hasUnsavedForm: false });
    visible = false;
    pip = false;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false });
    dirty = true;
    expect(await sample()).toEqual({ ...metrics, hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false });
    expect(inspections.map(entry => entry.tabId)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    inspections.length = 0;

    // Even when protectUnsavedForms is false, live visibility/PiP checks still run for palette status.
    visible = true;
    expect((await sampleTabWeights([tab], 1100, false)).get(1)).toEqual({
      ...metrics, hasUnsavedForm: false, isVisible: true, hasPictureInPicture: false,
    });
    expect(inspections).toEqual([{ tabId: 1, args: [false, false] }]);
    inspections.length = 0;

    // With refreshFormState=false, cached dirty tabs stay eligible for size-band ranking without probing frames,
    // while keeping the cached dirty flag intact as fallback for checkTabLiveProtection.
    cache["tabCurb.weightSamples"][1] = { ...metrics, hasUnsavedForm: true };
    expect((await sampleTabWeights([tab], 1100, true, false)).get(1)).toEqual({ ...metrics, hasUnsavedForm: false });
    expect(inspections).toEqual([]);
    expect(cache["tabCurb.weightSamples"][1].hasUnsavedForm).toBe(true);
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
      storage: { session: { get: async () => ({ "tabCurb.weightSamples": { 1: sample } }) } },
    } });
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
    expect(await checkTabLiveProtection(1, true)).toEqual({
      hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false, timedOut: false,
    });
    expect(await checkTabLiveProtection(1, false)).toEqual({
      hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false, timedOut: false,
    });
    sample.sampledAt -= 121_000;
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("saving samples drops tabs that were closed", async () => {
  const previous = globalThis.chrome;
  const metrics = { jsHeapBytes: 2048, domNodes: 38, mediaNodes: 0, weightMultiplier: 1.01, hasUnsavedForm: false, sampledAt: 1000 };
  const cache: Record<string, Record<string, unknown>> = { "tabCurb.weightSamples": { 1: metrics, 7: metrics, 9: metrics } };
  const tab = { id: 1, url: "https://editor.test/", title: "", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  try {
    Object.assign(globalThis, { chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 1 }, { id: 7 }] },
      storage: { session: {
        get: async () => structuredClone(cache),
        set: async (update: typeof cache) => Object.assign(cache, structuredClone(update)),
      } },
      scripting: { executeScript: async () => [{ frameId: 0, result: { hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false } }] },
    } });
    await sampleTabWeights([tab], 1100);
    expect(Object.keys(cache["tabCurb.weightSamples"]!).sort()).toEqual(["1", "7"]);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("fresh page sampling aggregates DOM and media across frames and deduplicates JS heap by origin", async () => {
  const previous = globalThis.chrome;
  const MiB = 1024 * 1024;
  const cache: Record<string, Record<string, unknown>> = {};
  const tab = { id: 1, url: "https://app.example.test/", title: "App", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  try {
    Object.assign(globalThis, { chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 1 }] },
      storage: { session: {
        get: async () => structuredClone(cache),
        set: async (update: typeof cache) => Object.assign(cache, structuredClone(update)),
      } },
      scripting: { executeScript: async () => [
        // Top frame on https://app.example.test
        { frameId: 0, result: { jsHeapBytes: 50 * MiB, domNodes: 1200, mediaNodes: 1, origin: "https://app.example.test", hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } },
        // Same-origin iframe shares V8 isolate: keep max heap (55 MiB), do not double-count, sum DOM/media.
        { frameId: 1, result: { jsHeapBytes: 55 * MiB, domNodes: 400, mediaNodes: 1, origin: "https://app.example.test", hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } },
        // Cross-origin iframe runs in its own isolate: sum its 80 MiB heap + DOM/media.
        { frameId: 2, result: { jsHeapBytes: 80 * MiB, domNodes: 900, mediaNodes: 2, origin: "https://embed.other.test", hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false } },
        // Opaque srcdoc/about:blank iframe: do not double-count its heap, still sum DOM/media.
        { frameId: 3, result: { jsHeapBytes: 55 * MiB, domNodes: 100, mediaNodes: 0, origin: "null", hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false } },
      ] },
    } });
    const sample = (await sampleTabWeights([tab], 2000)).get(1);
    expect(sample).toMatchObject({
      jsHeapBytes: 135 * MiB,
      domNodes: 2600,
      mediaNodes: 4,
      hasUnsavedForm: true,
      sampledAt: 2000,
    });
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("hung executeScript calls time out without stalling other tabs or discard checks", async () => {
  const previous = globalThis.chrome;
  const hungTab = { id: 1, url: "https://hung.test/", title: "Hung", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  const healthyTab = { id: 2, url: "https://ok.test/", title: "OK", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  const cache: Record<string, Record<string, unknown>> = {};
  try {
    Object.assign(globalThis, { chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 1 }, { id: 2 }] },
      storage: { session: {
        get: async () => structuredClone(cache),
        set: async (update: typeof cache) => Object.assign(cache, structuredClone(update)),
      } },
      scripting: { executeScript: ({ target }: { target: { tabId: number } }) => {
        if (target.tabId === 1) return new Promise(() => {}); // Never resolves (frozen renderer).
        return Promise.resolve([
          { frameId: 0, result: { jsHeapBytes: 1024, domNodes: 10, mediaNodes: 0, origin: "https://ok.test", hasUnsavedForm: true, isVisible: false, hasPictureInPicture: false } },
        ]);
      } },
    } });

    const t0 = Date.now();
    const weights = await sampleTabWeights([hungTab, healthyTab], 3000, true, true, 40);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(weights.has(1)).toBe(false);
    expect(weights.get(2)?.hasUnsavedForm).toBe(true);

    const t1 = Date.now();
    const forms = await sampleTabFormsOnly([hungTab, healthyTab], 3000, true, 40);
    expect(Date.now() - t1).toBeLessThan(500);
    expect(forms.has(1)).toBe(false);
    expect(forms.get(2)?.hasUnsavedForm).toBe(true);

    // Live pre-discard protection fails closed (timedOut: true) when inspection times out
    // so a momentarily busy page or slow third-party iframe never loses drafts, PiP, or sharing.
    const t2 = Date.now();
    const live = await checkTabLiveProtection(1, true, 40);
    expect(Date.now() - t2).toBeLessThan(500);
    expect(live).toEqual({ hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false, timedOut: true });
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});

test("slow third-party subframe falls back to main frame for ranking/status while keeping live discard fail-closed", async () => {
  const previous = globalThis.chrome;
  const tabWithSlowAd = { id: 1, url: "https://editor.test/", title: "Editor", windowId: 1, active: false, audible: false, pinned: false, discarded: false };
  const cache: Record<string, Record<string, unknown>> = {};
  let topFrameDirty = true;
  try {
    Object.assign(globalThis, { chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 1 }] },
      storage: { session: {
        get: async () => structuredClone(cache),
        set: async (update: typeof cache) => Object.assign(cache, structuredClone(update)),
      } },
      scripting: { executeScript: ({ target, args }: { target: { tabId: number; allFrames?: boolean; frameIds?: number[] }; args: boolean[] }) => {
        if (target.allFrames) return new Promise(() => {}); // Hung cross-origin ad iframe blocks allFrames.
        if (target.frameIds?.includes(0)) {
          const includeMetrics = args[0] === true;
          const protectForms = args[1] !== false;
          const base = { hasUnsavedForm: protectForms && topFrameDirty, isVisible: true, hasPictureInPicture: false };
          return Promise.resolve([{
            frameId: 0,
            result: includeMetrics ? { ...base, jsHeapBytes: 4096, domNodes: 25, mediaNodes: 1, origin: "https://editor.test" } : base,
          }]);
        }
        return Promise.resolve([]);
      } },
    } });

    const weights = await sampleTabWeights([tabWithSlowAd], 4000, true, true, 40);
    expect(weights.get(1)).toMatchObject({
      jsHeapBytes: 4096,
      domNodes: 25,
      mediaNodes: 1,
      hasUnsavedForm: true,
      isVisible: true,
    });

    const forms = await sampleTabFormsOnly([tabWithSlowAd], 4000, true, 40);
    expect(forms.get(1)).toMatchObject({ hasUnsavedForm: true, isVisible: true });

    // Even when the main frame itself has no draft, a hung subframe still marks timedOut: true
    // because the subframe could contain an unsaved form or Picture-in-Picture video.
    topFrameDirty = false;
    const live = await checkTabLiveProtection(1, true, 40);
    expect(live).toEqual({ hasUnsavedForm: false, isVisible: true, hasPictureInPicture: false, timedOut: true });
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});
