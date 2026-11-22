import { createAsyncQueue, isHttpUrl, loadConfig, normalizeUrl } from "../shared/config.ts";
import type {
  ActivityState,
  RestoreMode,
  SessionSnapshot,
  SnapshotListItem,
  SnapshotTab,
  SnapshotTrigger,
  SnapshotWindow,
  TabSummary,
} from "../shared/types.ts";
import {
  configureSyncFolder,
  getActiveSyncDir,
  deleteSyncedSnapshot,
  isFolderSyncOptedIn,
  loadPublishedSnapshotIds,
  findDeviceSnapshotEntry,
  utf8ByteLength,
  listSyncedSnapshots,
  loadDeviceIdentity,
  loadPendingSnapshotDeletes,
  pushSnapshotToSync,
  readSyncedSnapshot,
} from "./sync.ts";
import {
  enqueueActivityUpdate,
  getTabLastActiveAt,
  loadActivityState,
  loadKeptTabIds,
  recordTabVisit,
  saveActivityState,
  saveKeptTabIds,
  toTabSummary,
} from "./tracker.ts";

export const SNAPSHOTS_STORAGE_KEY = "tabReaper.sessionSnapshots";
const UNPUBLISHED_MANUAL_IDS = "tabReaper.unpublishedManualIds";
const LAST_WHOLE_SNAPSHOT_CACHE_KEY = "tabReaper.lastWholeSnapshotCache";
export const MAX_SNAPSHOTS = 5;
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_SNAPSHOT_URL_LEN = 4096;
export const MAX_SNAPSHOT_TITLE_LEN = 256;
export const MAX_SNAPSHOT_FAVICON_LEN = 512;
export const MAX_SNAPSHOTS_TOTAL_BYTES = 1_000_000; // 1 MB cap, well under chrome.storage.local 10 MB quota
const RECOVERY_MAX_CURRENT_TABS = 2;
const RECOVERY_MIN_SNAPSHOT_TABS = 5;
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface WholeSnapshotCheck {
  syncDir: string | null;
  checkedAt: number;
  id: string;
  digest?: string;
}

let restoreInFlight = false;
const enqueueLocalSnapshotMutation = createAsyncQueue();

async function loadWholeSnapshotCheck(): Promise<WholeSnapshotCheck | undefined> {
  const stored = await chrome.storage.session?.get(LAST_WHOLE_SNAPSHOT_CACHE_KEY).catch(() => undefined);
  return stored?.[LAST_WHOLE_SNAPSHOT_CACHE_KEY] as WholeSnapshotCheck | undefined;
}

async function rememberWholeSnapshotCheck(entry: WholeSnapshotCheck): Promise<void> {
  await chrome.storage.session?.set({ [LAST_WHOLE_SNAPSHOT_CACHE_KEY]: entry }).catch(() => undefined);
}

async function clearWholeSnapshotCheck(): Promise<void> {
  await chrome.storage.session?.remove(LAST_WHOLE_SNAPSHOT_CACHE_KEY).catch(() => undefined);
}

export function runSerializedWithSnapshots<T>(fn: () => Promise<T>): Promise<T> {
  return enqueueLocalSnapshotMutation(fn);
}

export function isRestoreInFlight(): boolean {
  return restoreInFlight;
}

export async function isAutoSnapshotsActive(): Promise<boolean> {
  return (await isFolderSyncOptedIn()) && (await loadConfig()).enableSessionSnapshots;
}

