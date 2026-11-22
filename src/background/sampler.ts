import { isInternalUrl } from "../shared/config.ts";
import type { TabSummary, TabWeightSample } from "../shared/types.ts";

const SAMPLE_CACHE_KEY = "tabReaper.weightSamples";
const SAMPLE_TTL_MS = 2 * 60 * 1000;

interface RawPageMetrics {
  jsHeapBytes: number;
  domNodes: number;
  mediaNodes: number;
  hasUnsavedForm?: boolean;
}

export function computeWeightMultiplier(metrics: RawPageMetrics): number {
  const heapMb = metrics.jsHeapBytes / (1024 * 1024);
  const heapScore = Math.min(2.5, heapMb / 60);
  const domScore = Math.min(1.0, metrics.domNodes / 5000);
  const mediaScore = Math.min(0.5, metrics.mediaNodes * 0.15);
  return Number((1.0 + heapScore + domScore + mediaScore).toFixed(2));
}

export async function hasHostAccessPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      permissions: ["scripting"],
      origins: ["<all_urls>"],
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
    let sample: TabWeightSample | null;
    if (cached && now - cached.sampledAt < SAMPLE_TTL_MS) {
      sample = cached;
      if (refreshFormState) {
        const dirty = protectUnsavedForms ? await inspectFormState(tab.id) : false;
        if (dirty !== undefined && dirty !== cached.hasUnsavedForm) {
          sample = { ...cached, hasUnsavedForm: dirty };
        }
      }
    } else {
      sample = await sampleSingleTab(tab.id, now, protectUnsavedForms);
    }
    if (!sample) return;
    // When refreshFormState is false, clear stale cached form flags in the returned map so
    // planEvictions still ranks the tab by weight and lets discardTabSafely run the live form check.
    weights.set(tab.id, !refreshFormState && sample === cached ? { ...sample, hasUnsavedForm: false } : sample);
    if (sample !== cached) {
      cache[key] = sample;
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

function inspectPageInTab(includeMetrics: boolean, protectUnsavedForms = true): RawPageMetrics | boolean {
  const hasUnsavedForm = protectUnsavedForms && window.tabReaperFormObserver?.dirty === true;
  if (!includeMetrics) return hasUnsavedForm;
  if (window !== window.top) {
    return { jsHeapBytes: 0, domNodes: 0, mediaNodes: 0, hasUnsavedForm };
  }

  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const jsHeapBytes = typeof perf.memory?.usedJSHeapSize === "number" ? perf.memory.usedJSHeapSize : 0;
  const domNodes = document.getElementsByTagName("*").length;
  const mediaNodes = document.querySelectorAll("iframe, canvas, video").length;
  return { jsHeapBytes, domNodes, mediaNodes, hasUnsavedForm };
}

export async function checkTabHasUnsavedForm(tabId: number): Promise<boolean> {
  if (!chrome.scripting?.executeScript) return false;
  if (!(await hasHostAccessPermission())) return false;
  const dirty = await inspectFormState(tabId);
  if (dirty !== undefined) return dirty;
  const cached = (await loadSampleCache())[String(tabId)];
  return cached?.hasUnsavedForm === true && Date.now() - cached.sampledAt < SAMPLE_TTL_MS;
}

async function inspectFormState(tabId: number): Promise<boolean | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inspectPageInTab,
      args: [false],
    });
    if (results.some(frame => frame.result === true)) return true;
    if (results.length > 0 && results.every(frame => frame.result === false)) return false;
  } catch {
    // Keep a previously observed draft protected until a successful recheck or cache expiry.
  }
}

async function sampleSingleTab(tabId: number, now: number, protectUnsavedForms: boolean): Promise<TabWeightSample | null> {
  if (!chrome.scripting?.executeScript) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inspectPageInTab,
      args: [true, protectUnsavedForms],
    });
    const topFrame = results.find((frame) => frame.frameId === 0) ?? results[0];
    const metrics = topFrame?.result as RawPageMetrics | undefined;
    if (!metrics || typeof metrics !== "object") return null;

    const hasUnsavedForm = results.some((frame) => {
      const res = frame?.result as RawPageMetrics | undefined;
      return Boolean(res && typeof res === "object" && res.hasUnsavedForm);
    });

    return {
      jsHeapBytes: metrics.jsHeapBytes,
      domNodes: metrics.domNodes,
      mediaNodes: metrics.mediaNodes,
      weightMultiplier: computeWeightMultiplier(metrics),
      hasUnsavedForm,
      sampledAt: now,
    };
  } catch {
    return null;
  }
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
