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

  await options.locator("#memory-mode").selectOption("fixed_gb");
  assert.ok(await options.locator("#memory-gb").isVisible());
  await options.locator("#memory-gb").fill("512");
  await options.getByRole("button", { name: "Save settings", exact: true }).click();
  await options.locator("#save-status.ok").waitFor();
  await options.reload();
  await options.locator("#fixed-gb-wrap").waitFor();
  assert.equal(await options.locator("#memory-mode").inputValue(), "fixed_gb");

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
  for (let i = 0; i < 8; i++) await search.press("ArrowDown");
  const selected = popup.getByRole("option", { selected: true });
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

  console.log("Settings and tab palette passed in Chromium.");
} finally {
  await context.close();
}
