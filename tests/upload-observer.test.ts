import { describe, expect, test } from "bun:test";
import {
  ACTIVE_UPLOADS_STORAGE_KEY,
  MAX_TRACKED_INFLIGHT_UPLOADS,
  MAX_TRACKED_UPLOADS_PER_TAB,
  UPLOAD_CHUNK_COOLDOWN_MS,
  UPLOAD_INFLIGHT_MAX_AGE_MS,
  UPLOAD_MIN_BYTES,
  UPLOAD_TEXT_API_MIN_BYTES,
  bootstrapUploadObserver,
  checkTabHasActiveUpload,
  clearTabUploads,
  createEmptyUploadState,
  getUploadingTabIdsFromState,
  inspectUploadRequestBody,
  isTabUploading,
  isUploadRequest,
  pruneUploadState,
  reconcileUploadObserver,
  recordUploadFinish,
  recordUploadStart,
  replaceUploadTabId,
} from "../src/background/upload-observer.ts";

describe("upload request classification", () => {
  test("ignores GET/HEAD/DELETE/OPTIONS requests regardless of body or headers", () => {
    expect(inspectUploadRequestBody("GET", { raw: [{ file: "/tmp/a.bin" }] })).toEqual({ kind: "none" });
    expect(inspectUploadRequestBody("DELETE", { raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES) }] })).toEqual({
      kind: "none",
    });
    expect(
      isUploadRequest("GET", undefined, [
        { name: "Content-Type", value: "multipart/form-data; boundary=abc" },
        { name: "Content-Length", value: String(UPLOAD_MIN_BYTES * 4) },
      ]),
    ).toBe(false);
  });

  test("classifies requestBody shapes accurately", () => {
    expect(inspectUploadRequestBody("POST", undefined)).toEqual({ kind: "none" });
    expect(inspectUploadRequestBody("POST", { raw: [{ file: "/Users/me/video.mp4" }] })).toEqual({ kind: "file" });
    expect(inspectUploadRequestBody("PUT", { raw: [{ file: "/Users/me/archive.zip" }] })).toEqual({ kind: "file" });
    expect(inspectUploadRequestBody("POST", { raw: [{ bytes: new ArrayBuffer(512) }] })).toEqual({
      kind: "raw_bytes",
      totalBytes: 512,
    });
    expect(
      inspectUploadRequestBody("PUT", {
        raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES / 2) }, { bytes: new ArrayBuffer(UPLOAD_MIN_BYTES / 2) }],
      }),
    ).toEqual({ kind: "raw_bytes", totalBytes: UPLOAD_MIN_BYTES });
    expect(inspectUploadRequestBody("POST", { formData: { q: ["hello"] } })).toEqual({ kind: "form_fields" });
    expect(inspectUploadRequestBody("POST", { error: "Unknown error." })).toEqual({ kind: "opaque" });
  });

  test("detects real file, FormData Blob, raw binary, and opaque Blob/slice uploads", () => {
    expect(isUploadRequest("POST", { kind: "file" }, [])).toBe(true);
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: UPLOAD_MIN_BYTES },
        [],
      ),
    ).toBe(true);
    expect(
      isUploadRequest(
        "PUT",
        { kind: "raw_bytes", totalBytes: UPLOAD_MIN_BYTES },
        [{ name: "Content-Type", value: "application/octet-stream" }],
      ),
    ).toBe(true);
    // FormData containing a Blob produces boundary-only raw bytes without formData.
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: 190 },
        [{ name: "Content-Type", value: "multipart/form-data; boundary=----WebKitFormBoundary123" }],
      ),
    ).toBe(true);
    // PUT/POST Blob or file.slice() chunks emit requestBody.error ("opaque") with binary or omitted Content-Type.
    expect(isUploadRequest("PUT", { kind: "opaque" }, [])).toBe(true);
    expect(isUploadRequest("POST", { kind: "opaque" }, [])).toBe(true);
    expect(
      isUploadRequest("PUT", { kind: "opaque" }, [{ name: "Content-Type", value: "application/octet-stream" }]),
    ).toBe(true);
    expect(
      isUploadRequest("PUT", { kind: "opaque" }, [{ name: "Content-Type", value: "application/macbinary" }]),
    ).toBe(true);
    expect(
      isUploadRequest("PUT", { kind: "opaque" }, [{ name: "Content-Type", value: "video/mp4" }]),
    ).toBe(true);
    // Huge (>= 1 MiB) JSON payloads (e.g. base64 upload inside JSON) are still protected.
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: UPLOAD_TEXT_API_MIN_BYTES },
        [{ name: "Content-Type", value: "application/json" }],
      ),
    ).toBe(true);
  });

  test("ignores Gmail/SPA false positives: empty POSTs, text/JSON Blobs, text-only FormData, medium JSON syncs, and small binary RPCs", () => {
    // fetch(POST, { body: "" }) and xhr.send("") produce requestBody.error + text/plain;charset=UTF-8 in Chromium.
    expect(
      isUploadRequest("POST", { kind: "opaque" }, [{ name: "Content-Type", value: "text/plain;charset=UTF-8" }]),
    ).toBe(false);
    // Small JSON, form-urlencoded, and protobuf Blob POSTs also produce requestBody.error.
    expect(
      isUploadRequest("POST", { kind: "opaque" }, [{ name: "Content-Type", value: "application/json" }]),
    ).toBe(false);
    expect(
      isUploadRequest("POST", { kind: "opaque" }, [{ name: "Content-Type", value: "application/json+protobuf" }]),
    ).toBe(false);
    expect(
      isUploadRequest("POST", { kind: "opaque" }, [
        { name: "Content-Type", value: "application/x-www-form-urlencoded;charset=UTF-8" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequest("POST", { kind: "opaque" }, [{ name: "Content-Type", value: "application/grpc-web+proto" }]),
    ).toBe(false);
    // Text-only FormData sends multipart/form-data but onBeforeRequest parses it into formData.
    expect(
      isUploadRequest("POST", { kind: "form_fields" }, [
        { name: "Content-Type", value: "multipart/form-data; boundary=----WebKitFormBoundary123" },
      ]),
    ).toBe(false);
    // Bodyless POST/PUT requests are never uploads.
    expect(
      isUploadRequest("POST", { kind: "none" }, [{ name: "Content-Type", value: "application/octet-stream" }]),
    ).toBe(false);
    // Medium (< 1 MiB) JSON/text/form-urlencoded sync or log payloads are not file uploads.
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: 80 * 1024 },
        [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
      ),
    ).toBe(false);
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: 80 * 1024 },
        [{ name: "Content-Type", value: "text/plain;charset=UTF-8" }],
      ),
    ).toBe(false);
    // Small (< 64 KiB) raw binary RPCs with application/octet-stream are not file uploads.
    expect(
      isUploadRequest(
        "POST",
        { kind: "raw_bytes", totalBytes: 256 },
        [{ name: "Content-Type", value: "application/octet-stream" }],
      ),
    ).toBe(false);
    expect(
      isUploadRequest(
        "PUT",
        { kind: "raw_bytes", totalBytes: UPLOAD_MIN_BYTES - 1 },
        [],
      ),
    ).toBe(false);
  });

  test("detects header-only tus, Content-Range, binary, media, and raw binary PATCH uploads", () => {
    expect(
      isUploadRequest("POST", undefined, [
        { name: "Content-Type", value: "multipart/form-data; boundary=----WebKitFormBoundary123" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "content-type", value: "application/offset+octet-stream" },
        { name: "upload-offset", value: "0" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PUT", undefined, [
        { name: "Content-Range", value: "bytes 0-99999/200000" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PUT", undefined, [
        { name: "Content-Type", value: "application/octet-stream" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PUT", undefined, [
        { name: "Content-Type", value: "video/mp4" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "Content-Length", value: String(UPLOAD_MIN_BYTES) },
      ]),
    ).toBe(true);
    // Raw binary PATCH (e.g. Uint8Array / untyped Blob) omits Content-Type and Content-Length in webRequest.
    expect(isUploadRequest("PATCH", undefined, [])).toBe(true);
    expect(isUploadRequest("PATCH", undefined, undefined)).toBe(true);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "Accept", value: "*/*" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "Content-Type", value: "application/json" },
        { name: "Content-Length", value: "64" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "Content-Type", value: "text/plain;charset=UTF-8" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequest("PATCH", undefined, [
        { name: "Content-Length", value: "12" },
      ]),
    ).toBe(false);
  });
});

