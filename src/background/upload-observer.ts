import { HTTP_HOST_ORIGINS, createAsyncQueue, loadConfig } from "../shared/config.ts";

export const ACTIVE_UPLOADS_STORAGE_KEY = "tabReaper.activeUploads";
/** Minimum binary/untyped request body or Content-Length size treated as a data upload (64 KiB). */
export const UPLOAD_MIN_BYTES = 64 * 1024;
/** Minimum text/JSON/form/protobuf payload size treated as an upload (1 MiB) so large API syncs/logs do not trigger. */
export const UPLOAD_TEXT_API_MIN_BYTES = 1024 * 1024;
/** Keep a tab protected briefly after an upload request completes to bridge multi-chunk gaps. */
export const UPLOAD_CHUNK_COOLDOWN_MS = 20_000;
/** Expire orphaned in-flight entries (e.g. dropped across a worker crash) while keeping multi-hour uploads protected. */
export const UPLOAD_INFLIGHT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Hard bounds prevent a single tab from flooding storage or starving other tabs' upload tracking. */
export const MAX_TRACKED_UPLOADS_PER_TAB = 32;
export const MAX_TRACKED_INFLIGHT_UPLOADS = 256;

export const UPLOAD_REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: HTTP_HOST_ORIGINS,
  types: ["xmlhttprequest", "main_frame", "sub_frame", "other"],
};

const UPLOAD_METHODS = new Set(["POST", "PUT", "PATCH"]);
const BODY_METHODS = new Set(["POST", "PUT"]);
const UPLOAD_EXACT_MEDIA_TYPES = new Set([
  "multipart/form-data",
  "application/octet-stream",
  "application/offset+octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
]);
const UPLOAD_MEDIA_PREFIXES = ["image/", "video/", "audio/"];
const NON_UPLOAD_EXACT_MEDIA_TYPES = new Set([
  "application/json",
  "application/json+protobuf",
  "application/x-www-form-urlencoded",
  "application/x-protobuf",
  "application/protobuf",
  "application/grpc-web",
  "application/grpc-web+proto",
  "application/grpc-web-text",
  "application/grpc-web-text+proto",
  "application/xml",
  "application/graphql",
  "application/javascript",
  "application/ecmascript",
  "application/x-javascript",
  "application/sdp",
  "application/x-ndjson",
  "application/ndjson",
  "application/csp-report",
  "application/reports+json",
  "application/dns-message",
  "application/ocsp-request",
]);

export type RequestBodyObservation =
  | { kind: "none" }
  | { kind: "file" }
  | { kind: "form_fields" }
  | { kind: "raw_bytes"; totalBytes: number }
  | { kind: "opaque" };

export interface ActiveUploadEntry {
  tabId: number;
  startedAt: number;
}

export interface UploadState {
  inFlight: Record<string, ActiveUploadEntry>;
  cooldownUntilByTabId: Record<string, number>;
}

export function createEmptyUploadState(): UploadState {
  return { inFlight: {}, cooldownUntilByTabId: {} };
}

function isExplicitUploadMediaType(mediaType: string): boolean {
  return (
    UPLOAD_EXACT_MEDIA_TYPES.has(mediaType) ||
    UPLOAD_MEDIA_PREFIXES.some((prefix) => mediaType.startsWith(prefix))
  );
}

function isNonUploadMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    NON_UPLOAD_EXACT_MEDIA_TYPES.has(mediaType) ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    mediaType.endsWith("+protobuf") ||
    mediaType.endsWith("+proto")
  );
}

export function inspectUploadRequestBody(
  method: string,
  requestBody?: chrome.webRequest.WebRequestBody | null,
): RequestBodyObservation {
  if (!BODY_METHODS.has(method.toUpperCase()) || !requestBody) return { kind: "none" };
  if (Array.isArray(requestBody.raw)) {
    let totalBytes = 0;
    for (const part of requestBody.raw) {
      if (typeof part.file === "string" && part.file.length > 0) return { kind: "file" };
      if (part.bytes && typeof part.bytes.byteLength === "number") {
        totalBytes += part.bytes.byteLength;
      }
    }
    return { kind: "raw_bytes", totalBytes };
  }
  // Chromium sets requestBody.error for Blobs, file.slice() chunks, streams, and empty string "" bodies.
  // Defer classification until onBeforeSendHeaders so text/JSON/form-urlencoded payloads can be excluded.
  if (typeof requestBody.error === "string" && requestBody.error.length > 0) return { kind: "opaque" };
  if (requestBody.formData && typeof requestBody.formData === "object") return { kind: "form_fields" };
  return { kind: "none" };
}