export async function loadSnapshots(): Promise<SessionSnapshot[]> {
  const result = await chrome.storage.local.get(SNAPSHOTS_STORAGE_KEY);
  const raw = result[SNAPSHOTS_STORAGE_KEY] as SessionSnapshot[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export function setSyncFolder(path: string | null) {
  return enqueueLocalSnapshotMutation(async () => {
    if (path === null && await isFolderSyncOptedIn()) {
      const manuals = (await loadSnapshots()).filter(s => s.trigger === "manual");
      const published = await loadPublishedSnapshotIds(manuals);
      // After opt-out the host cannot verify which local copies are safe to rotate.
      await chrome.storage.local.set({ [UNPUBLISHED_MANUAL_IDS]: manuals.filter(s => !published.has(s.id)).map(s => s.id) });
    }
    const status = await configureSyncFolder(path);
    await clearWholeSnapshotCheck();
    if (status.ok && status.enabled) await chrome.storage.local.remove(UNPUBLISHED_MANUAL_IDS);
    return status;
  });
}

export async function clearSnapshots(): Promise<void> {
  await enqueueLocalSnapshotMutation(async () => {
    await chrome.storage.local.remove(SNAPSHOTS_STORAGE_KEY);
    await chrome.storage.local.remove(UNPUBLISHED_MANUAL_IDS);
    await clearWholeSnapshotCheck();
  });
}

export async function listAllSnapshots(): Promise<SnapshotListItem[]> {
  const syncDir = await getActiveSyncDir();
  const [local, synced, pendingDeletes] = await Promise.all([
    loadSnapshots(),
    listSyncedSnapshots(),
    loadPendingSnapshotDeletes(syncDir),
  ]);
  const pendingSet = new Set(pendingDeletes);
  const byId = new Map<string, SnapshotListItem>();

  for (const item of synced) {
    if (pendingSet.has(item.id)) continue;
    byId.set(item.id, item);
  }

  for (const snap of local) {
    if (pendingSet.has(snap.id) || byId.has(snap.id)) continue;
    const windowCount = snap.windowCount ?? Math.max(1, new Set(snap.tabs.map((t) => t.windowId)).size);
    byId.set(snap.id, {
      id: snap.id,
      capturedAt: snap.capturedAt,
      tabCount: snap.tabCount,
      windowCount,
      trigger: snap.trigger ?? "auto",
      label: snap.label,
      deviceId: snap.deviceId,
      deviceName: snap.deviceName,
      source: "local",
      syncDir,
    });
  }

  return Array.from(byId.values()).sort((a, b) => b.capturedAt - a.capturedAt);
}

export async function deleteSnapshot(id: string, folder?: string | null): Promise<boolean> {
  const syncDir = folder === undefined ? await getActiveSyncDir() : folder;
  const removedLocal = await enqueueLocalSnapshotMutation(async () => {
    const local = await loadSnapshots();
    const remaining = local.filter((s) => s.id !== id);
    if (remaining.length !== local.length) {
      const saved = await chrome.storage.local.get(UNPUBLISHED_MANUAL_IDS);
      const protectedIds = saved[UNPUBLISHED_MANUAL_IDS] as string[] | undefined;
      const changes: Record<string, unknown> = { [SNAPSHOTS_STORAGE_KEY]: remaining };
      if (protectedIds?.includes(id)) changes[UNPUBLISHED_MANUAL_IDS] = protectedIds.filter(pending => pending !== id);
      await chrome.storage.local.set(changes);
      return true;
    }
    return false;
  });
  const syncRemoved = await deleteSyncedSnapshot(id, syncDir);
  if (removedLocal || syncRemoved) await clearWholeSnapshotCheck();
  return removedLocal || syncRemoved;
}

function isRecoverable(s: { tabCount: number; capturedAt: number }, now: number): boolean {
  return s.tabCount >= RECOVERY_MIN_SNAPSHOT_TABS && now - s.capturedAt <= RECOVERY_MAX_AGE_MS;
}

async function storeCapture(created: SessionSnapshot, existing: SessionSnapshot[], allowPartial = false): Promise<SessionSnapshot | null> {
  const candidates = [created, ...existing];
  const sizes = new Map(candidates.map(s => [s.id, utf8ByteLength(JSON.stringify(s)) + 1]));
  const overBudget = (list: SessionSnapshot[]) =>
    list.reduce((total, s) => total + sizes.get(s.id)!, 1) > MAX_SNAPSHOTS_TOTAL_BYTES;
  const store = (list: SessionSnapshot[]) => chrome.storage.local.set({ [SNAPSHOTS_STORAGE_KEY]: list });
  const isQuotaError = (error: unknown) => error instanceof Error && /quota/i.test(error.message);

  if (candidates.length <= MAX_SNAPSHOTS && !overBudget(candidates)) {
    try {
      await store(candidates);
      return created;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
    }
  }

  // Offline manual captures have no other known copy until the current folder indexes them.
  const manual = existing.filter(s => s.trigger === "manual");
  let protectedIds = new Set<string>();
  if (manual.length) {
    if (await isFolderSyncOptedIn()) {
      const published = await loadPublishedSnapshotIds(manual);
      protectedIds = new Set(manual.filter(s => !published.has(s.id)).map(s => s.id));
    } else {
      const saved = await chrome.storage.local.get(UNPUBLISHED_MANUAL_IDS);
      protectedIds = new Set(saved[UNPUBLISHED_MANUAL_IDS] ?? []);
    }
  }
  if (!created.complete || allowPartial) {
    const newestWhole = existing.find(s => s.complete);
    if (newestWhole) protectedIds.add(newestWhole.id);
  }
  // A closed window captures only part of a session. Reserve the latest whole-session recovery point first.
  const smallAuto = created.trigger === "auto" && created.tabCount < RECOVERY_MIN_SNAPSHOT_TABS;
  const recoveryCandidates = created.trigger === "window_closed" || smallAuto
    ? existing.filter(s => isRecoverable(s, created.capturedAt))
    : [];
  const recovery = recoveryCandidates.find(s => s.trigger !== "window_closed")
    ?? (created.tabCount < RECOVERY_MIN_SNAPSHOT_TABS ? recoveryCandidates[0] : undefined);
  const reserveRecovery = recovery !== undefined && !protectedIds.has(recovery.id);
  if (recovery) protectedIds.add(recovery.id);
  let kept = candidates.filter(s => protectedIds.has(s.id) || s === created);
  if (allowPartial && overBudget(kept)) {
    const reserved = kept.filter(s => s !== created);
    const partial = { ...created, complete: false, id: crypto.randomUUID(), tabs: [] as SnapshotTab[], tabCount: 0 };
    let bytes = utf8ByteLength(JSON.stringify([partial, ...reserved])) + String(created.tabCount).length;
    for (const tab of created.tabs) {
      const size = utf8ByteLength(JSON.stringify(tab)) + 1;
      if (bytes + size > MAX_SNAPSHOTS_TOTAL_BYTES) break;
      partial.tabs.push(tab);
      bytes += size;
    }
    if (!partial.tabs.length) return null;
    partial.tabCount = partial.tabs.length;
    const windowIds = new Set(partial.tabs.map(t => t.windowId));
    partial.windows = partial.windows?.filter(w => windowIds.has(w.id));
    partial.windowCount = windowIds.size;
    created = partial;
    kept = [created, ...reserved];
    sizes.set(created.id, utf8ByteLength(JSON.stringify(created)) + 1);
  }
  if (!overBudget(kept)) {
    let recentCount = reserveRecovery ? 2 : 1;
    for (const s of existing) {
      if (protectedIds.has(s.id)) continue;
      if (recentCount >= MAX_SNAPSHOTS || overBudget([...kept, s])) break;
      kept.push(s);
      recentCount++;
    }
    kept.sort((a, b) => b.capturedAt - a.capturedAt);
    for (;;) {
      try {
        await store(kept);
        return created;
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        const expendable = [...kept].reverse().find(s => s !== created && !protectedIds.has(s.id));
        if (!expendable) break;
        kept = kept.filter(s => s !== expendable);
      }
    }
  }
  return null;
}

async function snapshotDigest(tabs: SnapshotTab[]): Promise<string> {
  const ordered = tabs.map(t => JSON.stringify([
    t.windowId, t.index, normalizeUrl(t.url), Boolean(t.active), t.pinned,
    t.kept, t.groupId, t.groupTitle, t.groupColor, Boolean(t.groupCollapsed),
  ])).sort();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ordered.join("\n")));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeFavIconUrl(url: string | undefined): string | undefined {
  if (!isHttpUrl(url)) return undefined;
  if (url.length > MAX_SNAPSHOT_FAVICON_LEN) return undefined;
  return url;
}

export type CachedGroups = Record<number, Pick<chrome.tabGroups.TabGroup, "title" | "color" | "collapsed">>;

export async function buildSnapshotTabs(
  tabs: TabSummary[],
  activity?: ActivityState,
  now = Date.now(),
  cachedGroups?: CachedGroups,
): Promise<SnapshotTab[]> {
  const groupCache = new Map<number, { title?: string; color?: string; collapsed?: boolean }>();
  const out: SnapshotTab[] = [];

  const sorted = [...tabs].sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return (a.index ?? 0) - (b.index ?? 0);
  });

  for (const tab of sorted) {
    if (!isHttpUrl(tab.url)) continue;
    // Skip pathological mega-URLs (e.g., 2 MB hash-state URLs) to protect storage quota.
    if (tab.url.length > MAX_SNAPSHOT_URL_LEN) continue;

    let groupMeta: { title?: string; color?: string; collapsed?: boolean } = {};
    if (typeof tab.groupId === "number" && tab.groupId >= 0) {
      if (!groupCache.has(tab.groupId)) {
        try {
          const group = cachedGroups?.[tab.groupId] ?? await chrome.tabGroups.get(tab.groupId);
          groupCache.set(tab.groupId, {
            title: group.title || undefined,
            color: group.color,
            collapsed: Boolean(group.collapsed),
          });
        } catch {
          groupCache.set(tab.groupId, {});
        }
      }
      groupMeta = groupCache.get(tab.groupId) ?? {};
    }

    const rawTitle = tab.title || tab.url;
    out.push({
      url: tab.url,
      title: rawTitle.length > MAX_SNAPSHOT_TITLE_LEN ? rawTitle.slice(0, MAX_SNAPSHOT_TITLE_LEN) : rawTitle,
      pinned: tab.pinned,
      kept: Boolean(tab.kept),
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active || undefined,
      discarded: tab.discarded || undefined,
      groupId: typeof tab.groupId === "number" && tab.groupId >= 0 ? tab.groupId : undefined,
      groupTitle: groupMeta.title?.slice(0, 64),
      groupColor: groupMeta.color,
      groupCollapsed: groupMeta.collapsed,
      lastActiveAt: activity ? getTabLastActiveAt(activity, tab, now) : undefined,
      favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
    });
  }

  return out;
}

