import { isInternalUrl } from "../shared/config.ts";
import type { TabSummary, TabWeightSample } from "../shared/types.ts";

const SAMPLE_CACHE_KEY = "tabReaper.weightSamples";
const SAMPLE_TTL_MS = 2 * 60 * 1000;

interface RawPageMetrics {
  jsHeapBytes: number;
  domNodes: number;
  mediaNodes: number;
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
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
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

async function sampleSingleTab(tabId: number, now: number): Promise<TabWeightSample | null> {
  try {
    const results = await chrome.scripting.executeScript({
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
    });
    const metrics = results[0]?.result as RawPageMetrics | undefined;
    if (!metrics) return null;

    return {
      jsHeapBytes: metrics.jsHeapBytes,
      domNodes: metrics.domNodes,
      mediaNodes: metrics.mediaNodes,
      weightMultiplier: computeWeightMultiplier(metrics),
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