export function isUploadRequest(
  method: string,
  body?: RequestBodyObservation,
  headers?: chrome.webRequest.HttpHeader[],
): boolean {
  const upperMethod = method.toUpperCase();
  if (!UPLOAD_METHODS.has(upperMethod)) return false;
  if (body?.kind === "file") return true;

  let hasContentRange = false;
  let hasUploadOffset = false;
  let contentLength: number | null = null;
  let mediaType: string | null = null;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      const name = header.name.toLowerCase();
      const rawValue = typeof header.value === "string" ? header.value.trim() : "";
      if (!rawValue) continue;
      if (name === "content-range") hasContentRange = true;
      else if (name === "upload-offset") hasUploadOffset = true;
      else if (name === "content-length" && /^\d+$/.test(rawValue)) {
        contentLength = Number(rawValue);
      } else if (name === "content-type") {
        mediaType = rawValue.split(";", 1)[0]!.trim().toLowerCase() || null;
      }
    }
  }

  if (hasContentRange || hasUploadOffset || mediaType === "application/offset+octet-stream") {
    return true;
  }
  // Text-only FormData (no File or Blob parts) still sends multipart/form-data; onBeforeRequest parsed formData.
  if (body?.kind === "form_fields") return false;
  // FormData containing a Blob produces raw boundary chunks without formData because Chromium omits Blob bytes.
  if (mediaType === "multipart/form-data") return true;

  if (body?.kind === "opaque") {
    if (contentLength !== null) {
      if (contentLength === 0) return false;
      if (mediaType && isNonUploadMediaType(mediaType)) return contentLength >= UPLOAD_TEXT_API_MIN_BYTES;
      return contentLength >= UPLOAD_MIN_BYTES || (mediaType !== null && isExplicitUploadMediaType(mediaType));
    }
    if (mediaType && isNonUploadMediaType(mediaType)) return false;
    return true;
  }

  if (body?.kind === "raw_bytes") {
    if (mediaType && isNonUploadMediaType(mediaType)) return body.totalBytes >= UPLOAD_TEXT_API_MIN_BYTES;
    return body.totalBytes >= UPLOAD_MIN_BYTES;
  }

  // onBeforeRequest ran for POST/PUT and saw no body at all.
  if (body?.kind === "none" && BODY_METHODS.has(upperMethod)) return false;

  if (contentLength !== null) {
    if (mediaType && isNonUploadMediaType(mediaType)) return contentLength >= UPLOAD_TEXT_API_MIN_BYTES;
    return contentLength >= UPLOAD_MIN_BYTES;
  }
  if (mediaType) return isExplicitUploadMediaType(mediaType);
  // Chromium omits requestBody for PATCH and strips Content-Length from webRequest headers.
  // TypedArray/Blob PATCH bodies send no Content-Type, while JSON/text/form PATCH requests do.
  if (upperMethod === "PATCH") return true;
  return false;
}

export function pruneUploadState(
  state: UploadState,
  now: number,
  openTabIds?: ReadonlySet<number>,
): UploadState {
  let changed = false;
  const filtered: Record<string, ActiveUploadEntry> = {};
  for (const [requestId, entry] of Object.entries(state.inFlight)) {
    const expired = now >= entry.startedAt && now - entry.startedAt > UPLOAD_INFLIGHT_MAX_AGE_MS;
    if (!expired && (!openTabIds || openTabIds.has(entry.tabId))) {
      filtered[requestId] = entry;
    } else {
      changed = true;
    }
  }
  const nextInFlight = changed ? filtered : state.inFlight;
  const nextCooldowns: Record<string, number> = {};
  let cooldownChanged = false;
  for (const [tabKey, until] of Object.entries(state.cooldownUntilByTabId)) {
    const id = Number(tabKey);
    if (until > now && (!openTabIds || openTabIds.has(id))) {
      nextCooldowns[tabKey] = until;
    } else {
      cooldownChanged = true;
    }
  }
  if (!changed && !cooldownChanged) return state;
  return { inFlight: nextInFlight, cooldownUntilByTabId: cooldownChanged ? nextCooldowns : state.cooldownUntilByTabId };
}