export async function captureWindowMetadata(windowIds: Set<number>): Promise<SnapshotWindow[]> {
  if (typeof chrome.windows?.getAll !== "function") {
    return Array.from(windowIds).map((id, idx) => ({ id, focused: idx === 0 }));
  }
  try {
    const all = await chrome.windows.getAll();
    const out: SnapshotWindow[] = [];
    for (const win of all) {
      if (typeof win.id !== "number" || win.incognito || !windowIds.has(win.id)) continue;
      out.push({
        id: win.id,
        focused: Boolean(win.focused),
        state: win.state,
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
      });
    }
    return out;
  } catch {
    return Array.from(windowIds).map((id, idx) => ({ id, focused: idx === 0 }));
  }
}

export interface CaptureOptions {
  force?: boolean;
  now?: number;
  intervalMinutes?: number;
  trigger?: SnapshotTrigger;
  label?: string;
  activity?: ActivityState;
  skipSync?: boolean;
  closedWindow?: SnapshotWindow;
  groups?: CachedGroups;
}

/**
 * Captures a session snapshot when enough time has elapsed and tabs changed.
 * Stores up to 5 recent snapshots locally and pushes full GFS-retained snapshots
 * to the configured sync folder when Folder Sync is enabled.
 */
export async function captureSessionSnapshot(
  tabs: TabSummary[],
  options: CaptureOptions = {},
): Promise<SessionSnapshot | null> {
  if (restoreInFlight && options.trigger !== "pre_restore") return null;

  const now = options.now ?? Date.now();
  const force = Boolean(options.force);
  const trigger: SnapshotTrigger = options.trigger ?? (force ? "manual" : "auto");

  const intervalMs = (options.intervalMinutes ?? (await loadConfig()).snapshotIntervalMinutes) * 60_000;
  const last = !force ? await loadWholeSnapshotCheck() : undefined;
  if (!force) {
    if (!(await isAutoSnapshotsActive())) return null;
    const syncDir = await getActiveSyncDir();
    if (last && last.syncDir === syncDir && now >= last.checkedAt && now - last.checkedAt < intervalMs) return null;
  }

  const snapshotTabs = await buildSnapshotTabs(tabs, options.activity, now, options.groups);
  if (snapshotTabs.length === 0) return null;

  const windowIds = new Set(snapshotTabs.map((t) => t.windowId));
  const [windows, identity] = await Promise.all([
    options.closedWindow ? [options.closedWindow] : captureWindowMetadata(windowIds),
    loadDeviceIdentity().catch(() => null),
  ]);

  const cleanedLabel = options.label?.trim().slice(0, 80) || undefined;
  const isAutomaticTrigger = trigger !== "manual";
  return enqueueLocalSnapshotMutation(async () => {
    const stillAllowed = async (): Promise<boolean> => {
      if (!(await isFolderSyncOptedIn())) return false;
      if (isAutomaticTrigger && !(await loadConfig()).enableSessionSnapshots) return false;
      return true;
    };
    if (!(await stillAllowed())) return null;

    const activeDir = await getActiveSyncDir();
    const existing = await loadSnapshots();
    const digest = trigger === "window_closed" ? undefined : await snapshotDigest(snapshotTabs);
    if (!force) {
      // Measure elapsed time against whole-session captures only so closing a small window
      // never postpones whole-session backups indefinitely.
      const local = existing.find((s) => s.trigger !== "window_closed");
      const disk = await findDeviceSnapshotEntry(s => s.trigger !== "window_closed");
      const newest = disk && (!local || disk.capturedAt > local.capturedAt) ? disk : local;
      if (newest) {
        const cachedDigest = last?.syncDir === activeDir && last.id === newest.id ? last.digest : undefined;
        const check = { syncDir: activeDir, checkedAt: now, id: newest.id, digest: cachedDigest };
        if (now - newest.capturedAt < intervalMs) {
          await rememberWholeSnapshotCheck({ ...check, checkedAt: newest.capturedAt });
          return null;
        }
        if (snapshotTabs.length <= RECOVERY_MAX_CURRENT_TABS && isRecoverable(newest, now)) {
          await rememberWholeSnapshotCheck(check);
          return null;
        }
        if (newest.complete === true && newest.tabCount === snapshotTabs.length) {
          let previousDigest = cachedDigest;
          if (!previousDigest) {
            const previous = "relPath" in newest ? await readSyncedSnapshot(newest.relPath) : newest;
            if (previous) previousDigest = await snapshotDigest(previous.tabs);
          }
          if (previousDigest && previousDigest === digest) {
            await rememberWholeSnapshotCheck({ ...check, digest });
            return null;
          }
        }
      }
      // Re-check after async disk reads in case automatic snapshots or sync were disabled mid-flight.
      if (!(await stillAllowed())) return null;
    }

    const created: SessionSnapshot = {
      id: crypto.randomUUID(),
      schemaVersion: 2,
      complete: trigger !== "window_closed",
      capturedAt: now,
      tabCount: snapshotTabs.length,
      windowCount: Math.max(1, windowIds.size),
      trigger,
      label: cleanedLabel,
      deviceId: identity?.deviceId,
      deviceName: identity?.deviceName,
      windows,
      tabs: snapshotTabs,
    };

    let saved = await storeCapture(created, existing);
    if (!options.skipSync || !saved) {
      if (await pushSnapshotToSync(created, now).catch(() => false)) saved = created;
    }
    if (!saved && trigger !== "manual") saved = await storeCapture(created, existing, true);
    if (saved) {
      if (trigger !== "window_closed") {
        await rememberWholeSnapshotCheck({ syncDir: activeDir, checkedAt: now, id: saved.id,
          digest: saved === created ? digest : await snapshotDigest(saved.tabs) });
      }
      return saved;
    }
    if (trigger !== "manual") return null;
    throw new Error("Not enough local space. Reconnect the backup folder or delete an older snapshot and try again.");
  });
}

