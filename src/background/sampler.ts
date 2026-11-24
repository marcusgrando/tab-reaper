import { HTTP_HOST_ORIGINS, TimeoutError, isInternalUrl, withTimeout } from "../shared/config.ts";
import type { TabSummary, TabWeightSample } from "../shared/types.ts";

const SAMPLE_CACHE_KEY = "tabCurb.weightSamples";
const SAMPLE_TTL_MS = 2 * 60 * 1000;
/** Bound per-tab executeScript calls so one hung renderer cannot stall sweeps or the popup. */
export const SCRIPT_INSPECT_TIMEOUT_MS = 500;
const TOP_FRAME_FALLBACK_TIMEOUT_MS = 250;

interface RawLiveState {
  hasUnsavedForm: boolean;
  isVisible: boolean;
  hasPictureInPicture: boolean;
}

interface RawPageMetrics extends RawLiveState {
  jsHeapBytes: number;
  domNodes: number;
  mediaNodes: number;
  origin?: string;
}

export interface LiveTabProtection {
  hasUnsavedForm: boolean;
  isVisible: boolean;
  hasPictureInPicture: boolean;
  timedOut: boolean;
}

interface LiveTabInspection {
  hasUnsavedForm: boolean | undefined;
  isVisible: boolean;
  hasPictureInPicture: boolean;
  timedOut: boolean;
}

const FALLBACK_DOM_NODE_BYTES = 2048;
const FALLBACK_MEDIA_NODE_BYTES = 16 * 1024 * 1024;

export function computeWeightMultiplier(metrics: Pick<RawPageMetrics, "jsHeapBytes" | "domNodes" | "mediaNodes">): number {
  const heapMb = metrics.jsHeapBytes / (1024 * 1024);
  const heapScore = Math.min(2.5, heapMb / 60);
  const domScore = Math.min(1.0, metrics.domNodes / 5000);
  const mediaScore = Math.min(0.5, metrics.mediaNodes * 0.15);
  return Number((1.0 + heapScore + domScore + mediaScore).toFixed(2));
}

/**
 * Uncapped composite weight used when OS per-renderer memory is unavailable.
 * Combines measured JS heap with approximate DOM and media element overhead so
 * DOM/media-heavy pages are not masked by small JS heap differences.
 */
export function computeFallbackWeightBytes(
  sample?: Pick<TabWeightSample, "jsHeapBytes" | "domNodes" | "mediaNodes">,
): number {
  if (!sample) return 0;
  const heap = typeof sample.jsHeapBytes === "number" && Number.isFinite(sample.jsHeapBytes) && sample.jsHeapBytes > 0
    ? sample.jsHeapBytes
    : 0;
  const dom = typeof sample.domNodes === "number" && Number.isFinite(sample.domNodes) && sample.domNodes > 0
    ? sample.domNodes * FALLBACK_DOM_NODE_BYTES
    : 0;
  const media = typeof sample.mediaNodes === "number" && Number.isFinite(sample.mediaNodes) && sample.mediaNodes > 0
    ? sample.mediaNodes * FALLBACK_MEDIA_NODE_BYTES
    : 0;
  return heap + dom + media;
}

export async function hasHostAccessPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      permissions: ["scripting"],
      origins: HTTP_HOST_ORIGINS,
    });
  } catch {
    return false;
  }
}