export function recordUploadStart(
  state: UploadState,
  requestId: string,
  tabId: number,
  now: number,
): UploadState {
  if (tabId < 0 || requestId in state.inFlight) return state;
  const entries = Object.values(state.inFlight);
  if (entries.length >= MAX_TRACKED_INFLIGHT_UPLOADS) return state;
  let tabCount = 0;
  for (const entry of entries) {
    if (entry.tabId === tabId && ++tabCount >= MAX_TRACKED_UPLOADS_PER_TAB) return state;
  }
  return {
    inFlight: { ...state.inFlight, [requestId]: { tabId, startedAt: now } },
    cooldownUntilByTabId: state.cooldownUntilByTabId,
  };
}

export function recordUploadFinish(
  state: UploadState,
  requestId: string,
  now: number,
  applyCooldown: boolean,
): UploadState {
  const entry = state.inFlight[requestId];
  if (!entry) return state;
  const nextInFlight = { ...state.inFlight };
  delete nextInFlight[requestId];
  let nextCooldowns = state.cooldownUntilByTabId;
  if (applyCooldown) {
    const tabKey = String(entry.tabId);
    const until = Math.max(state.cooldownUntilByTabId[tabKey] ?? 0, now + UPLOAD_CHUNK_COOLDOWN_MS);
    nextCooldowns = { ...state.cooldownUntilByTabId, [tabKey]: until };
  }
  return { inFlight: nextInFlight, cooldownUntilByTabId: nextCooldowns };
}

export function clearTabUploads(state: UploadState, tabId: number): UploadState {
  const tabKey = String(tabId);
  let changed = false;
  const nextInFlight: Record<string, ActiveUploadEntry> = {};
  for (const [requestId, entry] of Object.entries(state.inFlight)) {
    if (entry.tabId === tabId) {
      changed = true;
    } else {
      nextInFlight[requestId] = entry;
    }
  }
  let nextCooldowns = state.cooldownUntilByTabId;
  if (tabKey in state.cooldownUntilByTabId) {
    nextCooldowns = { ...state.cooldownUntilByTabId };
    delete nextCooldowns[tabKey];
    changed = true;
  }
  if (!changed) return state;
  return { inFlight: nextInFlight, cooldownUntilByTabId: nextCooldowns };
}

export function replaceUploadTabId(state: UploadState, oldTabId: number, newTabId: number): UploadState {
  if (oldTabId === newTabId) return state;
  const oldKey = String(oldTabId);
  const newKey = String(newTabId);
  let changed = false;
  const nextInFlight: Record<string, ActiveUploadEntry> = {};
  for (const [requestId, entry] of Object.entries(state.inFlight)) {
    if (entry.tabId === oldTabId) {
      nextInFlight[requestId] = { ...entry, tabId: newTabId };
      changed = true;
    } else {
      nextInFlight[requestId] = entry;
    }
  }
  let nextCooldowns = state.cooldownUntilByTabId;
  if (oldKey in state.cooldownUntilByTabId) {
    nextCooldowns = { ...state.cooldownUntilByTabId };
    const existing = nextCooldowns[oldKey]!;
    delete nextCooldowns[oldKey];
    nextCooldowns[newKey] = Math.max(nextCooldowns[newKey] ?? 0, existing);
    changed = true;
  }
  if (!changed) return state;
  return { inFlight: nextInFlight, cooldownUntilByTabId: nextCooldowns };
}

export function isTabUploading(state: UploadState, tabId: number, now: number): boolean {
  const cooldown = state.cooldownUntilByTabId[String(tabId)];
  if (typeof cooldown === "number" && cooldown > now) return true;
  for (const entry of Object.values(state.inFlight)) {
    if (entry.tabId === tabId) return true;
  }
  return false;
}

export function getUploadingTabIdsFromState(state: UploadState, now: number): Set<number> {
  const uploading = new Set<number>();
  for (const entry of Object.values(state.inFlight)) {
    uploading.add(entry.tabId);
  }
  for (const [tabKey, until] of Object.entries(state.cooldownUntilByTabId)) {
    if (until > now) {
      const id = Number(tabKey);
      if (Number.isFinite(id)) uploading.add(id);
    }
  }
  return uploading;
}

export async function hasUploadProtectionPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      permissions: ["webRequest"],
      origins: HTTP_HOST_ORIGINS,
    });
  } catch {
    return false;
  }
}

