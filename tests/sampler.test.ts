import { expect, test } from "bun:test";
import { checkTabHasUnsavedForm, loadCachedWeights, sampleTabWeights } from "../src/background/sampler.ts";

test("live discard inspection recognizes external form controls and native default values", async () => {
  const globals = ["chrome", "location", "document"] as const;
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const visible = { checkVisibility: () => true, offsetHeight: 16, offsetWidth: 100, closest: () => null, getAttribute: () => null };
  const input = (type: string, value: string, defaultValue: string, pristine = defaultValue) => ({
    ...visible, tagName: "INPUT", type, value, defaultValue, cloneNode: () => ({
      get value() { return pristine; }, set value(_v: string) {},
    }),
  });
  const options = [{ selected: true, defaultSelected: false, disabled: false, closest: () => null }];
  const select = { ...visible, form: null as object | null, tagName: "SELECT", selectedIndex: 0, options, size: 3 };
  type Control = ReturnType<typeof input> | typeof select;
  let controls: Control[] = [];
  const form = { get elements() { return controls; }, querySelectorAll: (tag: string) =>
    controls.filter(c => c.tagName === tag.toUpperCase() && !("external" in c)) };
  try {
    Object.assign(globalThis, {
      location: { hostname: "editor.test" },
      document: { querySelectorAll: (tag: string) => tag === "form" ? [form] :
        controls.filter(c => tag.split(/,\s*/).includes(c.tagName.toLowerCase())) },
      chrome: { permissions: { contains: async () => true }, scripting: {
        executeScript: async ({ func, args }: { func: (metrics: boolean) => boolean; args: [boolean] }) =>
          [{ frameId: 0, result: func(...args) }],
      } },
    });
    controls = [Object.assign(input("text", "draft", ""), { external: true, form })];
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
    controls = [select];
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
    select.form = form;
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
    select.selectedIndex = -1;
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
    for (const type of ["checkbox", "radio"]) {
      const toggle = { ...input(type, "on", ""), checked: true, defaultChecked: false, form: null as object | null };
      controls = [toggle];
      expect(await checkTabHasUnsavedForm(1)).toBe(false);
      toggle.form = form;
      expect(await checkTabHasUnsavedForm(1)).toBe(true);
    }
    for (const hostname of ["docs.google.com", "editor.test"]) {
      Object.assign(globalThis, { location: { hostname } });
      controls = [input("text", "draft", "")];
      expect(await checkTabHasUnsavedForm(1)).toBe(true);
      controls = [{ ...input("text", "draft", ""), checkVisibility: () => false }];
      expect(await checkTabHasUnsavedForm(1)).toBe(false);
      controls = [];
      expect(await checkTabHasUnsavedForm(1)).toBe(false);
    }
    controls = [input("range", "50", "", "50"), input("color", "#000000", "", "#000000")];
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
    controls[0] = input("range", "75", "", "50");
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
  } finally {
    globals.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

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
    expect(inspections).toEqual([1, 1, 1]);
  } finally {
    Object.assign(globalThis, { chrome: previous });
  }
});
