import { beforeEach, describe, expect, test } from "bun:test";
import {
  GFS_RECENT_LIMIT,
  deleteSyncedSnapshot,
  getSyncStatus,
  listSyncedDevices,
  listSyncedSnapshots,
  pruneSnapshotsGfs,
  pullConfigFromSync,
  pushSnapshotToSync,
  readSyncedSnapshot,
  removeSyncedDevice,
  resolveLatestConfig,
  setDeviceName,
  setLocalConfigVersion,
  syncPendingLocalSnapshots,
  utf8ByteLength,
  type SyncedConfigEnvelope,
} from "../src/background/sync.ts";
import {
  adoptDeviceHistory,
  setSyncFolder,
  captureSessionSnapshot,
  deleteSnapshot,
  getSnapshotDetails,
  listAllSnapshots,
  findRecoverableSnapshot,
  loadSnapshots,
} from "../src/background/session.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/shared/config.ts";
import type { SessionSnapshot, TabCurbConfig } from "../src/shared/types.ts";

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

    const { keep, drop } = pruneSnapshotsGfs(items.map(s => ({ ...s, complete: true })), now);
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
      schemaVersion: 2,
      updatedAt: 1000,
      deviceId: "dev-a",
      config: { ...DEFAULT_CONFIG, memoryBudgetGb: 8 },
    };
    const b: SyncedConfigEnvelope = {
      schemaVersion: 2,
      updatedAt: 2000,
      deviceId: "dev-b",
      config: { ...DEFAULT_CONFIG, memoryBudgetGb: 15 },
    };
    const c: SyncedConfigEnvelope = {
      schemaVersion: 2,
      updatedAt: 2000,
      deviceId: "dev-c",
      config: { ...DEFAULT_CONFIG, memoryBudgetGb: 20 },
    };

    expect(resolveLatestConfig([a, b])?.deviceId).toBe("dev-b");
    expect(resolveLatestConfig([b, c])?.deviceId).toBe("dev-c");
    expect(resolveLatestConfig([c, b])?.deviceId).toBe("dev-c");
  });
});