const PENDING_BODY_TTL_MS = 60_000;
const PENDING_BODY_PRUNE_THRESHOLD = 256;
const MAX_PENDING_BODIES = 512;

interface PendingBodyEntry {
  tabId: number;
  body: RequestBodyObservation;
  seenAt: number;
}

const enqueue = createAsyncQueue();
let listenersAttached = false;
let observerEnabled: boolean | null = null;
let pendingReconciles = 0;
let cachedState: UploadState | null = null;
/** Synchronous in-flight, cooldown, and pending-body indexes so concurrent checks see events immediately. */
const knownInFlight = new Map<string, number>();
const knownCooldownUntil = new Map<number, number>();
const pendingBodies = new Map<string, PendingBodyEntry>();
/** Coalesced storage mutations prevent request floods from building an unbounded storage-write backlog. */
const pendingStarts = new Map<string, ActiveUploadEntry>();
const pendingFinishes = new Map<string, { now: number; applyCooldown: boolean }>();
const pendingCooldowns = new Map<number, number>();
let persistScheduled = false;

export function hasLiveUploadProtectionForTab(tabId: number, now = Date.now()): boolean {
  if (observerEnabled !== true) return false;
  const cooldownUntil = knownCooldownUntil.get(tabId);
  if (cooldownUntil !== undefined) {
    if (cooldownUntil > now) return true;
    knownCooldownUntil.delete(tabId);
  }
  for (const activeTabId of knownInFlight.values()) {
    if (activeTabId === tabId) return true;
  }
  return false;
}

function sanitizeStoredUploadState(raw: unknown): UploadState {
  if (!raw || typeof raw !== "object") return createEmptyUploadState();
  const obj = raw as Partial<UploadState>;
  const inFlight: Record<string, ActiveUploadEntry> = {};
  if (obj.inFlight && typeof obj.inFlight === "object") {
    for (const [id, entry] of Object.entries(obj.inFlight)) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.tabId === "number" &&
        Number.isFinite(entry.tabId) &&
        entry.tabId >= 0 &&
        typeof entry.startedAt === "number" &&
        Number.isFinite(entry.startedAt)
      ) {
        inFlight[id] = { tabId: entry.tabId, startedAt: entry.startedAt };
      }
    }
  }
  const cooldownUntilByTabId: Record<string, number> = {};
  if (obj.cooldownUntilByTabId && typeof obj.cooldownUntilByTabId === "object") {
    for (const [tabKey, until] of Object.entries(obj.cooldownUntilByTabId)) {
      if (typeof until === "number" && Number.isFinite(until)) {
        cooldownUntilByTabId[tabKey] = until;
      }
    }
  }
  return { inFlight, cooldownUntilByTabId };
}

async function loadState(now: number): Promise<UploadState> {
  if (cachedState) return cachedState;
  try {
    const stored = await chrome.storage.session.get(ACTIVE_UPLOADS_STORAGE_KEY);
    const hydrated = pruneUploadState(sanitizeStoredUploadState(stored[ACTIVE_UPLOADS_STORAGE_KEY]), now);
    cachedState = hydrated;
    // Union hydrated entries without clearing so concurrent events queued before hydration survive.
    for (const [id, entry] of Object.entries(hydrated.inFlight)) knownInFlight.set(id, entry.tabId);
    for (const [tabKey, until] of Object.entries(hydrated.cooldownUntilByTabId)) {
      const tabId = Number(tabKey);
      if (Number.isFinite(tabId) && until > now) {
        knownCooldownUntil.set(tabId, Math.max(knownCooldownUntil.get(tabId) ?? 0, until));
      }
    }
    return hydrated;
  } catch {
    cachedState = createEmptyUploadState();
    return cachedState;
  }
}

async function saveState(state: UploadState, previous?: UploadState): Promise<void> {
  cachedState = state;
  if (previous) {
    for (const id of Object.keys(previous.inFlight)) {
      if (!(id in state.inFlight)) knownInFlight.delete(id);
    }
  }
  for (const [id, entry] of Object.entries(state.inFlight)) knownInFlight.set(id, entry.tabId);
  for (const [tabKey, until] of Object.entries(state.cooldownUntilByTabId)) {
    const tabId = Number(tabKey);
    if (Number.isFinite(tabId)) {
      knownCooldownUntil.set(tabId, Math.max(knownCooldownUntil.get(tabId) ?? 0, until));
    }
  }
  try {
    if (
      Object.keys(state.inFlight).length === 0 &&
      Object.keys(state.cooldownUntilByTabId).length === 0
    ) {
      await chrome.storage.session.remove(ACTIVE_UPLOADS_STORAGE_KEY);
    } else {
      await chrome.storage.session.set({ [ACTIVE_UPLOADS_STORAGE_KEY]: state });
    }
  } catch {
    // Session storage is best-effort transient state.
  }
}

