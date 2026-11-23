import {
  DEFAULT_CONFIG,
  MAX_DISCARDS_WITHOUT_RELIEF,
  REOPEN_OPTIONS_KEY,
  SETUP_PENDING_KEY,
  buildQuickUpdateCommand,
  computeMemoryBudgetBytes,
  isHttpUrl,
  sanitizeConfig,
} from "../shared/config.ts";
import type {
  MemoryBudgetMode,
  MemorySnapshot,
  RestoreMode,
  SessionSnapshot,
  SnapshotListItem,
  SnapshotTab,
  StatusPayload,
  SyncFolderCandidate,
  SyncStatus,
  SyncedDeviceInfo,
  TabReaperConfig,
} from "../shared/types.ts";

const form = document.getElementById("settings-form") as HTMLFormElement;
const memoryMode = document.getElementById("memory-mode") as HTMLSelectElement;
const fractionWrap = document.getElementById("fraction-wrap") as HTMLElement;
const fixedGbWrap = document.getElementById("fixed-gb-wrap") as HTMLElement;
const memoryFraction = document.getElementById("memory-fraction") as HTMLInputElement;
const memoryGb = document.getElementById("memory-gb") as HTMLInputElement;
const idleEvictionPercent = document.getElementById("idle-eviction-percent") as HTMLInputElement;
const memoryModeHint = document.getElementById("memory-mode-hint") as HTMLElement;
const memoryNow = document.getElementById("memory-now") as HTMLElement;
const budgetFields = document.getElementById("budget-fields") as HTMLElement;
const sizeEvictionPercent = document.getElementById("size-eviction-percent") as HTMLInputElement;
const startupSweep = document.getElementById("startup-sweep") as HTMLInputElement;
const protectActive = document.getElementById("protect-active") as HTMLInputElement;
const protectAudible = document.getElementById("protect-audible") as HTMLInputElement;
const protectPinned = document.getElementById("protect-pinned") as HTMLInputElement;
const protectForms = document.getElementById("protect-forms") as HTMLInputElement;
const protectUploads = document.getElementById("protect-uploads") as HTMLInputElement;
const skipOffline = document.getElementById("skip-offline") as HTMLInputElement;
const enableSnapshots = document.getElementById("enable-snapshots") as HTMLInputElement;
const snapshotIntervalMinutes = document.getElementById("snapshot-interval-minutes") as HTMLInputElement;
const checkUpdates = document.getElementById("check-updates") as HTMLInputElement;
const updateCheckStatus = document.getElementById("update-check-status") as HTMLElement;
const btnCopyUpdateOpt = document.getElementById("btn-copy-update-opt") as HTMLButtonElement;
const allowlist = document.getElementById("allowlist") as HTMLTextAreaElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;

const installCmd = document.getElementById("install-cmd") as HTMLElement;
const btnCopyInstall = document.getElementById("btn-copy-install") as HTMLButtonElement;
const nativeStatus = document.getElementById("native-status") as HTMLElement;
const hostStatus = document.getElementById("host-status") as HTMLElement;
const uploadStatus = document.getElementById("upload-status") as HTMLElement;
const btnNativePerm = document.getElementById("btn-native-perm") as HTMLButtonElement;
const btnNativeTest = document.getElementById("btn-native-test") as HTMLButtonElement;
const btnHostPerm = document.getElementById("btn-host-perm") as HTMLButtonElement;
const btnUploadPerm = document.getElementById("btn-upload-perm") as HTMLButtonElement;
const snapshotsCardEl = document.getElementById("snapshots-card") as HTMLElement;
const btnSaveSnapshot = document.getElementById("btn-save-snapshot") as HTMLButtonElement;
const btnClearSnapshots = document.getElementById("btn-clear-snapshots") as HTMLButtonElement;
const snapshotLabelInput = document.getElementById("snapshot-label") as HTMLInputElement;
const snapshotStatus = document.getElementById("snapshot-status") as HTMLElement;
const snapshotList = document.getElementById("snapshot-list") as HTMLElement;

const syncStatusEl = document.getElementById("sync-status") as HTMLElement;
const syncControlsEl = document.getElementById("sync-controls") as HTMLElement;
const syncSnapshotsConfigEl = document.getElementById("sync-snapshots-config") as HTMLElement;
const syncSnapshotsStatusEl = document.getElementById("sync-snapshots-status") as HTMLElement;
const syncCandidatesWrap = document.getElementById("sync-candidates-wrap") as HTMLElement;
const syncCandidatesEl = document.getElementById("sync-candidates") as HTMLElement;
const syncFolderInput = document.getElementById("sync-folder-input") as HTMLInputElement;
const btnSyncPick = document.getElementById("btn-sync-pick") as HTMLButtonElement;
const btnSyncApply = document.getElementById("btn-sync-apply") as HTMLButtonElement;
const btnSyncNow = document.getElementById("btn-sync-now") as HTMLButtonElement;
const btnSyncDisable = document.getElementById("btn-sync-disable") as HTMLButtonElement;
const deviceNameInput = document.getElementById("device-name-input") as HTMLInputElement;
const btnDeviceName = document.getElementById("btn-device-name") as HTMLButtonElement;
const syncDevicesWrap = document.getElementById("sync-devices-wrap") as HTMLElement;
const syncDevicesList = document.getElementById("sync-devices-list") as HTMLElement;
const syncDevicesStatus = document.getElementById("sync-devices-status") as HTMLElement;

const setupCardEl = document.getElementById("setup-card") as HTMLElement;
const btnSetupDismiss = document.getElementById("btn-setup-dismiss") as HTMLButtonElement;
const setupStepNative = document.getElementById("setup-step-native") as HTMLElement;
const setupStepHost = document.getElementById("setup-step-host") as HTMLElement;
const setupStepSync = document.getElementById("setup-step-sync") as HTMLElement;
const setupNativeStatus = document.getElementById("setup-native-status") as HTMLElement;
const setupHostStatus = document.getElementById("setup-host-status") as HTMLElement;
const setupSyncStatus = document.getElementById("setup-sync-status") as HTMLElement;
const setupSyncActions = document.getElementById("setup-sync-actions") as HTMLElement;
const btnSetupNative = document.getElementById("btn-setup-native") as HTMLButtonElement;
const btnSetupHost = document.getElementById("btn-setup-host") as HTMLButtonElement;
const setupShortcutEl = document.getElementById("setup-shortcut") as HTMLElement;

function syncBudgetVisibility(): void {
  const isFixed = memoryMode.value === "fixed_gb";
  fractionWrap.classList.toggle("hidden", isFixed);
  fixedGbWrap.classList.toggle("hidden", !isFixed);
  renderMemoryMode();
}

const PRESSURE_LABELS = { normal: "normal", moderate: "moderate", critical: "critical" } as const;
let lastMemory: MemorySnapshot | null = null;

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Shows only the settings that apply to how memory is measured right now, with live numbers. */
function renderMemoryMode(): void {
  const memory = lastMemory;
  if (memory?.source === "system_memory") {
    budgetFields.classList.add("hidden");
    const free = `Now ${formatGb(memory.systemAvailableBytes)} is free`;
    const thresholds = memory.pressureThresholds;
    if (!thresholds) {
      memoryModeHint.textContent =
        "ChromeOS puts tabs to sleep under memory pressure on its own. Without the Local Companion, Tab Reaper puts tabs to sleep only when Chrome starts or when you ask.";
      memoryNow.textContent = `${free}.`;
      return;
    }
    memoryModeHint.textContent =
      "Without the Local Companion, Tab Reaper can't measure Chrome's memory, so it reacts to the computer's memory pressure and there is no budget to set. Install the Local Companion under Optional capabilities to cap Chrome's memory.";
    memoryNow.textContent =
      `${free} (${PRESSURE_LABELS[memory.pressure ?? "normal"]} pressure). ` +
      `Tabs start sleeping, least recently used first, when free memory drops to ${formatMb(thresholds.moderateBytes)}. ` +
      `At ${formatMb(thresholds.criticalBytes)} the heaviest go first. ` +
      `If ${MAX_DISCARDS_WITHOUT_RELIEF} tabs sleep without freeing memory, Tab Reaper waits until the pressure ends.`;
    return;
  }

  budgetFields.classList.remove("hidden");
  if (!memory) {
    memoryModeHint.textContent = "Memory reading is unavailable right now.";
    memoryNow.textContent = "";
    return;
  }
  const config = sanitizeConfig({ ...displayedConfig, ...readMainFormConfig() });
  const budget = computeMemoryBudgetBytes(config, memory.systemTotalBytes);
  const used = Math.round((memory.usedBytes / Math.max(1, budget)) * 100);
  memoryModeHint.textContent =
    "The Local Companion measures Chrome's own memory. Each check puts up to two eligible tabs to sleep until Chrome is back under the sleep threshold.";
  memoryNow.textContent =
    `Chrome uses ${formatGb(memory.usedBytes)} of a ${formatGb(budget)} budget (${used}%). ` +
    `Tabs start sleeping at ${formatGb((budget * config.idleEvictionPercent) / 100)}, ` +
    `and the heaviest go first at ${formatGb((budget * config.sizeEvictionPercent) / 100)}.`;
}

