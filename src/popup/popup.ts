import { buildQuickUpdateCommand } from "../shared/config.ts";
import type { MemoryPressure, OpenTabInfo, RestoreMode, StatusPayload, UpdateAvailableInfo } from "../shared/types.ts";

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const listEl = document.getElementById("tab-list") as HTMLElement;
const memoryBadge = document.getElementById("memory-badge") as HTMLElement;
const memorySource = document.getElementById("memory-source") as HTMLElement;
const memoryBar = document.getElementById("memory-bar") as HTMLElement;
const statLoaded = document.getElementById("stat-loaded") as HTMLElement;
const statDiscarded = document.getElementById("stat-discarded") as HTMLElement;
const btnDiscard = document.getElementById("btn-discard") as HTMLButtonElement;
const btnOptions = document.getElementById("btn-options") as HTMLButtonElement;
const actionStatus = document.getElementById("action-status") as HTMLElement;
const recoveryBanner = document.getElementById("recovery-banner") as HTMLElement;
const recoveryText = document.getElementById("recovery-text") as HTMLElement;
const btnRestoreSession = document.getElementById("btn-restore-session") as HTMLButtonElement;
const updateBanner = document.getElementById("update-banner") as HTMLElement;
const updateLink = document.getElementById("update-link") as HTMLAnchorElement;
const btnCopyUpdate = document.getElementById("btn-copy-update") as HTMLButtonElement;
const btnDismissUpdate = document.getElementById("btn-dismiss-update") as HTMLButtonElement;

let recoverableSnapshot: StatusPayload["recoverableSnapshot"] = null;
let updateAvailable: UpdateAvailableInfo | null = null;

const CLOSE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

let openTabs: OpenTabInfo[] = [];
// The tabs and rows of the last render, in display order.
let visibleTabs: OpenTabInfo[] = [];
let rows: HTMLElement[] = [];
let selectedIndex = 0;

const PRESSURE_LABELS: Record<MemoryPressure, string> = { normal: "Normal", moderate: "Moderate", critical: "Critical" };

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function formatAge(timestamp: number): string {
  const diffMin = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 48) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function formatIdle(idleMinutes: number): string {
  if (idleMinutes < 1) return "now";
  if (idleMinutes < 60) return `${idleMinutes}m idle`;
  const hours = Math.round(idleMinutes / 60);
  return `${hours}h idle`;
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function filteredOpenTabs(): OpenTabInfo[] {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return openTabs;
  return openTabs.filter(
    (tab) => tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q),
  );
}

async function activateTab(tabId: number): Promise<void> {
  const updated = await chrome.tabs.update(tabId, { active: true });
  if (typeof updated?.windowId === "number") {
    await chrome.windows.update(updated.windowId, { focused: true }).catch(() => {});
  }
  window.close();
}

function showActionStatus(text: string): void {
  actionStatus.textContent = text;
  actionStatus.classList.remove("hidden");
}

async function refreshStatus(): Promise<StatusPayload> {
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  openTabs = status.openTabs ?? [];
  statLoaded.textContent = String(status.loadedCount);
  statDiscarded.textContent = String(status.discardedCount);

  if (status.updateAvailable) {
    updateAvailable = status.updateAvailable;
    updateLink.textContent = `v${status.updateAvailable.latestVersion}`;
    updateLink.href = status.updateAvailable.releaseUrl;
    updateBanner.classList.remove("hidden");
  } else {
    updateAvailable = null;
    updateBanner.classList.add("hidden");
  }

  if (status.recoverableSnapshot) {
    recoverableSnapshot = status.recoverableSnapshot;
    const winSuffix =
      status.recoverableSnapshot.windowCount && status.recoverableSnapshot.windowCount > 1
        ? ` · ${status.recoverableSnapshot.windowCount} windows`
        : "";
    recoveryText.textContent = `Previous session saved (${status.recoverableSnapshot.tabCount} tabs${winSuffix} · ${formatAge(status.recoverableSnapshot.capturedAt)})`;
    recoveryBanner.classList.remove("hidden");
  } else {
    recoverableSnapshot = null;
    recoveryBanner.classList.add("hidden");
  }

  if (status.memory?.source === "system_memory") {
    // Without the Local Companion there is no budget to fill, only the system's pressure level.
    const pressure = status.memory.pressure ?? "normal";
    memorySource.textContent = status.online ? "System memory" : "System memory (offline)";
    memoryBadge.textContent = `${PRESSURE_LABELS[pressure]} · ${formatGb(status.memory.systemAvailableBytes)} free`;
    memoryBadge.classList.toggle("over", pressure === "critical");
    memoryBar.parentElement?.classList.add("hidden");
  } else if (status.memory) {
    const modeLabel = status.memory.metric === "pss" ? "Chrome PSS" : "Chrome RAM";
    memorySource.textContent = status.online ? modeLabel : `${modeLabel} (offline)`;
    memoryBadge.textContent = `${formatGb(status.memory.usedBytes)} / ${formatGb(status.memory.budgetBytes)} budget`;
    memoryBadge.classList.toggle("over", status.memory.overBudget);

    const pct = Math.min(100, Math.round((status.memory.usedBytes / Math.max(1, status.memory.budgetBytes)) * 100));
    memoryBar.parentElement?.classList.remove("hidden");
    memoryBar.style.width = `${pct}%`;
    memoryBar.classList.toggle("over", status.memory.overBudget);
  } else {
    memorySource.textContent = status.online ? "Memory usage" : "Memory usage (offline)";
    memoryBadge.textContent = "Unavailable";
    memoryBadge.classList.remove("over");
    memoryBar.style.width = "0%";
    memoryBar.classList.remove("over");
  }

  renderOpenTabs();
  return status;
}

