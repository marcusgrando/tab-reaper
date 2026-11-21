import type { MemoryBudgetMode, StatusPayload, TabReaperConfig } from "../shared/types.ts";

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
const bookmarkFolder = document.getElementById("bookmark-folder") as HTMLInputElement;
const allowlist = document.getElementById("allowlist") as HTMLTextAreaElement;
const saveStatus = document.getElementById("save-status") as HTMLElement;

const installCmd = document.getElementById("install-cmd") as HTMLElement;
const nativeStatus = document.getElementById("native-status") as HTMLElement;
const hostStatus = document.getElementById("host-status") as HTMLElement;
const btnNativePerm = document.getElementById("btn-native-perm") as HTMLButtonElement;
const btnNativeTest = document.getElementById("btn-native-test") as HTMLButtonElement;
const btnHostPerm = document.getElementById("btn-host-perm") as HTMLButtonElement;

function syncBudgetVisibility(): void {
  const isFixed = memoryMode.value === "fixed_gb";
  fractionWrap.classList.toggle("hidden", isFixed);
  fixedGbWrap.classList.toggle("hidden", !isFixed);
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
  bookmarkFolder.value = config.bookmarkFolderName;
  allowlist.value = config.allowlist.join("\n");
  syncBudgetVisibility();
}

async function refreshPermissionsUI(): Promise<void> {
  const [hasNative, hasHost] = await Promise.all([
    chrome.permissions.contains({ permissions: ["nativeMessaging"] }),
    chrome.permissions.contains({ origins: ["<all_urls>"] }),
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

async function init(): Promise<void> {
  installCmd.textContent = `./native-host/install.sh ${chrome.runtime.id}`;
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  populateForm(status.config);
  await refreshPermissionsUI();
}

memoryMode.addEventListener("change", syncBudgetVisibility);

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

btnNativePerm.addEventListener("click", async () => {
  const hasNative = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (hasNative) {
    await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
  } else {
    await chrome.permissions.request({ permissions: ["nativeMessaging"] });
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
  };
  if (resp?.ok) {
    nativeStatus.textContent = `Connected: tab-reaper-host v${resp.version} (${resp.platform})`;
    nativeStatus.className = "status-text ok";
  } else {
    nativeStatus.textContent = `Unavailable: ${resp?.error ?? "unknown error"}`;
    nativeStatus.className = "status-text err";
  }
});

btnHostPerm.addEventListener("click", async () => {
  const hasHost = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (hasHost) {
    await chrome.permissions.remove({ origins: ["<all_urls>"] });
  } else {
    await chrome.permissions.request({ origins: ["<all_urls>"] });
  }
  await refreshPermissionsUI();
});

void init();
