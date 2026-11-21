import { beforeEach, describe, expect, test } from "bun:test";
import { deleteArchivedTab, loadArchive, saveArchive, saveMergedArchiveWithBookmarks, searchArchive } from "../src/background/archive.ts";
import {
  GFS_RECENT_LIMIT,
  TOMBSTONE_TTL_MS,
  deleteSyncedSnapshot,
  getSyncStatus,
  listSyncedSnapshots,
  loadArchiveTombstones,
  mergeSyncedArchives,
  pruneSnapshotsGfs,
  pullAndMergeArchive,
  pullConfigFromSync,
  pushArchiveToSync,
  pushConfigToSync,
  pushSnapshotToSync,
  readSyncedSnapshot,
  resolveLatestConfig,
  setLocalConfigVersion,
  syncPendingLocalSnapshots,
  utf8ByteLength,
  type SyncedArchiveEnvelope,
  type SyncedConfigEnvelope,
} from "../src/background/sync.ts";
import { setSyncFolder, captureSessionSnapshot, deleteSnapshot, listAllSnapshots, findRecoverableSnapshot, loadSnapshots } from "../src/background/session.ts";
import { DEFAULT_CONFIG } from "../src/shared/config.ts";
import type { ArchivedTab, SessionSnapshot, TabReaperConfig } from "../src/shared/types.ts";

describe("folder sync conflict-free algorithms", () => {
  test("pruneSnapshotsGfs keeps all manual snapshots, 20 recent auto, 1/hour for 24h, and 1/day for 30d", () => {
    const now = Date.UTC(2026, 10, 21, 18, 0, 0);
    const items: Array<{ id: string; capturedAt: number; trigger?: "auto" | "manual" | "pre_restore" }> = [];

    for (let i = 0; i < 25; i++) {
      items.push({ id: `recent-${i}`, capturedAt: now - i * 5 * 60_000, trigger: "auto" });
    }
    items.push({ id: "h5-new", capturedAt: now - 5 * 3600_000 + 10 * 60_000, trigger: "auto" });
    items.push({ id: "h5-old", capturedAt: now - 5 * 3600_000 + 2 * 60_000, trigger: "auto" });
    items.push({ id: "d5-new", capturedAt: now - 5 * 86_400_000 + 3600_000, trigger: "auto" });
    items.push({ id: "d5-old", capturedAt: now - 5 * 86_400_000 + 60_000, trigger: "auto" });
    items.push({ id: "expired-auto", capturedAt: now - 45 * 86_400_000, trigger: "auto" });
    items.push({ id: "old-manual", capturedAt: now - 90 * 86_400_000, trigger: "manual" });

    const { keep, drop } = pruneSnapshotsGfs(items, now);
    const keptIds = new Set(keep.map((s) => s.id));
    const droppedIds = new Set(drop.map((s) => s.id));

    for (let i = 0; i < GFS_RECENT_LIMIT; i++) {
      expect(keptIds.has(`recent-${i}`)).toBe(true);
    }
    expect(keptIds.has("h5-new")).toBe(true);
    expect(droppedIds.has("h5-old")).toBe(true);
    expect(keptIds.has("d5-new")).toBe(true);
    expect(droppedIds.has("d5-old")).toBe(true);
    expect(droppedIds.has("expired-auto")).toBe(true);
    expect(keptIds.has("old-manual")).toBe(true);
  });

  test("resolveLatestConfig converges deterministically across devices including timestamp ties", () => {
    const a: SyncedConfigEnvelope = {
      schemaVersion: 1,
      updatedAt: 1000,
      deviceId: "dev-a",
      config: { ...DEFAULT_CONFIG, maxActiveTabs: 8 },
    };
    const b: SyncedConfigEnvelope = {
      schemaVersion: 1,
      updatedAt: 2000,
      deviceId: "dev-b",
      config: { ...DEFAULT_CONFIG, maxActiveTabs: 15 },
    };
    const c: SyncedConfigEnvelope = {
      schemaVersion: 1,
      updatedAt: 2000,
      deviceId: "dev-c",
      config: { ...DEFAULT_CONFIG, maxActiveTabs: 20 },
    };

    expect(resolveLatestConfig([a, b])?.deviceId).toBe("dev-b");
    expect(resolveLatestConfig([b, c])?.deviceId).toBe("dev-c");
    expect(resolveLatestConfig([c, b])?.deviceId).toBe("dev-c");
  });

  test("mergeSyncedArchives sanitizes malformed entries, preserves tombstones past 90d if remote still has URL", () => {
    const t0 = 1_700_000_000_000;
    const day91 = t0 + TOMBSTONE_TTL_MS + 86_400_000;

    const remote: SyncedArchiveEnvelope = {
      schemaVersion: 1,
      updatedAt: t0,
      deviceId: "dev-retired",
      items: [
        {
          id: "r1",
          url: "https://retired.com/deleted",
          normalizedUrl: "https://retired.com/deleted",
          title: "Retired Tab",
          lastActiveAt: t0,
          archivedAt: t0,
        },
        // Malformed entry missing title + bad URL entry
        {
          id: "r-notitle",
          url: "https://valid-no-title.com/page",
          normalizedUrl: "https://valid-no-title.com/page",
          title: undefined as unknown as string,
          lastActiveAt: t0,
          archivedAt: t0,
        },
        {
          id: "r-badscheme",
          url: "javascript:alert(1)",
          normalizedUrl: "javascript:alert(1)",
          title: "XSS",
          lastActiveAt: t0,
          archivedAt: t0,
        },
      ],
      tombstones: {},
    };

    const merged = mergeSyncedArchives([], { "https://retired.com/deleted": t0 + 5000 }, [remote], day91);
    // Deleted tab must NOT resurrect on day 91 while retired device still lists it.
    expect(merged.items.map((i) => i.url)).toEqual(["https://valid-no-title.com/page"]);
    expect(merged.tombstones["https://retired.com/deleted"]).toBe(t0 + 5000);
    // Missing title falls back to URL so searchArchive never throws.
    expect(searchArchive(merged.items, "valid-no-title")).toHaveLength(1);
  });
});

