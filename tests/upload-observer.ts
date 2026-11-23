import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import type { StatusPayload } from "../src/shared/types.ts";

const pendingReleases = new Map<string, () => void>();

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/uploader" || url.pathname === "/chat") {
      return new Response(
        `<!doctype html>
        <input id="hidden-file" type="file" style="display:none">
        <script>
          window.controllers = {};
          window.startFileUpload = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            const fd = new FormData();
            fd.append("file", document.getElementById("hidden-file").files[0]);
            return fetch("/hold/" + id, { method: "POST", body: fd, signal: ctrl.signal }).catch(() => "aborted");
          };
          window.startBlobPut = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            return fetch("/hold/" + id, {
              method: "PUT",
              body: new Blob([new Uint8Array(80_000)], { type: "application/octet-stream" }),
              signal: ctrl.signal,
            }).catch(() => "aborted");
          };
          window.startTusPatch = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            return fetch("/hold/" + id, {
              method: "PATCH",
              headers: { "content-type": "application/offset+octet-stream", "upload-offset": "0" },
              body: new Uint8Array(4096),
              signal: ctrl.signal,
            }).catch(() => "aborted");
          };
          window.startRawBinaryPatch = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            return fetch("/hold/" + id, {
              method: "PATCH",
              body: new Uint8Array(80_000),
              signal: ctrl.signal,
            }).catch(() => "aborted");
          };
          window.startSmallJsonPost = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            return fetch("/hold/" + id, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ping: true }),
              signal: ctrl.signal,
            }).catch(() => "aborted");
          };
          window.startLongGet = (id) => {
            const ctrl = new AbortController();
            window.controllers[id] = ctrl;
            return fetch("/hold/" + id, { method: "GET", signal: ctrl.signal }).catch(() => "aborted");
          };
          window.abortRequest = (id) => window.controllers[id]?.abort();
        </script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname.startsWith("/hold/")) {
      const id = url.pathname.slice("/hold/".length);
      if (req.method !== "GET") {
        await req.arrayBuffer().catch(() => {});
      }
      await new Promise<void>((resolve) => {
        pendingReleases.set(id, resolve);
      });
      pendingReleases.delete(id);
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

const baseUrl = `http://127.0.0.1:${server.port}`;
const cache = path.join(homedir(), ".cache", "tab-reaper");
await mkdir(cache, { recursive: true });
const dir = await mkdtemp(path.join(cache, "upload-test-"));
const sampleFile = path.join(dir, "clip.bin");
await writeFile(sampleFile, new Uint8Array(70_000));
const extension = path.join(dir, "extension");
const launch = () =>
  chromium.launchPersistentContext(path.join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });

