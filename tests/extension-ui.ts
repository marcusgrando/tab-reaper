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
  await options.getByRole("button", { name: "Save settings", exact: true }).click();
  await options.locator("#save-status.ok").waitFor();
  await options.reload();
  await options.locator("#fixed-gb-wrap").waitFor();
  assert.equal(await options.locator("#memory-mode").inputValue(), "fixed_gb");

  await options.setViewportSize({ width: 320, height: 700 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await context.route("https://work.example.test/**", route =>
    route.fulfill({ contentType: "text/html", body: "<title>Project notes</title>" })
  );
  for (let i = 0; i < 9; i++) {
    const tab = await context.newPage();
    await tab.goto(`https://work.example.test/${i}`);
  }

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 460, height: 600 });
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator(".tab-item").first().waitFor();
  const search = popup.getByRole("combobox", { name: "Search open tabs" });
  await search.fill("no matching tab");
  assert.ok(await popup.locator(".empty").isVisible());

  await search.fill("work.example.test");
  assert.equal(await popup.getByRole("option").count(), 9);
  for (let i = 0; i < 8; i++) await search.press("ArrowDown");
  const selected = popup.getByRole("option", { selected: true });
  assert.equal(await selected.getAttribute("id"), await search.getAttribute("aria-activedescendant"));
  assert.ok(await selected.evaluate(row => {
    const list = row.parentElement!.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1;
  }), "The selected tab must stay visible during keyboard navigation");

  console.log("Settings and tab palette passed in Chromium.");
} finally {
  await context.close();
}
