import { DEFAULT_CONFIG } from "../shared/config.ts";
import type { MemoryBudgetMode, SessionSnapshot, StatusPayload, TabReaperConfig } from "../shared/types.ts";

const form = document.getElementById("settings-form") as HTMLFormElement;
const memoryMode = document.getElementById("memory-mode") as HTMLSelectElement;
const fractionWrap = document.getElementById("fraction-wrap") as HTMLElement;
const fixedGbWrap = document.getElementById("fixed-gb-wrap") as HTMLElement;
const memoryFraction = document.getElementById("memory-fraction") as HTMLInputElement;
const memoryGb = document.getElementById("memory-gb") as HTMLInputElement;
const maxActiveTabs = document.getElementById("max-active-tabs") as HTMLInputElement;
const discardMinutes = document.getElementById("discard-minutes") as HTMLInputElement;
const archiveHours = document.getElementById("archive-hours") as HTMLInputElement;
const startupSweep = document.getElementById("startup-sweep") as HTMLInputElement;
const protectActive = document.getElementById("protect-active") as HTMLInputElement;
const protectAudible = document.getElementById("protect-audible") as HTMLInputElement;
const protectPinned = document.getElementById("protect-pinned") as HTMLInputElement;
const protectForms = document.getElementById("protect-forms") as HTMLInputElement;
const skipOffline = document.getElementById("skip-offline") as HTMLInputElement;
const enableSnapshots = document.getElementById("enable-snapshots") as HTMLInputElement;
const bookmarkFolder = document.getElementById("bookmark-folder") as HTMLInputElement;
const allowlist = document.getElementById("allowlist") as HTMLTextAreaElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;

const installCmd = document.getElementById("install-cmd") as HTMLElement;
const btnCopyInstall = document.getElementById("btn-copy-install") as HTMLButtonElement;
const nativeStatus = document.getElementById("native-status") as HTMLElement;
const hostStatus = document.getElementById("host-status") as HTMLElement;
const btnNativePerm = document.getElementById("btn-native-perm") as HTMLButtonElement;
const btnNativeTest = document.getElementById("btn-native-test") as HTMLButtonElement;
const btnHostPerm = document.getElementById("btn-host-perm") as HTMLButtonElement;
const btnSaveSnapshot = document.getElementById("btn-save-snapshot") as HTMLButtonElement;
const btnClearSnapshots = document.getElementById("btn-clear-snapshots") as HTMLButtonElement;
const snapshotStatus = document.getElementById("snapshot-status") as HTMLElement;
const snapshotList = document.getElementById("snapshot-list") as HTMLElement;

function syncBudgetVisibility(): void {
  const isFixed = memoryMode.value === "fixed_gb";
  fractionWrap.classList.toggle("hidden", isFixed);
  fixedGbWrap.classList.toggle("hidden", !isFixed);
}

const UNDO_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';

type ConfigKey = keyof TabReaperConfig;

interface FieldBinding {
  isDefault: () => boolean;
  reset: () => void;
  defaultLabel: string;
}

