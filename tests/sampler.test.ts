import { expect, test } from "bun:test";
import { checkTabHasUnsavedForm } from "../src/background/sampler.ts";

test("live discard inspection recognizes external form controls and native default values", async () => {
  const globals = ["chrome", "location", "document"] as const;
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const visible = { offsetHeight: 16, offsetWidth: 100, closest: () => null, getAttribute: () => null };
  const input = (type: string, value: string, defaultValue: string, pristine = defaultValue) => ({
    ...visible, tagName: "INPUT", type, value, defaultValue, cloneNode: () => ({
      get value() { return pristine; }, set value(_v: string) {},
    }),
  });
  const options = [{ selected: true, defaultSelected: false, disabled: false, closest: () => null }];
  const select = { ...visible, tagName: "SELECT", selectedIndex: 0, options, size: 3 };
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
    expect(await checkTabHasUnsavedForm(1)).toBe(true);
    select.selectedIndex = -1;
    expect(await checkTabHasUnsavedForm(1)).toBe(false);
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