export async function sampleTabWeights(
  tabs: TabSummary[],
  now = Date.now(),
  protectUnsavedForms = true,
  refreshFormState = true,
  timeoutMs = SCRIPT_INSPECT_TIMEOUT_MS,
): Promise<Map<number, TabWeightSample>> {
  const weights = new Map<number, TabWeightSample>();
  if (tabs.length === 0) return weights;

  const hostAccess = await hasHostAccessPermission();
  if (!hostAccess) return weights;

  const cache = await loadSampleCache();
  let cacheChanged = false;
  await Promise.all(tabs.map(async (tab) => {
    if (tab.discarded || isInternalUrl(tab.url)) return;
    const key = String(tab.id);
    const cached = cache[key];
    let cacheable: TabWeightSample | null;
    let live: Pick<LiveTabProtection, "isVisible" | "hasPictureInPicture"> | undefined;
    if (cached && now - cached.sampledAt < SAMPLE_TTL_MS) {
      cacheable = cached;
      if (refreshFormState) {
        const inspected = await inspectLiveTabState(tab.id, protectUnsavedForms, timeoutMs);
        live = { isVisible: inspected.isVisible, hasPictureInPicture: inspected.hasPictureInPicture };
        const dirty = protectUnsavedForms ? inspected.hasUnsavedForm : false;
        if (dirty !== undefined && dirty !== cached.hasUnsavedForm) {
          cacheable = { ...cached, hasUnsavedForm: dirty };
        }
      }
    } else {
      const sampled = await sampleSingleTab(tab.id, now, protectUnsavedForms, timeoutMs);
      cacheable = sampled?.cacheable ?? null;
      live = sampled?.live;
    }
    if (!cacheable) return;
    // When refreshFormState is false, clear stale cached form flags in the returned map so
    // planEvictions still ranks the tab by weight and lets discardTabSafely run the live check.
    if (!refreshFormState && cacheable === cached) {
      weights.set(tab.id, { ...cacheable, hasUnsavedForm: false });
    } else if (live) {
      weights.set(tab.id, { ...cacheable, isVisible: live.isVisible, hasPictureInPicture: live.hasPictureInPicture });
    } else {
      weights.set(tab.id, cacheable);
    }
    if (cacheable !== cached) {
      // Never persist transient visibility or PiP flags in the 2-minute weight cache.
      cache[key] = cacheable;
      cacheChanged = true;
    }
  }));
  if (cacheChanged) await saveSampleCache(await withoutClosedTabs(cache));
  return weights;
}

// Session storage has a quota. Closed tabs never come back with the same id.
async function withoutClosedTabs(cache: Record<string, TabWeightSample>): Promise<Record<string, TabWeightSample>> {
  try {
    const open = new Set((await chrome.tabs.query({})).map(tab => String(tab.id)));
    return Object.fromEntries(Object.entries(cache).filter(([id]) => open.has(id)));
  } catch {
    return cache;
  }
}

export async function sampleTabFormsOnly(
  tabs: TabSummary[],
  now = Date.now(),
  protectUnsavedForms = true,
  timeoutMs = SCRIPT_INSPECT_TIMEOUT_MS,
): Promise<Map<number, TabWeightSample>> {
  const results = new Map<number, TabWeightSample>();
  if (tabs.length === 0 || !(await hasHostAccessPermission())) return results;
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.discarded || isInternalUrl(tab.url)) return;
      const live = await inspectLiveTabState(tab.id, protectUnsavedForms, timeoutMs);
      if (live.hasUnsavedForm === true || live.isVisible || live.hasPictureInPicture) {
        results.set(tab.id, {
          jsHeapBytes: 0,
          domNodes: 0,
          mediaNodes: 0,
          weightMultiplier: 1.0,
          hasUnsavedForm: live.hasUnsavedForm === true,
          isVisible: live.isVisible,
          hasPictureInPicture: live.hasPictureInPicture,
          sampledAt: now,
        });
      }
    }),
  );
  return results;
}

export async function clearSampleCache(): Promise<void> {
  try {
    await chrome.storage.session.remove(SAMPLE_CACHE_KEY);
  } catch {
    // Session storage is best-effort cache.
  }
}

export async function loadCachedWeights(now = Date.now()): Promise<Map<number, TabWeightSample>> {
  const weights = new Map<number, TabWeightSample>();
  const cache = await loadSampleCache();
  for (const [idStr, sample] of Object.entries(cache)) {
    const id = Number(idStr);
    if (Number.isFinite(id) && sample && now - sample.sampledAt < SAMPLE_TTL_MS) {
      weights.set(id, { ...sample, hasUnsavedForm: false });
    }
  }
  return weights;
}