let context: BrowserContext | undefined;
try {
  // Seed a disposable profile with scripting + webRequest + <all_urls>. Run assertions with the shipping manifest.
  await cp(path.resolve(import.meta.dir, "../dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const original = await readFile(manifestPath, "utf8");
  const seed = JSON.parse(original);
  seed.permissions.push("scripting", "webRequest");
  seed.optional_permissions = seed.optional_permissions.filter((p: string) => p !== "scripting" && p !== "webRequest");
  seed.host_permissions = seed.optional_host_permissions;
  delete seed.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(seed));
  context = await launch();
  const setup = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await setup.evaluate(() =>
    chrome.storage.local.set({
      "tabReaper.config": {
        protectUnsavedForms: false,
        protectActiveUploads: false,
        startupSweep: false,
        memoryBudgetMode: "fixed_gb",
        memoryBudgetGb: 512,
      },
    }),
  );
  await context.close();
  await writeFile(manifestPath, original);

  context = await launch();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const options = await context.newPage();
  await options.goto(new URL("options.html", worker.url()).href);

  const waitHeld = async (id: string) => {
    const deadline = Date.now() + 5000;
    while (!pendingReleases.has(id) && Date.now() < deadline) await Bun.sleep(20);
    assert.ok(pendingReleases.has(id), `Expected server to receive held request ${id}`);
  };
  const release = (id: string) => {
    pendingReleases.get(id)?.();
  };
  const getTab = async (address: string) => {
    const status = (await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "get_status" }),
    )) as StatusPayload;
    return status.openTabs.find((t) => t.url === address)!;
  };
  const waitUploadState = async (address: string, expected: boolean, why: string) => {
    const deadline = Date.now() + 4000;
    let tab = await getTab(address);
    while (tab.hasActiveUpload !== expected && Date.now() < deadline) {
      await Bun.sleep(40);
      tab = await getTab(address);
    }
    assert.equal(tab.hasActiveUpload, expected, why);
    return tab;
  };
  const setProtectUploads = async (enabled: boolean) => {
    await options.evaluate(
      (protectActiveUploads) =>
        chrome.runtime.sendMessage({ type: "save_config", config: { protectActiveUploads } }),
      enabled,
    );
  };

  const uploaderUrl = `${baseUrl}/uploader`;
  const uploader = await context.newPage();
  await uploader.goto(uploaderUrl);
  await uploader.setInputFiles("#hidden-file", sampleFile);

  // 1. Off by default: in-flight upload must NOT protect the tab while protectActiveUploads is false.
  await options.bringToFront();
  await uploader.evaluate(() => {
    void (window as unknown as { startFileUpload(id: string): Promise<unknown> }).startFileUpload("off-1");
  });
  await waitHeld("off-1");
  const whileOff = await getTab(uploaderUrl);
  assert.equal(whileOff.hasActiveUpload, false, "upload protection must stay off by default");
  assert.equal(whileOff.protectedReason, null);
  release("off-1");
  await Bun.sleep(100);

  // 2. Enable protectActiveUploads: hidden file input upload protects the tab and blocks discard.
  await setProtectUploads(true);
  await uploader.evaluate(() => {
    void (window as unknown as { startFileUpload(id: string): Promise<unknown> }).startFileUpload("file-1");
  });
  await waitHeld("file-1");
  const duringFile = await waitUploadState(uploaderUrl, true, "hidden file FormData upload should be detected");
  assert.equal(duringFile.protectedReason, "Upload");
  assert.equal(duringFile.canSleep, false);
  assert.deepEqual(
    await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: "discard_tab", tabId }), duringFile.id),
    { ok: false },
    "uploading tab must not be discarded",
  );
  // After completion, chunk cooldown keeps the tab protected briefly.
  release("file-1");
  await Bun.sleep(150);
  const afterComplete = await getTab(uploaderUrl);
  assert.equal(afterComplete.hasActiveUpload, true, "completed upload should stay protected during chunk cooldown");

  // 3. Aborted PUT Blob chunk clears protection immediately (no cooldown on error/abort).
  const blobUrl = `${baseUrl}/uploader?mode=blob`;
  const blobTab = await context.newPage();
  await blobTab.goto(blobUrl);
  await options.bringToFront();
  await blobTab.evaluate(() => {
    void (window as unknown as { startBlobPut(id: string): Promise<unknown> }).startBlobPut("blob-1");
  });
  await waitHeld("blob-1");
  const duringBlob = await waitUploadState(blobUrl, true, "PUT Blob upload should be detected");
  assert.equal(duringBlob.protectedReason, "Upload");
  await blobTab.evaluate(() => {
    (window as unknown as { abortRequest(id: string): void }).abortRequest("blob-1");
  });
  release("blob-1");
  await waitUploadState(blobUrl, false, "aborted upload should clear protection immediately");
  await blobTab.close();

  // 4. Resumable tus PATCH and raw binary Uint8Array PATCH (without Content-Type) are detected.
  const patchUrl = `${baseUrl}/uploader?mode=patch`;
  const patchTab = await context.newPage();
  await patchTab.goto(patchUrl);
  await options.bringToFront();
  await patchTab.evaluate(() => {
    void (window as unknown as { startTusPatch(id: string): Promise<unknown> }).startTusPatch("patch-1");
  });
  await waitHeld("patch-1");
  await waitUploadState(patchUrl, true, "tus PATCH upload should be detected");
  await patchTab.evaluate(() => {
    (window as unknown as { abortRequest(id: string): void }).abortRequest("patch-1");
  });
  release("patch-1");
  await waitUploadState(patchUrl, false, "aborted PATCH should clear");

  await patchTab.evaluate(() => {
    void (window as unknown as { startRawBinaryPatch(id: string): Promise<unknown> }).startRawBinaryPatch("patch-bin");
  });
  await waitHeld("patch-bin");
  const duringRawPatch = await waitUploadState(patchUrl, true, "raw binary PATCH without Content-Type should be detected");
  assert.deepEqual(
    await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: "discard_tab", tabId }), duringRawPatch.id),
    { ok: false },
    "tab with in-flight raw binary PATCH must not be discarded",
  );
  await patchTab.evaluate(() => {
    (window as unknown as { abortRequest(id: string): void }).abortRequest("patch-bin");
  });
  release("patch-bin");
  await waitUploadState(patchUrl, false, "aborted raw binary PATCH should clear");
  await patchTab.close();

  // 5. Small JSON POST + long-lived GET (polling/SSE) must NOT block sleeping.
  const chatUrl = `${baseUrl}/chat`;
  const chatTab = await context.newPage();
  await chatTab.goto(chatUrl);
  await options.bringToFront();
  await chatTab.evaluate(() => {
    void (window as unknown as { startSmallJsonPost(id: string): Promise<unknown> }).startSmallJsonPost("json-1");
    void (window as unknown as { startLongGet(id: string): Promise<unknown> }).startLongGet("get-1");
  });
  await Promise.all([waitHeld("json-1"), waitHeld("get-1")]);
  await Bun.sleep(150);
  const chatStatus = await getTab(chatUrl);
  assert.equal(chatStatus.hasActiveUpload, false, "small JSON POST and long GET must not look like uploads");
  assert.equal(chatStatus.protectedReason, null);
  assert.equal(chatStatus.canSleep, true);
  assert.deepEqual(
    await options.evaluate((tabId) => chrome.runtime.sendMessage({ type: "discard_tab", tabId }), chatStatus.id),
    { ok: true },
    "tab with only small JSON POST / long GET should still sleep",
  );
  release("json-1");
  release("get-1");

  // 6. Disabling protectActiveUploads clears active protection immediately.
  await setProtectUploads(false);
  await waitUploadState(uploaderUrl, false, "disabling protectActiveUploads should clear active protection");

  // 7. Unchecking #protect-uploads in Settings revokes webRequest while keeping <all_urls> for Weighted Eviction,
  // and unchecking both Weighted Eviction and unsaved forms revokes scripting + <all_urls>.
  await setProtectUploads(true);
  await options.reload();
  await options.locator("#protect-uploads").waitFor();
  assert.equal(await options.locator("#protect-uploads").isChecked(), true);
  assert.equal(await options.locator("#weighted-eviction").isChecked(), true);
  await options.locator("#protect-uploads").uncheck();
  await options.waitForFunction(async () => !(await chrome.permissions.contains({ permissions: ["webRequest"] })));
  const hostStillGranted = await options.evaluate(() =>
    chrome.permissions.contains({ permissions: ["scripting"], origins: ["<all_urls>"] }),
  );
  assert.equal(hostStillGranted, true, "turning off upload protection must not revoke <all_urls> used by Weighted Eviction");

  await options.locator("#weighted-eviction").uncheck();
  await options.waitForFunction(
    async () => !(await chrome.permissions.contains({ permissions: ["scripting"], origins: ["<all_urls>"] })),
  );

  console.log("Upload protection passed in Chromium.");
} finally {
  for (const rel of pendingReleases.values()) rel();
  await context?.close();
  server.stop();
  await rm(dir, { recursive: true, force: true });
}
