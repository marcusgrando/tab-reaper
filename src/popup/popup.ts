import type { ArchivedTab, OpenTabInfo, StatusPayload } from "../shared/types.ts";

type ActiveView = "open" | "archived";

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const listEl = document.getElementById("archive-list") as HTMLElement;
const memoryBadge = document.getElementById("memory-badge") as HTMLElement;
const memoryBar = document.getElementById("memory-bar") as HTMLElement;
const statLoaded = document.getElementById("stat-loaded") as HTMLElement;
const statDiscarded = document.getElementById("stat-discarded") as HTMLElement;
const statArchived = document.getElementById("stat-archived") as HTMLElement;
const tabOpenBtn = document.getElementById("tab-open") as HTMLButtonElement;
const tabArchivedBtn = document.getElementById("tab-archived") as HTMLButtonElement;
const btnDiscard = document.getElementById("btn-discard") as HTMLButtonElement;
const btnOptions = document.getElementById("btn-options") as HTMLButtonElement;
const actionStatus = document.getElementById("action-status") as HTMLElement;
const recoveryBanner = document.getElementById("recovery-banner") as HTMLElement;
const recoveryText = document.getElementById("recovery-text") as HTMLElement;
const btnRestoreSession = document.getElementById("btn-restore-session") as HTMLButtonElement;

let recoverableSnapshotId: string | null = null;

const CLOSE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

let activeView: ActiveView = "open";
let openTabs: OpenTabInfo[] = [];
let archivedItems: ArchivedTab[] = [];
let hasHostAccess = false;
let selectedIndex = 0;

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

function showActionStatus(text: string): void {
  actionStatus.textContent = text;
  actionStatus.classList.remove("hidden");
}

function setActiveView(view: ActiveView): void {
  activeView = view;
  selectedIndex = 0;
  tabOpenBtn.classList.toggle("active", view === "open");
  tabOpenBtn.setAttribute("aria-selected", String(view === "open"));
  tabArchivedBtn.classList.toggle("active", view === "archived");
  tabArchivedBtn.setAttribute("aria-selected", String(view === "archived"));
  searchInput.placeholder =
    view === "open"
      ? "Filter open tabs... (Enter to switch, Esc to close)"
      : "Search archived tabs... (Enter to open, Esc to close)";
  renderList();
}

async function refreshStatus(): Promise<StatusPayload> {
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  openTabs = status.openTabs ?? [];
  hasHostAccess = Boolean(status.permissions?.hostAccess);
  statLoaded.textContent = `${status.loadedCount} (cap ${status.config.maxActiveTabs})`;
  statDiscarded.textContent = String(status.discardedCount);
  statArchived.textContent = String(status.archivedCount);
  tabOpenBtn.textContent = `Open (${openTabs.length})`;
  tabArchivedBtn.textContent = `Archived (${status.archivedCount})`;

  if (status.recoverableSnapshot) {
    recoverableSnapshotId = status.recoverableSnapshot.id;
    recoveryText.textContent = `Previous session saved (${status.recoverableSnapshot.tabCount} tabs · ${formatAge(status.recoverableSnapshot.capturedAt)})`;
    recoveryBanner.classList.remove("hidden");
  } else {
    recoverableSnapshotId = null;
    recoveryBanner.classList.add("hidden");
  }

  if (status.memory) {
    const modeLabel =
      status.memory.source === "native_host"
        ? status.memory.metric === "pss"
          ? "Chrome PSS"
          : "Chrome RAM"
        : "System RAM";
    const offlinePrefix = status.online ? "" : "Offline · ";
    memoryBadge.textContent = `${offlinePrefix}${formatGb(status.memory.usedBytes)} / ${formatGb(status.memory.budgetBytes)} (${modeLabel})`;
    memoryBadge.classList.toggle("over", status.memory.overBudget);

    const pct = Math.min(100, Math.round((status.memory.usedBytes / Math.max(1, status.memory.budgetBytes)) * 100));
    memoryBar.style.width = `${pct}%`;
    memoryBar.classList.toggle("over", status.memory.overBudget);
  }

  if (activeView === "open") {
    renderList();
  }
  return status;
}

async function refreshArchive(query = searchInput.value): Promise<void> {
  archivedItems = (await chrome.runtime.sendMessage({ type: "get_archive", query })) as ArchivedTab[];
  if (activeView === "archived") {
    selectedIndex = Math.min(selectedIndex, Math.max(0, archivedItems.length - 1));
    renderList();
  }
}

function renderList(): void {
  if (activeView === "open") {
    renderOpenTabs();
  } else {
    renderArchivedTabs();
  }
}

