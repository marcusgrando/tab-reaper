import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import type { StatusPayload } from "../src/shared/types.ts";

const cache = path.join(homedir(), ".cache", "tab-reaper");
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(path.join(cache, "form-test-"));
const extension = path.join(dir, "extension");
const launch = () => chromium.launchPersistentContext(path.join(dir, "profile"), {
  channel: "chromium",
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let context: BrowserContext | undefined;
try {
  // Seed a disposable profile with page access. Run every assertion with the shipping manifest.
  await cp(path.resolve(import.meta.dir, "../dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const original = await readFile(manifestPath, "utf8");
  const seed = JSON.parse(original);
  seed.permissions.push("scripting");
  seed.optional_permissions = seed.optional_permissions.filter((p: string) => p !== "scripting");
  seed.host_permissions = seed.optional_host_permissions;
  delete seed.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(seed));
  context = await launch();
  const setup = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await setup.evaluate(() => chrome.storage.local.set({
    "tabReaper.config": { protectUnsavedForms: false, startupSweep: false, memoryBudgetMode: "fixed_gb", memoryBudgetGb: 512 },
  }));
  await context.close();
  await writeFile(manifestPath, original);
  context = await launch();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const options = await context.newPage();
  await options.goto(new URL("options.html", worker.url()).href);
  const url = "https://planner.example.test/";
  const child = "https://editor.example.test/";
  const chat = "https://chat.example.test/";
  await context.route(url, route => route.fulfill({ contentType: "text/html", body: `
    <input id="title"><input id="helper" style="width:0;height:0;padding:0;border:0">
    <form role="search"><input id="search"></form><input type="password"><input type="date"><input type="checkbox">
    <form id="draft"><button type="reset">Reset</button></form><input form="draft" type="checkbox" id="confirm">
    <input form="draft" type="radio" name="group" id="a" checked>
    <input form="draft" type="radio" name="group" id="b">
    <select form="draft" size="2"><option selected>A</option><option>B</option></select>
    <iframe src="${child}"></iframe>
    <script>document.querySelector("#title").value = "Existing plan";</script>` }));
  await context.route(child, route => route.fulfill({ contentType: "text/html", body: '<div contenteditable>Note</div>' }));
  // Chat composers clear themselves by script after sending.
  await context.route(chat, route => route.fulfill({ contentType: "text/html", body: `
    <textarea id="message"></textarea><div id="composer" contenteditable></div>
    <script>
      window.send = () => {
        document.querySelector("#message").value = "";
        document.querySelector("#composer").replaceChildren();
      };
    </script>` }));
  const page = await context.newPage();
  await page.goto(url);
  const debuggerSession = await context.newCDPSession(page);
  const { frameTree } = await debuggerSession.send("Page.getFrameTree");
  let isolatedWorld: number | undefined;
  const uncaughtExceptions: string[] = [];
  debuggerSession.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.name === "Tab Reaper" && context.auxData?.frameId === frameTree.frame.id) isolatedWorld = context.id;
  });
  debuggerSession.on("Runtime.executionContextsCleared", () => { isolatedWorld = undefined; });
  debuggerSession.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    uncaughtExceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  await debuggerSession.send("Runtime.enable");
  // Inspect the isolated world even after Chrome withdraws the extension's scripting API.
  // "idle" means installed but not yet authorized by the worker.
  const waitForObserver = async (expected: "missing" | "idle" | "active") => {
    const deadline = Date.now() + 3000;
    let state: unknown;
    do {
      const read = isolatedWorld && await debuggerSession.send("Runtime.evaluate", {
        contextId: isolatedWorld,
        expression: "(() => { const obs = globalThis[Symbol.for('tabReaper.formObserver')]; return obs ? (obs.active ? 'active' : 'idle') : 'missing'; })()",
      });
      state = read ? read.result.value : "missing";
      if (state === expected) return;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    assert.fail(`Observer is ${state}, expected ${expected}`);
  };
  const status = async (address = url) => {
    const result: StatusPayload = await options.evaluate(() => chrome.runtime.sendMessage({ type: "get_status" }));
    return result.openTabs.find(tab => tab.url === address)!;
  };
  const expectDirty = async (expected: boolean, why: string, address = url) =>
    assert.equal((await status(address)).hasUnsavedForm, expected, why);
  const configure = async (enabled: boolean) => {
    await options.evaluate(async protectUnsavedForms => {
      const key = "tabReaper.config";
      const values = await chrome.storage.local.get(key);
      await chrome.storage.local.set({ [key]: { ...values[key], protectUnsavedForms } });
    }, enabled);
    await options.waitForFunction(async expected =>
      (await chrome.scripting.getRegisteredContentScripts()).length === Number(expected), enabled);
    await waitForObserver(enabled ? "idle" : "missing");
  };
  const title = page.locator("#title");
  await expectDirty(false, "protection is off");
  await configure(true);
  const storageAccess = await debuggerSession.send("Runtime.evaluate", {
    contextId: isolatedWorld, awaitPromise: true,
    expression: "chrome.storage.local.get('tabReaper.config').then(() => true, () => false)",
  });
  assert.equal(storageAccess.result.value, false, "page observer cannot read profile data");
  await expectDirty(false, "app-populated title on an already open page");
  await title.evaluate((el: HTMLInputElement) => {
    el.value = "Restored plan";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await page.locator("[type=password]").fill("ignored");
  await page.locator("#helper").press("x");
  await page.locator("#search").press("x");
  await page.locator("[type=date]").fill("2026-11-22");
  await page.locator("[type=checkbox]").first().check();
  await expectDirty(false, "synthetic input, password and standalone filters");
  await Bun.sleep(200);
  await waitForObserver("idle");
  await title.press("End");
  await waitForObserver("active");
  await title.press("x");
  await expectDirty(true, "first real edit after a cached clean sample");
  await options.bringToFront();
  const { id } = await status();
  assert.deepEqual(await options.evaluate(tabId => chrome.runtime.sendMessage({ type: "discard_tab", tabId }), id), { ok: false });
  await page.bringToFront();
  await title.press("ControlOrMeta+z");
  await expectDirty(false, "undo restored the pre-edit value");
  await page.locator("#confirm").check();
  await expectDirty(true, "external form checkbox");
  await page.locator("#confirm").uncheck();
  await expectDirty(false, "checkbox restored");
  await page.locator("#confirm").check();
  await page.getByRole("button", { name: "Reset" }).click();
  assert.equal(await page.locator("#confirm").isChecked(), false);
  await options.waitForFunction(async id => {
    const status: StatusPayload = await chrome.runtime.sendMessage({ type: "get_status" });
    return status.openTabs.find(tab => tab.id === id)?.hasUnsavedForm === false;
  }, id, { timeout: 4000, polling: 100 });
  await page.locator("#b").check();
  await expectDirty(true, "radio group changed");
  await page.locator("#a").check();
  await expectDirty(false, "radio group restored");
  await page.locator("select").press("ArrowDown");
  assert.equal(await page.locator("select").inputValue(), "B");
  await expectDirty(true, "form selection changed");
  await page.locator("select").press("ArrowUp");
  await expectDirty(false, "selection restored");
  const editor = page.frameLocator("iframe").locator("[contenteditable]");
  await editor.press("End");
  await editor.press("x");
  await expectDirty(true, "trusted edit in a cross-origin frame");
  await editor.press("Backspace");
  await expectDirty(false, "frame editor restored");
  await editor.fill("");
  await editor.fill("Note");
  await expectDirty(false, "rich text restored after replacing its contents");
  await title.press("End");
  await title.press("x");
  await title.evaluate(el => el.replaceWith(el.cloneNode(true)));
  await expectDirty(true, "redrawing the control preserves a pending draft");
  const chatPage = await context.newPage();
  await chatPage.goto(chat);
  const message = chatPage.locator("#message");
  const composer = chatPage.locator("#composer");
  await message.fill("Ship it");
  await composer.pressSequentially("Shipped");
  await expectDirty(true, "unsent chat drafts", chat);
  await chatPage.evaluate(() => (window as unknown as { send(): void }).send());
  await expectDirty(false, "the app cleared both composers after sending", chat);
  await message.fill("Next");
  await composer.pressSequentially("Next");
  await expectDirty(true, "a new draft after the app cleared the composers", chat);
  await composer.evaluate(el => el.replaceChildren());
  await expectDirty(true, "the textarea draft is still pending", chat);
  await message.evaluate((el: HTMLTextAreaElement) => { el.value = ""; });
  await expectDirty(false, "both composers cleared", chat);
  await chatPage.close();
  await page.bringToFront();
  await configure(false);
  await title.press("y");
  await configure(true);
  await expectDirty(false, "re-enabling starts fresh on an open page");
  await page.reload();
  await waitForObserver("idle");
  await expectDirty(false, "app-populated title on a newly registered document");
  await title.press("End");
  await title.press("x");
  await expectDirty(true, "edits observed after navigation");
  await page.reload();
  await waitForObserver("idle");
  await debuggerSession.send("Runtime.evaluate", {
    contextId: isolatedWorld,
    expression: "delete chrome.runtime",
  });
  await title.press("End");
  await title.press("x");
  assert.deepEqual(uncaughtExceptions, [], "missing chrome.runtime does not throw");
  await waitForObserver("missing");
  await page.reload();
  await waitForObserver("idle");
  await debuggerSession.send("Runtime.evaluate", {
    contextId: isolatedWorld,
    expression: "delete chrome.runtime.id",
  });
  await title.press("End");
  await title.press("x");
  assert.deepEqual(uncaughtExceptions, [], "invalidated chrome.runtime.id does not throw");
  await waitForObserver("missing");
  await page.reload();
  await waitForObserver("idle");
  await debuggerSession.send("Runtime.evaluate", {
    contextId: isolatedWorld,
    expression: "chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); }",
  });
  await title.press("End");
  await title.press("x");
  await waitForObserver("missing");
  assert.deepEqual(uncaughtExceptions, [], "synchronous sendMessage failure tears down without unhandled rejections");
  await page.reload();
  await waitForObserver("idle");

  // Security regressions: DOM clobbering cannot forge PiP, block observer install, or crash radio forms.
  const httpPipUrl = "http://clobber-pip.example.test/";
  await context.route(httpPipUrl, route => route.fulfill({
    contentType: "text/html",
    body: `<form id="documentPictureInPicture"><input name="window"></form>`,
  }));
  const httpPipPage = await context.newPage();
  await httpPipPage.goto(httpPipUrl);

  const clobberObsUrl = "https://clobber-obs.example.test/";
  await context.route(clobberObsUrl, route => route.fulfill({
    contentType: "text/html",
    body: `<div id="tabReaperFormObserver"></div><input id="draft"><form><input name="elements"><input type="radio" name="grp" id="r1"><input type="radio" name="grp" id="r2"></form>`,
  }));
  await configure(false);
  const clobberObsPage = await context.newPage();
  const cdpClobber = await context.newCDPSession(clobberObsPage);
  const clobberExceptions: string[] = [];
  cdpClobber.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    clobberExceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  await cdpClobber.send("Runtime.enable");
  await clobberObsPage.goto(clobberObsUrl);
  await configure(true);
  await clobberObsPage.locator("#r1").click();
  await clobberObsPage.locator("#draft").fill("edited");
  assert.deepEqual(clobberExceptions, [], "DOM clobbering must not cause uncaught exceptions in form-observer");

  // Security regression: a hung background tab must not freeze get_status beyond the script timeout.
  const hungUrl = "https://hung-tab.example.test/";
  await context.route(hungUrl, route => route.fulfill({ contentType: "text/html", body: "<h1>busy</h1>" }));
  const hungPage = await context.newPage();
  await hungPage.goto(hungUrl);
  await options.bringToFront();

  const httpPipTab = await status(httpPipUrl);
  assert.equal(httpPipTab.protectedReason, null, "DOM clobbering on http:// must not forge PiP protection");
  assert.equal(httpPipTab.canSleep, true, "DOM-clobbered http:// tab must remain sleepable");
  await expectDirty(true, "DOM clobbering #tabReaperFormObserver and form[name=elements] must not break form protection", clobberObsUrl);

  hungPage.evaluate(() => { const end = Date.now() + 2500; while (Date.now() < end) {} }).catch(() => {});
  await Bun.sleep(100);
  const statusStart = Date.now();
  await options.evaluate(() => chrome.runtime.sendMessage({ type: "get_status" }));
  const elapsedMs = Date.now() - statusStart;
  assert.ok(elapsedMs < 1500, `Expected get_status to time out hung tab quickly, took ${elapsedMs}ms`);
  await Bun.sleep(2500);
  await httpPipPage.close();
  await clobberObsPage.close();
  await hungPage.close();
  await page.bringToFront();
  await page.reload();
  await waitForObserver("idle");

  await options.evaluate(() => chrome.permissions.remove({ permissions: ["scripting"] }));
  await waitForObserver("missing");
  await page.reload();
  await title.press("x");
  await waitForObserver("missing");
  await expectDirty(false, "revoking page access clears protection");
  assert.deepEqual(uncaughtExceptions, [], "no uncaught exceptions in page observer");
  console.log("Form protection passed in Chromium.");
} finally {
  await context?.close();
  await rm(dir, { recursive: true, force: true });
}