describe("multi-device single-writer folder sync integration", () => {
  let storageData: Record<string, unknown>;
  let virtualFs: Map<string, string>;
  let writable: boolean;
  let hostOnline: boolean;
  let hostOutdated: boolean;
  let hostSupportsDeviceManagement: boolean;
  let failNextIndexWrite: boolean;
  let failNextIndexRead: boolean;
  let loseIndexReply: boolean;
  let approvedFolders: Map<string, string>;

  let activeSyncDir: string;
  let hostHostname: string;
  let readPaths: string[];

  beforeEach(() => {
    activeSyncDir = "/iCloud/TabCurb";
    hostHostname = "MacBook";
    storageData = {
      "tabCurb.deviceIdentity": { deviceId: "dev-mac", deviceName: "MacBook Pro", deviceNameSource: "custom" },
      "tabCurb.folderSyncOptedIn": true,
      "tabCurb.activeSyncDir": activeSyncDir,
    };
    virtualFs = new Map<string, string>();
    readPaths = [];
    writable = true;
    hostOnline = true;
    hostOutdated = false;
    hostSupportsDeviceManagement = true;
    failNextIndexWrite = false;
    failNextIndexRead = false;
    loseIndexReply = false;
    approvedFolders = new Map<string, string>([["dev-mac", activeSyncDir]]);

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
          const capabilities = hostOutdated
            ? []
            : hostSupportsDeviceManagement
              ? ["expected_dir", "manage_devices"]
              : ["expected_dir"];
          if (cmd === "sync_set_folder") {
            const dev = payload.deviceId as string;
            if (payload.path) approvedFolders.set(dev, payload.path as string);
            else approvedFolders.delete(dev);
            return { ok: true, enabled: Boolean(payload.path), syncDir: payload.path, writable, capabilities, hostname: hostHostname };
          }
          if (cmd === "sync_get_status") {
            return { ok: true, enabled: true, capabilities, syncDir: activeSyncDir, writable, hostname: hostHostname };
          }
          if (["sync_write", "sync_read", "sync_list", "sync_delete", "sync_delete_device"].includes(cmd) && payload.expectedDir !== activeSyncDir) {
            return { ok: false, error: "sync folder changed" };
          }
          if (cmd === "sync_write") {
            const dev = payload.deviceId as string;
            const targetDev = (payload.targetDeviceId as string | undefined) ?? dev;
            const relPath = payload.relPath as string;
            if (targetDev === dev) {
              if (!relPath.startsWith(`devices/${dev}/`)) return { ok: false, error: "not owned" };
            } else {
              if (!hostSupportsDeviceManagement) return { ok: false, error: "unsupported" };
              const allowed =
                relPath === `devices/${targetDev}/index.json` ||
                relPath.startsWith(`devices/${targetDev}/snapshots/`) ||
                relPath.startsWith(`devices/${targetDev}/index-parts/`);
              if (!allowed) return { ok: false, error: "not allowed cross-device" };
            }
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
            readPaths.push(relPath);
            if (failNextIndexRead && relPath.endsWith("/index.json")) {
              failNextIndexRead = false;
              return { ok: false, error: "transient i/o error" };
            }
            const content = virtualFs.get(relPath);
            return content !== undefined ? { ok: true, exists: true, content } : { ok: true, exists: false };
          }
          if (cmd === "sync_delete") {
            const dev = payload.deviceId as string;
            const targetDev = (payload.targetDeviceId as string | undefined) ?? dev;
            const relPath = payload.relPath as string;
            if (targetDev === dev) {
              if (!relPath.startsWith(`devices/${dev}/`)) return { ok: false, error: "not owned" };
            } else {
              if (!hostSupportsDeviceManagement) return { ok: false, error: "unsupported" };
              const allowed =
                relPath === `devices/${targetDev}/index.json` ||
                relPath.startsWith(`devices/${targetDev}/snapshots/`) ||
                relPath.startsWith(`devices/${targetDev}/index-parts/`);
              if (!allowed) return { ok: false, error: "not allowed cross-device" };
            }
            return { ok: true, deleted: virtualFs.delete(relPath) };
          }
          if (cmd === "sync_delete_device") {
            if (!hostSupportsDeviceManagement) return { ok: false, error: "unsupported" };
            const dev = payload.deviceId as string;
            const targetDev = payload.targetDeviceId as string;
            if (!targetDev || targetDev === dev) return { ok: false, error: "cannot remove self" };
            const prefix = `devices/${targetDev}/`;
            let deleted = false;
            for (const key of Array.from(virtualFs.keys())) {
              if (key.startsWith(prefix)) {
                virtualFs.delete(key);
                deleted = true;
              }
            }
            return { ok: true, deleted };
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

  test("periodic sync confirms published snapshots from the folder listing without reading them", async () => {
    const tabs = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Draft", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const snap = await captureSessionSnapshot(tabs, { force: true });
    const entry = (await listSyncedSnapshots())[0]!;
    expect(virtualFs.has(entry.relPath!.replace(".json", "_p1.json"))).toBe(true);

    readPaths = [];
    const again = await syncPendingLocalSnapshots(async () => [snap!]);
    expect(again).toMatchObject({ ok: true, uploaded: 0 });
    expect(readPaths.filter((path) => path.includes("/snapshots/"))).toEqual([]);
  });

  test("a queued window backup cannot suppress the next complete capture after disk rotation", async () => {
    const session: Record<string, unknown> = {};
    Object.assign(chrome.storage, { session: {
      get: async (key: string) => ({ [key]: session[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(session, values),
      remove: async (key: string) => { delete session[key]; },
    } });
    const now = Date.UTC(2026, 10, 21, 18);
    const tabs = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Page", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const whole = await captureSessionSnapshot(tabs, { now, intervalMinutes: 1440 });
    expect(whole?.tabCount).toBe(tabs.length);
    expect(await loadSnapshots()).toHaveLength(0);
    const queued = Array.from({ length: GFS_RECENT_LIMIT }, (_, i): SessionSnapshot => ({
      id: `closed-${i}`, capturedAt: now + i + 3, trigger: "window_closed", complete: false,
      tabCount: 2, tabs: whole!.tabs.slice(0, 2),
    }));
    expect((await syncPendingLocalSnapshots(async () => queued, now + 60_000)).ok).toBe(true);
    expect((await findRecoverableSnapshot([], [], now + 120_000))?.id).toBe(whole!.id);
    await captureSessionSnapshot(tabs, { now: now + 600_000, intervalMinutes: 1440 });
    const complete = (await listSyncedSnapshots()).find(s => s.tabCount === tabs.length);
    expect(complete).toBeDefined();
    expect((await readSyncedSnapshot(complete!.relPath!))?.tabs).toHaveLength(tabs.length);
  });

  test("uploading a truncated offline capture preserves the last complete session during rotation", async () => {
    const now = Date.UTC(2026, 10, 21, 18);
    const tabs = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Page", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const whole = await captureSessionSnapshot(tabs, { now });
    expect(whole?.tabCount).toBe(tabs.length);
    // While disconnected, a second whole session exceeds the 1 MB local cache.
    hostOnline = false;
    const changed = tabs.map(t => ({ ...t, url: t.url.replace("docs.test", "draft.test") }));
    const partial = await captureSessionSnapshot(changed, { now: now + 1, force: true, trigger: "auto" });
    expect(partial?.complete).toBe(false);
    expect(partial!.tabCount).toBeGreaterThan(0);
    expect(partial!.tabCount).toBeLessThan(changed.length);
    hostOnline = true;
    expect((await syncPendingLocalSnapshots(loadSnapshots, now + 2)).uploaded).toBe(1);
    const index = JSON.parse(virtualFs.get("devices/dev-mac/index.json")!) as { snapshots: Array<{
      id: string; relPath: string; complete?: boolean;
    }> };
    const indexedPartial = index.snapshots.find(entry => entry.id === partial!.id)!;
    expect(indexedPartial.complete).toBe(false);
    expect((await readSyncedSnapshot(indexedPartial.relPath))?.complete).toBe(false);
    expect(index.snapshots.find(entry => entry.id === whole!.id)?.complete).toBe(true);
    const queued = Array.from({ length: GFS_RECENT_LIMIT }, (_, i): SessionSnapshot => ({
      id: `closed-${i}`, capturedAt: now + i + 3, trigger: "window_closed", complete: false,
      tabCount: 2, tabs: whole!.tabs.slice(0, 2),
    }));
    expect((await syncPendingLocalSnapshots(async () => queued, now + 60_000)).ok).toBe(true);
    const retained = (await listSyncedSnapshots()).find(s => s.id === whole!.id);
    expect(retained).toBeDefined();
    expect((await readSyncedSnapshot(retained!.relPath!))?.tabs).toEqual(whole!.tabs);
  });

  test("rechecks an unchanged disk-only snapshot by index without downloading its body", async () => {
    const cache: Record<string, unknown> = {};
    Object.assign(chrome.storage, { session: {
      get: async (key: string) => ({ [key]: cache[key] }),
      set: async (changes: Record<string, unknown>) => Object.assign(cache, changes),
    } });
    const tabs = Array.from({ length: 400 }, (_, id) => ({
      id, url: `https://docs.test/${id}/${"x".repeat(2900)}`, title: "Draft", windowId: 1,
      pinned: false, discarded: false, active: false, audible: false,
    }));
    const now = Date.now();
    const saved = await captureSessionSnapshot(tabs, { now });
    expect(saved?.tabCount).toBe(400);
    expect(await loadSnapshots()).toHaveLength(0);
    let bodyReads = 0;
    const read = chrome.runtime.sendNativeMessage;
    Object.assign(chrome.runtime, { sendNativeMessage: (host: string, req: {cmd: string; relPath?: string}) => {
      if (req.cmd === "sync_read" && req.relPath?.includes("/snapshots/")) bodyReads++;
      return read(host, req);
    } });
    expect(await captureSessionSnapshot(tabs, { now: now + 400_000 })).toBeNull();
    expect(bodyReads).toBe(0);
    expect(JSON.stringify(cache).length).toBeLessThan(1024);
    const send = chrome.runtime.sendNativeMessage;
    Object.assign(chrome.runtime, { sendNativeMessage: (host: string, req: {cmd: string; relPrefix?: string}) =>
      req.cmd === "sync_list" && req.relPrefix?.endsWith("/snapshots") ? { ok: false } : send(host, req) });
    expect((await findRecoverableSnapshot([], [], now + 600_000))?.id).toBe(saved!.id);
    Object.assign(chrome.runtime, { sendNativeMessage: send });
    const entry = (await listSyncedSnapshots())[0]!;
    expect(virtualFs.delete(entry.relPath!.replace(".json", "_p1.json"))).toBe(true);
    expect(await findRecoverableSnapshot([], [], now + 700_000)).toBeNull();
    const replacement = await captureSessionSnapshot(tabs, { now: now + 800_000 });
    expect(replacement?.tabCount).toBe(tabs.length);
    const recoverable = await findRecoverableSnapshot([], [], now + 800_001);
    expect(recoverable?.id).toBe(replacement!.id);
    expect((await readSyncedSnapshot(recoverable!.relPath!))?.tabs).toEqual(replacement!.tabs);

  });

  test("a session-cache write failure still acknowledges a durable manual backup", async () => {
    Object.assign(chrome.storage, { session: { set: async () => { throw Error("QuotaExceededError"); } } });
    const saved = await captureSessionSnapshot([{ id: 1, url: "https://docs.test/", title: "Page",
      windowId: 1, active: true, audible: false, discarded: false, pinned: false }], { force: true });
    expect(saved?.id).toBeDefined();
    expect((await listSyncedSnapshots()).map(row => row.id)).toEqual([saved!.id]);
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
    const snap: SessionSnapshot = { complete: true, id: "saved", capturedAt: Date.now(), tabCount: 1, tabs: [
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

  test("serializes concurrent snapshot captures, protects against transient index errors, and keeps remote snapshots read-only", async () => {
    const now = 1_700_000_000_000;
    const snap1: SessionSnapshot = {
      complete: true,
      id: "snap-1",
      capturedAt: now + 1000,
      tabCount: 2,
      windowCount: 1,
      trigger: "auto",
      tabs: [{ url: "https://a.com", title: "A", pinned: false, kept: false, windowId: 1 }],
    };
    const snap2: SessionSnapshot = {
      complete: true,
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
            complete: true,
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
    await pullConfigFromSync(async () => ({ ...DEFAULT_CONFIG, memoryBudgetGb: 10 }), async () => {});
    virtualFs.set(
      "devices/dev-z/config-v2.json",
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: now,
        deviceId: "dev-z",
        config: {
          ...DEFAULT_CONFIG,
          memoryBudgetMode: "fixed_gb",
          memoryBudgetGb: 77,
          discardAfterMinutes: 15,
          snapshotIntervalMinutes: 1440,
        },
      }),
    );

    let applied: TabCurbConfig | null = null;
    const pullRes = await pullConfigFromSync(
      async () => ({ ...DEFAULT_CONFIG, memoryBudgetGb: 10 }),
      async (cfg) => {
        applied = cfg;
      },
    );
    expect(pullRes.updated).toBe(true);
    expect(applied).not.toHaveProperty("discardAfterMinutes");
    // A GB budget sized for another machine's RAM must not apply here.
    expect(applied!.memoryBudgetMode).toBe("fraction");
    expect(applied!.memoryBudgetGb).toBe(10);
    expect(applied!.snapshotIntervalMinutes).toBe(1440);

    // The next sync publishes settings edited offline.
    hostOnline = false;
    await setLocalConfigVersion({ updatedAt: now + 10_000, deviceId: "dev-mac" });
    expect((await pullConfigFromSync(async () => ({ ...DEFAULT_CONFIG, memoryBudgetGb: 42 }), async () => {})).ok).toBe(false);
    hostOnline = true;
    await pullConfigFromSync(async () => ({ ...DEFAULT_CONFIG, memoryBudgetGb: 42 }), async () => {});
    const storedRemote = JSON.parse(virtualFs.get("devices/dev-mac/config-v2.json")!) as SyncedConfigEnvelope;
    expect(storedRemote.schemaVersion).toBe(2);
    expect(storedRemote.config.memoryBudgetGb).toBe(42);

    // A host must enforce the selected directory for each file operation.
    hostOutdated = true;
    const status = await getSyncStatus();
    expect(status.hostConnected).toBe(true);
    expect(status.hostOutdated).toBe(true);
    expect((await pullConfigFromSync(loadConfig, async () => {})).ok).toBe(false);
  });

  test("keeps protectActiveUploads and weightedEviction device-local when pulling a newer v0.9.4 config that omits them", async () => {
    const now = 1_700_000_000_000;
    const legacyConfig = { ...DEFAULT_CONFIG, snapshotIntervalMinutes: 30 } as Record<string, unknown>;
    delete legacyConfig.protectActiveUploads;
    delete legacyConfig.weightedEviction;
    virtualFs.set(
      "devices/dev-legacy/config-v2.json",
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: now + 5000,
        deviceId: "dev-legacy",
        config: legacyConfig,
      }),
    );

    await setLocalConfigVersion({ updatedAt: now, deviceId: "dev-mac" });
    let applied: TabCurbConfig | null = null;
    const res = await pullConfigFromSync(
      async () => ({ ...DEFAULT_CONFIG, protectActiveUploads: true, weightedEviction: false }),
      async (cfg) => { applied = cfg; },
    );
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(true);
    expect(applied!.snapshotIntervalMinutes).toBe(30);
    expect(applied!.protectActiveUploads).toBe(true);
    expect(applied!.weightedEviction).toBe(false);
  });

  test("a failed config read leaves the device file intact for a retry", async () => {
    const path = "devices/dev-mac/config-v2.json";
    const config = { ...DEFAULT_CONFIG, snapshotIntervalMinutes: 1440, idleEvictionPercent: 63 };
    const previous = JSON.stringify({ schemaVersion: 2, updatedAt: 100, deviceId: "dev-mac", config });
    virtualFs.set(path, previous);
    const send = chrome.runtime.sendNativeMessage;
    let fail = true;
    Object.assign(chrome.runtime, { sendNativeMessage: (host: string, req: { cmd: string; relPath?: string }) =>
      fail && req.cmd === "sync_read" && req.relPath === path ? { ok: false } : send(host, req) });
    const apply = async (cfg: TabCurbConfig) => { await saveConfig(cfg); };
    expect((await pullConfigFromSync(loadConfig, apply)).ok).toBe(false);
    expect(virtualFs.get(path)).toBe(previous);
    fail = false;
    expect((await pullConfigFromSync(loadConfig, apply)).ok).toBe(true);
    expect(await loadConfig()).toEqual(config);
  });

  test("saves one complete settings record and syncs it with one version", async () => {
    storageData["tabCurb.config"] = { unusedSetting: true };
    const config = await saveConfig({ memoryBudgetGb: 51 });
    expect(storageData["tabCurb.config"]).toEqual(config);
    await setLocalConfigVersion({ updatedAt: 200, deviceId: "dev-mac" });
    expect((await pullConfigFromSync(loadConfig, async () => {})).ok).toBe(true);
    const file = JSON.parse(virtualFs.get("devices/dev-mac/config-v2.json")!);
    expect(file).toEqual({ schemaVersion: 2, updatedAt: 200, deviceId: "dev-mac", config });
  });

  test("deleting from a stale list never removes the same named save in the new folder", async () => {
    const folderA = activeSyncDir;
    const snapshot = await captureSessionSnapshot([{ id: 1, windowId: 1, title: "A",
      url: "https://example.org/a", active: true, audible: false, discarded: false, pinned: false }], { force: true, label: "Keep in B" });
    const [row] = await listAllSnapshots();
    const filesA = virtualFs;
    activeSyncDir = "/Dropbox/TabCurb";
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
      return pushSnapshotToSync({ id: `auto-${n}`, capturedAt: now + n, tabCount: 1, trigger: "auto", complete: true,
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
    const snap: SessionSnapshot = { complete: true, id: "lost-reply", capturedAt: Date.now(), tabCount: 1, trigger: "manual",
      tabs: [{ url: "https://example.org/published", title: "Saved", windowId: 1, pinned: false, kept: false }] };
    loseIndexReply = true;
    expect(await pushSnapshotToSync(snap)).toBe(false);
    expect((await syncPendingLocalSnapshots(async () => [])).ok).toBe(true);
    const [saved] = await listSyncedSnapshots();
    expect((await readSyncedSnapshot(saved!.relPath!))?.tabs).toEqual(snap.tabs);
  });

  test("publishes a large snapshot index in generations and preserves the last complete one on failure", async () => {
    const deviceId = "dev-mac";
    const base = `devices/${deviceId}`;
    const indexPath = `${base}/index.json`;
    const entries: { id: string; capturedAt: number; tabCount: number; windowCount: number; trigger: string; label: string; relPath: string }[] = [];
    const index = { schemaVersion: 1, deviceId, deviceName: "Mac", updatedAt: 10, snapshots: entries };
    let bytes = utf8ByteLength(JSON.stringify(index));
    for (let i = 0; ; i++) {
      const entry = { id: `manual-${i}`, complete: true, capturedAt: i, tabCount: 1, windowCount: 1, trigger: "manual",
        label: `Session ${i}`, relPath: `${base}/snapshots/manual-${i}.json` };
      bytes += utf8ByteLength(JSON.stringify(entry)) + 1;
      if (bytes > 800 * 1024) break;
      entries.push(entry);
    }
    expect(entries.length).toBeGreaterThan(3250);
    virtualFs.set(indexPath, JSON.stringify(index));
    const initialCount = entries.length;
    const snap: SessionSnapshot = { complete: true, id: "new-save", capturedAt: Date.now(), trigger: "manual", label: "設".repeat(80),
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
    activeSyncDir = "/Dropbox/TabCurb";
    storageData["tabCurb.activeSyncDir"] = activeSyncDir;
    virtualFs.clear();
    const sync2 = await syncPendingLocalSnapshots(loadSnapshots, now + 200);
    expect(sync2.ok).toBe(true);
    expect(sync2.uploaded).toBe(6);

    // Delete snapshot `a` offline while active dir is folder A; syncing folder B must NOT clear folder A's pending delete
    activeSyncDir = "/iCloud/TabCurb";
    storageData["tabCurb.activeSyncDir"] = activeSyncDir;
    hostOnline = false;
    await deleteSnapshot(a!.id);
    hostOnline = true;
    activeSyncDir = "/Dropbox/TabCurb";
    storageData["tabCurb.activeSyncDir"] = activeSyncDir;
    await syncPendingLocalSnapshots(loadSnapshots, now + 250);

    // Return to folder A -> pending delete for folder A drains cleanly
    activeSyncDir = "/iCloud/TabCurb";
    storageData["tabCurb.activeSyncDir"] = activeSyncDir;
    virtualFs = folderAFiles;
    const sync3 = await syncPendingLocalSnapshots(loadSnapshots, now + 300);
    expect(sync3.deleted).toBe(1);
    const listedAfterDelete = await listSyncedSnapshots();
    expect(listedAfterDelete.some((s) => s.id === a!.id)).toBe(false);
  });

  test("shards multipart snapshots (>500 KB) cleanly", async () => {
    const now = 1_700_000_000_000;
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
      complete: true,
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

  test("deviceName defaults to and follows host hostname until a custom name is set", async () => {
    // Custom names survive hostname changes.
    expect((await getSyncStatus()).deviceName).toBe("MacBook Pro");

    // Profile with no stored identity adopts the host hostname.
    delete storageData["tabCurb.deviceIdentity"];
    hostHostname = "Work-MacBook";
    expect((await getSyncStatus()).deviceName).toBe("Work-MacBook");

    // Subsequent hostname changes keep following the host.
    hostHostname = "Studio-Mac";
    expect((await getSyncStatus()).deviceName).toBe("Studio-Mac");

    // Setting an explicit custom name stops following hostname changes.
    await setDeviceName("Custom Laptop");
    hostHostname = "Renamed-Host";
    expect((await getSyncStatus()).deviceName).toBe("Custom Laptop");
  });

  test("lists synced devices, flags same computer installs, and inspects snapshot tabs", async () => {
    const now = 1_700_000_000_000;
    hostHostname = "mnag-note";
    storageData["tabCurb.deviceIdentity"] = {
      deviceId: "dev-new",
      deviceName: "mnag-note",
      hostname: "mnag-note",
      deviceNameSource: "hostname",
    };

    // Current device snapshot
    const ownSnap: SessionSnapshot = {
      id: "own-1",
      complete: true,
      capturedAt: now + 2000,
      tabCount: 1,
      windowCount: 1,
      trigger: "manual",
      tabs: [{ url: "https://own.test/a", title: "Own Tab", pinned: false, kept: false, windowId: 1, index: 0 }],
    };
    expect(await pushSnapshotToSync(ownSnap, now + 2000)).toBe(true);

    // Earlier install on the SAME computer (legacy meta.json without hostname, same deviceName)
    virtualFs.set("devices/dev-old-same/meta.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-old-same",
      deviceName: "mnag-note",
      lastSeenAt: now + 1000,
    }));
    virtualFs.set("devices/dev-old-same/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-old-same",
      deviceName: "mnag-note",
      updatedAt: now + 1000,
      snapshots: [{
        id: "old-1",
        complete: true,
        capturedAt: now + 1000,
        tabCount: 2,
        windowCount: 1,
        trigger: "auto",
        relPath: "devices/dev-old-same/snapshots/s1.json",
      }],
    }));
    virtualFs.set("devices/dev-old-same/snapshots/s1.json", JSON.stringify({
      id: "old-1",
      complete: true,
      capturedAt: now + 1000,
      tabCount: 2,
      windowCount: 1,
      trigger: "auto",
      tabs: [
        { url: "https://old.test/1", title: "Old 1", pinned: true, kept: false, windowId: 1, index: 0 },
        { url: "https://old.test/2", title: "Old 2", pinned: false, kept: true, windowId: 1, index: 1 },
      ],
    }));

    // Different computer with same custom deviceName but DIFFERENT hostname must NOT be flagged as same computer
    virtualFs.set("devices/dev-other-host/meta.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-other-host",
      deviceName: "mnag-note",
      hostname: "work-linux",
      lastSeenAt: now + 500,
    }));
    virtualFs.set("devices/dev-other-host/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-other-host",
      deviceName: "mnag-note",
      updatedAt: now + 500,
      snapshots: [],
    }));

    const devices = await listSyncedDevices();
    expect(devices.map((d) => d.deviceId)).toEqual(["dev-new", "dev-old-same", "dev-other-host"]);
    expect(devices[0]!.isCurrent).toBe(true);
    expect(devices[0]!.isSameComputer).toBe(true);
    expect(devices[0]!.snapshotCount).toBe(1);
    expect(devices[1]!.isCurrent).toBe(false);
    expect(devices[1]!.isSameComputer).toBe(true);
    expect(devices[1]!.snapshotCount).toBe(1);
    expect(devices[2]!.isCurrent).toBe(false);
    expect(devices[2]!.isSameComputer).toBe(false);

    // Inspect tabs on demand for another device's synced snapshot
    const details = await getSnapshotDetails("old-1", "devices/dev-old-same/snapshots/s1.json");
    expect(details?.tabs.map((t) => t.title)).toEqual(["Old 1", "Old 2"]);
  });

  test("deletes individual snapshots on another device and removes unused device folders", async () => {
    const now = 1_700_000_000_000;
    virtualFs.set("devices/dev-other/meta.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-other",
      deviceName: "Work Desktop",
      hostname: "work-pc",
      lastSeenAt: now,
    }));
    virtualFs.set("devices/dev-other/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-other",
      deviceName: "Work Desktop",
      updatedAt: now,
      snapshots: [
        {
          id: "other-s1",
          complete: true,
          capturedAt: now,
          tabCount: 1,
          windowCount: 1,
          trigger: "auto",
          relPath: "devices/dev-other/snapshots/s1.json",
        },
        {
          id: "other-s2",
          complete: true,
          capturedAt: now - 60_000,
          tabCount: 1,
          windowCount: 1,
          trigger: "auto",
          relPath: "devices/dev-other/snapshots/s2.json",
        },
      ],
    }));
    virtualFs.set("devices/dev-other/snapshots/s1.json", JSON.stringify({ id: "other-s1", tabs: [] }));
    virtualFs.set("devices/dev-other/snapshots/s2.json", JSON.stringify({ id: "other-s2", tabs: [] }));

    // Delete a single snapshot belonging to dev-other
    expect(await deleteSnapshot("other-s1", activeSyncDir, "dev-other")).toBe(true);
    expect(virtualFs.has("devices/dev-other/snapshots/s1.json")).toBe(false);
    expect(virtualFs.has("devices/dev-other/snapshots/s2.json")).toBe(true);
    const remaining = await listSyncedSnapshots();
    expect(remaining.map((s) => s.id)).toEqual(["other-s2"]);

    // Reject removing own device
    expect((await removeSyncedDevice("dev-mac")).ok).toBe(false);

    // Reject management when Local Companion lacks manage_devices capability
    hostSupportsDeviceManagement = false;
    expect((await removeSyncedDevice("dev-other")).ok).toBe(false);
    expect(await deleteSnapshot("other-s2", activeSyncDir, "dev-other")).toBe(false);
    hostSupportsDeviceManagement = true;

    // Remove the other device folder cleanly
    expect((await removeSyncedDevice("dev-other")).ok).toBe(true);
    expect(Array.from(virtualFs.keys()).some((k) => k.startsWith("devices/dev-other/"))).toBe(false);
  });

  test("adopting an earlier device merges new snapshots and removes the temporary device folder", async () => {
    const now = 1_700_000_000_000;
    hostHostname = "mnag-note";
    storageData["tabCurb.deviceIdentity"] = {
      deviceId: "dev-temp",
      deviceName: "mnag-note",
      hostname: "mnag-note",
      deviceNameSource: "hostname",
    };
    approvedFolders.set("dev-temp", activeSyncDir);

    // Earlier install history on the same computer
    virtualFs.set("devices/dev-original/meta.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-original",
      deviceName: "mnag-note",
      hostname: "mnag-note",
      lastSeenAt: now - 300_000,
    }));
    virtualFs.set("devices/dev-original/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-original",
      deviceName: "mnag-note",
      updatedAt: now - 300_000,
      snapshots: [{
        id: "orig-1",
        complete: true,
        capturedAt: now - 300_000,
        tabCount: 1,
        windowCount: 1,
        trigger: "auto",
        relPath: "devices/dev-original/snapshots/orig1.json",
      }],
    }));
    virtualFs.set("devices/dev-original/snapshots/orig1.json", JSON.stringify({
      id: "orig-1",
      complete: true,
      capturedAt: now - 300_000,
      tabCount: 1,
      windowCount: 1,
      trigger: "auto",
      tabs: [{ url: "https://orig.test/1", title: "Orig", pinned: false, kept: false, windowId: 1, index: 0 }],
    }));

    // Temporary new install captured 1 snapshot locally + synced
    const tempSnap: SessionSnapshot = {
      id: "temp-1",
      complete: true,
      capturedAt: now,
      tabCount: 1,
      windowCount: 1,
      trigger: "auto",
      deviceId: "dev-temp",
      deviceName: "mnag-note",
      tabs: [{ url: "https://temp.test/1", title: "Temp", pinned: false, kept: false, windowId: 1, index: 0 }],
    };
    storageData["tabCurb.sessionSnapshots"] = [tempSnap];
    expect(await pushSnapshotToSync(tempSnap, now)).toBe(true);

    const res = await adoptDeviceHistory("dev-original");
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(1);

    // Active deviceId is now dev-original, approved in host, temp device removed & unapproved
    const status = await getSyncStatus();
    expect(status.deviceId).toBe("dev-original");
    expect(approvedFolders.get("dev-original")).toBe(activeSyncDir);
    expect(approvedFolders.has("dev-temp")).toBe(false);
    expect(Array.from(virtualFs.keys()).some((k) => k.startsWith("devices/dev-temp/"))).toBe(false);

    // Both snapshots now belong to dev-original
    const listed = await listAllSnapshots();
    expect(listed.map((s) => s.id)).toEqual(["temp-1", "orig-1"]);
    expect(listed.every((s) => s.deviceId === "dev-original")).toBe(true);
    expect((await loadSnapshots())[0]?.deviceId).toBe("dev-original");
  });

  test("rejects tampered sync index entries with spoofed relPath or excessive partCount", async () => {
    const now = 1_700_000_000_000;
    virtualFs.set("devices/dev-tampered/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-tampered",
      deviceName: "Tampered",
      updatedAt: now,
      snapshots: [
        {
          id: "spoofed-path",
          complete: true,
          capturedAt: now,
          tabCount: 1,
          windowCount: 1,
          trigger: "auto",
          relPath: "devices/dev-mac/snapshots/stolen.json",
        },
        {
          id: "huge-parts",
          complete: true,
          capturedAt: now - 1000,
          tabCount: 1,
          windowCount: 1,
          trigger: "auto",
          relPath: "devices/dev-tampered/snapshots/huge.json",
          partCount: 1_000_000,
        },
        {
          id: "valid-entry",
          complete: true,
          capturedAt: now - 2000,
          tabCount: 1,
          windowCount: 1,
          trigger: "auto",
          relPath: "devices/dev-tampered/snapshots/valid.json",
        },
      ],
    }));
    virtualFs.set("devices/dev-tampered/snapshots/huge.json", JSON.stringify({
      id: "huge-parts",
      complete: true,
      capturedAt: now - 1000,
      tabCount: 1,
      partCount: 1_000_000,
      tabs: [{ url: "https://a.test/", title: "A", pinned: false, kept: false, windowId: 1 }],
    }));
    virtualFs.set("devices/dev-tampered/snapshots/valid.json", JSON.stringify({
      id: "valid-entry",
      complete: true,
      capturedAt: now - 2000,
      tabCount: 1,
      tabs: [{ url: "https://valid.test/", title: "Valid", pinned: false, kept: false, windowId: 1 }],
    }));

    // Spoofed relPath outside dev-tampered/snapshots/ must be ignored; excessive partCount entry must be ignored.
    const listed = await listSyncedSnapshots();
    expect(listed.map((s) => s.id)).toEqual(["valid-entry"]);

    // Reading a snapshot claiming excessive partCount must fail fast without looping.
    expect(await readSyncedSnapshot("devices/dev-tampered/snapshots/huge.json")).toBeNull();

    // Deleting a tampered snapshot entry with huge partCount must not OOM or hang.
    expect(await deleteSyncedSnapshot("huge-parts", activeSyncDir, "dev-tampered")).toBe(true);

    // An index claiming excessive index-parts count must fail validation immediately.
    virtualFs.set("devices/dev-bad-idx/index.json", JSON.stringify({
      schemaVersion: 1,
      deviceId: "dev-bad-idx",
      deviceName: "BadIdx",
      updatedAt: now,
      generation: "11111111-1111-4111-8111-111111111111",
      partCount: 1_000_000,
      snapshots: [],
    }));
    expect((await listSyncedSnapshots()).some((s) => s.deviceId === "dev-bad-idx")).toBe(false);
  });
});