function renderOpenTabs(): void {
  listEl.replaceChildren();
  const items = filteredOpenTabs();
  selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = searchInput.value.trim() ? "No open tabs match your filter." : "No open tabs.";
    listEl.appendChild(empty);
    return;
  }

  if (!hasHostAccess) {
    const tip = document.createElement("div");
    tip.className = "tip-banner";
    tip.textContent = "Enable Weighted Eviction in Settings to see and sort by per-tab JS memory.";
    listEl.appendChild(tip);
  }

  const sleepingCount = items.filter((t) => t.discarded).length;
  let renderedSleepingHeader = false;

  items.forEach((tab, index) => {
    if (tab.discarded && !renderedSleepingHeader) {
      renderedSleepingHeader = true;
      const divider = document.createElement("div");
      divider.className = "section-divider";
      divider.textContent = `Sleeping (${sleepingCount})`;
      listEl.appendChild(divider);
    }

    const row = document.createElement("div");
    row.className = `archive-item${tab.discarded ? " sleeping" : ""}${index === selectedIndex ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedIndex));

    const main = document.createElement("div");
    main.className = "item-main";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = tab.title || tab.url;

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

    main.append(title, meta);

    row.addEventListener("click", async () => {
      await chrome.tabs.update(tab.id, { active: true });
      window.close();
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
        : "Keep this tab always loaded (never sleep or archive)";
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

    if (tab.canArchive) {
      const archiveBtn = document.createElement("button");
      archiveBtn.className = "item-action";
      archiveBtn.type = "button";
      archiveBtn.title = "Archive to bookmarks and close this tab";
      archiveBtn.textContent = "Archive";
      archiveBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        archiveBtn.disabled = true;
        const res = (await chrome.runtime.sendMessage({ type: "archive_tab", tabId: tab.id })) as { ok?: boolean };
        await Promise.all([refreshStatus(), refreshArchive()]);
        if (res?.ok) {
          showActionStatus(`Archived "${tab.title || extractHost(tab.url)}".`);
        }
      });
      right.appendChild(archiveBtn);
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
    listEl.appendChild(row);
  });
}

function renderArchivedTabs(): void {
  listEl.replaceChildren();

  if (archivedItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = searchInput.value.trim()
      ? "No archived tabs match your query."
      : "No archived tabs yet. Click Archive on any open tab to save it here and in Bookmarks.";
    listEl.appendChild(empty);
    return;
  }

  archivedItems.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `archive-item${index === selectedIndex ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedIndex));

    const main = document.createElement("div");
    main.className = "item-main";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title || item.url;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const groupPrefix = item.groupTitle ? `[${item.groupTitle}] ` : "";
    meta.textContent = `${groupPrefix}${item.url} · archived ${formatAge(item.archivedAt)}`;

    main.append(title, meta);

    const delBtn = document.createElement("button");
    delBtn.className = "item-delete";
    delBtn.type = "button";
    delBtn.title = "Delete from archive and bookmarks";
    delBtn.textContent = "x";
    delBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await chrome.runtime.sendMessage({ type: "delete_archived", id: item.id });
      await Promise.all([refreshArchive(), refreshStatus()]);
    });

    row.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "restore_archived", id: item.id });
      window.close();
    });

    row.append(main, delBtn);
    listEl.appendChild(row);
  });
}

tabOpenBtn.addEventListener("click", () => setActiveView("open"));
tabArchivedBtn.addEventListener("click", () => {
  setActiveView("archived");
  void refreshArchive(searchInput.value);
});

searchInput.addEventListener("input", () => {
  selectedIndex = 0;
  if (activeView === "archived") {
    void refreshArchive(searchInput.value);
  } else {
    renderOpenTabs();
  }
});

searchInput.addEventListener("keydown", async (event) => {
  const count = activeView === "open" ? filteredOpenTabs().length : archivedItems.length;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (count > 0) {
      selectedIndex = (selectedIndex + 1) % count;
      renderList();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (count > 0) {
      selectedIndex = (selectedIndex - 1 + count) % count;
      renderList();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (activeView === "open") {
      const target = filteredOpenTabs()[selectedIndex];
      if (target) {
        await chrome.tabs.update(target.id, { active: true });
        window.close();
      }
    } else {
      const target = archivedItems[selectedIndex];
      if (target) {
        await chrome.runtime.sendMessage({ type: "restore_archived", id: target.id });
        window.close();
      }
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

btnRestoreSession.addEventListener("click", async () => {
  if (!recoverableSnapshotId) return;
  btnRestoreSession.disabled = true;
  const res = (await chrome.runtime.sendMessage({
    type: "restore_snapshot",
    id: recoverableSnapshotId,
  })) as { restored?: number; skippedExisting?: number };
  await refreshStatus();
  showActionStatus(`Restored ${res?.restored ?? 0} tab(s) from previous session.`);
  btnRestoreSession.disabled = false;
});

async function init(): Promise<void> {
  await Promise.all([refreshStatus(), refreshArchive("")]);
  setActiveView("open");
  searchInput.focus();
}

void init();