describe("upload state machine", () => {
  const t0 = 1_700_000_000_000;

  test("tracks in-flight uploads, bridges chunk gaps with cooldown, and expires cleanly", () => {
    let state = createEmptyUploadState();
    // Service Worker / background requests (tabId < 0) are ignored.
    expect(recordUploadStart(state, "sw-1", -1, t0)).toBe(state);

    state = recordUploadStart(state, "req-1", 10, t0);
    // Duplicate start for the same requestId is a no-op.
    expect(recordUploadStart(state, "req-1", 10, t0 + 100)).toBe(state);
    expect(isTabUploading(state, 10, t0 + 500)).toBe(true);
    expect(getUploadingTabIdsFromState(state, t0 + 500)).toEqual(new Set([10]));

    // Completing an untracked request leaves state untouched (referential equality).
    expect(recordUploadFinish(state, "unknown", t0 + 1000, true)).toBe(state);

    // Completing a tracked upload clears inFlight and starts the chunk cooldown.
    state = recordUploadFinish(state, "req-1", t0 + 1000, true);
    expect(state.inFlight).toEqual({});
    expect(isTabUploading(state, 10, t0 + 1000 + UPLOAD_CHUNK_COOLDOWN_MS - 1)).toBe(true);
    expect(isTabUploading(state, 10, t0 + 1000 + UPLOAD_CHUNK_COOLDOWN_MS)).toBe(false);
    expect(getUploadingTabIdsFromState(state, t0 + 1000 + UPLOAD_CHUNK_COOLDOWN_MS)).toEqual(new Set());
  });

  test("error/aborted upload clears inFlight without applying chunk cooldown", () => {
    let state = recordUploadStart(createEmptyUploadState(), "req-err", 12, t0);
    state = recordUploadFinish(state, "req-err", t0 + 500, false);
    expect(isTabUploading(state, 12, t0 + 500)).toBe(false);
  });

  test("keeps long-running (>2h) in-flight transfers protected while pruning closed tabs and expired cooldowns", () => {
    let state = recordUploadStart(createEmptyUploadState(), "long-open", 20, t0);
    state = recordUploadStart(state, "closed-tab", 21, t0);
    state = recordUploadStart(state, "done", 22, t0);
    state = recordUploadFinish(state, "done", t0 + 1000, true);

    const fourHoursLater = t0 + 4 * 60 * 60 * 1000;
    const prunedWithoutOpenList = pruneUploadState(state, fourHoursLater);
    expect(Object.keys(prunedWithoutOpenList.inFlight).sort()).toEqual(["closed-tab", "long-open"]);
    expect(prunedWithoutOpenList.cooldownUntilByTabId).toEqual({});
    expect(isTabUploading(prunedWithoutOpenList, 20, fourHoursLater)).toBe(true);
    expect(isTabUploading(prunedWithoutOpenList, 22, fourHoursLater)).toBe(false);

    const prunedWithOpenList = pruneUploadState(state, fourHoursLater, new Set([20, 22]));
    expect(Object.keys(prunedWithOpenList.inFlight)).toEqual(["long-open"]);
    expect(isTabUploading(prunedWithOpenList, 20, fourHoursLater)).toBe(true);
    expect(isTabUploading(prunedWithOpenList, 21, fourHoursLater)).toBe(false);
  });

  test("clears uploads when a tab closes and remaps tabId when Chrome replaces a tab", () => {
    let state = recordUploadStart(createEmptyUploadState(), "req-a", 30, t0);
    state = recordUploadStart(state, "req-b", 31, t0);
    state = recordUploadFinish(state, "req-b", t0 + 100, true);

    state = replaceUploadTabId(state, 30, 300);
    state = replaceUploadTabId(state, 31, 310);
    expect(isTabUploading(state, 30, t0 + 200)).toBe(false);
    expect(isTabUploading(state, 300, t0 + 200)).toBe(true);
    expect(isTabUploading(state, 310, t0 + 200)).toBe(true);

    state = clearTabUploads(state, 300);
    state = clearTabUploads(state, 310);
    expect(state).toEqual(createEmptyUploadState());
  });

  test("caps tracked in-flight uploads per tab and globally so one tab cannot exhaust state or starve others", () => {
    let state = createEmptyUploadState();
    for (let i = 0; i < MAX_TRACKED_UPLOADS_PER_TAB + 20; i++) {
      state = recordUploadStart(state, `flood-${i}`, 50, t0 + i);
    }
    expect(Object.keys(state.inFlight)).toHaveLength(MAX_TRACKED_UPLOADS_PER_TAB);

    // Another tab can still track uploads after tab 50 hits its per-tab cap.
    state = recordUploadStart(state, "other-tab-1", 51, t0 + 1000);
    expect(isTabUploading(state, 51, t0 + 1000)).toBe(true);

    // Global cap bounds total tracked in-flight requests across all tabs.
    let globalState = createEmptyUploadState();
    for (let i = 0; i < MAX_TRACKED_INFLIGHT_UPLOADS + 40; i++) {
      globalState = recordUploadStart(globalState, `g-${i}`, 100 + Math.floor(i / 2), t0 + i);
    }
    expect(Object.keys(globalState.inFlight)).toHaveLength(MAX_TRACKED_INFLIGHT_UPLOADS);
  });

  test("evicts oldest entry from the fullest tab at the global cap so noisy tabs cannot starve other tabs", () => {
    let state = createEmptyUploadState();
    const noisyTabCount = MAX_TRACKED_INFLIGHT_UPLOADS / MAX_TRACKED_UPLOADS_PER_TAB;
    for (let tab = 1; tab <= noisyTabCount; tab++) {
      for (let i = 0; i < MAX_TRACKED_UPLOADS_PER_TAB; i++) {
        state = recordUploadStart(state, `t${tab}-r${i}`, tab, t0 + tab * 1000 + i);
      }
    }
    expect(Object.keys(state.inFlight)).toHaveLength(MAX_TRACKED_INFLIGHT_UPLOADS);

    // A 9th tab must still get protected by evicting the oldest entry from the fullest tab (tab 1).
    state = recordUploadStart(state, "victim-legit-1", 99, t0 + 99_000);
    expect(Object.keys(state.inFlight)).toHaveLength(MAX_TRACKED_INFLIGHT_UPLOADS);
    expect(isTabUploading(state, 99, t0 + 99_000)).toBe(true);
    expect(state.inFlight["t1-r0"]).toBeUndefined();
    expect(isTabUploading(state, 1, t0 + 99_000)).toBe(true);

    // When 256 distinct tabs each hold only 1 upload, a 257th tab does not strip another tab's sole protection.
    let distinctState = createEmptyUploadState();
    for (let tab = 1; tab <= MAX_TRACKED_INFLIGHT_UPLOADS; tab++) {
      distinctState = recordUploadStart(distinctState, `solo-${tab}`, tab, t0 + tab);
    }
    const afterOverflow = recordUploadStart(distinctState, "solo-overflow", 999, t0 + 9999);
    expect(afterOverflow).toBe(distinctState);
  });

  test("persists a replacement upload started in the same batch as a finish at the per-tab cap", async () => {
    const previous = globalThis.chrome;
    const sessionData: Record<string, unknown> = {};
    const localData: Record<string, unknown> = { "tabCurb.config": { protectActiveUploads: true } };
    let onBeforeRequest: ((details: any) => void) | undefined;
    let onCompleted: ((details: any) => void) | undefined;
    try {
      Object.assign(globalThis, {
        chrome: {
          permissions: { contains: async () => true },
          tabs: { query: async () => [{ id: 70 }, { id: 71 }] },
          storage: {
            local: {
              get: async (key: string) => ({ [key]: localData[key] }),
              set: async (vals: Record<string, unknown>) => Object.assign(localData, vals),
            },
            session: {
              get: async (key: string) => ({ [key]: structuredClone(sessionData[key]) }),
              set: async (vals: Record<string, unknown>) => Object.assign(sessionData, structuredClone(vals)),
              remove: async (key: string) => { delete sessionData[key]; },
            },
          },
          webRequest: {
            onBeforeRequest: {
              addListener: (fn: any) => { onBeforeRequest = fn; },
              removeListener: () => { onBeforeRequest = undefined; },
              hasListener: (fn: any) => onBeforeRequest === fn,
            },
            onBeforeSendHeaders: { addListener: () => {}, removeListener: () => {} },
            onResponseStarted: { addListener: () => {}, removeListener: () => {} },
            onCompleted: {
              addListener: (fn: any) => { onCompleted = fn; },
              removeListener: () => { onCompleted = undefined; },
            },
            onErrorOccurred: { addListener: () => {}, removeListener: () => {} },
          },
        },
      });
      bootstrapUploadObserver();
      await reconcileUploadObserver();

      // Fill tab 70 to the per-tab cap and flush to session storage.
      for (let i = 0; i < MAX_TRACKED_UPLOADS_PER_TAB; i++) {
        onBeforeRequest!({
          requestId: `batch-${i}`,
          tabId: 70,
          method: "POST",
          requestBody: { raw: [{ file: `/tmp/f-${i}.bin` }] },
        });
      }
      expect(await checkTabHasActiveUpload(70)).toBe(true);

      // In the same event turn, finish batch-0 and start batch-replacement.
      onCompleted!({ requestId: "batch-0", tabId: 70, statusCode: 200 });
      onBeforeRequest!({
        requestId: "batch-replacement",
        tabId: 70,
        method: "POST",
        requestBody: { raw: [{ file: "/tmp/replacement.bin" }] },
      });
      // Drain the queued persistence batch.
      expect(await checkTabHasActiveUpload(70)).toBe(true);

      const stored = sessionData[ACTIVE_UPLOADS_STORAGE_KEY] as { inFlight: Record<string, unknown> } | undefined;
      expect(stored?.inFlight["batch-0"]).toBeUndefined();
      expect(stored?.inFlight["batch-replacement"]).toBeDefined();

      // Fill the remaining 7 tabs to hit the 256 global cap, then verify a 9th tab (tab 99) evicts
      // an entry from the fullest tab and persists both the eviction and tab 99's upload.
      const openTabs = [{ id: 70 }, { id: 71 }, { id: 72 }, { id: 73 }, { id: 74 }, { id: 75 }, { id: 76 }, { id: 77 }, { id: 99 }];
      Object.assign(chrome.tabs, { query: async () => openTabs });
      for (let tabId = 71; tabId <= 77; tabId++) {
        for (let i = 0; i < MAX_TRACKED_UPLOADS_PER_TAB; i++) {
          onBeforeRequest!({
            requestId: `fill-${tabId}-${i}`,
            tabId,
            method: "POST",
            requestBody: { raw: [{ file: `/tmp/fill-${tabId}-${i}.bin` }] },
          });
        }
      }
      expect(await checkTabHasActiveUpload(77)).toBe(true);
      onBeforeRequest!({
        requestId: "fair-tab-99",
        tabId: 99,
        method: "POST",
        requestBody: { raw: [{ file: "/tmp/fair.bin" }] },
      });
      expect(await checkTabHasActiveUpload(99)).toBe(true);
      const storedAfterFair = sessionData[ACTIVE_UPLOADS_STORAGE_KEY] as { inFlight: Record<string, unknown> } | undefined;
      expect(Object.keys(storedAfterFair?.inFlight ?? {})).toHaveLength(MAX_TRACKED_INFLIGHT_UPLOADS);
      expect(storedAfterFair?.inFlight["fair-tab-99"]).toBeDefined();
    } finally {
      localData["tabCurb.config"] = { protectActiveUploads: false };
      await reconcileUploadObserver();
      Object.assign(globalThis, { chrome: previous });
    }
  });

  test("expires orphaned in-flight entries older than UPLOAD_INFLIGHT_MAX_AGE_MS", () => {
    let state = recordUploadStart(createEmptyUploadState(), "stale-1", 60, t0);
    state = recordUploadStart(state, "fresh-1", 61, t0 + UPLOAD_INFLIGHT_MAX_AGE_MS - 1000);
    const pruned = pruneUploadState(state, t0 + UPLOAD_INFLIGHT_MAX_AGE_MS + 1);
    expect(Object.keys(pruned.inFlight)).toEqual(["fresh-1"]);
    expect(isTabUploading(pruned, 60, t0 + UPLOAD_INFLIGHT_MAX_AGE_MS + 1)).toBe(false);
    expect(isTabUploading(pruned, 61, t0 + UPLOAD_INFLIGHT_MAX_AGE_MS + 1)).toBe(true);
  });
});