const fieldBindings: Record<ConfigKey, FieldBinding> = {
  memoryBudgetMode: {
    isDefault: () => memoryMode.value === DEFAULT_CONFIG.memoryBudgetMode,
    reset: () => {
      memoryMode.value = DEFAULT_CONFIG.memoryBudgetMode;
      syncBudgetVisibility();
    },
    defaultLabel: "Fraction of system RAM",
  },
  memoryBudgetFraction: {
    isDefault: () => Number(memoryFraction.value) === DEFAULT_CONFIG.memoryBudgetFraction,
    reset: () => {
      memoryFraction.value = String(DEFAULT_CONFIG.memoryBudgetFraction);
    },
    defaultLabel: String(DEFAULT_CONFIG.memoryBudgetFraction),
  },
  memoryBudgetGb: {
    isDefault: () => Number(memoryGb.value) === DEFAULT_CONFIG.memoryBudgetGb,
    reset: () => {
      memoryGb.value = String(DEFAULT_CONFIG.memoryBudgetGb);
    },
    defaultLabel: `${DEFAULT_CONFIG.memoryBudgetGb} GB`,
  },
  maxActiveTabs: {
    isDefault: () => Number(maxActiveTabs.value) === DEFAULT_CONFIG.maxActiveTabs,
    reset: () => {
      maxActiveTabs.value = String(DEFAULT_CONFIG.maxActiveTabs);
    },
    defaultLabel: String(DEFAULT_CONFIG.maxActiveTabs),
  },
  discardAfterMinutes: {
    isDefault: () => Number(discardMinutes.value) === DEFAULT_CONFIG.discardAfterMinutes,
    reset: () => {
      discardMinutes.value = String(DEFAULT_CONFIG.discardAfterMinutes);
    },
    defaultLabel: `${DEFAULT_CONFIG.discardAfterMinutes} min`,
  },
  archiveAfterHours: {
    isDefault: () => Number(archiveHours.value) === DEFAULT_CONFIG.archiveAfterHours,
    reset: () => {
      archiveHours.value = String(DEFAULT_CONFIG.archiveAfterHours);
    },
    defaultLabel: `${DEFAULT_CONFIG.archiveAfterHours}h (7 days)`,
  },
  startupSweep: {
    isDefault: () => startupSweep.checked === DEFAULT_CONFIG.startupSweep,
    reset: () => {
      startupSweep.checked = DEFAULT_CONFIG.startupSweep;
    },
    defaultLabel: DEFAULT_CONFIG.startupSweep ? "enabled" : "disabled",
  },
  protectActive: {
    isDefault: () => protectActive.checked === DEFAULT_CONFIG.protectActive,
    reset: () => {
      protectActive.checked = DEFAULT_CONFIG.protectActive;
    },
    defaultLabel: DEFAULT_CONFIG.protectActive ? "enabled" : "disabled",
  },
  protectAudible: {
    isDefault: () => protectAudible.checked === DEFAULT_CONFIG.protectAudible,
    reset: () => {
      protectAudible.checked = DEFAULT_CONFIG.protectAudible;
    },
    defaultLabel: DEFAULT_CONFIG.protectAudible ? "enabled" : "disabled",
  },
  protectPinned: {
    isDefault: () => protectPinned.checked === DEFAULT_CONFIG.protectPinned,
    reset: () => {
      protectPinned.checked = DEFAULT_CONFIG.protectPinned;
    },
    defaultLabel: DEFAULT_CONFIG.protectPinned ? "enabled" : "disabled",
  },
  protectUnsavedForms: {
    isDefault: () => protectForms.checked === DEFAULT_CONFIG.protectUnsavedForms,
    reset: () => {
      protectForms.checked = DEFAULT_CONFIG.protectUnsavedForms;
    },
    defaultLabel: DEFAULT_CONFIG.protectUnsavedForms ? "enabled" : "disabled",
  },
  skipWhenOffline: {
    isDefault: () => skipOffline.checked === DEFAULT_CONFIG.skipWhenOffline,
    reset: () => {
      skipOffline.checked = DEFAULT_CONFIG.skipWhenOffline;
    },
    defaultLabel: DEFAULT_CONFIG.skipWhenOffline ? "enabled" : "disabled",
  },
  enableSessionSnapshots: {
    isDefault: () => enableSnapshots.checked === DEFAULT_CONFIG.enableSessionSnapshots,
    reset: () => {
      enableSnapshots.checked = DEFAULT_CONFIG.enableSessionSnapshots;
    },
    defaultLabel: DEFAULT_CONFIG.enableSessionSnapshots ? "enabled" : "disabled",
  },
  bookmarkFolderName: {
    isDefault: () => bookmarkFolder.value.trim() === DEFAULT_CONFIG.bookmarkFolderName,
    reset: () => {
      bookmarkFolder.value = DEFAULT_CONFIG.bookmarkFolderName;
    },
    defaultLabel: DEFAULT_CONFIG.bookmarkFolderName,
  },
  allowlist: {
    isDefault: () =>
      allowlist.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean).length === DEFAULT_CONFIG.allowlist.length,
    reset: () => {
      allowlist.value = DEFAULT_CONFIG.allowlist.join("\n");
    },
    defaultLabel: "empty",
  },
};

const resetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-reset]"));

for (const btn of resetButtons) {
  const key = btn.dataset.reset as ConfigKey | undefined;
  if (!key || !(key in fieldBindings)) continue;
  const binding = fieldBindings[key];
  btn.innerHTML = UNDO_ICON_SVG;
  const hint = `Reset to default (${binding.defaultLabel})`;
  btn.title = hint;
  btn.setAttribute("aria-label", hint);
  btn.addEventListener("click", () => {
    binding.reset();
    syncResetButtons();
  });
}

function syncResetButtons(): void {
  for (const btn of resetButtons) {
    const key = btn.dataset.reset as ConfigKey | undefined;
    if (!key || !(key in fieldBindings)) continue;
    btn.classList.toggle("hidden", fieldBindings[key].isDefault());
  }
}

