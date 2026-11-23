import type { TabSummary, TabWeightSample } from "../shared/types.ts";

export interface FrameProcessInfo {
  frameId: number;
  processId: number;
  documentLifecycle?: string;
}

export interface TabProcessMemory {
  processMemoryBytes: number;
  reclaimableProcessBytes: number;
  sharedProcessTabs: number;
  sharedProcessTotalBytes: number;
  pinnedByProtectedPeer: boolean;
}

/**
 * Attributes per-renderer OS memory (keyed by Chromium --renderer-client-id, which equals
 * webNavigation frame.processId) to open loaded tabs.
 *
 * Ownership tiers prevent a small cross-origin iframe from stealing memory credit from a
 * top-level tab in the same SiteInstance renderer:
 * 1. Active top-level frames (frameId === 0)
 * 2. Active subframes (isolated OOPIFs whose origin is not open as a top-level tab)
 * 3. Live BFCache / prerender frames held exclusively by a tab
 */
export function attributeRendererMemory(
  tabs: TabSummary[],
  framesByTab: Map<number, FrameProcessInfo[]>,
  renderers: Record<string, number>,
  protectedTabIds: Set<number>,
): Map<number, TabProcessMemory> {
  const tier1 = new Map<string, Set<number>>();
  const tier2 = new Map<string, Set<number>>();
  const tier3 = new Map<string, Set<number>>();
  const mainProcessByTab = new Map<number, string>();
  const referencedPids = new Set<string>();

  const addRef = (bucket: Map<string, Set<number>>, pidKey: string, tabId: number) => {
    let set = bucket.get(pidKey);
    if (!set) {
      set = new Set();
      bucket.set(pidKey, set);
    }
    set.add(tabId);
    referencedPids.add(pidKey);
  };

  for (const tab of tabs) {
    if (tab.discarded) continue;
    const frames = framesByTab.get(tab.id);
    if (!frames) continue;
    for (const frame of frames) {
      if (!Number.isInteger(frame.processId) || frame.processId < 0) continue;
      if (frame.documentLifecycle === "pending_deletion") continue;
      const pidKey = String(frame.processId);
      const bytes = renderers[pidKey];
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) continue;

      const isActive = frame.documentLifecycle === undefined || frame.documentLifecycle === "active";
      if (isActive && frame.frameId === 0) {
        addRef(tier1, pidKey, tab.id);
        mainProcessByTab.set(tab.id, pidKey);
      } else if (isActive) {
        addRef(tier2, pidKey, tab.id);
      } else {
        addRef(tier3, pidKey, tab.id);
      }
    }
  }

  const ownersByPid = new Map<string, Set<number>>();
  const totals = new Map<number, { processMemoryBytes: number; reclaimableProcessBytes: number }>();

  for (const pidKey of referencedPids) {
    const bytes = renderers[pidKey]!;
    const t1 = tier1.get(pidKey);
    const t2 = tier2.get(pidKey);
    const t3 = tier3.get(pidKey);
    const owners = t1 && t1.size > 0 ? t1 : t2 && t2.size > 0 ? t2 : t3;
    if (!owners || owners.size === 0) continue;

    ownersByPid.set(pidKey, owners);
    const share = Math.round(bytes / owners.size);
    for (const tabId of owners) {
      let hasProtectedPeer = false;
      for (const otherId of owners) {
        if (otherId !== tabId && protectedTabIds.has(otherId)) {
          hasProtectedPeer = true;
          break;
        }
      }
      const entry = totals.get(tabId) ?? { processMemoryBytes: 0, reclaimableProcessBytes: 0 };
      entry.processMemoryBytes += share;
      if (!hasProtectedPeer) {
        entry.reclaimableProcessBytes += share;
      }
      totals.set(tabId, entry);
    }
  }

  const result = new Map<number, TabProcessMemory>();
  for (const [tabId, entry] of totals.entries()) {
    const mainPid = mainProcessByTab.get(tabId);
    const mainOwners = mainPid ? ownersByPid.get(mainPid) : undefined;
    let pinnedByProtectedPeer = false;
    if (mainOwners) {
      for (const otherId of mainOwners) {
        if (otherId !== tabId && protectedTabIds.has(otherId)) {
          pinnedByProtectedPeer = true;
          break;
        }
      }
    }
    result.set(tabId, {
      processMemoryBytes: entry.processMemoryBytes,
      reclaimableProcessBytes: entry.reclaimableProcessBytes,
      sharedProcessTabs: mainOwners ? mainOwners.size : 1,
      sharedProcessTotalBytes: mainPid ? renderers[mainPid]! : entry.processMemoryBytes,
      pinnedByProtectedPeer,
    });
  }
  return result;
}

export async function measureTabProcessMemory(
  tabs: TabSummary[],
  renderers: Record<string, number> | undefined,
  protectedTabIds: Set<number>,
): Promise<Map<number, TabProcessMemory>> {
  if (!renderers || Object.keys(renderers).length === 0) return new Map();
  if (!chrome.webNavigation?.getAllFrames) return new Map();

  const framesByTab = new Map<number, FrameProcessInfo[]>();
  const loadedTabs = tabs.filter((tab) => !tab.discarded);
  await Promise.all(
    loadedTabs.map(async (tab) => {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        if (Array.isArray(frames) && frames.length > 0) {
          framesByTab.set(
            tab.id,
            frames.map((frame) => ({
              frameId: frame.frameId,
              processId: frame.processId,
              documentLifecycle: (frame as { documentLifecycle?: string }).documentLifecycle,
            })),
          );
        }
      } catch {
        // Tab may have closed or become unavailable concurrently.
      }
    }),
  );

  return attributeRendererMemory(tabs, framesByTab, renderers, protectedTabIds);
}

export function mergeProcessMemorySamples(
  base: Map<number, TabWeightSample>,
  processMemory: Map<number, TabProcessMemory>,
  now = Date.now(),
): Map<number, TabWeightSample> {
  if (processMemory.size === 0) return base;
  const merged = new Map<number, TabWeightSample>(base);
  for (const [tabId, proc] of processMemory.entries()) {
    const existing = merged.get(tabId);
    if (existing) {
      merged.set(tabId, {
        ...existing,
        ...proc,
      });
    } else {
      merged.set(tabId, {
        jsHeapBytes: 0,
        domNodes: 0,
        mediaNodes: 0,
        weightMultiplier: 1,
        sampledAt: now,
        ...proc,
      });
    }
  }
  return merged;
}