function schedulePersist(): void {
  if (persistScheduled) return;
  persistScheduled = true;
  void enqueue(async () => {
    persistScheduled = false;
    if (!observerEnabled) {
      pendingStarts.clear();
      pendingFinishes.clear();
      pendingCooldowns.clear();
      return;
    }
    const starts = Array.from(pendingStarts.entries());
    const finishes = Array.from(pendingFinishes.entries());
    const cooldowns = Array.from(pendingCooldowns.entries());
    pendingStarts.clear();
    pendingFinishes.clear();
    pendingCooldowns.clear();
    if (starts.length === 0 && finishes.length === 0 && cooldowns.length === 0) return;

    const now = Date.now();
    const loaded = await loadState(now);
    let next = pruneUploadState(loaded, now);
    for (const [requestId, entry] of starts) {
      next = recordUploadStart(next, requestId, entry.tabId, entry.startedAt);
    }
    for (const [requestId, fin] of finishes) {
      next = recordUploadFinish(next, requestId, fin.now, fin.applyCooldown);
    }
    if (cooldowns.length > 0) {
      let nextCooldowns = next.cooldownUntilByTabId;
      for (const [tabId, until] of cooldowns) {
        if (until <= now) continue;
        const tabKey = String(tabId);
        if ((nextCooldowns[tabKey] ?? 0) < until) {
          if (nextCooldowns === next.cooldownUntilByTabId) nextCooldowns = { ...nextCooldowns };
          nextCooldowns[tabKey] = until;
        }
      }
      if (nextCooldowns !== next.cooldownUntilByTabId) {
        next = { inFlight: next.inFlight, cooldownUntilByTabId: nextCooldowns };
      }
    }
    if (next !== loaded) await saveState(next, loaded);
  });
}

function canTrackInFlightForTab(tabId: number): boolean {
  if (knownInFlight.size >= MAX_TRACKED_INFLIGHT_UPLOADS) return false;
  let count = 0;
  for (const activeTabId of knownInFlight.values()) {
    if (activeTabId === tabId && ++count >= MAX_TRACKED_UPLOADS_PER_TAB) return false;
  }
  return true;
}

function trackUploadStart(requestId: string, tabId: number): void {
  pendingBodies.delete(requestId);
  if (tabId < 0 || knownInFlight.has(requestId) || !canTrackInFlightForTab(tabId)) return;
  const now = Date.now();
  knownInFlight.set(requestId, tabId);
  pendingFinishes.delete(requestId);
  pendingStarts.set(requestId, { tabId, startedAt: now });
  schedulePersist();
}

function trackUploadFinish(requestId: string, applyCooldown: boolean): void {
  if (observerEnabled === false) return;
  const activeTabId = knownInFlight.get(requestId);
  const hadPendingStart = pendingStarts.delete(requestId);
  if (cachedState !== null && activeTabId === undefined && !hadPendingStart) return;
  const now = Date.now();
  if (applyCooldown && activeTabId !== undefined) {
    const until = now + UPLOAD_CHUNK_COOLDOWN_MS;
    // Record the chunk cooldown synchronously before clearing in-flight so a concurrent discard check never sees a gap.
    knownCooldownUntil.set(
      activeTabId,
      Math.max(knownCooldownUntil.get(activeTabId) ?? 0, until),
    );
    pendingCooldowns.set(activeTabId, Math.max(pendingCooldowns.get(activeTabId) ?? 0, until));
  }
  knownInFlight.delete(requestId);
  if (!hadPendingStart) {
    pendingFinishes.set(requestId, { now, applyCooldown });
  }
  schedulePersist();
}

function isSuccessOrResumeStatus(statusCode?: number): boolean {
  return typeof statusCode === "number" && statusCode >= 200 && statusCode < 400;
}

function onBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
  if (observerEnabled === false || details.tabId < 0) return;
  const upperMethod = details.method.toUpperCase();
  if (!BODY_METHODS.has(upperMethod)) return;
  const body = inspectUploadRequestBody(upperMethod, details.requestBody);
  if (body.kind === "file") {
    pendingBodies.delete(details.requestId);
    trackUploadStart(details.requestId, details.tabId);
    return;
  }
  const now = Date.now();
  if (pendingBodies.size >= PENDING_BODY_PRUNE_THRESHOLD) {
    for (const [id, entry] of pendingBodies.entries()) {
      if (now - entry.seenAt >= PENDING_BODY_TTL_MS) pendingBodies.delete(id);
    }
  }
  while (pendingBodies.size >= MAX_PENDING_BODIES) {
    const oldest = pendingBodies.keys().next().value;
    if (oldest === undefined) break;
    pendingBodies.delete(oldest);
  }
  pendingBodies.set(details.requestId, { tabId: details.tabId, body, seenAt: now });
}

function onBeforeSendHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
  if (observerEnabled === false || details.tabId < 0) {
    pendingBodies.delete(details.requestId);
    return;
  }
  const upperMethod = details.method.toUpperCase();
  if (!UPLOAD_METHODS.has(upperMethod)) return;
  if (knownInFlight.has(details.requestId)) return;
  const pending = pendingBodies.get(details.requestId);
  if (isUploadRequest(upperMethod, pending?.body, details.requestHeaders)) {
    trackUploadStart(details.requestId, details.tabId);
  }
}

function onResponseStarted(details: chrome.webRequest.WebResponseCacheDetails): void {
  pendingBodies.delete(details.requestId);
  trackUploadFinish(details.requestId, isSuccessOrResumeStatus(details.statusCode));
}

function onCompleted(details: chrome.webRequest.WebResponseCacheDetails): void {
  pendingBodies.delete(details.requestId);
  trackUploadFinish(details.requestId, isSuccessOrResumeStatus(details.statusCode));
}

function onErrorOccurred(details: chrome.webRequest.WebResponseErrorDetails): void {
  pendingBodies.delete(details.requestId);
  trackUploadFinish(details.requestId, false);
}

function attachListeners(): void {
  if (!chrome.webRequest?.onBeforeRequest) return;
  const alreadyAttached = chrome.webRequest.onBeforeRequest.hasListener
    ? chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)
    : listenersAttached;
  if (alreadyAttached) {
    listenersAttached = true;
    return;
  }
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, UPLOAD_REQUEST_FILTER, ["requestBody"]);
  chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, UPLOAD_REQUEST_FILTER, ["requestHeaders"]);
  chrome.webRequest.onResponseStarted?.addListener(onResponseStarted, UPLOAD_REQUEST_FILTER);
  chrome.webRequest.onCompleted.addListener(onCompleted, UPLOAD_REQUEST_FILTER);
  chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, UPLOAD_REQUEST_FILTER);
  listenersAttached = true;
}