async function refreshMemoryMode(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "get_status", includeTabs: false })) as StatusPayload;
  lastMemory = status.memory;
  renderMemoryMode();
}

const UNDO_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';

type ConfigKey = keyof TabReaperConfig;

interface FieldSpec<T> {
  read: () => T;
  write: (value: T) => void;
  isDefault: () => boolean;
  defaultLabel: string;
}

type FieldSpecs = { [K in ConfigKey]: FieldSpec<TabReaperConfig[K]> };

function selectField<T extends string>(
  el: HTMLSelectElement,
  defaultValue: T,
  defaultLabel: string,
  onWrite?: () => void,
): FieldSpec<T> {
  return {
    read: () => el.value as T,
    write: (value) => {
      el.value = value;
      onWrite?.();
    },
    isDefault: () => el.value === defaultValue,
    defaultLabel,
  };
}

function numberField(
  el: HTMLInputElement,
  defaultValue: number,
  defaultLabel = String(defaultValue),
): FieldSpec<number> {
  return {
    read: () => Number(el.value),
    write: (value) => {
      el.value = String(value);
    },
    isDefault: () => Number(el.value) === defaultValue,
    defaultLabel,
  };
}

function boolField(el: HTMLInputElement, defaultValue: boolean): FieldSpec<boolean> {
  return {
    read: () => el.checked,
    write: (value) => {
      el.checked = value;
    },
    isDefault: () => el.checked === defaultValue,
    defaultLabel: defaultValue ? "enabled" : "disabled",
  };
}

function linesField(el: HTMLTextAreaElement, defaultValue: string[], defaultLabel = "empty"): FieldSpec<string[]> {
  const readLines = (): string[] =>
    el.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  return {
    read: readLines,
    write: (value) => {
      el.value = value.join("\n");
    },
    isDefault: () => {
      const lines = readLines();
      return lines.length === defaultValue.length && lines.every((line, i) => line === defaultValue[i]);
    },
    defaultLabel,
  };
}

const fieldSpecs: FieldSpecs = {
  memoryBudgetMode: selectField<MemoryBudgetMode>(
    memoryMode,
    DEFAULT_CONFIG.memoryBudgetMode,
    "Fraction of system RAM",
    syncBudgetVisibility,
  ),
  memoryBudgetFraction: numberField(memoryFraction, DEFAULT_CONFIG.memoryBudgetFraction),
  memoryBudgetGb: numberField(memoryGb, DEFAULT_CONFIG.memoryBudgetGb, `${DEFAULT_CONFIG.memoryBudgetGb} GB`),
  idleEvictionPercent: numberField(
    idleEvictionPercent,
    DEFAULT_CONFIG.idleEvictionPercent,
    `${DEFAULT_CONFIG.idleEvictionPercent}%`,
  ),
  sizeEvictionPercent: numberField(
    sizeEvictionPercent,
    DEFAULT_CONFIG.sizeEvictionPercent,
    `${DEFAULT_CONFIG.sizeEvictionPercent}%`,
  ),
  startupSweep: boolField(startupSweep, DEFAULT_CONFIG.startupSweep),
  protectActive: boolField(protectActive, DEFAULT_CONFIG.protectActive),
  protectAudible: boolField(protectAudible, DEFAULT_CONFIG.protectAudible),
  protectPinned: boolField(protectPinned, DEFAULT_CONFIG.protectPinned),
  protectUnsavedForms: boolField(protectForms, DEFAULT_CONFIG.protectUnsavedForms),
  protectActiveUploads: boolField(protectUploads, DEFAULT_CONFIG.protectActiveUploads),
  skipWhenOffline: boolField(skipOffline, DEFAULT_CONFIG.skipWhenOffline),
  enableSessionSnapshots: boolField(enableSnapshots, DEFAULT_CONFIG.enableSessionSnapshots),
  snapshotIntervalMinutes: numberField(
    snapshotIntervalMinutes,
    DEFAULT_CONFIG.snapshotIntervalMinutes,
    `${DEFAULT_CONFIG.snapshotIntervalMinutes} min`,
  ),
  allowlist: linesField(allowlist, DEFAULT_CONFIG.allowlist),
  checkForUpdates: boolField(checkUpdates, DEFAULT_CONFIG.checkForUpdates),
};

const FIELD_KEYS = Object.keys(fieldSpecs) as ConfigKey[];
const INSTANT_SAVE_KEYS = new Set<ConfigKey>(["enableSessionSnapshots", "snapshotIntervalMinutes", "checkForUpdates"]);
const MAIN_FORM_KEYS = FIELD_KEYS.filter((key) => !INSTANT_SAVE_KEYS.has(key));

function isConfigKey(key: string | undefined): key is ConfigKey {
  return key !== undefined && key in fieldSpecs;
}

function writeFieldFrom<K extends ConfigKey>(key: K, config: TabReaperConfig): void {
  fieldSpecs[key].write(config[key]);
}

let displayedConfig = DEFAULT_CONFIG;

function readMainFormConfig(): Partial<TabReaperConfig> {
  const payload: Partial<TabReaperConfig> = {};
  const assign = <K extends ConfigKey>(key: K): void => {
    const value = fieldSpecs[key].read();
    if (JSON.stringify(value) !== JSON.stringify(displayedConfig[key])) payload[key] = value;
  };
  for (const key of MAIN_FORM_KEYS) {
    assign(key);
  }
  return payload;
}

type SnapshotSetting = "enableSessionSnapshots" | "snapshotIntervalMinutes";
const snapshotSaveSeq = { enableSessionSnapshots: 0, snapshotIntervalMinutes: 0 };

async function saveSyncSnapshotSettings(key: SnapshotSetting): Promise<void> {
  syncResetButtons();
  const value = fieldSpecs[key].read();
  const seq = ++snapshotSaveSeq[key];
  const res = (await chrome.runtime.sendMessage({
    type: "save_config",
    config: { [key]: value },
  })) as { ok: boolean; config: TabReaperConfig };
  if (seq !== snapshotSaveSeq[key]) return;
  if (res?.ok) {
    if (fieldSpecs[key].read() === value) writeFieldFrom(key, res.config);
    syncResetButtons();
    syncSnapshotsStatusEl.textContent = "Saved.";
    syncSnapshotsStatusEl.className = "status-text ok";
  } else {
    syncSnapshotsStatusEl.textContent = "Failed to save snapshot settings.";
    syncSnapshotsStatusEl.className = "status-text err";
  }
}

const resetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-reset]"));