function inspectPageInTab(includeMetrics: boolean, protectUnsavedForms = true): RawPageMetrics | RawLiveState {
  // Read observer via a Symbol key and built-ins via prototype descriptors/type checks
  // so page DOM clobbering (e.g. <form id="documentPictureInPicture">) cannot spoof state.
  const observer = (globalThis as Record<symbol, { dirty?: unknown } | undefined>)[
    Symbol.for("tabCurb.formObserver")
  ];
  const hasUnsavedForm = protectUnsavedForms && observer?.dirty === true;
  const isTop = window === window.top;
  // HeadlessChrome keeps every tab's visibilityState === "visible" regardless of activation,
  // so only treat an inactive visible document as screen-shared/split-view in headed browsers.
  const isHeadless = typeof navigator !== "undefined" && /\bHeadlessChrome\//i.test(navigator.userAgent);
  const visState =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get?.call(document) ??
    document.visibilityState;
  const isVisible = isTop && !isHeadless && visState === "visible";

  const rawPipEl =
    Object.getOwnPropertyDescriptor(Document.prototype, "pictureInPictureElement")?.get?.call(document) ??
    document.pictureInPictureElement;
  const hasVideoPip = rawPipEl instanceof Element;
  const docPipCtor = (globalThis as { DocumentPictureInPicture?: new (...args: never[]) => { window?: unknown } })
    .DocumentPictureInPicture;
  const docPip = window.isSecureContext
    ? (window as Window & { documentPictureInPicture?: unknown }).documentPictureInPicture
    : undefined;
  const hasDocPip =
    typeof docPipCtor === "function" &&
    docPip instanceof docPipCtor &&
    Boolean((docPip as { window?: unknown }).window);
  const hasPictureInPicture = hasVideoPip || hasDocPip;
  if (!includeMetrics) return { hasUnsavedForm, isVisible, hasPictureInPicture };

  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const jsHeapBytes = typeof perf.memory?.usedJSHeapSize === "number" ? perf.memory.usedJSHeapSize : 0;
  const domNodes = Document.prototype.getElementsByTagName.call(document, "*").length;
  const mediaNodes = Document.prototype.querySelectorAll.call(document, "iframe, canvas, video").length;
  const origin = typeof location?.origin === "string" ? location.origin : "";
  return { jsHeapBytes, domNodes, mediaNodes, origin, hasUnsavedForm, isVisible, hasPictureInPicture };
}

export async function checkTabLiveProtection(
  tabId: number,
  protectUnsavedForms = true,
  timeoutMs = SCRIPT_INSPECT_TIMEOUT_MS,
): Promise<LiveTabProtection> {
  if (!chrome.scripting?.executeScript || !(await hasHostAccessPermission())) {
    return { hasUnsavedForm: false, isVisible: false, hasPictureInPicture: false, timedOut: false };
  }
  const live = await inspectLiveTabState(tabId, protectUnsavedForms, timeoutMs);
  let hasUnsavedForm = false;
  if (protectUnsavedForms) {
    if (live.hasUnsavedForm !== undefined) {
      hasUnsavedForm = live.hasUnsavedForm;
    } else {
      const cached = (await loadSampleCache())[String(tabId)];
      hasUnsavedForm = cached?.hasUnsavedForm === true && Date.now() - cached.sampledAt < SAMPLE_TTL_MS;
    }
  }
  return {
    hasUnsavedForm,
    isVisible: live.isVisible,
    hasPictureInPicture: live.hasPictureInPicture,
    timedOut: live.timedOut,
  };
}

export async function checkTabHasUnsavedForm(tabId: number): Promise<boolean> {
  return (await checkTabLiveProtection(tabId, true)).hasUnsavedForm;
}

async function executeInspectScript(
  tabId: number,
  includeMetrics: boolean,
  protectUnsavedForms: boolean,
  timeoutMs: number,
): Promise<{ results: chrome.scripting.InjectionResult[] | null; timedOut: boolean }> {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: inspectPageInTab,
        args: [includeMetrics, protectUnsavedForms],
      }),
      timeoutMs,
    );
    return { results, timedOut: false };
  } catch (err) {
    if (!(err instanceof TimeoutError)) {
      return { results: null, timedOut: false };
    }
    // A slow third-party subframe can stall allFrames; probe the main frame separately so
    // ranking and popup badges still reflect top-frame state while keeping timedOut true.
    try {
      const topResults = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: inspectPageInTab,
          args: [includeMetrics, protectUnsavedForms],
        }),
        Math.min(timeoutMs, TOP_FRAME_FALLBACK_TIMEOUT_MS),
      );
      return { results: topResults, timedOut: true };
    } catch {
      return { results: null, timedOut: true };
    }
  }
}

