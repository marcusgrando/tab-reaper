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

/**
 * Samples candidate loaded tabs on demand via chrome.scripting.executeScript.
 * Never injects permanent content scripts. Falls back to weight 1.0 when
 * optional host permission is not granted or a page blocks scripting.
 */
export async function sampleTabWeights(
  tabs: TabSummary[],
  now = Date.now(),
): Promise<Map<number, TabWeightSample>> {
  const weights = new Map<number, TabWeightSample>();
  if (tabs.length === 0) return weights;

  const hostAccess = await hasHostAccessPermission();
  if (!hostAccess) return weights;

  const cache = await loadSampleCache();
  const staleTabs: TabSummary[] = [];

  for (const tab of tabs) {
    if (tab.discarded || isInternalUrl(tab.url)) continue;
    const cached = cache[String(tab.id)];
    if (cached && now - cached.sampledAt < SAMPLE_TTL_MS) {
      weights.set(tab.id, cached);
    } else {
      staleTabs.push(tab);
    }
  }

  if (staleTabs.length === 0) return weights;

  await Promise.all(
    staleTabs.map(async (tab) => {
      const sample = await sampleSingleTab(tab.id, now);
      if (sample) {
        weights.set(tab.id, sample);
        cache[String(tab.id)] = sample;
      }
    }),
  );

  await saveSampleCache(cache);
  return weights;
}

export async function loadCachedWeights(now = Date.now()): Promise<Map<number, TabWeightSample>> {
  const weights = new Map<number, TabWeightSample>();
  const cache = await loadSampleCache();
  for (const [idStr, sample] of Object.entries(cache)) {
    const id = Number(idStr);
    if (Number.isFinite(id) && sample && now - sample.sampledAt < SAMPLE_TTL_MS) {
      weights.set(id, sample);
    }
  }
  return weights;
}

function detectUnsavedFormInPage(): boolean {
  const host = location.hostname.toLowerCase();
  // Auto-saving cloud editors continuously persist changes and use hidden/JS-populated inputs.
  const autoSaveHosts = [
    "docs.google.com",
    "notion.so",
    "www.notion.so",
    "figma.com",
    "www.figma.com",
    "miro.com",
    "coda.io",
    "airtable.com",
  ];
  if (autoSaveHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return false;
  }

  const isVisibleEditable = (el: HTMLElement): boolean => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
    if (el.closest("header, nav, [role='toolbar'], [role='search'], [role='menubar']")) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return false;
    return true;
  };

  const textareas = document.querySelectorAll("textarea");
  for (const ta of textareas) {
    if (ta.disabled || ta.readOnly || !isVisibleEditable(ta)) continue;
    if (ta.value !== ta.defaultValue && ta.value.trim().length >= 3) {
      return true;
    }
  }

  const skipTypes = new Set([
    "hidden",
    "submit",
    "button",
    "reset",
    "image",
    "checkbox",
    "radio",
    "file",
    "search",
    "range",
    "color",
  ]);
  const forms = document.querySelectorAll("form");
  for (const form of forms) {
    if (!form.querySelector("button[type='submit'], input[type='submit'], button:not([type])")) continue;
    const inputs = form.querySelectorAll("input");
    for (const input of inputs) {
      const type = (input.type || "text").toLowerCase();
      if (skipTypes.has(type) || input.disabled || input.readOnly || !isVisibleEditable(input)) continue;
      if (input.value !== input.defaultValue && input.value.trim().length > 0) {
        return true;
      }
    }
  }

  return false;
}

export async function checkTabHasUnsavedForm(tabId: number): Promise<boolean> {
  if (!chrome.scripting?.executeScript) return false;
  const hostAccess = await hasHostAccessPermission();
  if (!hostAccess) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectUnsavedFormInPage,
    });
    return Boolean(results[0]?.result);
  } catch {
    return false;
  }
}

async function sampleSingleTab(tabId: number, now: number): Promise<TabWeightSample | null> {
  if (!chrome.scripting?.executeScript) return null;
  try {
    const [metricsResults, formResults] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const perf = performance as Performance & {
            memory?: { usedJSHeapSize?: number };
          };
          const jsHeapBytes = typeof perf.memory?.usedJSHeapSize === "number" ? perf.memory.usedJSHeapSize : 0;
          const domNodes = document.getElementsByTagName("*").length;
          const mediaNodes = document.querySelectorAll("iframe, canvas, video").length;
          return { jsHeapBytes, domNodes, mediaNodes };
        },
      }),
      chrome.scripting.executeScript({
        target: { tabId },
        func: detectUnsavedFormInPage,
      }),
    ]);
    const metrics = metricsResults[0]?.result as RawPageMetrics | undefined;
    if (!metrics) return null;

    return {
      jsHeapBytes: metrics.jsHeapBytes,
      domNodes: metrics.domNodes,
      mediaNodes: metrics.mediaNodes,
      weightMultiplier: computeWeightMultiplier(metrics),
      hasUnsavedForm: Boolean(formResults[0]?.result),
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