function populateForm(config: TabReaperConfig): void {
  memoryMode.value = config.memoryBudgetMode;
  memoryFraction.value = String(config.memoryBudgetFraction);
  memoryGb.value = String(config.memoryBudgetGb);
  maxActiveTabs.value = String(config.maxActiveTabs);
  discardMinutes.value = String(config.discardAfterMinutes);
  archiveHours.value = String(config.archiveAfterHours);
  startupSweep.checked = config.startupSweep;
  protectActive.checked = config.protectActive;
  protectAudible.checked = config.protectAudible;
  protectPinned.checked = config.protectPinned;
  protectForms.checked = config.protectUnsavedForms;
  skipOffline.checked = config.skipWhenOffline;
  enableSnapshots.checked = config.enableSessionSnapshots;
  bookmarkFolder.value = config.bookmarkFolderName;
  allowlist.value = config.allowlist.join("\n");
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

async function refreshPermissionsUI(): Promise<void> {
  const [hasNative, hasHost] = await Promise.all([
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
    chrome.permissions.contains(WEIGHTED_EVICTION_PERMS),
  ]);

  btnNativePerm.textContent = hasNative ? "Revoke" : "Enable";
  nativeStatus.textContent = hasNative ? "Permission granted." : "Permission not granted (using System RAM fallback).";
  nativeStatus.className = `status-text ${hasNative ? "ok" : ""}`;

  btnHostPerm.textContent = hasHost ? "Revoke" : "Enable";
  hostStatus.textContent = hasHost
    ? "Enabled (weighted eviction active)."
    : "Disabled (using pure LRU eviction).";
  hostStatus.className = `status-text ${hasHost ? "ok" : ""}`;
}

function formatSnapshotTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

async function refreshSnapshotsUI(): Promise<void> {
  const snapshots = (await chrome.runtime.sendMessage({ type: "get_snapshots" })) as SessionSnapshot[];
  snapshotList.replaceChildren();
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
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
    count.textContent = `${snap.tabCount} tabs`;
    const meta = document.createElement("span");
    meta.className = "snapshot-meta";
    meta.textContent = ` · ${formatSnapshotTime(snap.capturedAt)}`;
    info.append(count, meta);

    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "secondary small";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", async () => {
      restoreBtn.disabled = true;
      snapshotStatus.textContent = "Restoring session...";
      snapshotStatus.className = "status-text";
      const res = (await chrome.runtime.sendMessage({ type: "restore_snapshot", id: snap.id })) as {
        ok?: boolean;
        restored?: number;
        skippedExisting?: number;
      };
      const skipped = res?.skippedExisting ? `, ${res.skippedExisting} already open` : "";
      snapshotStatus.textContent = `Restored ${res?.restored ?? 0} tab(s)${skipped}.`;
      snapshotStatus.className = "status-text ok";
      restoreBtn.disabled = false;
    });

    row.append(info, restoreBtn);
    snapshotList.appendChild(row);
  }
}

async function init(): Promise<void> {
  installCmd.textContent = buildInstallCommand(chrome.runtime.id);
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  populateForm(status.config);
  await Promise.all([refreshPermissionsUI(), refreshSnapshotsUI()]);
}

memoryMode.addEventListener("change", syncBudgetVisibility);
form.addEventListener("input", syncResetButtons);
form.addEventListener("change", syncResetButtons);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload: Partial<TabReaperConfig> = {
    memoryBudgetMode: memoryMode.value as MemoryBudgetMode,
    memoryBudgetFraction: Number(memoryFraction.value),
    memoryBudgetGb: Number(memoryGb.value),
    maxActiveTabs: Number(maxActiveTabs.value),
    discardAfterMinutes: Number(discardMinutes.value),
    archiveAfterHours: Number(archiveHours.value),
    startupSweep: startupSweep.checked,
    protectActive: protectActive.checked,
    protectAudible: protectAudible.checked,
    protectPinned: protectPinned.checked,
    protectUnsavedForms: protectForms.checked,
    skipWhenOffline: skipOffline.checked,
    enableSessionSnapshots: enableSnapshots.checked,
    bookmarkFolderName: bookmarkFolder.value.trim(),
    allowlist: allowlist.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };

  const res = (await chrome.runtime.sendMessage({ type: "save_config", config: payload })) as {
    ok: boolean;
    config: TabReaperConfig;
  };
  if (res?.ok) {
    populateForm(res.config);
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

const REOPEN_OPTIONS_KEY = "tabReaper.reopenOptions";

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
    nativeStatus.textContent = `Connected: tab-reaper-host v${resp.version} (${resp.platform})`;
    nativeStatus.className = "status-text ok";
  } else {
    nativeStatus.textContent = `Unavailable: ${resp?.error ?? "unknown error"}`;
    nativeStatus.className = "status-text err";
  }
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
  const res = (await chrome.runtime.sendMessage({ type: "capture_snapshot_now" })) as {
    ok?: boolean;
    snapshot?: SessionSnapshot;
  };
  if (res?.ok && res.snapshot) {
    snapshotStatus.textContent = `Saved snapshot (${res.snapshot.tabCount} tabs).`;
    snapshotStatus.className = "status-text ok";
  } else {
    snapshotStatus.textContent = "No http(s) tabs open to snapshot.";
    snapshotStatus.className = "status-text";
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
