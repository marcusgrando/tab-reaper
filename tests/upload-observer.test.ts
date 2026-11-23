import { describe, expect, test } from "bun:test";
import {
  UPLOAD_CHUNK_COOLDOWN_MS,
  UPLOAD_MIN_BYTES,
  UPLOAD_TEXT_API_MIN_BYTES,
  clearTabUploads,
  createEmptyUploadState,
  getUploadingTabIdsFromState,
  inspectUploadRequestBody,
  isTabUploading,
  isUploadRequest,
  pruneUploadState,
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
});