function renderOpenTabs(): void {
  listEl.replaceChildren();
  const items = filteredOpenTabs();
  visibleTabs = items;
  rows = [];
  selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  if (items.length === 0) {
    searchInput.removeAttribute("aria-activedescendant");
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = searchInput.value.trim() ? "No open tabs match your filter." : "No open tabs.";
    listEl.appendChild(empty);
    return;
  }

  let group: HTMLDivElement;
  items.forEach((tab, index) => {
    if (items[index - 1]?.discarded !== tab.discarded) {
      const label = tab.discarded ? "Sleeping" : "Loaded";
      const heading = document.createElement("div");
      heading.className = "section-divider";
      heading.id = tab.discarded ? "sleeping-heading" : "loaded-heading";
      heading.textContent = label;
      group = document.createElement("div");
      if (tab.discarded) group.className = "sleeping-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-labelledby", heading.id);
      group.appendChild(heading);
      listEl.appendChild(group);
    }

    const row = document.createElement("div");
    row.className = `tab-item${tab.discarded ? " sleeping" : ""}${index === selectedIndex ? " selected" : ""}`;
    row.id = `tab-${tab.id}`;
    if (index === selectedIndex) searchInput.setAttribute("aria-activedescendant", row.id);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedIndex));

    const main = document.createElement("div");
    main.className = "item-main";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = tab.title || tab.url;
    title.title = title.textContent;

    const metaParts: string[] = [];
    if (tab.isPwa) {
      metaParts.push("PWA");
    }
    if (tab.discarded) {
      metaParts.push("Sleeping");
    } else if (tab.jsHeapBytes && tab.jsHeapBytes > 0) {
      metaParts.push(`JS ${formatMb(tab.jsHeapBytes)}`);
    }
    metaParts.push(extractHost(tab.url), formatIdle(tab.idleMinutes));
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = metaParts.join(" · ");
    if (tab.discarded) {
      meta.insertAdjacentHTML("afterbegin", '<svg class="icon" aria-hidden="true"><use href="ui.svg#moon"/></svg>');
    }

    main.append(title, meta);

    row.addEventListener("click", async () => {
      await activateTab(tab.id);
    });

    const right = document.createElement("div");
    right.className = "item-right";

    if (tab.protectedReason && tab.protectedReason !== "Kept") {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = tab.protectedReason;
      right.appendChild(pill);
    }

    if (tab.canKeep) {
      const keepBtn = document.createElement("button");
      keepBtn.className = `item-action${tab.kept ? " kept" : ""}`;
      keepBtn.type = "button";
      keepBtn.title = tab.kept
        ? "Stop keeping this tab always loaded"
        : "Keep this tab always loaded (never sleep)";
      keepBtn.textContent = tab.kept ? "Kept" : "Keep";
      keepBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        keepBtn.disabled = true;
        await chrome.runtime.sendMessage({ type: "toggle_keep_tab", tabId: tab.id });
        await refreshStatus();
      });
      right.appendChild(keepBtn);
    }

    if (tab.canSleep) {
      const sleepBtn = document.createElement("button");
      sleepBtn.className = "item-action";
      sleepBtn.type = "button";
      sleepBtn.title = "Put this tab to sleep now to free RAM";
      sleepBtn.textContent = "Sleep";
      sleepBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        sleepBtn.disabled = true;
        await chrome.runtime.sendMessage({ type: "discard_tab", tabId: tab.id });
        await refreshStatus();
      });
      right.appendChild(sleepBtn);
    }

    if (tab.canClose) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "item-close";
      closeBtn.type = "button";
      closeBtn.title = "Close tab";
      closeBtn.setAttribute("aria-label", "Close tab");
      closeBtn.innerHTML = CLOSE_ICON_SVG;
      closeBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        closeBtn.disabled = true;
        await chrome.runtime.sendMessage({ type: "close_tab", tabId: tab.id });
        await refreshStatus();
      });
      right.appendChild(closeBtn);
    }

    row.append(main, right);
    group.appendChild(row);
    rows.push(row);
  });
}