for (const btn of resetButtons) {
  const key = btn.dataset.reset;
  if (!isConfigKey(key)) continue;
  const spec = fieldSpecs[key];
  btn.innerHTML = UNDO_ICON_SVG;
  const hint = `Reset to default (${spec.defaultLabel})`;
  btn.title = hint;
  btn.setAttribute("aria-label", hint);
  btn.addEventListener("click", () => {
    writeFieldFrom(key, DEFAULT_CONFIG);
    syncResetButtons();
    if (key === "enableSessionSnapshots" || key === "snapshotIntervalMinutes") {
      void saveSyncSnapshotSettings(key);
    }
  });
}

function syncResetButtons(): void {
  for (const btn of resetButtons) {
    const key = btn.dataset.reset;
    if (!isConfigKey(key)) continue;
    btn.classList.toggle("hidden", fieldSpecs[key].isDefault());
  }
}

function populateForm(config: TabReaperConfig): void {
  displayedConfig = config;
  for (const key of FIELD_KEYS) {
    writeFieldFrom(key, config);
  }
  syncBudgetVisibility();
  syncResetButtons();
}

const WEIGHTED_EVICTION_PERMS: chrome.permissions.Permissions = {
  permissions: ["scripting"],
  origins: ["<all_urls>"],
};

const UPLOAD_PROTECTION_PERMS: chrome.permissions.Permissions = {
  permissions: ["webRequest"],
  origins: ["<all_urls>"],
};

function buildInstallCommand(extensionId: string): string {
  const versionTag = `v${chrome.runtime.getManifest().version}`;
  const isWindows = /Windows/i.test(navigator.userAgent);
  if (isWindows) {
    return `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/marcusgrando/tab-reaper/${versionTag}/native-host/install.ps1))) -Version ${versionTag} ${extensionId}`;
  }
  return `curl -fsSL https://raw.githubusercontent.com/marcusgrando/tab-reaper/${versionTag}/native-host/install.sh | TAB_REAPER_VERSION=${versionTag} bash -s -- ${extensionId}`;
}

let setupVisible = false;
let hasNativePerm = false;
let hasHostPerm = false;
let lastSyncStatus: SyncStatus | null = null;
let lastSyncCandidates: SyncFolderCandidate[] = [];
let setupNativeError: string | null = null;

function setStepDone(stepEl: HTMLElement, stepNumber: string, done: boolean): void {
  stepEl.classList.toggle("done", done);
  const badge = stepEl.querySelector(".setup-badge");
  if (badge) badge.textContent = done ? "\u2713" : stepNumber;
}

function renderSetupCard(): void {
  setupCardEl.classList.toggle("hidden", !setupVisible);
  if (!setupVisible) return;

  const companionReady = hasNativePerm && Boolean(lastSyncStatus?.hostConnected) && !lastSyncStatus?.hostOutdated;
  setStepDone(setupStepNative, "1", companionReady);
  btnSetupNative.classList.toggle("hidden", companionReady);
  if (companionReady) {
    const versionPart = lastSyncStatus?.hostVersion ? `v${lastSyncStatus.hostVersion}` : "connected";
    const ramPart = lastMemory?.source === "native_host" ? ` · Chrome ${formatGb(lastMemory.usedBytes)}` : "";
    setupNativeStatus.textContent = `Connected (${versionPart}${ramPart}).`;
    setupNativeStatus.className = "status-text ok";
  } else if (setupNativeError) {
    btnSetupNative.textContent = "Retry";
    setupNativeStatus.textContent = setupNativeError;
    setupNativeStatus.className = "status-text err";
  } else if (lastSyncStatus?.hostOutdated) {
    btnSetupNative.textContent = "Retry";
    setupNativeStatus.textContent =
      lastSyncStatus.lastError ?? "Installed companion is outdated. Re-run the install command below to upgrade.";
    setupNativeStatus.className = "status-text err";
  } else {
    btnSetupNative.textContent = hasNativePerm ? "Test connection" : "Connect";
    setupNativeStatus.textContent = hasNativePerm
      ? "Permission granted. Click Test connection to verify the companion."
      : "";
    setupNativeStatus.className = "status-text";
  }

  setStepDone(setupStepHost, "2", hasHostPerm);
  btnSetupHost.classList.toggle("hidden", hasHostPerm);
  setupHostStatus.textContent = hasHostPerm ? "Enabled." : "";
  setupHostStatus.className = `status-text ${hasHostPerm ? "ok" : ""}`;

  const syncReady = Boolean(lastSyncStatus?.enabled && lastSyncStatus.writable);
  setStepDone(setupStepSync, "3", syncReady);
  setupSyncActions.replaceChildren();
  if (syncReady) {
    setupSyncStatus.textContent = `Active: ${lastSyncStatus?.syncDir ?? ""}`;
    setupSyncStatus.className = "status-text ok";
  } else if (companionReady) {
    setupSyncStatus.textContent =
      lastSyncCandidates.length > 0
        ? "Pick a detected cloud folder or choose any folder on your computer:"
        : "Choose a local or cloud-synced folder:";
    setupSyncStatus.className = "status-text";
    for (const cand of lastSyncCandidates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      btn.textContent = cand.exists ? `${cand.label} (existing)` : cand.label;
      btn.title = cand.path;
      btn.addEventListener("click", () => {
        syncFolderInput.value = cand.path;
        void applySyncFolder(cand.path);
      });
      setupSyncActions.appendChild(btn);
    }
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "secondary small";
    pickBtn.textContent = "Choose folder…";
    pickBtn.addEventListener("click", () => {
      pickBtn.disabled = true;
      void pickSyncFolderWithDialog().finally(() => {
        pickBtn.disabled = false;
      });
    });
    setupSyncActions.appendChild(pickBtn);
  } else {
    setupSyncStatus.textContent = "Connect Local Companion in step 1 first.";
    setupSyncStatus.className = "status-text";
  }
}

async function pickSyncFolderWithDialog(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: "pick_sync_folder" })) as {
    ok?: boolean;
    path?: string;
    cancelled?: boolean;
    error?: string;
  };
  if (res?.ok && res.path) {
    syncFolderInput.value = res.path;
    await applySyncFolder(res.path);
  } else if (res?.error && !res.cancelled) {
    syncStatusEl.textContent = `Picker error: ${res.error}`;
    syncStatusEl.className = "status-text err";
  }
}

async function refreshPermissionsUI(): Promise<void> {
  const [hasNative, hasHost, hasUpload] = await Promise.all([
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
    chrome.permissions.contains(WEIGHTED_EVICTION_PERMS),
    chrome.permissions.contains(UPLOAD_PROTECTION_PERMS),
  ]);
  hasNativePerm = hasNative;
  hasHostPerm = hasHost;

  btnNativePerm.textContent = hasNative ? "Revoke" : "Enable";
  nativeStatus.textContent = hasNative ? "Permission granted." : "Permission is off. Tab Reaper uses system RAM.";
  nativeStatus.className = `status-text ${hasNative ? "ok" : ""}`;

  btnHostPerm.textContent = hasHost ? "Revoke" : "Enable";
  hostStatus.textContent = hasHost
    ? "On. Heavier tabs sleep first at the size threshold."
    : "Off. The oldest idle tabs sleep first.";
  hostStatus.className = `status-text ${hasHost ? "ok" : ""}`;

  btnUploadPerm.textContent = hasUpload ? "Revoke" : "Enable";
  if (!hasUpload) {
    uploadStatus.textContent = "Off. Active uploads are not tracked.";
    uploadStatus.className = "status-text";
  } else if (displayedConfig.protectActiveUploads) {
    uploadStatus.textContent = "On. Active HTTP uploads pause sleeping.";
    uploadStatus.className = "status-text ok";
  } else {
    uploadStatus.textContent = "Permission granted, but protection is off under Protections above.";
    uploadStatus.className = "status-text";
  }
  renderSetupCard();
}

function formatSnapshotTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

async function applySyncFolder(path: string | null): Promise<void> {
  syncStatusEl.textContent = path ? "Configuring sync folder..." : "Disabling folder sync...";
  syncStatusEl.className = "status-text";
  const res = (await chrome.runtime.sendMessage({ type: "set_sync_folder", path })) as SyncStatus & {
    ok?: boolean;
    error?: string;
  };
  if (res?.ok) {
    await refreshSyncAndSnapshotsUI();
    if (path) {
      const status = (await chrome.runtime.sendMessage({ type: "get_status", includeTabs: false })) as StatusPayload;
      populateForm(status.config);
    }
  } else {
    syncStatusEl.textContent = `Error: ${res?.error ?? "failed to update sync folder"}`;
    syncStatusEl.className = "status-text err";
  }
}

