import {
  DEFAULT_CONFIG,
  MAX_DISCARDS_WITHOUT_RELIEF,
  REOPEN_OPTIONS_KEY,
  SETUP_PENDING_KEY,
  computeMemoryBudgetBytes,
  sanitizeConfig,
} from "../shared/config.ts";
import type {
  MemoryBudgetMode,
  MemorySnapshot,
  RestoreMode,
  SessionSnapshot,
  SnapshotListItem,
  StatusPayload,
  SyncFolderCandidate,
  SyncStatus,
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
const skipOffline = document.getElementById("skip-offline") as HTMLInputElement;
const enableSnapshots = document.getElementById("enable-snapshots") as HTMLInputElement;
const snapshotIntervalMinutes = document.getElementById("snapshot-interval-minutes") as HTMLInputElement;
const allowlist = document.getElementById("allowlist") as HTMLTextAreaElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;

const installCmd = document.getElementById("install-cmd") as HTMLElement;
const btnCopyInstall = document.getElementById("btn-copy-install") as HTMLButtonElement;
const nativeStatus = document.getElementById("native-status") as HTMLElement;
const hostStatus = document.getElementById("host-status") as HTMLElement;
const btnNativePerm = document.getElementById("btn-native-perm") as HTMLButtonElement;
const btnNativeTest = document.getElementById("btn-native-test") as HTMLButtonElement;
const btnHostPerm = document.getElementById("btn-host-perm") as HTMLButtonElement;
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
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
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
  skipWhenOffline: boolField(skipOffline, DEFAULT_CONFIG.skipWhenOffline),
  enableSessionSnapshots: boolField(enableSnapshots, DEFAULT_CONFIG.enableSessionSnapshots),
  snapshotIntervalMinutes: numberField(
    snapshotIntervalMinutes,
    DEFAULT_CONFIG.snapshotIntervalMinutes,
    `${DEFAULT_CONFIG.snapshotIntervalMinutes} min`,
  ),
  allowlist: linesField(allowlist, DEFAULT_CONFIG.allowlist),
};

const FIELD_KEYS = Object.keys(fieldSpecs) as ConfigKey[];
const SNAPSHOT_FIELD_KEYS = new Set<ConfigKey>(["enableSessionSnapshots", "snapshotIntervalMinutes"]);
const MAIN_FORM_KEYS = FIELD_KEYS.filter((key) => !SNAPSHOT_FIELD_KEYS.has(key));

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
  const [hasNative, hasHost] = await Promise.all([
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
    chrome.permissions.contains(WEIGHTED_EVICTION_PERMS),
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
    await Promise.all([refreshSyncUI(), refreshSnapshotsUI()]);
    if (path) {
      const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
      populateForm(status.config);
    }
  } else {
    syncStatusEl.textContent = `Error: ${res?.error ?? "failed to update sync folder"}`;
    syncStatusEl.className = "status-text err";
  }
}

let currentDeviceId: string | null = null;
let syncEnabledState = false;
let hasStoredSnapshots = false;

function updateSnapshotsCardVisibility(): void {
  snapshotsCardEl.classList.toggle("hidden", !syncEnabledState && !hasStoredSnapshots);
}

async function refreshSyncUI(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "get_sync_status" })) as SyncStatus;
  lastSyncStatus = status ?? null;
  currentDeviceId = status?.deviceId ?? null;
  if (!status?.hostConnected) {
    lastSyncCandidates = [];
    syncEnabledState = false;
    syncControlsEl.classList.add("hidden");
    syncSnapshotsConfigEl.classList.add("hidden");
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
    syncEnabledState = false;
    syncControlsEl.classList.add("hidden");
    syncSnapshotsConfigEl.classList.add("hidden");
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

  const candidates = (await chrome.runtime.sendMessage({ type: "detect_sync_folders" })) as SyncFolderCandidate[];
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
  await refreshSnapshotsUI();
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

  for (const snap of snapshots) {
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
    const devicePart = snap.deviceName ? ` · ${snap.deviceName}` : "";
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

    const isOwnSnapshot = !snap.deviceId || !currentDeviceId || snap.deviceId === currentDeviceId;

    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "secondary small";
    restoreBtn.textContent = "Restore";

    const delBtn = isOwnSnapshot ? document.createElement("button") : null;
    if (delBtn) {
      delBtn.type = "button";
      delBtn.className = "secondary small";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        await chrome.runtime.sendMessage({ type: "delete_snapshot", id: snap.id, syncDir: snap.syncDir });
        await refreshSnapshotsUI();
      });
    }

    const renderDefaultActions = () => {
      if (delBtn) {
        actions.replaceChildren(restoreBtn, delBtn);
      } else {
        actions.replaceChildren(restoreBtn);
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
    snapshotList.appendChild(row);
  }
}

async function init(): Promise<void> {
  installCmd.textContent = buildInstallCommand(chrome.runtime.id);
  setupShortcutEl.textContent = /Mac/i.test(navigator.platform) ? "Option+Shift+K" : "Alt+Shift+K";
  const [storedSetup, status] = await Promise.all([
    chrome.storage.local.get(SETUP_PENDING_KEY),
    chrome.runtime.sendMessage({ type: "get_status" }) as Promise<StatusPayload>,
  ]);
  if (storedSetup[SETUP_PENDING_KEY] || new URLSearchParams(location.search).get("setup") === "1") {
    setupVisible = true;
  }
  lastMemory = status.memory;
  populateForm(status.config);
  await Promise.all([refreshPermissionsUI(), refreshSyncUI(), refreshSnapshotsUI()]);
  renderSetupCard();
}

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
    await Promise.all([refreshMemoryMode(), refreshSyncUI()]);
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
    await Promise.all([refreshMemoryMode(), refreshPermissionsUI(), refreshSyncUI()]);
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
  await Promise.all([refreshSyncUI(), refreshSnapshotsUI()]);
  if (!res?.ok) {
    syncStatusEl.textContent = "Sync failed. Check folder connection, permissions, or disk space and try again.";
    syncStatusEl.className = "status-text err";
  }
  if (res?.configUpdated) {
    const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
    populateForm(status.config);
  }
  btnSyncNow.disabled = false;
});

btnDeviceName.addEventListener("click", async () => {
  const name = deviceNameInput.value.trim();
  if (!name) return;
  btnDeviceName.disabled = true;
  await chrome.runtime.sendMessage({ type: "set_device_name", deviceName: name });
  await refreshSyncUI();
  btnDeviceName.disabled = false;
});

btnHostPerm.addEventListener("click", async () => {
  const hasHost = await chrome.permissions.contains(WEIGHTED_EVICTION_PERMS);
  if (hasHost) {
    await chrome.permissions.remove(WEIGHTED_EVICTION_PERMS);
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
  await refreshSnapshotsUI();
  btnSaveSnapshot.disabled = false;
});

btnClearSnapshots.addEventListener("click", async () => {
  btnClearSnapshots.disabled = true;
  await chrome.runtime.sendMessage({ type: "clear_snapshots" });
  snapshotStatus.textContent = "Cleared saved snapshots.";
  snapshotStatus.className = "status-text ok";
  await refreshSnapshotsUI();
  btnClearSnapshots.disabled = false;
});

void init();