// Arrow keys only move the selection. Rebuilding every row costs tens of milliseconds per key with many tabs.
function moveSelection(next: number): void {
  const previous = rows[selectedIndex];
  previous?.classList.remove("selected");
  previous?.setAttribute("aria-selected", "false");
  selectedIndex = next;
  const row = rows[next];
  if (!row) return;
  row.classList.add("selected");
  row.setAttribute("aria-selected", "true");
  searchInput.setAttribute("aria-activedescendant", row.id);
  row.scrollIntoView({ block: "nearest" });
}

searchInput.addEventListener("input", () => {
  selectedIndex = 0;
  renderOpenTabs();
  listEl.scrollTop = 0;
});

searchInput.addEventListener("keydown", async (event) => {
  const count = visibleTabs.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count > 0) {
      const step = event.key === "ArrowDown" ? 1 : -1;
      moveSelection((selectedIndex + step + count) % count);
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    const target = visibleTabs[selectedIndex];
    if (target) {
      await activateTab(target.id);
    }
  } else if (event.key === "Escape") {
    window.close();
  }
});

btnDiscard.addEventListener("click", async () => {
  btnDiscard.disabled = true;
  const res = (await chrome.runtime.sendMessage({ type: "discard_idle_now" })) as {
    discarded?: number;
  };
  await refreshStatus();
  showActionStatus(`Put ${res?.discarded ?? 0} idle tab(s) to sleep.`);
  btnDiscard.disabled = false;
});

btnOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function executePopupRestore(mode: RestoreMode): Promise<void> {
  if (!recoverableSnapshot) return;
  const { id, relPath } = recoverableSnapshot;
  const res = (await chrome.runtime.sendMessage({
    type: "restore_snapshot",
    targetWindowId: (await chrome.windows.getCurrent()).id,
    relPath,
    id,
    mode,
  })) as { ok?: boolean; error?: string; restored?: number; skippedExisting?: number; windowsCreated?: number };
  await refreshStatus();
  if (!res?.ok) {
    showActionStatus(res?.error ?? "Restore failed. Try again.");
    return;
  }
  const winPart = res?.windowsCreated ? ` across ${res.windowsCreated} window(s)` : "";
  showActionStatus(`Restored ${res?.restored ?? 0} tab(s)${winPart} from previous session.`);
}

btnRestoreSession.addEventListener("click", () => {
  if (!recoverableSnapshot) return;
  const winCount = recoverableSnapshot.windowCount ?? 1;

  const existingChoice = recoveryBanner.querySelector(".recovery-choice");
  if (existingChoice) {
    existingChoice.remove();
    return;
  }

  btnRestoreSession.classList.add("hidden");
  const choice = document.createElement("div");
  choice.className = "recovery-choice";

  const winBtn = document.createElement("button");
  winBtn.type = "button";
  winBtn.className = "item-action";
  winBtn.textContent = winCount > 1 ? `Restore ${winCount} windows` : "New window";
  winBtn.addEventListener("click", async () => {
    winBtn.disabled = true;
    curBtn.disabled = true;
    await executePopupRestore("windows");
    choice.remove();
    btnRestoreSession.classList.remove("hidden");
  });

  const curBtn = document.createElement("button");
  curBtn.type = "button";
  curBtn.className = "item-action";
  curBtn.textContent = "Current window";
  curBtn.addEventListener("click", async () => {
    winBtn.disabled = true;
    curBtn.disabled = true;
    await executePopupRestore("current_window");
    choice.remove();
    btnRestoreSession.classList.remove("hidden");
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "item-action";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    choice.remove();
    btnRestoreSession.classList.remove("hidden");
  });

  choice.append(winBtn, curBtn, cancelBtn);
  recoveryBanner.appendChild(choice);
});

btnDismissUpdate.innerHTML = CLOSE_ICON_SVG;

btnCopyUpdate.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildQuickUpdateCommand());
    btnCopyUpdate.textContent = "Copied";
    showActionStatus("Update command copied. Run it in Terminal, then click Reload in chrome://extensions.");
    setTimeout(() => {
      btnCopyUpdate.textContent = "Copy update command";
    }, 1800);
  } catch {
    btnCopyUpdate.textContent = "Copy failed";
  }
});

btnDismissUpdate.addEventListener("click", async () => {
  if (!updateAvailable) return;
  const version = updateAvailable.latestVersion;
  updateAvailable = null;
  updateBanner.classList.add("hidden");
  await chrome.runtime.sendMessage({ type: "dismiss_update", version });
});

async function init(): Promise<void> {
  await refreshStatus();
  searchInput.focus();
}

void init();
