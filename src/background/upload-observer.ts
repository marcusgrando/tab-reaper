import { createAsyncQueue, loadConfig } from "../shared/config.ts";

export const ACTIVE_UPLOADS_STORAGE_KEY = "tabReaper.activeUploads";
/** Minimum raw request body or Content-Length size treated as a data upload (64 KiB). */
export const UPLOAD_MIN_BYTES = 64 * 1024;
/** Keep a tab protected briefly after an upload request completes to bridge multi-chunk gaps. */
export const UPLOAD_CHUNK_COOLDOWN_MS = 20_000;

export const UPLOAD_REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["<all_urls>"],
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

export function isUploadRequestBody(
  method: string,
  requestBody?: chrome.webRequest.WebRequestBody | null,
): boolean {
  if (!BODY_METHODS.has(method.toUpperCase()) || !requestBody) return false;
  // Chromium reports requestBody.error for Blob, file.slice() chunk, and stream bodies on POST/PUT.
  if (typeof requestBody.error === "string" && requestBody.error.length > 0) return true;
  if (!Array.isArray(requestBody.raw)) return false;
  let totalBytes = 0;
  for (const part of requestBody.raw) {
    if (typeof part.file === "string" && part.file.length > 0) return true;
    if (part.bytes && typeof part.bytes.byteLength === "number") {
      totalBytes += part.bytes.byteLength;
      if (totalBytes >= UPLOAD_MIN_BYTES) return true;
    }
  }
  return false;
}

export function isUploadRequestHeaders(
  method: string,
  headers?: chrome.webRequest.HttpHeader[],
): boolean {
  const upperMethod = method.toUpperCase();
  if (!UPLOAD_METHODS.has(upperMethod)) return false;
  let hasContentType = false;
  let contentLength: number | null = null;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      const name = header.name.toLowerCase();
      const rawValue = typeof header.value === "string" ? header.value.trim() : "";
      if (!rawValue) continue;
      if (name === "content-range" || name === "upload-offset") return true;
      if (name === "content-length" && /^\d+$/.test(rawValue)) {
        contentLength = Number(rawValue);
        if (contentLength >= UPLOAD_MIN_BYTES) return true;
      }
      if (name === "content-type") {
        hasContentType = true;
        const mediaType = rawValue.split(";", 1)[0]!.trim().toLowerCase();
        if (
          UPLOAD_EXACT_MEDIA_TYPES.has(mediaType) ||
          UPLOAD_MEDIA_PREFIXES.some((prefix) => mediaType.startsWith(prefix))
        ) {
          return true;
        }
      }
    }
  }
  // Chromium omits requestBody for PATCH and strips Content-Length from webRequest headers.
  // TypedArray/Blob PATCH bodies send no Content-Type, while JSON/text/form PATCH requests do.
  if (upperMethod === "PATCH" && !hasContentType && (contentLength === null || contentLength >= UPLOAD_MIN_BYTES)) {
    return true;
  }
  return false;
}

export function pruneUploadState(
  state: UploadState,
  now: number,
  openTabIds?: ReadonlySet<number>,
): UploadState {
  let changed = false;
  let nextInFlight = state.inFlight;
  if (openTabIds) {
    const filtered: Record<string, ActiveUploadEntry> = {};
    for (const [requestId, entry] of Object.entries(state.inFlight)) {
      if (openTabIds.has(entry.tabId)) {
        filtered[requestId] = entry;
      } else {
        changed = true;
      }
    }
    if (changed) nextInFlight = filtered;
  }
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
      origins: ["<all_urls>"],
    });
  } catch {
    return false;
  }
}

const enqueue = createAsyncQueue();
let listenersAttached = false;
let observerEnabled: boolean | null = null;
let pendingReconciles = 0;
let cachedState: UploadState | null = null;
/** Synchronous in-flight and cooldown indexes so events firing during an async check are seen immediately. */
const knownInFlight = new Map<string, number>();
const knownCooldownUntil = new Map<number, number>();

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

function trackUploadStart(requestId: string, tabId: number): void {
  knownInFlight.set(requestId, tabId);
  const now = Date.now();
  void enqueue(async () => {
    if (!observerEnabled) return;
    const loaded = await loadState(now);
    const current = pruneUploadState(loaded, now);
    const next = recordUploadStart(current, requestId, tabId, now);
    if (next !== loaded) await saveState(next, loaded);
  });
}

function trackUploadFinish(requestId: string, applyCooldown: boolean): void {
  if (observerEnabled === false) return;
  const activeTabId = knownInFlight.get(requestId);
  if (cachedState !== null && activeTabId === undefined) return;
  const now = Date.now();
  if (applyCooldown && activeTabId !== undefined) {
    // Record the chunk cooldown synchronously before clearing in-flight so a concurrent discard check never sees a gap.
    knownCooldownUntil.set(
      activeTabId,
      Math.max(knownCooldownUntil.get(activeTabId) ?? 0, now + UPLOAD_CHUNK_COOLDOWN_MS),
    );
  }
  knownInFlight.delete(requestId);
  void enqueue(async () => {
    if (!observerEnabled) return;
    const loaded = await loadState(now);
    const current = pruneUploadState(loaded, now);
    const next = recordUploadFinish(current, requestId, now, applyCooldown);
    if (next !== loaded) await saveState(next, loaded);
  });
}

function onBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
  if (observerEnabled === false || details.tabId < 0) return;
  if (!BODY_METHODS.has(details.method)) return;
  if (isUploadRequestBody(details.method, details.requestBody)) {
    trackUploadStart(details.requestId, details.tabId);
  }
}

function onBeforeSendHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
  if (observerEnabled === false || details.tabId < 0) return;
  if (!UPLOAD_METHODS.has(details.method)) return;
  if (knownInFlight.has(details.requestId)) return;
  if (isUploadRequestHeaders(details.method, details.requestHeaders)) {
    trackUploadStart(details.requestId, details.tabId);
  }
}

function onCompleted(details: chrome.webRequest.WebResponseCacheDetails): void {
  trackUploadFinish(details.requestId, true);
}

function onErrorOccurred(details: chrome.webRequest.WebResponseErrorDetails): void {
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
  knownCooldownUntil.delete(tabId);
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
  const existingCooldown = knownCooldownUntil.get(oldTabId);
  if (existingCooldown !== undefined) {
    knownCooldownUntil.delete(oldTabId);
    knownCooldownUntil.set(newTabId, Math.max(knownCooldownUntil.get(newTabId) ?? 0, existingCooldown));
  }
  return enqueue(async () => {
    if (!observerEnabled) return;
    const current = await loadState(Date.now());
    const next = replaceUploadTabId(current, oldTabId, newTabId);
    if (next !== current) await saveState(next, current);
  });
}