let currentDeviceId: string | null = null;
let supportsDeviceManagement = false;
let syncedDevices: SyncedDeviceInfo[] = [];
let syncEnabledState = false;
let hasStoredSnapshots = false;

function shortDeviceTag(deviceId: string): string {
  const cleaned = deviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toLowerCase();
  return cleaned ? `#${cleaned}` : "";
}

function getDuplicateDeviceNames(items: Array<{ deviceId?: string; deviceName?: string }>): Set<string> {
  const idsByName = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.deviceId || !item.deviceName) continue;
    const key = item.deviceName.trim().toLowerCase();
    let set = idsByName.get(key);
    if (!set) {
      set = new Set();
      idsByName.set(key, set);
    }
    set.add(item.deviceId);
  }
  const dupes = new Set<string>();
  for (const [key, ids] of idsByName.entries()) {
    if (ids.size > 1) dupes.add(key);
  }
  return dupes;
}

function formatDeviceDisplayName(deviceId: string, deviceName: string, duplicateNames: Set<string>): string {
  const key = deviceName.trim().toLowerCase();
  if (!duplicateNames.has(key)) return deviceName;
  const tag = shortDeviceTag(deviceId);
  return tag ? `${deviceName} · ${tag}` : deviceName;
}

function formatTabUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    const combined = `${parsed.hostname}${path}`;
    return combined.length > 72 ? `${combined.slice(0, 71)}…` : combined;
  } catch {
    return url.length > 72 ? `${url.slice(0, 71)}…` : url;
  }
}

function updateSnapshotsCardVisibility(): void {
  snapshotsCardEl.classList.toggle("hidden", !syncEnabledState && !hasStoredSnapshots);
}

function renderSyncedDevicesUI(): void {
  syncDevicesList.replaceChildren();
  if (!syncEnabledState) {
    syncDevicesStatus.textContent = "";
    syncDevicesWrap.classList.add("hidden");
    return;
  }
  if (syncedDevices.length <= 1) {
    syncDevicesWrap.classList.add("hidden");
    return;
  }

  syncDevicesWrap.classList.remove("hidden");
  const duplicateNames = getDuplicateDeviceNames(syncedDevices);

  for (const dev of syncedDevices) {
    const row = document.createElement("div");
    row.className = "device-row";

    const info = document.createElement("div");
    const nameEl = document.createElement("strong");
    nameEl.textContent = formatDeviceDisplayName(dev.deviceId, dev.deviceName, duplicateNames);
    info.appendChild(nameEl);

    if (dev.isCurrent) {
      const badge = document.createElement("span");
      badge.className = "snapshot-badge";
      badge.textContent = "this browser";
      info.appendChild(badge);
    } else if (dev.isSameComputer) {
      const badge = document.createElement("span");
      badge.className = "snapshot-badge muted";
      badge.textContent = "same computer";
      info.appendChild(badge);
    }

    const meta = document.createElement("span");
    meta.className = "device-meta";
    const lastPart = dev.lastSeenAt ? `Last active ${formatSnapshotTime(dev.lastSeenAt)}` : "No activity recorded";
    const snapPart = `${dev.snapshotCount} snapshot${dev.snapshotCount === 1 ? "" : "s"}`;
    const hintPart = !dev.isCurrent && dev.isSameComputer ? " · Earlier install or other profile" : "";
    meta.textContent = `${lastPart} · ${snapPart}${hintPart}`;
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "device-actions";

    if (!dev.isCurrent && supportsDeviceManagement) {
      const renderDefaultDeviceActions = () => {
        actions.replaceChildren();
        if (dev.isSameComputer) {
          const adoptBtn = document.createElement("button");
          adoptBtn.type = "button";
          adoptBtn.className = "secondary small";
          adoptBtn.textContent = "Use this history";
          adoptBtn.addEventListener("click", () => {
            actions.replaceChildren();
            const prompt = document.createElement("div");
            prompt.className = "confirm-prompt";

            const confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className = "small";
            confirmBtn.textContent = "Confirm";
            confirmBtn.addEventListener("click", async () => {
              confirmBtn.disabled = true;
              syncDevicesStatus.textContent = "Merging history...";
              syncDevicesStatus.className = "status-text";
              const res = (await chrome.runtime.sendMessage({
                type: "adopt_synced_device",
                targetDeviceId: dev.deviceId,
              })) as { ok?: boolean; migrated?: number; error?: string };
              if (res?.ok) {
                const moved = res.migrated ? ` Merged ${res.migrated} recent snapshot(s).` : "";
                syncDevicesStatus.textContent = `Switched to ${dev.deviceName}'s history.${moved}`;
                syncDevicesStatus.className = "status-text ok";
                await refreshSyncAndSnapshotsUI();
              } else {
                syncDevicesStatus.textContent = res?.error ?? "Could not switch device history.";
                syncDevicesStatus.className = "status-text err";
                renderDefaultDeviceActions();
              }
            });

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "secondary small";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", renderDefaultDeviceActions);

            const note = document.createElement("span");
            note.className = "confirm-note";
            note.textContent = "Use only if that earlier install is no longer running.";

            prompt.append(confirmBtn, cancelBtn, note);
            actions.appendChild(prompt);
          });
          actions.appendChild(adoptBtn);
        }

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "secondary small";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          actions.replaceChildren();
          const prompt = document.createElement("div");
          prompt.className = "confirm-prompt";

          const confirmBtn = document.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.className = "small";
          confirmBtn.textContent = "Remove device";
          confirmBtn.addEventListener("click", async () => {
            confirmBtn.disabled = true;
            syncDevicesStatus.textContent = "Removing device...";
            syncDevicesStatus.className = "status-text";
            const res = (await chrome.runtime.sendMessage({
              type: "remove_synced_device",
              targetDeviceId: dev.deviceId,
            })) as { ok?: boolean; error?: string };
            if (res?.ok) {
              syncDevicesStatus.textContent = `Removed ${dev.deviceName} from this sync folder.`;
              syncDevicesStatus.className = "status-text ok";
              await refreshSyncAndSnapshotsUI();
            } else {
              syncDevicesStatus.textContent = res?.error ?? "Could not remove device.";
              syncDevicesStatus.className = "status-text err";
              renderDefaultDeviceActions();
            }
          });

          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "secondary small";
          cancelBtn.textContent = "Cancel";
          cancelBtn.addEventListener("click", renderDefaultDeviceActions);

          prompt.append(confirmBtn, cancelBtn);
          actions.appendChild(prompt);
        });
        actions.appendChild(removeBtn);
      };

      renderDefaultDeviceActions();
    }

    row.append(info, actions);
    syncDevicesList.appendChild(row);
  }

  if (!supportsDeviceManagement) {
    syncDevicesStatus.textContent = "Update the Local Companion to remove or merge other devices from here.";
    syncDevicesStatus.className = "status-text";
  }
}

async function refreshSyncAndSnapshotsUI(): Promise<void> {
  await refreshSyncUI();
  await refreshSnapshotsUI();
}

