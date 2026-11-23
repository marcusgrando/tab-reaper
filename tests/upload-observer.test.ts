import { describe, expect, test } from "bun:test";
import {
  UPLOAD_CHUNK_COOLDOWN_MS,
  UPLOAD_MIN_BYTES,
  clearTabUploads,
  createEmptyUploadState,
  getUploadingTabIdsFromState,
  isTabUploading,
  isUploadRequestBody,
  isUploadRequestHeaders,
  pruneUploadState,
  recordUploadFinish,
  recordUploadStart,
  replaceUploadTabId,
} from "../src/background/upload-observer.ts";

describe("upload request classification", () => {
  test("ignores GET/HEAD/DELETE/OPTIONS requests regardless of body or headers", () => {
    expect(isUploadRequestBody("GET", { raw: [{ file: "/tmp/a.bin" }] })).toBe(false);
    expect(isUploadRequestBody("DELETE", { raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES) }] })).toBe(false);
    expect(
      isUploadRequestHeaders("GET", [
        { name: "Content-Type", value: "multipart/form-data; boundary=abc" },
        { name: "Content-Length", value: String(UPLOAD_MIN_BYTES * 4) },
      ]),
    ).toBe(false);
  });

  test("detects direct file uploads and large binary payloads from requestBody on POST and PUT", () => {
    expect(isUploadRequestBody("POST", { raw: [{ file: "/Users/me/video.mp4" }] })).toBe(true);
    expect(isUploadRequestBody("PUT", { raw: [{ file: "/Users/me/archive.zip" }] })).toBe(true);
    expect(isUploadRequestBody("POST", { raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES) }] })).toBe(true);
    expect(
      isUploadRequestBody("PUT", {
        raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES / 2) }, { bytes: new ArrayBuffer(UPLOAD_MIN_BYTES / 2) }],
      }),
    ).toBe(true);
    // Blob / file.slice() / streaming bodies produce requestBody.error in Chromium.
    expect(isUploadRequestBody("PUT", { error: "Unknown error." })).toBe(true);
    expect(isUploadRequestBody("POST", { error: "Unknown error." })).toBe(true);
  });

  test("ignores small JSON, form-urlencoded, and empty POST/PUT requests", () => {
    expect(isUploadRequestBody("POST", undefined)).toBe(false);
    expect(isUploadRequestBody("POST", { raw: [{ bytes: new ArrayBuffer(512) }] })).toBe(false);
    expect(isUploadRequestBody("POST", { formData: { q: ["hello"] } })).toBe(false);
    expect(isUploadRequestBody("PUT", { raw: [{ bytes: new ArrayBuffer(UPLOAD_MIN_BYTES - 1) }] })).toBe(false);
    expect(
      isUploadRequestHeaders("POST", [
        { name: "Content-Type", value: "application/json; charset=utf-8" },
        { name: "Content-Length", value: "128" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequestHeaders("POST", [
        { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      ]),
    ).toBe(false);
  });

  test("detects multipart, binary, media, tus, Content-Range, and large Content-Length headers on POST/PUT/PATCH", () => {
    expect(
      isUploadRequestHeaders("POST", [
        { name: "Content-Type", value: "multipart/form-data; boundary=----WebKitFormBoundary123" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PATCH", [
        { name: "content-type", value: "application/offset+octet-stream" },
        { name: "upload-offset", value: "0" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PUT", [
        { name: "Content-Range", value: "bytes 0-99999/200000" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PUT", [
        { name: "Content-Type", value: "application/octet-stream" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PUT", [
        { name: "Content-Type", value: "video/mp4" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PATCH", [
        { name: "Content-Length", value: String(UPLOAD_MIN_BYTES) },
      ]),
    ).toBe(true);
    // Raw binary PATCH (e.g. Uint8Array / untyped Blob) omits Content-Type and Content-Length in webRequest.
    expect(isUploadRequestHeaders("PATCH", [])).toBe(true);
    expect(isUploadRequestHeaders("PATCH", undefined)).toBe(true);
    expect(
      isUploadRequestHeaders("PATCH", [
        { name: "Accept", value: "*/*" },
      ]),
    ).toBe(true);
    expect(
      isUploadRequestHeaders("PATCH", [
        { name: "Content-Type", value: "application/json" },
        { name: "Content-Length", value: "64" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequestHeaders("PATCH", [
        { name: "Content-Type", value: "text/plain;charset=UTF-8" },
      ]),
    ).toBe(false);
    expect(
      isUploadRequestHeaders("PATCH", [
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