export async function findRecoverableSnapshot(
  currentTabs: TabSummary[],
  snapshots: SessionSnapshot[],
  now = Date.now(),
): Promise<{ id: string; capturedAt: number; tabCount: number; windowCount?: number; relPath?: string } | null> {
  if (!(await isFolderSyncOptedIn())) return null;
  const currentHttpCount = currentTabs.filter((t) => isHttpUrl(t.url)).length;
  if (currentHttpCount > RECOVERY_MAX_CURRENT_TABS) return null;

  const disk = await findDeviceSnapshotEntry(s => isRecoverable(s, now));
  const candidates = [
    ...snapshots.map(s => ({
      id: s.id, capturedAt: s.capturedAt, tabCount: s.tabCount,
      windowCount: s.windowCount ?? Math.max(1, new Set(s.tabs.map(t => t.windowId)).size),
    })),
    ...(disk ? [disk] : []),
  ];
  return candidates.sort((a, b) => b.capturedAt - a.capturedAt).find(
    s => isRecoverable(s, now),
  ) ?? null;
}

export interface RestoreOptions {
  targetWindowId?: number;
  mode?: RestoreMode;
  relPath?: string;
}

export interface RestoreResult {
  restored: number;
  skippedExisting: number;
  windowsCreated: number;
}

