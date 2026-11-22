import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";

const extension = path.resolve(import.meta.dir, "../dist");
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const options = await context.newPage();
  await options.goto(new URL("options.html", worker.url()).href);
  await options.getByRole("link", { name: "Protections", exact: true }).click();
  assert.equal(new URL(options.url()).hash, "#protections");

  // First install opens Settings with the Quick setup card.
  await options.locator("#setup-card").waitFor({ state: "visible" });
  assert.equal(await options.locator("#setup-card .setup-step").count(), 3);
  await options.setViewportSize({ width: 320, height: 700 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await options.setViewportSize({ width: 1024, height: 720 });
  await options.locator("#btn-setup-dismiss").click();
  assert.ok(await options.locator("#setup-card").isHidden());

  // Without the Local Companion there is no Chrome budget: Settings shows the pressure thresholds instead.
  await options.locator("#memory-now").filter({ hasText: "free" }).waitFor();
  assert.ok(await options.locator("#budget-fields").isHidden());
  assert.match(await options.locator("#memory-now").innerText(), /drops to \d+ MB/);

  const startupSweep = options.locator("#startup-sweep");
  const startupBefore = await startupSweep.isChecked();
  await startupSweep.setChecked(!startupBefore);
  await options.getByRole("button", { name: "Save settings", exact: true }).click();
  await options.locator("#save-status.ok").waitFor();
  await options.reload();
  await options.locator("#memory-now").filter({ hasText: "free" }).waitFor();
  assert.ok(await options.locator("#setup-card").isHidden(), "Dismissed setup card must stay hidden after reload");
  assert.equal(await startupSweep.isChecked(), !startupBefore);

  await options.setViewportSize({ width: 320, height: 700 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const longTitle = "Project notes for the November platform planning meeting with the application and infrastructure teams";
  await options.setViewportSize({ width: 1024, height: 720 });
  await worker.evaluate(() => chrome.action.openPopup());
  await options.waitForFunction(() => chrome.extension.getViews({ type: "popup" })[0]?.document.querySelector(".tab-item"));
  const toolbarWidth = await options.evaluate(() => {
    const popup = chrome.extension.getViews({ type: "popup" })[0]!;
    const width = popup.innerWidth;
    popup.close();
    return width;
  });
  assert.ok(toolbarWidth > 460 && toolbarWidth <= 800, "The toolbar popup itself should open wider");

  await context.route("https://work.example.test/**", route => {
    const id = new URL(route.request().url()).pathname.slice(1);
    const title = id === "0" ? longTitle : `Project notes ${id}`;
    return route.fulfill({ contentType: "text/html", body: `<title>${title}</title>` });
  });
  for (let i = 0; i < 9; i++) {
    const tab = await context.newPage();
    await tab.goto(`https://work.example.test/${i}`);
  }

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 800, height: 600 });
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator(".tab-item").first().waitFor();
  assert.match(await popup.locator("#memory-badge").innerText(), /^(Normal|Moderate|Critical) · [\d.]+ GB free$/);
  assert.ok(await popup.locator(".bar-track").isHidden());
  const search = popup.getByRole("combobox", { name: "Search open tabs" });
  await search.fill("no matching tab");
  assert.ok(await popup.locator(".empty").isVisible());

  await search.fill("work.example.test");
  assert.equal(await popup.getByRole("option").count(), 9);
  assert.equal(await popup.evaluate(() => document.body.offsetWidth), toolbarWidth);
  const loaded = popup.getByRole("group", { name: "Loaded", exact: true });
  const sleeping = popup.getByRole("group", { name: "Sleeping", exact: true });
  assert.equal(await loaded.getByRole("option").count(), 9);
  assert.equal(await sleeping.count(), 0);
  const title = loaded.getByText(longTitle, { exact: true });
  assert.equal(await title.getAttribute("title"), longTitle);
  assert.ok(await title.evaluate(el => {
    const height = el.getBoundingClientRect().height;
    const line = parseFloat(getComputedStyle(el).lineHeight);
    return height > line && height <= 2 * line + 1 && el.scrollWidth <= el.clientWidth;
  }), "Long titles should wrap within the space beside the actions");

  await loaded.getByRole("option", { name: /Project notes 3/ }).getByRole("button", { name: "Sleep", exact: true }).click();
  const sleeper = sleeping.getByRole("option", { name: /Project notes 3/ });
  await sleeper.waitFor();
  assert.equal(await loaded.getByRole("option").count(), 8);
  for (const colorScheme of ["light", "dark"] as const) {
    await popup.emulateMedia({ colorScheme });
    const awakeColor = await title.evaluate(el => getComputedStyle(el).color);
    const sleepColor = await sleeper.locator(".item-title").evaluate(el => getComputedStyle(el).color);
    assert.notEqual(sleepColor, awakeColor, `Sleeping titles should be distinct in ${colorScheme} mode`);
  }
  await search.fill("Project notes 3");
  assert.equal(await loaded.count(), 0);
  assert.equal(await sleeping.getByRole("option").count(), 1);
  await search.fill("work.example.test");
  await popup.evaluate(() => {
    (window as unknown as { rows: Element[] }).rows = [...document.querySelectorAll('[role="option"]')];
  });
  for (let i = 0; i < 8; i++) await search.press("ArrowDown");
  assert.ok(await popup.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="option"]')];
    const before = (window as unknown as { rows: Element[] }).rows;
    return rows.length === before.length && rows.every((row, i) => row === before[i]);
  }), "Arrow navigation should move the selection without rebuilding rows");
  const selected = popup.getByRole("option", { selected: true });
  assert.equal(await selected.count(), 1);
  assert.equal(await popup.locator(".tab-item.selected").count(), 1);
  assert.equal(await selected.getAttribute("id"), await sleeper.getAttribute("id"));
  assert.equal(await selected.getAttribute("id"), await search.getAttribute("aria-activedescendant"));
  assert.ok(await selected.evaluate(row => {
    const list = row.closest('[role="listbox"]')!.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1;
  }), "The selected tab must stay visible during keyboard navigation");

  await popup.setViewportSize({ width: 360, height: 600 });
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await search.press("Enter");
  await options.waitForFunction(async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active?.url === "https://work.example.test/3" && !active.discarded;
  });

  // Update banner appears in the popup when a newer release is cached and hides after dismissal.
  await worker.evaluate(() => chrome.storage.local.set({
    "tabReaper.updateState": {
      checkedAt: Date.now(),
      latestVersion: "99.0.0",
      releaseUrl: "https://github.com/marcusgrando/tab-reaper/releases/tag/v99.0.0",
    },
  }));
  const updatePopup = await context.newPage();
  await updatePopup.setViewportSize({ width: 580, height: 600 });
  await updatePopup.goto(new URL("popup.html", worker.url()).href);
  await updatePopup.locator("#update-banner").waitFor({ state: "visible" });
  assert.equal(await updatePopup.locator("#update-link").innerText(), "v99.0.0");
  await updatePopup.locator("#btn-dismiss-update").click();
  assert.ok(await updatePopup.locator("#update-banner").isHidden());
  await updatePopup.reload();
  await updatePopup.locator(".tab-item").first().waitFor();
  assert.ok(await updatePopup.locator("#update-banner").isHidden(), "Dismissed update banner must stay hidden");
  await updatePopup.close();

  console.log("Settings and tab palette passed in Chromium.");
} finally {
  await context.close();
}
