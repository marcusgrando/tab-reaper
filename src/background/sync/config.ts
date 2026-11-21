import { sanitizeConfig } from "../../shared/config.ts";
import type { TabReaperConfig } from "../../shared/types.ts";
import {
  enqueueConfigMutation,
  getActiveSyncDir,
  getReadySyncDir,
  loadDeviceIdentity,
  syncListFilesResult,
  syncReadJsonResult,
  syncWriteJson,
  writeDeviceMeta,
} from "./client.ts";

const CONFIG_VERSION_KEY = "tabReaper.configVersion";

interface ConfigVersion {
  updatedAt: number;
  deviceId: string;
}

export interface SyncedConfigEnvelope extends ConfigVersion {
  schemaVersion: 2;
  config: TabReaperConfig;
}

function parseConfigVersion(raw: Partial<ConfigVersion> | undefined): ConfigVersion {
  if (raw && typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && typeof raw.deviceId === "string") {
    return { updatedAt: raw.updatedAt, deviceId: raw.deviceId };
  }
  return { updatedAt: 0, deviceId: "" };
}

export async function getLocalConfigVersion(): Promise<ConfigVersion> {
  const res = await chrome.storage.local.get(CONFIG_VERSION_KEY);
  return parseConfigVersion(res[CONFIG_VERSION_KEY] as Partial<ConfigVersion> | undefined);
}

export async function setLocalConfigVersion(version: ConfigVersion): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_VERSION_KEY]: version });
}

function compareConfigVersions(a: ConfigVersion, b: ConfigVersion): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return a.deviceId.localeCompare(b.deviceId);
}

export function resolveLatestConfig(envelopes: SyncedConfigEnvelope[]): SyncedConfigEnvelope | null {
  let latest: SyncedConfigEnvelope | null = null;
  for (const envelope of envelopes) {
    if (!latest || compareConfigVersions(envelope, latest) > 0) latest = envelope;
  }
  return latest;
}

export function pullConfigFromSync(
  loadCurrentConfig: () => Promise<TabReaperConfig>,
  applyConfig: (cfg: TabReaperConfig) => Promise<void>,
): Promise<{ ok: boolean; updated: boolean }> {
  return enqueueConfigMutation(async () => {
    const syncDir = await getReadySyncDir();
    if (!syncDir) return { ok: false, updated: false };
    const identity = await loadDeviceIdentity();
    const ownPath = `devices/${identity.deviceId}/config-v2.json`;
    const list = await syncListFilesResult(syncDir, identity.deviceId, "devices");
    if (!list.ok) return { ok: false, updated: false };

    let own: SyncedConfigEnvelope | undefined;
    const remote: SyncedConfigEnvelope[] = [];
    for (const { relPath } of list.files) {
      if (!/^devices\/[^/]+\/config-v2\.json$/.test(relPath)) continue;
      const read = await syncReadJsonResult<SyncedConfigEnvelope>(syncDir, identity.deviceId, relPath);
      if (read.status === "missing") continue;
      if (read.status !== "ok" || read.value?.schemaVersion !== 2 || !read.value.config || !Number.isFinite(read.value.updatedAt) ||
          typeof read.value.deviceId !== "string") return { ok: false, updated: false };
      const env = { ...read.value, config: sanitizeConfig(read.value.config) };
      remote.push(env);
      if (relPath === ownPath) own = env;
    }

    const [config, version] = await Promise.all([loadCurrentConfig(), getLocalConfigVersion()]);
    if ((await getActiveSyncDir()) !== syncDir) return { ok: false, updated: false };
    const local: SyncedConfigEnvelope = {
      schemaVersion: 2, updatedAt: version.updatedAt, deviceId: version.deviceId || identity.deviceId, config,
    };
    const winner = resolveLatestConfig([local, ...remote])!;
    const updated = winner !== local;
    if (updated) {
      await applyConfig(winner.config);
      await setLocalConfigVersion({ updatedAt: winner.updatedAt, deviceId: winner.deviceId });
    }
    if (own && compareConfigVersions(own, winner) === 0) return { ok: true, updated };
    const ok = await syncWriteJson(syncDir, identity.deviceId, ownPath, winner);
    if (ok) await writeDeviceMeta(syncDir, identity, Date.now());
    return { ok, updated };
  });
}