async function restoreTabsIntoWindow(
  items: SnapshotTab[],
  targetWindowId: number,
  existingFirstTabId: number | undefined,
  openUrls: Set<string> | null,
  newlyKeptIds: number[],
  createdRecords: Array<{ id: number; url: string }>,
): Promise<{ restored: number; skippedExisting: number }> {
  let restored = 0;
  let skippedExisting = 0;
  let firstTabConsumed = false;

  const groupBuckets = new Map<
    string,
    { title?: string; color?: string; collapsed?: boolean; tabIds: number[] }
  >();

  const ordered = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const item of ordered) {
    if (!isHttpUrl(item.url)) continue;
    const norm = normalizeUrl(item.url);
    if (openUrls && openUrls.has(norm)) {
      skippedExisting++;
      continue;
    }

    try {
      let createdId: number | undefined;
      if (!firstTabConsumed && typeof existingFirstTabId === "number") {
        firstTabConsumed = true;
        createdId = existingFirstTabId;
        if (item.pinned && typeof chrome.tabs.update === "function") {
          try {
            await chrome.tabs.update(createdId, { pinned: true });
          } catch {
            // Best-effort pin on initial window tab.
          }
        }
      } else {
        const createOpts: chrome.tabs.CreateProperties = {
          url: item.url,
          active: Boolean(item.active && openUrls === null),
          windowId: targetWindowId,
          pinned: item.pinned,
        };
        const created = await chrome.tabs.create(createOpts);
        createdId = created.id;
      }

      openUrls?.add(norm);
      restored++;

      if (typeof createdId === "number") {
        createdRecords.push({ id: createdId, url: item.url });
        if (item.kept) {
          newlyKeptIds.push(createdId);
        }
        if (item.groupId !== undefined) {
          const gKey = JSON.stringify([item.windowId, item.groupId]);
          let bucket = groupBuckets.get(gKey);
          if (!bucket) {
            bucket = {
              title: item.groupTitle,
              color: item.groupColor,
              collapsed: item.groupCollapsed,
              tabIds: [],
            };
            groupBuckets.set(gKey, bucket);
          }
          bucket.tabIds.push(createdId);
        }
        if (!item.pinned && !item.kept && !item.active) {
          try {
            await chrome.tabs.discard(createdId);
          } catch {
            // Some Chrome versions reject discarding a brand-new tab before initial navigation; next sweep handles it.
          }
        }
      }
    } catch {
      // Skip individual tab creation errors.
    }
  }

  for (const bucket of groupBuckets.values()) {
    if (bucket.tabIds.length === 0) continue;
    try {
      const groupOpts: chrome.tabs.GroupOptions = {
        tabIds: bucket.tabIds as [number, ...number[]],
        createProperties: { windowId: targetWindowId },
      };
      const groupId = await chrome.tabs.group(groupOpts);
      const updateProps: chrome.tabGroups.UpdateProperties = {};
      if (bucket.title) updateProps.title = bucket.title;
      if (bucket.color) updateProps.color = bucket.color as chrome.tabGroups.UpdateProperties["color"];
      if (typeof bucket.collapsed === "boolean") updateProps.collapsed = bucket.collapsed;
      if (
        updateProps.title !== undefined ||
        updateProps.color !== undefined ||
        updateProps.collapsed !== undefined
      ) {
        await chrome.tabGroups.update(groupId, updateProps);
      }
    } catch {
      // Best-effort group restoration.
    }
  }

  return { restored, skippedExisting };
}