async function inspectLiveTabState(
  tabId: number,
  protectUnsavedForms: boolean,
  timeoutMs = SCRIPT_INSPECT_TIMEOUT_MS,
): Promise<LiveTabInspection> {
  const { results, timedOut } = await executeInspectScript(tabId, false, protectUnsavedForms, timeoutMs);
  if (!results) {
    // Keep a previously observed draft protected until a successful recheck or cache expiry.
    return { hasUnsavedForm: undefined, isVisible: false, hasPictureInPicture: false, timedOut };
  }
  const frames = results
    .map(frame => frame?.result as Partial<RawLiveState> | undefined)
    .filter((res): res is Partial<RawLiveState> => Boolean(res && typeof res === "object"));
  const hasUnsavedForm = frames.some(frame => frame.hasUnsavedForm === true)
    ? true
    : !timedOut && frames.length > 0 && frames.length === results.length && frames.every(frame => frame.hasUnsavedForm === false)
      ? false
      : undefined;
  return {
    hasUnsavedForm,
    isVisible: frames.some(frame => frame.isVisible === true),
    hasPictureInPicture: frames.some(frame => frame.hasPictureInPicture === true),
    timedOut,
  };
}

async function sampleSingleTab(
  tabId: number,
  now: number,
  protectUnsavedForms: boolean,
  timeoutMs = SCRIPT_INSPECT_TIMEOUT_MS,
): Promise<{ cacheable: TabWeightSample; live: Pick<LiveTabProtection, "isVisible" | "hasPictureInPicture"> } | null> {
  if (!chrome.scripting?.executeScript) return null;
  const { results } = await executeInspectScript(tabId, true, protectUnsavedForms, timeoutMs);
  if (!results) return null;
  const topFrame = results.find((frame) => frame.frameId === 0) ?? results[0];
  const topMetrics = topFrame?.result as Partial<RawPageMetrics> | undefined;
  if (!topMetrics || typeof topMetrics !== "object") return null;

  const frames = results
    .map(frame => frame?.result as Partial<RawPageMetrics> | undefined)
    .filter((res): res is Partial<RawPageMetrics> => Boolean(res && typeof res === "object"));
  const hasUnsavedForm = frames.some(frame => Boolean(frame.hasUnsavedForm));
  const isVisible = frames.some(frame => frame.isVisible === true);
  const hasPictureInPicture = frames.some(frame => frame.hasPictureInPicture === true);

  // Same-origin frames share a V8 isolate, so deduplicate JS heap per concrete origin while
  // summing cross-origin iframes (and never double-counting opaque srcdoc/about:blank frames).
  const heapByOrigin = new Map<string, number>();
  let domNodes = 0;
  let mediaNodes = 0;
  for (const frame of frames) {
    if (typeof frame.domNodes === "number" && frame.domNodes > 0) domNodes += frame.domNodes;
    if (typeof frame.mediaNodes === "number" && frame.mediaNodes > 0) mediaNodes += frame.mediaNodes;
    const heap = typeof frame.jsHeapBytes === "number" && frame.jsHeapBytes > 0 ? frame.jsHeapBytes : 0;
    const origin = typeof frame.origin === "string" && frame.origin !== "" && frame.origin !== "null" ? frame.origin : null;
    if (heap > 0 && origin) {
      heapByOrigin.set(origin, Math.max(heapByOrigin.get(origin) ?? 0, heap));
    }
  }
  let jsHeapBytes = 0;
  if (heapByOrigin.size > 0) {
    for (const bytes of heapByOrigin.values()) jsHeapBytes += bytes;
  } else if (typeof topMetrics.jsHeapBytes === "number" && topMetrics.jsHeapBytes > 0) {
    jsHeapBytes = topMetrics.jsHeapBytes;
  }

  const aggregated = { jsHeapBytes, domNodes, mediaNodes };
  return {
    cacheable: {
      jsHeapBytes,
      domNodes,
      mediaNodes,
      weightMultiplier: computeWeightMultiplier(aggregated),
      hasUnsavedForm,
      sampledAt: now,
    },
    live: { isVisible, hasPictureInPicture },
  };
}

async function loadSampleCache(): Promise<Record<string, TabWeightSample>> {
  try {
    const result = await chrome.storage.session.get(SAMPLE_CACHE_KEY);
    const raw = result[SAMPLE_CACHE_KEY] as Record<string, TabWeightSample> | undefined;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function saveSampleCache(cache: Record<string, TabWeightSample>): Promise<void> {
  try {
    await chrome.storage.session.set({ [SAMPLE_CACHE_KEY]: cache });
  } catch {
    // Session storage is best-effort cache.
  }
}