async function refreshSyncUI(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "get_sync_status" })) as SyncStatus;
  lastSyncStatus = status ?? null;
  currentDeviceId = status?.deviceId ?? null;
  supportsDeviceManagement = Boolean(status?.supportsDeviceManagement);
  if (!status?.hostConnected) {
    lastSyncCandidates = [];
    syncedDevices = [];
    syncEnabledState = false;
    syncControlsEl.classList.add("hidden");
    syncSnapshotsConfigEl.classList.add("hidden");
    renderSyncedDevicesUI();
    updateSnapshotsCardVisibility();
    btnSyncNow.classList.add("hidden");
    btnSyncDisable.classList.add("hidden");
    syncStatusEl.textContent = "Enable and connect Local Companion above to use Folder Sync.";
    syncStatusEl.className = "status-text";
    renderSetupCard();
    return;
  }

  if (status.hostOutdated) {
    lastSyncCandidates = [];
    syncedDevices = [];
    syncEnabledState = false;
    syncControlsEl.classList.add("hidden");
    syncSnapshotsConfigEl.classList.add("hidden");
    renderSyncedDevicesUI();
    updateSnapshotsCardVisibility();
    btnSyncNow.classList.add("hidden");
    btnSyncDisable.classList.add("hidden");
    syncStatusEl.textContent =
      status.lastError ??
      `Connected host v${status.hostVersion ?? "unknown"} does not support Folder Sync. Re-run the install command above to upgrade.`;
    syncStatusEl.className = "status-text err";
    renderSetupCard();
    return;
  }

  syncEnabledState = Boolean(status.enabled);
  syncControlsEl.classList.remove("hidden");
  syncSnapshotsConfigEl.classList.toggle("hidden", !syncEnabledState);
  updateSnapshotsCardVisibility();
  btnSyncNow.classList.toggle("hidden", !syncEnabledState);
  btnSyncDisable.classList.toggle("hidden", !syncEnabledState);
  syncFolderInput.value = status.syncDir ?? "";
  deviceNameInput.value = status.deviceName ?? "";

  if (status.enabled && status.writable) {
    const lastText = status.lastSyncAt ? ` · Last synced ${formatSnapshotTime(status.lastSyncAt)}` : "";
    syncStatusEl.textContent = `Active: ${status.syncDir}${lastText}`;
    syncStatusEl.className = "status-text ok";
  } else if (status.enabled && !status.writable) {
    syncStatusEl.textContent = `Configured folder is not writable: ${status.syncDir}`;
    syncStatusEl.className = "status-text err";
  } else {
    syncStatusEl.textContent = "Local Companion connected. Choose a cloud-synced folder below to enable sync.";
    syncStatusEl.className = "status-text";
  }

  const [candidates, devices] = await Promise.all([
    chrome.runtime.sendMessage({ type: "detect_sync_folders" }) as Promise<SyncFolderCandidate[]>,
    syncEnabledState
      ? (chrome.runtime.sendMessage({ type: "get_synced_devices" }) as Promise<SyncedDeviceInfo[]>)
      : Promise.resolve([]),
  ]);
  syncedDevices = Array.isArray(devices) ? devices : [];
  renderSyncedDevicesUI();
  lastSyncCandidates = Array.isArray(candidates) ? candidates : [];
  syncCandidatesEl.replaceChildren();
  if (lastSyncCandidates.length === 0) {
    syncCandidatesWrap.classList.add("hidden");
    renderSetupCard();
    return;
  }
  syncCandidatesWrap.classList.remove("hidden");
  for (const cand of lastSyncCandidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip-btn${status.syncDir === cand.path ? " active" : ""}`;
    btn.textContent = cand.exists ? `${cand.label} (existing)` : cand.label;
    btn.title = cand.path;
    btn.addEventListener("click", () => {
      syncFolderInput.value = cand.path;
      void applySyncFolder(cand.path);
    });
    syncCandidatesEl.appendChild(btn);
  }
  renderSetupCard();
}

async function runRestore(snap: SnapshotListItem, mode: RestoreMode): Promise<void> {
  snapshotStatus.textContent = "Restoring session...";
  snapshotStatus.className = "status-text";
  const res = (await chrome.runtime.sendMessage({
    type: "restore_snapshot",
    targetWindowId: (await chrome.windows.getCurrent()).id,
    id: snap.id,
    mode,
    relPath: snap.relPath,
  })) as {
    ok?: boolean;
    error?: string;
    restored?: number;
    skippedExisting?: number;
    windowsCreated?: number;
  };
  if (!res?.ok) {
    snapshotStatus.textContent = res?.error ?? "Restore failed. Try again.";
    snapshotStatus.className = "status-text err";
    return;
  }
  const winPart = res?.windowsCreated ? ` across ${res.windowsCreated} window(s)` : "";
  const skipped = res?.skippedExisting ? `, ${res.skippedExisting} already open` : "";
  snapshotStatus.textContent = `Restored ${res?.restored ?? 0} tab(s)${winPart}${skipped}.`;
  snapshotStatus.className = "status-text ok";
  await refreshSyncAndSnapshotsUI();
}

function renderSnapshotTabsPanel(panel: HTMLElement, snapshot: SessionSnapshot): void {
  panel.replaceChildren();
  if (!snapshot.tabs.length) {
    const empty = document.createElement("div");
    empty.className = "snapshot-meta";
    empty.textContent = "No tabs recorded in this snapshot.";
    panel.appendChild(empty);
    return;
  }

  const byWindow = new Map<number, SnapshotTab[]>();
  for (const tab of snapshot.tabs) {
    const list = byWindow.get(tab.windowId) ?? [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }

  const multiWindow = byWindow.size > 1;
  let winIdx = 0;
  for (const tabs of byWindow.values()) {
    winIdx++;
    const winWrap = document.createElement("div");
    winWrap.className = "snapshot-tabs-window";
    if (multiWindow) {
      const heading = document.createElement("div");
      heading.className = "snapshot-tabs-window-title";
      heading.textContent = `Window ${winIdx} (${tabs.length} tabs)`;
      winWrap.appendChild(heading);
    }

    const list = document.createElement("ul");
    list.className = "snapshot-tab-list";
    const ordered = [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const tab of ordered) {
      const li = document.createElement("li");
      li.className = "snapshot-tab-entry";

      if (tab.groupTitle) {
        const grp = document.createElement("span");
        grp.className = "snapshot-badge muted";
        grp.textContent = tab.groupTitle;
        li.appendChild(grp);
      }
      if (tab.pinned) {
        const pin = document.createElement("span");
        pin.className = "snapshot-badge muted";
        pin.textContent = "pinned";
        li.appendChild(pin);
      }
      if (tab.kept) {
        const kept = document.createElement("span");
        kept.className = "snapshot-badge";
        kept.textContent = "kept";
        li.appendChild(kept);
      }

      if (isHttpUrl(tab.url)) {
        const link = document.createElement("a");
        link.className = "snapshot-tab-link";
        link.href = tab.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = tab.title || tab.url;
        link.title = tab.url;
        li.appendChild(link);
      } else {
        const titleEl = document.createElement("span");
        titleEl.className = "snapshot-tab-link";
        titleEl.textContent = tab.title || tab.url;
        li.appendChild(titleEl);
      }

      const urlEl = document.createElement("span");
      urlEl.className = "snapshot-tab-url";
      urlEl.textContent = formatTabUrl(tab.url);
      li.appendChild(urlEl);

      list.appendChild(li);
    }
    winWrap.appendChild(list);
    panel.appendChild(winWrap);
  }
}

function buildSnapshotItemEl(
  snap: SnapshotListItem,
  options: { showDeviceInRow: boolean; isOwn: boolean; detailsCache: Map<string, SessionSnapshot> },
): HTMLElement {
  const item = document.createElement("div");
  item.className = "snapshot-item";

  const row = document.createElement("div");
  row.className = "snapshot-row";

  const info = document.createElement("div");
  const count = document.createElement("strong");
  const winLabel = snap.windowCount > 1 ? ` · ${snap.windowCount} windows` : "";
  count.textContent = snap.label
    ? `${snap.label} (${snap.tabCount} tabs${winLabel})`
    : `${snap.tabCount} tabs${winLabel}`;

  const meta = document.createElement("span");
  meta.className = "snapshot-meta";
  const devicePart = options.showDeviceInRow && snap.deviceName ? ` · ${snap.deviceName}` : "";
  meta.textContent = ` · ${formatSnapshotTime(snap.capturedAt)}${devicePart}`;
  info.append(count, meta);

  if (snap.trigger === "manual") {
    const badge = document.createElement("span");
    badge.className = "snapshot-badge manual";
    badge.textContent = "manual";
    info.appendChild(badge);
  } else if (snap.trigger === "pre_restore") {
    const badge = document.createElement("span");
    badge.className = "snapshot-badge";
    badge.textContent = "pre-restore";
    info.appendChild(badge);
  }

  if (snap.source === "sync") {
    const badge = document.createElement("span");
    badge.className = "snapshot-badge sync";
    badge.textContent = "synced";
    info.appendChild(badge);
  }

  const actions = document.createElement("div");
  actions.className = "snapshot-actions";

  const tabsPanel = document.createElement("div");
  tabsPanel.className = "snapshot-tabs-panel hidden";

  const tabsBtn = document.createElement("button");
  tabsBtn.type = "button";
  tabsBtn.className = "secondary small";
  tabsBtn.textContent = "Tabs";
  tabsBtn.setAttribute("aria-expanded", "false");
  tabsBtn.addEventListener("click", async () => {
    const opening = tabsPanel.classList.contains("hidden");
    if (!opening) {
      tabsPanel.classList.add("hidden");
      tabsBtn.textContent = "Tabs";
      tabsBtn.setAttribute("aria-expanded", "false");
      return;
    }
    tabsPanel.classList.remove("hidden");
    tabsBtn.textContent = "Hide tabs";
    tabsBtn.setAttribute("aria-expanded", "true");

    const cached = options.detailsCache.get(snap.id);
    if (cached) {
      renderSnapshotTabsPanel(tabsPanel, cached);
      return;
    }
    tabsPanel.textContent = "Loading tabs...";
    const res = (await chrome.runtime.sendMessage({
      type: "get_snapshot_details",
      id: snap.id,
      relPath: snap.relPath,
    })) as { ok?: boolean; snapshot?: SessionSnapshot; error?: string };
    if (res?.ok && res.snapshot) {
      options.detailsCache.set(snap.id, res.snapshot);
      renderSnapshotTabsPanel(tabsPanel, res.snapshot);
    } else {
      tabsPanel.textContent = res?.error ?? "Could not load tabs for this snapshot.";
    }
  });

  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.className = "secondary small";
  restoreBtn.textContent = "Restore";

  const canDelete = options.isOwn || supportsDeviceManagement;
  const delBtn = canDelete ? document.createElement("button") : null;
  if (delBtn) {
    delBtn.type = "button";
    delBtn.className = "secondary small";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      const res = (await chrome.runtime.sendMessage({
        type: "delete_snapshot",
        id: snap.id,
        syncDir: snap.syncDir,
        ownerDeviceId: snap.deviceId,
      })) as { ok?: boolean };
      if (!res?.ok && !options.isOwn) {
        snapshotStatus.textContent = "Could not delete snapshot. Check folder permissions and try again.";
        snapshotStatus.className = "status-text err";
        delBtn.disabled = false;
        return;
      }
      await refreshSyncAndSnapshotsUI();
    });
  }

  const renderDefaultActions = () => {
    if (delBtn) {
      actions.replaceChildren(tabsBtn, restoreBtn, delBtn);
    } else {
      actions.replaceChildren(tabsBtn, restoreBtn);
    }
  };

  restoreBtn.addEventListener("click", () => {
    actions.replaceChildren();
    const prompt = document.createElement("div");
    prompt.className = "restore-prompt";

    const winBtn = document.createElement("button");
    winBtn.type = "button";
    winBtn.className = "small";
    winBtn.textContent = snap.windowCount > 1 ? `Restore ${snap.windowCount} windows` : "New window";
    winBtn.addEventListener("click", async () => {
      winBtn.disabled = true;
      await runRestore(snap, "windows");
    });

    const curBtn = document.createElement("button");
    curBtn.type = "button";
    curBtn.className = "secondary small";
    curBtn.textContent = "Current window";
    curBtn.addEventListener("click", async () => {
      curBtn.disabled = true;
      await runRestore(snap, "current_window");
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary small";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", renderDefaultActions);

    prompt.append(winBtn, curBtn, cancelBtn);
    actions.appendChild(prompt);
  });

  renderDefaultActions();
  row.append(info, actions);
  item.append(row, tabsPanel);
  return item;
}

async function refreshSnapshotsUI(): Promise<void> {
  const snapshots = (await chrome.runtime.sendMessage({ type: "get_snapshots" })) as SnapshotListItem[];
  hasStoredSnapshots = Array.isArray(snapshots) && snapshots.length > 0;
  updateSnapshotsCardVisibility();
  snapshotList.replaceChildren();
  if (!hasStoredSnapshots) {
    const empty = document.createElement("div");
    empty.className = "snapshot-meta";
    empty.textContent = "No snapshots captured yet.";
    snapshotList.appendChild(empty);
    return;
  }

  const detailsCache = new Map<string, SessionSnapshot>();
  const deviceInfoById = new Map(syncedDevices.map((d) => [d.deviceId, d]));
  const ownSnapshots: SnapshotListItem[] = [];
  const otherGroups = new Map<string, SnapshotListItem[]>();

  for (const snap of snapshots) {
    const isOwn = !snap.deviceId || !currentDeviceId || snap.deviceId === currentDeviceId;
    if (isOwn) {
      ownSnapshots.push(snap);
    } else {
      const list = otherGroups.get(snap.deviceId!) ?? [];
      list.push(snap);
      otherGroups.set(snap.deviceId!, list);
    }
  }

  // Single-device view stays compact with no redundant group headings.
  if (otherGroups.size === 0) {
    for (const snap of ownSnapshots) {
      snapshotList.appendChild(buildSnapshotItemEl(snap, { showDeviceInRow: true, isOwn: true, detailsCache }));
    }
    return;
  }

  const allNamed = [
    ...syncedDevices,
    ...snapshots.map((s) => ({ deviceId: s.deviceId, deviceName: s.deviceName })),
  ];
  const duplicateNames = getDuplicateDeviceNames(allNamed);

  // Section 1: This browser
  const ownSection = document.createElement("div");
  ownSection.className = "snapshot-group";
  const ownHead = document.createElement("div");
  ownHead.className = "snapshot-group-head";
  const ownTitleWrap = document.createElement("div");
  const ownTitle = document.createElement("span");
  ownTitle.className = "snapshot-group-title";
  const ownName = lastSyncStatus?.deviceName ?? ownSnapshots[0]?.deviceName ?? "This browser";
  ownTitle.textContent = currentDeviceId
    ? formatDeviceDisplayName(currentDeviceId, ownName, duplicateNames)
    : ownName;
  const ownBadge = document.createElement("span");
  ownBadge.className = "snapshot-badge";
  ownBadge.textContent = "this browser";
  ownTitleWrap.append(ownTitle, ownBadge);

  const ownCount = document.createElement("span");
  ownCount.className = "snapshot-meta";
  ownCount.textContent = `${ownSnapshots.length} snapshot${ownSnapshots.length === 1 ? "" : "s"}`;
  ownHead.append(ownTitleWrap, ownCount);
  ownSection.appendChild(ownHead);

  if (ownSnapshots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "snapshot-meta snapshot-group-empty";
    empty.textContent = "No snapshots saved from this browser yet.";
    ownSection.appendChild(empty);
  } else {
    for (const snap of ownSnapshots) {
      ownSection.appendChild(buildSnapshotItemEl(snap, { showDeviceInRow: false, isOwn: true, detailsCache }));
    }
  }
  snapshotList.appendChild(ownSection);

  // Section 2+: Each other device/profile in its own section
  for (const [devId, groupSnaps] of otherGroups.entries()) {
    const devInfo = deviceInfoById.get(devId);
    const section = document.createElement("div");
    section.className = "snapshot-group";

    const head = document.createElement("div");
    head.className = "snapshot-group-head";
    const titleWrap = document.createElement("div");
    const title = document.createElement("span");
    title.className = "snapshot-group-title";
    const rawName = devInfo?.deviceName ?? groupSnaps[0]?.deviceName ?? devId;
    title.textContent = formatDeviceDisplayName(devId, rawName, duplicateNames);
    titleWrap.appendChild(title);

    if (devInfo?.isSameComputer) {
      const badge = document.createElement("span");
      badge.className = "snapshot-badge muted";
      badge.textContent = "same computer";
      titleWrap.appendChild(badge);
    }

    const meta = document.createElement("span");
    meta.className = "snapshot-meta";
    const lastActive = devInfo?.lastSeenAt ? `Last active ${formatSnapshotTime(devInfo.lastSeenAt)} · ` : "";
    meta.textContent = `${lastActive}${groupSnaps.length} snapshot${groupSnaps.length === 1 ? "" : "s"}`;
    head.append(titleWrap, meta);
    section.appendChild(head);

    for (const snap of groupSnaps) {
      section.appendChild(buildSnapshotItemEl(snap, { showDeviceInRow: false, isOwn: false, detailsCache }));
    }
    snapshotList.appendChild(section);
  }
}

async function init(): Promise<void> {
  installCmd.textContent = buildInstallCommand(chrome.runtime.id);
  setupShortcutEl.textContent = /Mac/i.test(navigator.platform) ? "Option+Shift+K" : "Alt+Shift+K";
  const [storedSetup, status] = await Promise.all([
    chrome.storage.local.get(SETUP_PENDING_KEY),
    chrome.runtime.sendMessage({ type: "get_status", includeTabs: false }) as Promise<StatusPayload>,
  ]);
  if (storedSetup[SETUP_PENDING_KEY] || new URLSearchParams(location.search).get("setup") === "1") {
    setupVisible = true;
  }
  lastMemory = status.memory;
  populateForm(status.config);
  renderUpdateCheckStatus(status);
  // Load sync status and device identity before rendering snapshots so ownership and grouping are accurate.
  await Promise.all([refreshPermissionsUI(), refreshSyncUI()]);
  await refreshSnapshotsUI();
  renderSetupCard();
}

function renderUpdateCheckStatus(status: StatusPayload): void {
  const version = chrome.runtime.getManifest().version;
  if (!status.config.checkForUpdates) {
    updateCheckStatus.textContent = `Automatic checks are off (installed v${version}).`;
    updateCheckStatus.className = "status-text";
    btnCopyUpdateOpt.classList.add("hidden");
    return;
  }
  const latest = status.updateAvailable?.latestVersion ?? status.updateStatus?.latestVersion ?? null;
  if (latest) {
    const dismissedNote = status.updateStatus?.dismissed ? " · popup banner dismissed" : "";
    updateCheckStatus.textContent = `Update available: v${latest} (installed v${version}${dismissedNote}).`;
    updateCheckStatus.className = "status-text ok";
    btnCopyUpdateOpt.classList.remove("hidden");
  } else if (status.updateStatus && status.updateStatus.checkedAt === null) {
    updateCheckStatus.textContent = `Update check pending (installed v${version}).`;
    updateCheckStatus.className = "status-text";
    btnCopyUpdateOpt.classList.add("hidden");
  } else {
    updateCheckStatus.textContent = `Up to date (v${version}).`;
    updateCheckStatus.className = "status-text";
    btnCopyUpdateOpt.classList.add("hidden");
  }
}

checkUpdates.addEventListener("change", async () => {
  const res = (await chrome.runtime.sendMessage({
    type: "save_config",
    config: { checkForUpdates: checkUpdates.checked },
  })) as { ok: boolean; config: TabReaperConfig };
  if (res?.ok) {
    const status = (await chrome.runtime.sendMessage({ type: "get_status", includeTabs: false })) as StatusPayload;
    renderUpdateCheckStatus(status);
  }
});

btnCopyUpdateOpt.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildQuickUpdateCommand());
    btnCopyUpdateOpt.textContent = "Copied";
    setTimeout(() => {
      btnCopyUpdateOpt.textContent = "Copy update command";
    }, 1800);
  } catch {
    btnCopyUpdateOpt.textContent = "Copy failed";
  }
});

memoryMode.addEventListener("change", syncBudgetVisibility);
form.addEventListener("input", syncResetButtons);
budgetFields.addEventListener("input", renderMemoryMode);
form.addEventListener("change", syncResetButtons);
enableSnapshots.addEventListener("change", () => {
  void saveSyncSnapshotSettings("enableSessionSnapshots");
});
snapshotIntervalMinutes.addEventListener("input", syncResetButtons);
snapshotIntervalMinutes.addEventListener("change", () => {
  void saveSyncSnapshotSettings("snapshotIntervalMinutes");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const before = Object.fromEntries(MAIN_FORM_KEYS.map(key => [key, JSON.stringify(fieldSpecs[key].read())]));
  const payload = readMainFormConfig();

  const res = (await chrome.runtime.sendMessage({ type: "save_config", config: payload })) as {
    ok: boolean;
    config: TabReaperConfig;
  };
  if (res?.ok) {
    displayedConfig = res.config;
    for (const key of MAIN_FORM_KEYS) {
      if (JSON.stringify(fieldSpecs[key].read()) === before[key]) writeFieldFrom(key, res.config);
    }
    syncBudgetVisibility();
    syncResetButtons();
    void refreshMemoryMode();
    void refreshPermissionsUI();
    saveStatus.textContent = "Saved.";
    saveStatus.className = "status-text ok";
  } else {
    saveStatus.textContent = "Failed to save settings.";
    saveStatus.className = "status-text err";
  }
});

btnCopyInstall.addEventListener("click", async () => {
  const cmd = installCmd.textContent ?? "";
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    btnCopyInstall.textContent = "Copied";
    setTimeout(() => {
      btnCopyInstall.textContent = "Copy";
    }, 1500);
  } catch {
    btnCopyInstall.textContent = "Copy failed";
  }
});

async function reloadToActivatePermission(): Promise<void> {
  await chrome.storage.local.set({ [REOPEN_OPTIONS_KEY]: true });
  chrome.runtime.reload();
}

btnNativePerm.addEventListener("click", async () => {
  const hasNative = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (hasNative) {
    await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    await refreshPermissionsUI();
    return;
  }
  const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
  if (granted) {
    const check = (await chrome.runtime.sendMessage({ type: "test_native_host" })) as {
      ok?: boolean;
      needsReload?: boolean;
    };
    if (check?.needsReload) {
      nativeStatus.textContent = "Activating native messaging...";
      nativeStatus.className = "status-text";
      await reloadToActivatePermission();
      return;
    }
  }
  await refreshPermissionsUI();
});

btnNativeTest.addEventListener("click", async () => {
  nativeStatus.textContent = "Testing native host...";
  nativeStatus.className = "status-text";
  const resp = (await chrome.runtime.sendMessage({ type: "test_native_host" })) as {
    ok: boolean;
    version?: string;
    platform?: string;
    error?: string;
    needsReload?: boolean;
  };
  if (resp?.needsReload) {
    nativeStatus.textContent = "Reloading extension to activate native messaging...";
    await reloadToActivatePermission();
    return;
  }
  if (resp?.ok) {
    setupNativeError = null;
    nativeStatus.textContent = `Connected: tab-reaper-host v${resp.version} (${resp.platform})`;
    nativeStatus.className = "status-text ok";
    await Promise.all([refreshMemoryMode(), refreshSyncAndSnapshotsUI()]);
  } else {
    nativeStatus.textContent = `Unavailable: ${resp?.error ?? "unknown error"}`;
    nativeStatus.className = "status-text err";
  }
});

btnSyncPick.addEventListener("click", async () => {
  btnSyncPick.disabled = true;
  await pickSyncFolderWithDialog();
  btnSyncPick.disabled = false;
});

btnSetupDismiss.addEventListener("click", async () => {
  setupVisible = false;
  setupCardEl.classList.add("hidden");
  await chrome.storage.local.remove(SETUP_PENDING_KEY);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(SETUP_PENDING_KEY in changes)) return;
  setupVisible = Boolean(changes[SETUP_PENDING_KEY]?.newValue);
  renderSetupCard();
});

btnSetupNative.addEventListener("click", async () => {
  btnSetupNative.disabled = true;
  setupNativeError = null;
  setupNativeStatus.textContent = "Connecting Local Companion...";
  setupNativeStatus.className = "status-text";
  try {
    const alreadyGranted = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    const granted = alreadyGranted || (await chrome.permissions.request({ permissions: ["nativeMessaging"] }));
    if (!granted) {
      setupNativeError = "Permission was not granted. You can enable it anytime below.";
      renderSetupCard();
      return;
    }
    const resp = (await chrome.runtime.sendMessage({ type: "test_native_host" })) as {
      ok?: boolean;
      error?: string;
      needsReload?: boolean;
    };
    if (resp?.needsReload) {
      setupNativeStatus.textContent = "Reloading extension to activate Local Companion...";
      await reloadToActivatePermission();
      return;
    }
    if (!resp?.ok) {
      setupNativeError = `Companion not found (${resp?.error ?? "unknown error"}). Run the Quick Install command or the command under Optional capabilities.`;
    }
    await Promise.all([refreshMemoryMode(), refreshPermissionsUI(), refreshSyncAndSnapshotsUI()]);
  } finally {
    btnSetupNative.disabled = false;
  }
});

btnSetupHost.addEventListener("click", async () => {
  btnSetupHost.disabled = true;
  try {
    const granted = await chrome.permissions.request(WEIGHTED_EVICTION_PERMS);
    if (granted && !chrome.scripting?.executeScript) {
      setupHostStatus.textContent = "Reloading extension to activate Weighted Eviction...";
      setupHostStatus.className = "status-text";
      await reloadToActivatePermission();
      return;
    }
    await refreshPermissionsUI();
  } finally {
    btnSetupHost.disabled = false;
  }
});

btnSyncApply.addEventListener("click", async () => {
  const path = syncFolderInput.value.trim();
  if (!path) return;
  btnSyncApply.disabled = true;
  await applySyncFolder(path);
  btnSyncApply.disabled = false;
});

btnSyncDisable.addEventListener("click", async () => {
  btnSyncDisable.disabled = true;
  await applySyncFolder(null);
  btnSyncDisable.disabled = false;
});

btnSyncNow.addEventListener("click", async () => {
  btnSyncNow.disabled = true;
  syncStatusEl.textContent = "Syncing...";
  syncStatusEl.className = "status-text";
  const res = (await chrome.runtime.sendMessage({ type: "sync_now" })) as {
    ok?: boolean;
    configUpdated?: boolean;
  };
  await refreshSyncAndSnapshotsUI();
  if (!res?.ok) {
    syncStatusEl.textContent = "Sync failed. Check folder connection, permissions, or disk space and try again.";
    syncStatusEl.className = "status-text err";
  }
  if (res?.configUpdated) {
    const status = (await chrome.runtime.sendMessage({ type: "get_status", includeTabs: false })) as StatusPayload;
    populateForm(status.config);
  }
  btnSyncNow.disabled = false;
});

btnDeviceName.addEventListener("click", async () => {
  const name = deviceNameInput.value.trim();
  if (!name) return;
  btnDeviceName.disabled = true;
  await chrome.runtime.sendMessage({ type: "set_device_name", deviceName: name });
  await refreshSyncAndSnapshotsUI();
  btnDeviceName.disabled = false;
});

btnHostPerm.addEventListener("click", async () => {
  const hasHost = await chrome.permissions.contains(WEIGHTED_EVICTION_PERMS);
  if (hasHost) {
    // Keep <all_urls> when Active upload detection still relies on host access.
    const keepOrigins = await chrome.permissions.contains({ permissions: ["webRequest"] });
    await chrome.permissions.remove(keepOrigins ? { permissions: ["scripting"] } : WEIGHTED_EVICTION_PERMS);
    await refreshPermissionsUI();
    return;
  }
  const granted = await chrome.permissions.request(WEIGHTED_EVICTION_PERMS);
  if (granted && !chrome.scripting?.executeScript) {
    hostStatus.textContent = "Activating weighted eviction...";
    hostStatus.className = "status-text";
    await reloadToActivatePermission();
    return;
  }
  await refreshPermissionsUI();
});

protectUploads.addEventListener("change", async () => {
  if (!protectUploads.checked) return;
  const hasUpload = await chrome.permissions.contains(UPLOAD_PROTECTION_PERMS);
  if (hasUpload) return;
  const granted = await chrome.permissions.request(UPLOAD_PROTECTION_PERMS);
  if (!granted) {
    protectUploads.checked = false;
    syncResetButtons();
    saveStatus.textContent = "Network request permission was not granted.";
    saveStatus.className = "status-text err";
    return;
  }
  if (!chrome.webRequest?.onBeforeRequest) {
    await chrome.runtime.sendMessage({ type: "save_config", config: { protectActiveUploads: true } });
    uploadStatus.textContent = "Activating upload detection...";
    uploadStatus.className = "status-text";
    await reloadToActivatePermission();
    return;
  }
  await refreshPermissionsUI();
  saveStatus.textContent = "Permission granted. Click Save settings to apply.";
  saveStatus.className = "status-text";
});

btnUploadPerm.addEventListener("click", async () => {
  const hasUpload = await chrome.permissions.contains(UPLOAD_PROTECTION_PERMS);
  if (hasUpload) {
    const keepOrigins = await chrome.permissions.contains({ permissions: ["scripting"] });
    await chrome.permissions.remove(keepOrigins ? { permissions: ["webRequest"] } : UPLOAD_PROTECTION_PERMS);
    const res = (await chrome.runtime.sendMessage({
      type: "save_config",
      config: { protectActiveUploads: false },
    })) as { ok?: boolean; config?: TabReaperConfig };
    if (res?.ok && res.config) {
      displayedConfig = res.config;
      writeFieldFrom("protectActiveUploads", res.config);
      syncResetButtons();
    }
    await refreshPermissionsUI();
    return;
  }
  const granted = await chrome.permissions.request(UPLOAD_PROTECTION_PERMS);
  if (!granted) {
    await refreshPermissionsUI();
    return;
  }
  const res = (await chrome.runtime.sendMessage({
    type: "save_config",
    config: { protectActiveUploads: true },
  })) as { ok?: boolean; config?: TabReaperConfig };
  if (res?.ok && res.config) {
    displayedConfig = res.config;
    writeFieldFrom("protectActiveUploads", res.config);
    syncResetButtons();
  }
  if (!chrome.webRequest?.onBeforeRequest) {
    uploadStatus.textContent = "Activating upload detection...";
    uploadStatus.className = "status-text";
    await reloadToActivatePermission();
    return;
  }
  await refreshPermissionsUI();
});

btnSaveSnapshot.addEventListener("click", async () => {
  btnSaveSnapshot.disabled = true;
  const label = snapshotLabelInput.value.trim() || undefined;
  const res = (await chrome.runtime.sendMessage({ type: "capture_snapshot_now", label })) as {
    ok?: boolean;
    snapshot?: SessionSnapshot;
    error?: string;
  };
  if (res?.ok && res.snapshot) {
    snapshotLabelInput.value = "";
    snapshotStatus.textContent = `Saved snapshot (${res.snapshot.tabCount} tabs).`;
    snapshotStatus.className = "status-text ok";
  } else {
    snapshotStatus.textContent = res?.error ?? "No http(s) tabs open to snapshot.";
    snapshotStatus.className = res?.error ? "status-text err" : "status-text";
  }
  await refreshSyncAndSnapshotsUI();
  btnSaveSnapshot.disabled = false;
});

btnClearSnapshots.addEventListener("click", async () => {
  btnClearSnapshots.disabled = true;
  await chrome.runtime.sendMessage({ type: "clear_snapshots" });
  snapshotStatus.textContent = "Cleared saved snapshots.";
  snapshotStatus.className = "status-text ok";
  await refreshSyncAndSnapshotsUI();
  btnClearSnapshots.disabled = false;
});

void init();