export async function restoreSessionSnapshot(
  snapshotId: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (restoreInFlight) return { restored: 0, skippedExisting: 0, windowsCreated: 0 };
  restoreInFlight = true;

  try {
    const targetWindowId = options.targetWindowId ?? (await chrome.windows.getLastFocused()).id;
    if (targetWindowId === undefined || targetWindowId < 0) throw new Error("Restore needs an open browser window.");
    const localSnapshots = await loadSnapshots();
    let snapshot: SessionSnapshot | null = localSnapshots.find((s) => s.id === snapshotId) ?? null;
    if (!snapshot && options.relPath) {
      snapshot = await readSyncedSnapshot(options.relPath);
    }
    if (!snapshot || snapshot.id !== snapshotId) throw new Error("Snapshot unavailable. Wait for the backup folder to sync and try again.");

    const [currentTabs, kept] = await Promise.all([chrome.tabs.query({}), loadKeptTabIds()]);
    const openUrls = new Set<string>();
    const currentSummaries: TabSummary[] = [];
    for (const tab of currentTabs) {
      const summary = toTabSummary(tab, kept);
      if (summary && isHttpUrl(summary.url)) {
        openUrls.add(normalizeUrl(summary.url));
        currentSummaries.push(summary);
      }
    }

    // Safety net: capture a pre_restore snapshot if the user currently has an active session.
    if (currentSummaries.length >= 3 && (await isAutoSnapshotsActive())) {
      try {
        await captureSessionSnapshot(currentSummaries, {
          force: true,
          trigger: "pre_restore",
          label: "Before restore",
        });
      } catch {
        // Best-effort safety snapshot.
      }
    }

    const newlyKeptIds: number[] = [];
    const createdRecords: Array<{ id: number; url: string }> = [];
    let restored = 0;
    let skippedExisting = 0;
    let windowsCreated = 0;

    const tabsByWindow = new Map<number, SnapshotTab[]>();
    for (const item of snapshot.tabs) {
      if (!isHttpUrl(item.url)) continue;
      const list = tabsByWindow.get(item.windowId) ?? [];
      list.push(item);
      tabsByWindow.set(item.windowId, list);
    }

    const canCreateWindows = typeof chrome.windows?.create === "function";
    const resolvedMode: RestoreMode =
      options.mode ?? (tabsByWindow.size > 1 && canCreateWindows ? "windows" : "current_window");

    if (resolvedMode === "windows" && canCreateWindows) {
      const windowMetaById = new Map<number, SnapshotWindow>();
      for (const w of snapshot.windows ?? []) {
        windowMetaById.set(w.id, w);
      }

      let focusAfterRestore = targetWindowId;
      for (const [origWinId, winTabs] of tabsByWindow.entries()) {
        const ordered = [...winTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (ordered.length === 0) continue;

        // Preserve every saved tab occurrence in new-window mode (duplicate suppression
        // is scoped to current-window recovery so multi-window snapshots never drop a window).
        const firstTab = ordered[0]!;
        const winMeta = windowMetaById.get(origWinId);
        const winCreateOpts: chrome.windows.CreateData = {
          url: firstTab.url,
        };
        if (winMeta?.state === "maximized" || winMeta?.state === "fullscreen") {
          winCreateOpts.state = winMeta.state;
        } else {
          winCreateOpts.focused = false;
        }

        try {
          const newWin = await chrome.windows.create(winCreateOpts);
          windowsCreated++;
          const newWinId = newWin?.id;
          if (newWinId === undefined) throw new Error("Chrome did not return the new window ID.");
          if (winMeta?.focused) focusAfterRestore = newWinId;
          const firstTabId = newWin?.tabs?.[0]?.id;
          const res = await restoreTabsIntoWindow(
            ordered,
            newWinId,
            firstTabId,
            null,
            newlyKeptIds,
            createdRecords,
          );
          restored += res.restored;
          skippedExisting += res.skippedExisting;
        } catch {
          // Fallback to current window if window creation fails.
          const res = await restoreTabsIntoWindow(
            ordered,
            targetWindowId,
            undefined,
            openUrls,
            newlyKeptIds,
            createdRecords,
          );
          restored += res.restored;
          skippedExisting += res.skippedExisting;
        }
      }
      if (windowsCreated > 0) {
        // Maximized and fullscreen windows may take focus as Chrome creates them.
        await chrome.windows.update(focusAfterRestore, { focused: true }).catch(() => undefined);
      }
    } else {
      const res = await restoreTabsIntoWindow(
        snapshot.tabs,
        targetWindowId,
        undefined,
        openUrls,
        newlyKeptIds,
        createdRecords,
      );
      restored += res.restored;
      skippedExisting += res.skippedExisting;
    }

    await enqueueActivityUpdate(async () => {
      if (newlyKeptIds.length > 0) {
        const keptIds = await loadKeptTabIds();
        for (const id of newlyKeptIds) keptIds.add(id);
        await saveKeptTabIds(keptIds);
      }

      if (createdRecords.length > 0) {
        const now = Date.now();
        const loaded = await loadActivityState();
        let activity = loaded;
        for (const rec of createdRecords) {
          activity = recordTabVisit(activity, rec.id, rec.url, now);
        }
        await saveActivityState(activity, loaded);
      }
    });

    return { restored, skippedExisting, windowsCreated };
  } finally {
    restoreInFlight = false;
  }
}