function detachListeners(): void {
  if (!listenersAttached || !chrome.webRequest?.onBeforeRequest) {
    listenersAttached = false;
    return;
  }
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
  chrome.webRequest.onResponseStarted?.removeListener(onResponseStarted);
  chrome.webRequest.onCompleted.removeListener(onCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
  listenersAttached = false;
}

/**
 * Registers webRequest listeners synchronously during service worker startup
 * only when the optional webRequest API is already granted, then reconciles
 * against the user's opt-in setting so disabled profiles detach immediately.
 */
export function bootstrapUploadObserver(): void {
  if (typeof chrome === "undefined" || !chrome.webRequest?.onBeforeRequest) {
    observerEnabled = false;
    return;
  }
  attachListeners();
  void reconcileUploadObserver();
}

export function reconcileUploadObserver(): Promise<void> {
  pendingReconciles++;
  return enqueue(async () => {
    try {
      const [config, hasPermission] = await Promise.all([loadConfig(), hasUploadProtectionPermission()]);
      const enabled = Boolean(config.protectActiveUploads && hasPermission && chrome.webRequest?.onBeforeRequest);
      observerEnabled = enabled;
      if (enabled) {
        attachListeners();
        const now = Date.now();
        const loaded = await loadState(now);
        const openTabs = await chrome.tabs.query({}).catch(() => null);
        if (openTabs) {
          const openIds = new Set(
            openTabs.map((t) => t.id).filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
          );
          const pruned = pruneUploadState(loaded, now, openIds);
          if (pruned !== loaded) await saveState(pruned, loaded);
        }
      } else {
        detachListeners();
        cachedState = createEmptyUploadState();
        knownInFlight.clear();
        knownCooldownUntil.clear();
        pendingBodies.clear();
        pendingStarts.clear();
        pendingFinishes.clear();
        pendingCooldowns.clear();
        try {
          await chrome.storage.session.remove(ACTIVE_UPLOADS_STORAGE_KEY);
        } catch {
          // Ignore session storage cleanup failure.
        }
      }
    } finally {
      pendingReconciles--;
    }
  }).catch((error) => {
    console.warn("Could not update the upload observer", error);
  });
}

export async function getUploadingTabIds(now = Date.now()): Promise<Set<number>> {
  if (observerEnabled === false && pendingReconciles === 0) return new Set();
  return enqueue(async () => {
    if (!observerEnabled) return new Set<number>();
    const current = await loadState(now);
    const pruned = pruneUploadState(current, now);
    if (pruned !== current) await saveState(pruned, current);
    const ids = getUploadingTabIdsFromState(pruned, now);
    for (const activeTabId of knownInFlight.values()) ids.add(activeTabId);
    for (const [tabId, until] of knownCooldownUntil.entries()) {
      if (until > now) ids.add(tabId);
      else knownCooldownUntil.delete(tabId);
    }
    return ids;
  });
}

export async function checkTabHasActiveUpload(tabId: number, now = Date.now()): Promise<boolean> {
  if (observerEnabled === false && pendingReconciles === 0) return false;
  return enqueue(async () => {
    if (!observerEnabled) return false;
    const current = await loadState(now);
    const pruned = pruneUploadState(current, now);
    if (pruned !== current) await saveState(pruned, current);
    return isTabUploading(pruned, tabId, now) || hasLiveUploadProtectionForTab(tabId, now);
  });
}

export function forgetTabUploads(tabId: number): Promise<void> {
  if (observerEnabled === false && pendingReconciles === 0) return Promise.resolve();
  for (const [requestId, activeTabId] of knownInFlight.entries()) {
    if (activeTabId === tabId) knownInFlight.delete(requestId);
  }
  for (const [requestId, entry] of pendingStarts.entries()) {
    if (entry.tabId === tabId) pendingStarts.delete(requestId);
  }
  for (const [requestId, entry] of pendingBodies.entries()) {
    if (entry.tabId === tabId) pendingBodies.delete(requestId);
  }
  knownCooldownUntil.delete(tabId);
  pendingCooldowns.delete(tabId);
  return enqueue(async () => {
    if (!observerEnabled) return;
    const current = await loadState(Date.now());
    const next = clearTabUploads(current, tabId);
    if (next !== current) await saveState(next, current);
  });
}

export function migrateTabUploads(oldTabId: number, newTabId: number): Promise<void> {
  if ((observerEnabled === false && pendingReconciles === 0) || oldTabId === newTabId) return Promise.resolve();
  for (const [requestId, activeTabId] of knownInFlight.entries()) {
    if (activeTabId === oldTabId) knownInFlight.set(requestId, newTabId);
  }
  for (const entry of pendingStarts.values()) {
    if (entry.tabId === oldTabId) entry.tabId = newTabId;
  }
  for (const entry of pendingBodies.values()) {
    if (entry.tabId === oldTabId) entry.tabId = newTabId;
  }
  const existingCooldown = knownCooldownUntil.get(oldTabId);
  if (existingCooldown !== undefined) {
    knownCooldownUntil.delete(oldTabId);
    knownCooldownUntil.set(newTabId, Math.max(knownCooldownUntil.get(newTabId) ?? 0, existingCooldown));
  }
  const existingPendingCooldown = pendingCooldowns.get(oldTabId);
  if (existingPendingCooldown !== undefined) {
    pendingCooldowns.delete(oldTabId);
    pendingCooldowns.set(newTabId, Math.max(pendingCooldowns.get(newTabId) ?? 0, existingPendingCooldown));
  }
  return enqueue(async () => {
    if (!observerEnabled) return;
    const current = await loadState(Date.now());
    const next = replaceUploadTabId(current, oldTabId, newTabId);
    if (next !== current) await saveState(next, current);
  });
}