describe("multi-device single-writer folder sync integration", () => {
  let storageData: Record<string, unknown>;
  let virtualFs: Map<string, string>;
  let failArchiveManifest: boolean;
  let writable: boolean;
  let hostOnline: boolean;
  let hostOutdated: boolean;
  let failNextIndexWrite: boolean;
  let failNextIndexRead: boolean;
  let loseIndexReply: boolean;

  let activeSyncDir: string;

  beforeEach(() => {
    activeSyncDir = "/iCloud/TabReaper";
    storageData = {
      "tabReaper.deviceIdentity": { deviceId: "dev-mac", deviceName: "MacBook Pro" },
      "tabReaper.folderSyncOptedIn": true,
      "tabReaper.activeSyncDir": activeSyncDir,
    };
    virtualFs = new Map<string, string>();
    failArchiveManifest = false;
    writable = true;
    hostOnline = true;
    hostOutdated = false;
    failNextIndexWrite = false;
    failNextIndexRead = false;
    loseIndexReply = false;

    (globalThis as unknown as { chrome: unknown }).chrome = {
      permissions: {
        contains: async () => true,
      },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storageData[key] }),
          set: async (obj: Record<string, unknown>) => {
            Object.assign(storageData, obj);
          },
          remove: async (key: string | string[]) => {
            for (const k of Array.isArray(key) ? key : [key]) {
              delete storageData[k];
            }
          },
        },
      },
      runtime: {
        sendNativeMessage: async (_host: string, payload: Record<string, unknown>) => {
          if (!hostOnline) return null;
          const cmd = payload.cmd as string;
          if (hostOutdated) {
            if (cmd === "ping") {
              return { ok: true, version: "0.4.4", platform: "macos" };
            }
            return { ok: false, error: "unknown command" };
          }
          if (cmd === "sync_set_folder") {
            return { ok: true, enabled: Boolean(payload.path), syncDir: payload.path, writable };
          }
          if (cmd === "sync_get_status") {
            return { ok: true, enabled: true, capabilities: ["expected_dir"], syncDir: activeSyncDir, writable, hostname: "MacBook" };
          }
          if (["sync_write", "sync_read", "sync_list", "sync_delete"].includes(cmd) && payload.expectedDir !== activeSyncDir) return { ok: false, error: "sync folder changed" };
          if (cmd === "sync_write") {
            const dev = payload.deviceId as string;
            const relPath = payload.relPath as string;
            if (!relPath.startsWith(`devices/${dev}/`)) {
              return { ok: false, error: "not owned" };
            }
            if (failArchiveManifest && relPath.endsWith("/archive.json")) return { ok: false };
            const content = payload.content as string;
            if (utf8ByteLength(content) > 800 * 1024) return { ok: false, error: "file exceeds limit" };
            if (failNextIndexWrite && relPath.endsWith("/index.json")) {
              failNextIndexWrite = false;
              return { ok: false };
            }
            virtualFs.set(relPath, content);
            if (loseIndexReply && relPath.endsWith("/index.json")) {
              loseIndexReply = false;
              return null;
            }
            return { ok: true, bytesWritten: content.length };
          }
          if (cmd === "sync_read") {
            const relPath = payload.relPath as string;
            if (failNextIndexRead && relPath.endsWith("/index.json")) {
              failNextIndexRead = false;
              return { ok: false, error: "transient i/o error" };
            }
            const content = virtualFs.get(relPath);
            return content !== undefined ? { ok: true, exists: true, content } : { ok: true, exists: false };
          }
          if (cmd === "sync_delete") {
            const dev = payload.deviceId as string;
            const relPath = payload.relPath as string;
            if (!relPath.startsWith(`devices/${dev}/`)) {
              return { ok: false, error: "not owned" };
            }
            return { ok: true, deleted: virtualFs.delete(relPath) };
          }
          if (cmd === "sync_list") {
            const prefix = (payload.relPrefix as string) || "";
            const files = Array.from(virtualFs.entries())
              .filter(([k]) => !prefix || k.startsWith(`${prefix}/`) || k === prefix)
              .map(([relPath, content]) => ({ relPath, sizeBytes: content.length, modifiedMs: Date.now() }));
            return { ok: true, files };
          }
          return { ok: false, error: "unknown" };
        },
      },
    };
  });

  test("repairs missing snapshot parts and restores from a read-only folder", async () => {
    const tabs = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Draft", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const snap = await captureSessionSnapshot(tabs, { force: true });
    expect(snap?.tabCount).toBe(400);
    expect(await captureSessionSnapshot(tabs, { now: snap!.capturedAt + 400_000 })).toBeNull();
    expect(await listSyncedSnapshots()).toHaveLength(1);
    const entry = (await listSyncedSnapshots())[0]!;
    expect(await captureSessionSnapshot([tabs[0]!], { now: snap!.capturedAt + 800_000 })).toBeNull();
    expect(await loadSnapshots()).toHaveLength(0);
    const recovery = await findRecoverableSnapshot([tabs[0]!], await loadSnapshots());
    expect(recovery?.relPath).toBe(entry.relPath);
    const partPath = entry.relPath!.replace(".json", "_p1.json");
    expect(virtualFs.delete(partPath)).toBe(true);
    const retry = await syncPendingLocalSnapshots(async () => [snap!]);
    expect(retry.uploaded).toBe(1);
    writable = false;
    expect((await listSyncedSnapshots())[0]?.id).toBe(snap!.id);
    expect((await readSyncedSnapshot(entry.relPath!))?.tabs.length).toBe(400);
  });

  test("disabling sync forgets an unpublished archive deletion", async () => {
    const url = "https://example.org/offline";
    const item = { id: "offline", url, normalizedUrl: url, title: "Offline", lastActiveAt: 10, archivedAt: 10 };
    await saveArchive([item]);
    virtualFs.set("devices/peer/archive.json", JSON.stringify({
      schemaVersion: 1, deviceId: "peer", updatedAt: 10, items: [item], tombstones: {},
    }));
    writable = false;
    await deleteArchivedTab(item.id);
    expect((await loadArchiveTombstones())[url]).toBeGreaterThan(10);
    expect((await setSyncFolder(null)).ok).toBe(true);
    expect(await loadArchiveTombstones()).toEqual({});
    writable = true;
    await setSyncFolder(activeSyncDir);
    const result = await pullAndMergeArchive({ loadLocal: loadArchive, saveMergedLocal: async items => {
      await saveArchive(items);
      return items;
    } });
    expect(result.ok).toBe(true);
    expect((await loadArchive()).map(entry => entry.url)).toEqual([url]);
  });

  test("re-enabling sync reads published deletion markers before importing a stale peer", async () => {
    const url = "https://example.org/archived";
    const item = { id: "archived", url, normalizedUrl: url, title: "Deleted", archivedAt: 10, lastActiveAt: 10 };
    const envelope = { schemaVersion: 1, updatedAt: 10, items: [item], tombstones: {}, deviceId: "peer" };
    virtualFs.set("devices/peer/archive.json", JSON.stringify(envelope));
    virtualFs.set("devices/dev-mac/archive.json", JSON.stringify({
      ...envelope, deviceId: "dev-mac", items: [], tombstones: { [url]: Date.now() },
    }));
    await setSyncFolder(null);
    await setSyncFolder(activeSyncDir);
    const res = await pullAndMergeArchive({ loadLocal: loadArchive, saveMergedLocal: async items => {
      await saveArchive(items);
      return items;
    } });
    expect(res.ok).toBe(true);
    expect(await loadArchive()).toEqual([]);
    expect((await loadArchiveTombstones())[url]).toBeGreaterThan(10);
  });

  test("uses the newest disk or local capture when a session shrinks to its former size", async () => {
    const now = Date.now() - 1_200_000;
    const large = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Page", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const small = large.slice(0, 5);
    expect((await captureSessionSnapshot(small, { now }))?.tabCount).toBe(5);
    expect((await captureSessionSnapshot(large, { now: now + 400_000 }))?.tabCount).toBe(400);
    const latest = await captureSessionSnapshot(small, { now: now + 800_000 });
    expect(latest?.tabCount).toBe(5);
    expect(await captureSessionSnapshot(small, { now: now + 1_200_000 })).toBeNull();
    expect((await findRecoverableSnapshot([], await loadSnapshots()))?.id).toBe(latest!.id);
  });

  test("an offline deletion survives disabling and re-enabling the same folder", async () => {
    const snap: SessionSnapshot = { id: "saved", capturedAt: Date.now(), tabCount: 1, tabs: [
      { url: "https://example.com", title: "Saved", windowId: 1, pinned: false, kept: false },
    ] };
    expect(await pushSnapshotToSync(snap)).toBe(true);
    hostOnline = false;
    await deleteSyncedSnapshot(snap.id);
    hostOnline = true;
    await setSyncFolder(null);
    await setSyncFolder(activeSyncDir);
    expect((await syncPendingLocalSnapshots(async () => [])).deleted).toBe(1);
    expect(await listSyncedSnapshots()).toHaveLength(0);
  });

  test("unmodified remote defaults preserve customized settings on upgrade", async () => {
    const legacy = { ...DEFAULT_CONFIG, enableSessionSnapshots: false };
    virtualFs.set("devices/zzz/config.json", JSON.stringify({
      schemaVersion: 1, config: DEFAULT_CONFIG, updatedAt: 0, deviceId: "zzz",
    }));
    const result = await pullConfigFromSync(async () => legacy, async () => { throw Error("Legacy settings overwritten"); });
    expect(result.ok).toBe(true);
    expect(JSON.parse(virtualFs.get("devices/dev-mac/config.json")!).config.enableSessionSnapshots).toBe(false);
  });

  test("a deletion wins over an archived URL from a device with a faster clock", async () => {
    const url = "https://example.com/" + "a".repeat(4200);
    const item = { id: "ahead", url, normalizedUrl: url, title: "Ahead", lastActiveAt: 1, archivedAt: Date.now() + 60_000 };
    const remote: SyncedArchiveEnvelope = { schemaVersion: 1, deviceId: "peer", updatedAt: item.archivedAt, items: [item], tombstones: {} };
    const imported = mergeSyncedArchives([], {}, [remote]);
    expect(imported.items[0]?.url).toBe(url);
    await saveArchive(imported.items);
    await deleteArchivedTab(item.id);
    const tombstones = await loadArchiveTombstones();
    expect(mergeSyncedArchives([], tombstones, [remote]).items).toHaveLength(0);
  });

  test("serializes concurrent snapshot captures, protects against transient index errors, and keeps remote snapshots read-only", async () => {
    const now = 1_700_000_000_000;
    const snap1: SessionSnapshot = {
      id: "snap-1",
      capturedAt: now + 1000,
      tabCount: 2,
      windowCount: 1,
      trigger: "auto",
      tabs: [{ url: "https://a.com", title: "A", pinned: false, kept: false, windowId: 1 }],
    };
    const snap2: SessionSnapshot = {
      id: "snap-2",
      capturedAt: now + 2000,
      tabCount: 3,
      windowCount: 1,
      trigger: "auto",
      tabs: [{ url: "https://b.com", title: "B", pinned: false, kept: false, windowId: 1 }],
    };

    // Seed a remote snapshot owned by dev-linux
    virtualFs.set(
      "devices/dev-linux/index.json",
      JSON.stringify({
        schemaVersion: 1,
        deviceId: "dev-linux",
        deviceName: "Workstation",
        updatedAt: now,
        snapshots: [
          {
            id: "snap-remote",
            capturedAt: now,
            tabCount: 5,
            windowCount: 1,
            trigger: "manual",
            relPath: "devices/dev-linux/snapshots/snap-remote.json",
          },
        ],
      }),
    );
    virtualFs.set("devices/dev-linux/snapshots/snap-remote.json", JSON.stringify({ id: "snap-remote" }));

    // Concurrent pushes must BOTH remain in index
    const [ok1, ok2] = await Promise.all([pushSnapshotToSync(snap1, now + 1000), pushSnapshotToSync(snap2, now + 2000)]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    // Transient index read failure must abort without wiping prior history
    failNextIndexRead = true;
    const snap3: SessionSnapshot = { ...snap2, id: "snap-3", capturedAt: now + 3000 };
    expect(await pushSnapshotToSync(snap3, now + 3000)).toBe(false);

    const listed = await listSyncedSnapshots();
    const ids = listed.map((s) => s.id);
    expect(ids).toContain("snap-1");
    expect(ids).toContain("snap-2");
    expect(ids).toContain("snap-remote");

    // Attempting to delete remote snapshot must fail and leave remote file untouched
    expect(await deleteSyncedSnapshot("snap-remote")).toBe(false);
    expect(virtualFs.has("devices/dev-linux/snapshots/snap-remote.json")).toBe(true);
  });

  test("converges equal-timestamp configs, pushes offline edits on reconnect, and detects outdated host", async () => {
    const now = 1_700_000_000_000;

    // Equal-timestamp config from dev-z (> dev-mac) must converge on pull
    await setLocalConfigVersion({ updatedAt: now, deviceId: "dev-mac" });
    await pushConfigToSync(async () => ({ ...DEFAULT_CONFIG, maxActiveTabs: 10 }), now);
    virtualFs.set(
      "devices/dev-z/config.json",
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: now,
        deviceId: "dev-z",
        config: { ...DEFAULT_CONFIG, maxActiveTabs: 77 },
      }),
    );

    let applied: TabReaperConfig | null = null;
    const pullRes = await pullConfigFromSync(
      async () => ({ ...DEFAULT_CONFIG, maxActiveTabs: 10 }),
      async (cfg) => {
        applied = cfg;
      },
    );
    expect(pullRes.updated).toBe(true);
    expect(applied!.maxActiveTabs).toBe(77);

    // Offline edit must be pushed once host reconnects
    hostOnline = false;
    await setLocalConfigVersion({ updatedAt: now + 10_000, deviceId: "dev-mac" });
    expect(await pushConfigToSync(async () => ({ ...DEFAULT_CONFIG, maxActiveTabs: 42 }), now + 10_000)).toBe(false);
    hostOnline = true;
    await pullConfigFromSync(async () => ({ ...DEFAULT_CONFIG, maxActiveTabs: 42 }), async () => {});
    const storedRemote = JSON.parse(virtualFs.get("devices/dev-mac/config.json")!) as SyncedConfigEnvelope;
    expect(storedRemote.config.maxActiveTabs).toBe(42);

    // Outdated v0.4.4 host is flagged as hostOutdated
    hostOutdated = true;
    const status = await getSyncStatus();
    expect(status.hostConnected).toBe(true);
    expect(status.hostOutdated).toBe(true);
    expect(status.hostVersion).toBe("0.4.4");
  });

  test("serializes concurrent archive deletions and reconciles Chrome bookmarks on merge", async () => {
    const now = 1_700_000_000_000;
    const createdBookmarks: Array<{ id: string; url: string }> = [];
    const removedBookmarks: string[] = [];
    let nextBmId = 10;

    const chromeMock = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    chromeMock.bookmarks = {
      getTree: async () => [{ id: "0", children: [{ id: "1" }, { id: "2" }] }],
      getChildren: async () => [{ id: "folder-1", title: "Auto-Archived Tabs" }],
      create: async (opts: { url: string }) => {
        const bm = { id: `bm-${nextBmId++}`, url: opts.url };
        createdBookmarks.push(bm);
        return bm;
      },
      remove: async (id: string) => {
        removedBookmarks.push(id);
      },
    };

    const initial: ArchivedTab[] = [
      { id: "a", url: "https://one.com", normalizedUrl: "https://one.com", title: "One", lastActiveAt: now, archivedAt: now, bookmarkId: "bm-1" },
      { id: "b", url: "https://two.com", normalizedUrl: "https://two.com", title: "Two", lastActiveAt: now, archivedAt: now, bookmarkId: "bm-2" },
      { id: "c", url: "https://three.com", normalizedUrl: "https://three.com", title: "Three", lastActiveAt: now, archivedAt: now, bookmarkId: "bm-3" },
    ];
    await saveArchive(initial);

    // Concurrent local deletions must keep BOTH tombstones
    await Promise.all([deleteArchivedTab("a"), deleteArchivedTab("b")]);
    const tombs = await loadArchiveTombstones();
    expect(tombs["https://one.com"]).toBeGreaterThan(0);
    expect(tombs["https://two.com"]).toBeGreaterThan(0);

    // Remote adds https://four.com and deletes https://three.com -> bookmarks must reconcile
    virtualFs.set(
      "devices/dev-linux/archive.json",
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: now + 5000,
        deviceId: "dev-linux",
        items: [
          { id: "d", url: "https://four.com", normalizedUrl: "https://four.com", title: "Four", lastActiveAt: now + 1000, archivedAt: now + 1000 },
        ],
        tombstones: { "https://three.com": now + 2000 },
      }),
    );

    const res = await pullAndMergeArchive(
      {
        loadLocal: loadArchive,
        saveMergedLocal: (merged, prev) => saveMergedArchiveWithBookmarks(merged, prev, "Auto-Archived Tabs"),
      },
      now + 6000,
    );
    expect(res.ok).toBe(true);
    expect(createdBookmarks.map((b) => b.url)).toEqual(["https://four.com"]);
    expect(removedBookmarks).toContain("bm-3");
    const finalArchive = await loadArchive();
    expect(finalArchive.map((i) => i.url)).toEqual(["https://four.com"]);
    expect(finalArchive[0]!.bookmarkId).toBe("bm-10");
  });

  test("deleting from a stale list never removes the same named save in the new folder", async () => {
    const folderA = activeSyncDir;
    const snapshot = await captureSessionSnapshot([{ id: 1, windowId: 1, title: "A",
      url: "https://example.org/a", active: true, audible: false, discarded: false, pinned: false }], { force: true, label: "Keep in B" });
    const [row] = await listAllSnapshots();
    const filesA = virtualFs;
    activeSyncDir = "/Dropbox/TabReaper";
    virtualFs = new Map(filesA);
    await setSyncFolder(activeSyncDir);
    await deleteSnapshot(row!.id, row!.syncDir);
    expect((await listSyncedSnapshots()).map(item => item.id)).toContain(snapshot!.id);
    activeSyncDir = folderA;
    virtualFs = filesA;
    await setSyncFolder(folderA);
    expect((await syncPendingLocalSnapshots(loadSnapshots)).deleted).toBe(1);
    expect(await listSyncedSnapshots()).toHaveLength(0);
  });

  test("deleting an unpublished local snapshot cleans up its body and overflow parts", async () => {
    const tabs = Array.from({ length: 200 }, (_, id) => ({ id, windowId: 1, title: "Private",
      url: "https://example.org/private/" + "a".repeat(2800) + id, active: false, audible: false, discarded: false, pinned: false }));
    failNextIndexWrite = true;
    const snap = await captureSessionSnapshot(tabs, { force: true, label: "Private" });
    expect(snap).not.toBeNull();
    const bodies = [...virtualFs.keys()].filter(key => key.includes("/snapshots/"));
    expect(bodies.length).toBeGreaterThan(1);
    hostOnline = false;
    expect(await deleteSnapshot(snap!.id)).toBe(true);
    hostOnline = true;
    expect((await syncPendingLocalSnapshots(loadSnapshots)).ok).toBe(true);
    expect(bodies.filter(path => virtualFs.has(path))).toEqual([]);
  });

  test("rotation removes expired files after the host loses the committed index reply", async () => {
    const now = Date.UTC(2026, 10, 21, 12);
    async function save(n: number) {
      return pushSnapshotToSync({ id: `auto-${n}`, capturedAt: now + n, tabCount: 1, trigger: "auto",
        tabs: [{ url: `https://example.com/${n}`, title: "Saved", windowId: 1, pinned: false, kept: false }] }, now + n);
    }
    for (let i = 0; i < GFS_RECENT_LIMIT; i++) expect(await save(i)).toBe(true);
    const oldest = (await listSyncedSnapshots()).find(s => s.id === "auto-0")!;
    loseIndexReply = true;
    expect(await save(GFS_RECENT_LIMIT)).toBe(false);
    expect((await listSyncedSnapshots()).map(s => s.id)).not.toContain(oldest.id);
    expect((await syncPendingLocalSnapshots(async () => [])).ok).toBe(true);
    expect(virtualFs.has(oldest.relPath!)).toBe(false);
    for (const kept of await listSyncedSnapshots()) expect(virtualFs.has(kept.relPath!)).toBe(true);
  });

  test("cleanup preserves a published snapshot when the host lost the index acknowledgement", async () => {
    const snap: SessionSnapshot = { id: "lost-reply", capturedAt: Date.now(), tabCount: 1, trigger: "manual",
      tabs: [{ url: "https://example.org/published", title: "Saved", windowId: 1, pinned: false, kept: false }] };
    loseIndexReply = true;
    expect(await pushSnapshotToSync(snap)).toBe(false);
    expect((await syncPendingLocalSnapshots(async () => [])).ok).toBe(true);
    const [saved] = await listSyncedSnapshots();
    expect((await readSyncedSnapshot(saved!.relPath!))?.tabs).toEqual(snap.tabs);
  });

  test("publishes a large legacy snapshot index in generations and preserves the last complete one on failure", async () => {
    const deviceId = "dev-mac";
    const base = `devices/${deviceId}`;
    const indexPath = `${base}/index.json`;
    const entries: { id: string; capturedAt: number; tabCount: number; windowCount: number; trigger: string; label: string; relPath: string }[] = [];
    const index = { schemaVersion: 1, deviceId, deviceName: "Mac", updatedAt: 10, snapshots: entries };
    let bytes = utf8ByteLength(JSON.stringify(index));
    for (let i = 0; ; i++) {
      const entry = { id: `manual-${i}`, capturedAt: i, tabCount: 1, windowCount: 1, trigger: "manual",
        label: `Session ${i}`, relPath: `${base}/snapshots/manual-${i}.json` };
      bytes += utf8ByteLength(JSON.stringify(entry)) + 1;
      if (bytes > 800 * 1024) break;
      entries.push(entry);
    }
    expect(entries.length).toBeGreaterThan(3250);
    virtualFs.set(indexPath, JSON.stringify(index));
    const initialCount = entries.length;
    const snap: SessionSnapshot = { id: "new-save", capturedAt: Date.now(), trigger: "manual", label: "設".repeat(80),
      tabCount: 1, tabs: [{ url: "https://example.com", title: "New", windowId: 1, pinned: false, kept: false }] };
    expect(await pushSnapshotToSync(snap)).toBe(true);
    const published = new Map(virtualFs);
    const newFiles = [...published.keys()].filter(key => key.includes("/index-parts/"));
    expect(newFiles.length).toBeGreaterThan(0);
    const auto = { ...snap, trigger: "auto" as const, id: "new-auto", capturedAt: snap.capturedAt + 1 };
    failNextIndexWrite = true;
    expect(await pushSnapshotToSync(auto)).toBe(false);
    expect(virtualFs.get(indexPath) === published.get(indexPath)).toBe(true);
    for (const path of newFiles) expect(virtualFs.get(path) === published.get(path)).toBe(true);
    expect(await listSyncedSnapshots()).toHaveLength(initialCount + 1);

    // Cloud clients may deliver the manifest before an overflow part.
    const partPath = newFiles[0]!;
    const contents = virtualFs.get(partPath)!;
    virtualFs.delete(partPath);
    expect(await pushSnapshotToSync(auto)).toBe(false);
    expect(virtualFs.get(indexPath) === published.get(indexPath)).toBe(true);
    virtualFs.set(partPath, contents);
    expect(await pushSnapshotToSync(auto)).toBe(true);
    const all = await listSyncedSnapshots();
    expect(all).toHaveLength(initialCount + 2);
    expect((await readSyncedSnapshot(all.find(s => s.id === auto.id)!.relPath!))?.tabs).toEqual(snap.tabs);
    expect(await deleteSyncedSnapshot(entries[0]!.id)).toBe(true);
    expect((await listSyncedSnapshots()).some(s => s.id === entries[0]!.id)).toBe(false);
    for (const path of newFiles) expect(virtualFs.has(path)).toBe(false);
  });

  test("disabling folder sync keeps unpublished manual snapshots through automatic rotation", async () => {
    const now = 1_700_000_000_000;
    const tabs = (n: number) => [{
      id: n, windowId: 1, url: `https://offline.test/${n}`, title: String(n),
      pinned: false, active: false, discarded: false, audible: false,
    }];
    writable = false;
    const manualIds: string[] = [];
    for (let n = 0; n < 6; n++) {
      const snapshot = await captureSessionSnapshot(tabs(n), { force: true, label: `Save ${n}`, now: now + n });
      manualIds.push(snapshot!.id);
    }
    expect((await setSyncFolder(null)).ok).toBe(true);
    await captureSessionSnapshot(tabs(10), { now: now + 400_000 });
    expect((await loadSnapshots()).filter(s => s.trigger === "manual").map(s => s.id).sort()).toEqual(manualIds.sort());
    await deleteSnapshot(manualIds[0]!);
    writable = true;
    await setSyncFolder(activeSyncDir);
    expect((await syncPendingLocalSnapshots(loadSnapshots)).ok).toBe(true);
    expect((await listSyncedSnapshots()).filter(s => s.trigger === "manual").map(s => s.id).sort()).toEqual(manualIds.slice(1));
  });

  test("retains concurrent and >5 offline manual snapshots, syncs into switched folder, and queues offline deletions", async () => {
    const now = 1_700_000_000_000;
    hostOnline = false;

    const makeTab = (n: number) => ({
      id: n,
      url: `https://offline-${n}.com`,
      title: `Off ${n}`,
      active: false,
      audible: false,
      pinned: false,
      discarded: false,
      windowId: 1,
    });

    // Two concurrent offline manual captures must both survive locally
    const [a, b] = await Promise.all([
      captureSessionSnapshot([makeTab(1)], { force: true, trigger: "manual", label: "M1", now }),
      captureSessionSnapshot([makeTab(2)], { force: true, trigger: "manual", label: "M2", now: now + 1 }),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // 4 more sequential offline manual captures -> total 6 (> MAX_SNAPSHOTS=5) must all survive
    for (let i = 3; i <= 6; i++) {
      await captureSessionSnapshot([makeTab(i)], { force: true, trigger: "manual", label: `M${i}`, now: now + i });
    }
    const localSnaps = await loadSnapshots();
    expect(localSnaps).toHaveLength(6);

    // Reconnect -> all 6 upload into empty folder
    hostOnline = true;
    const sync1 = await syncPendingLocalSnapshots(loadSnapshots, now + 100);
    expect(sync1.ok).toBe(true);
    expect(sync1.uploaded).toBe(6);

    // Switch to a brand new empty folder B -> existing local snapshots still upload!
    const folderAFiles = new Map(virtualFs);
    activeSyncDir = "/Dropbox/TabReaper";
    storageData["tabReaper.activeSyncDir"] = activeSyncDir;
    virtualFs.clear();
    const sync2 = await syncPendingLocalSnapshots(loadSnapshots, now + 200);
    expect(sync2.ok).toBe(true);
    expect(sync2.uploaded).toBe(6);

    // Delete snapshot `a` offline while active dir is folder A; syncing folder B must NOT clear folder A's pending delete
    activeSyncDir = "/iCloud/TabReaper";
    storageData["tabReaper.activeSyncDir"] = activeSyncDir;
    hostOnline = false;
    await deleteSnapshot(a!.id);
    hostOnline = true;
    activeSyncDir = "/Dropbox/TabReaper";
    storageData["tabReaper.activeSyncDir"] = activeSyncDir;
    await syncPendingLocalSnapshots(loadSnapshots, now + 250);

    // Return to folder A -> pending delete for folder A drains cleanly
    activeSyncDir = "/iCloud/TabReaper";
    storageData["tabReaper.activeSyncDir"] = activeSyncDir;
    virtualFs = folderAFiles;
    const sync3 = await syncPendingLocalSnapshots(loadSnapshots, now + 300);
    expect(sync3.deleted).toBe(1);
    const listedAfterDelete = await listSyncedSnapshots();
    expect(listedAfterDelete.some((s) => s.id === a!.id)).toBe(false);
  });

  test("shards CJK archives in UTF-8 bytes and multipart snapshots (>500 KB) cleanly", async () => {
    const now = 1_700_000_000_000;
    const cjkItems: ArchivedTab[] = [];
    for (let i = 0; i < 1500; i++) {
      cjkItems.push({
        id: `cjk-${i}`,
        url: `https://example.jp/article/${i}?ref=sync`,
        normalizedUrl: `https://example.jp/article/${i}?ref=sync`,
        title: `日本語の長いタイトル設計ドキュメントと同期テスト記事番号_${i}_詳細解説ページ`,
        lastActiveAt: now - i,
        archivedAt: now - i,
      });
    }
    await saveArchive(cjkItems);
    expect(await pushArchiveToSync(loadArchive, now)).toBe(true);
    for (const [key, val] of virtualFs.entries()) {
      if (key.includes("/archive")) {
        expect(utf8ByteLength(val)).toBeLessThan(800 * 1024);
      }
    }

    // Large 350-tab snapshot (>500 KB) shards into multipart files and reassembles cleanly
    const bigTabs = Array.from({ length: 350 }, (_, i) => ({
      url: `https://docs.example.com/workspace/project/section/${i}/${"x".repeat(1600)}`,
      title: `Large Tab ${i}`,
      pinned: false,
      kept: false,
      windowId: 1,
      index: i,
    }));
    const bigSnap: SessionSnapshot = {
      id: "big-snap-1",
      capturedAt: now + 5000,
      tabCount: bigTabs.length,
      windowCount: 1,
      trigger: "manual",
      tabs: bigTabs,
    };
    expect(await pushSnapshotToSync(bigSnap, now + 5000)).toBe(true);
    const listed = await listSyncedSnapshots();
    const entry = listed.find((s) => s.id === "big-snap-1");
    expect(entry).toBeDefined();
    const restored = await readSyncedSnapshot(entry!.relPath!);
    expect(restored?.tabs).toHaveLength(350);
  });

  test("a failed multipart publication leaves the preceding archive readable", async () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({
      id: String(i), url: `https://example.org/${i}`, normalizedUrl: `https://example.org/${i}`,
      archivedAt: 1, lastActiveAt: 1, title: "a".repeat(250),
    }));
    expect(await pushArchiveToSync(async () => items, 100)).toBe(true);
    const previous = new Map(virtualFs);
    failArchiveManifest = true;
    expect(await pushArchiveToSync(async () => items.map(item => ({ ...item, title: "b".repeat(250) })), 200)).toBe(false);
    for (const [name, contents] of previous) expect(virtualFs.get(name) === contents).toBe(true);
  });

  test("shards large archives (>500 KB) across multiple part files and avoids duplicate Chrome Sync bookmarks", async () => {
    const now = 1_700_000_000_000;
    const bigItems: ArchivedTab[] = [];
    for (let i = 0; i < 3000; i++) {
      bigItems.push({
        id: `big-${i}`,
        url: `https://example.com/very/long/path/document-${i}?section=architecture&tab=details`,
        normalizedUrl: `https://example.com/very/long/path/document-${i}?section=architecture&tab=details`,
        title: `Document number ${i} with descriptive title for size testing`,
        lastActiveAt: now - i,
        archivedAt: now - i,
      });
    }
    await saveArchive(bigItems);
    const pushed = await pushArchiveToSync(loadArchive, now);
    expect(pushed).toBe(true);
    expect(virtualFs.has("devices/dev-mac/archive.json")).toBe(true);
    const { generation } = JSON.parse(virtualFs.get("devices/dev-mac/archive.json")!);
    expect(virtualFs.has(`devices/dev-mac/archive-${generation}-p1.json`)).toBe(true);

    // Verify existing Chrome Sync bookmark is reused instead of duplicated
    const created: string[] = [];
    const chromeMock = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    chromeMock.bookmarks = {
      getTree: async () => [{ id: "0", children: [{ id: "1" }, { id: "2" }] }],
      getChildren: async (parentId: string) =>
        parentId === "2"
          ? [{ id: "folder-1", title: "Auto-Archived Tabs" }]
          : [{ id: "bm-existing", title: "Already synced", url: "https://already.com/page" }],
      create: async (opts: { url: string }) => {
        created.push(opts.url);
        return { id: "bm-new", url: opts.url };
      },
      remove: async () => {},
    };

    const reconciled = await saveMergedArchiveWithBookmarks(
      [
        {
          id: "x1",
          url: "https://already.com/page",
          normalizedUrl: "https://already.com/page",
          title: "Already synced",
          lastActiveAt: now,
          archivedAt: now,
        },
      ],
      [],
      "Auto-Archived Tabs",
    );
    expect(created).toEqual([]);
    expect(reconciled[0]!.bookmarkId).toBe("bm-existing");
  });

  test("local-only profiles do not persist archive deletion tombstones", async () => {
    const now = 1_700_000_000_000;
    storageData["tabReaper.folderSyncOptedIn"] = false;
    await saveArchive([
      {
        id: "loc-1",
        url: "https://private-local.com/page",
        normalizedUrl: "https://private-local.com/page",
        title: "Private",
        lastActiveAt: now,
        archivedAt: now,
      },
    ]);
    await deleteArchivedTab("loc-1");
    expect(await loadArchiveTombstones()).toEqual({});
  });
});
