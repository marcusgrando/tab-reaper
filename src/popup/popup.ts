import type { ArchivedTab, LoadedTabInfo, StatusPayload } from "../shared/types.ts";

type ActiveView = "loaded" | "archived";

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const listEl = document.getElementById("archive-list") as HTMLElement;
const memoryBadge = document.getElementById("memory-badge") as HTMLElement;
const memoryBar = document.getElementById("memory-bar") as HTMLElement;
const statLoaded = document.getElementById("stat-loaded") as HTMLElement;
const statDiscarded = document.getElementById("stat-discarded") as HTMLElement;
const statArchived = document.getElementById("stat-archived") as HTMLElement;
const tabLoadedBtn = document.getElementById("tab-loaded") as HTMLButtonElement;
const tabArchivedBtn = document.getElementById("tab-archived") as HTMLButtonElement;
const btnDiscard = document.getElementById("btn-discard") as HTMLButtonElement;
const btnArchive = document.getElementById("btn-archive") as HTMLButtonElement;
const btnOptions = document.getElementById("btn-options") as HTMLButtonElement;
const actionStatus = document.getElementById("action-status") as HTMLElement;

let activeView: ActiveView = "loaded";
let loadedTabs: LoadedTabInfo[] = [];
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

function filteredLoadedTabs(): LoadedTabInfo[] {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return loadedTabs;
  return loadedTabs.filter(
    (tab) => tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q),
  );
}

function setActiveView(view: ActiveView): void {
  activeView = view;
  selectedIndex = 0;
  tabLoadedBtn.classList.toggle("active", view === "loaded");
  tabLoadedBtn.setAttribute("aria-selected", String(view === "loaded"));
  tabArchivedBtn.classList.toggle("active", view === "archived");
  tabArchivedBtn.setAttribute("aria-selected", String(view === "archived"));
  searchInput.placeholder =
    view === "loaded"
      ? "Filter loaded tabs... (Enter to switch, Esc to close)"
      : "Search archived tabs... (Enter to open, Esc to close)";
  renderList();
}

async function refreshStatus(): Promise<StatusPayload> {
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  loadedTabs = status.loadedTabs ?? [];
  hasHostAccess = Boolean(status.permissions?.hostAccess);
  statLoaded.textContent = `${status.loadedCount} (cap ${status.config.maxActiveTabs})`;
  statDiscarded.textContent = String(status.discardedCount);
  statArchived.textContent = String(status.archivedCount);
  tabLoadedBtn.textContent = `Loaded (${status.loadedCount})`;
  tabArchivedBtn.textContent = `Archived (${status.archivedCount})`;

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

  if (activeView === "loaded") {
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
  if (activeView === "loaded") {
    renderLoadedTabs();
  } else {
    renderArchivedTabs();
  }
}

function renderLoadedTabs(): void {
  listEl.replaceChildren();
  const items = filteredLoadedTabs();
  selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = searchInput.value.trim() ? "No loaded tabs match your filter." : "No loaded tabs.";
    listEl.appendChild(empty);
    return;
  }

  if (!hasHostAccess) {
    const tip = document.createElement("div");
    tip.className = "tip-banner";
    tip.textContent = "Enable Weighted Eviction in Settings to see and sort by per-tab JS memory.";
    listEl.appendChild(tip);
  }

  items.forEach((tab, index) => {
    const row = document.createElement("div");
    row.className = `archive-item${index === selectedIndex ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedIndex));

    const main = document.createElement("div");
    main.className = "item-main";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = tab.title || tab.url;

    const metaParts: string[] = [];
    if (tab.jsHeapBytes && tab.jsHeapBytes > 0) {
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

    if (tab.isPwa) {
      const pwaPill = document.createElement("span");
      pwaPill.className = "pill pwa";
      pwaPill.textContent = "PWA";
      right.appendChild(pwaPill);
    }

    if (tab.protectedReason) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = tab.protectedReason;
      right.appendChild(pill);
    }

    if (tab.canDiscardManually && (!tab.protectedReason || tab.isPwa || tab.protectedReason === "Form")) {
      const discardBtn = document.createElement("button");
      discardBtn.className = "item-action";
      discardBtn.type = "button";
      discardBtn.title = "Discard this tab to free RAM";
      discardBtn.textContent = "Discard";
      discardBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        discardBtn.disabled = true;
        await chrome.runtime.sendMessage({ type: "discard_tab", tabId: tab.id });
        await refreshStatus();
      });
      right.appendChild(discardBtn);
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
      : "No archived tabs yet. Tabs idle beyond your archive threshold will appear here.";
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

tabLoadedBtn.addEventListener("click", () => setActiveView("loaded"));
tabArchivedBtn.addEventListener("click", () => {
  setActiveView("archived");
  void refreshArchive(searchInput.value);
});

searchInput.addEventListener("input", () => {
  selectedIndex = 0;
  if (activeView === "archived") {
    void refreshArchive(searchInput.value);
  } else {
    renderLoadedTabs();
  }
});

searchInput.addEventListener("keydown", async (event) => {
  const count = activeView === "loaded" ? filteredLoadedTabs().length : archivedItems.length;
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
    if (activeView === "loaded") {
      const target = filteredLoadedTabs()[selectedIndex];
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

function showActionStatus(text: string): void {
  actionStatus.textContent = text;
  actionStatus.classList.remove("hidden");
}

btnDiscard.addEventListener("click", async () => {
  btnDiscard.disabled = true;
  const res = (await chrome.runtime.sendMessage({ type: "discard_idle_now" })) as {
    discarded?: number;
    archived?: number;
  };
  await refreshStatus();
  showActionStatus(`Discarded ${res?.discarded ?? 0} tab(s).`);
  btnDiscard.disabled = false;
});

btnArchive.addEventListener("click", async () => {
  btnArchive.disabled = true;
  const res = (await chrome.runtime.sendMessage({ type: "archive_old_now" })) as {
    archived?: number;
    skippedProtected?: number;
    skippedNotDiscarded?: number;
    skippedNonHttp?: number;
    failed?: number;
  };
  await Promise.all([refreshStatus(), refreshArchive()]);
  const skippedParts: string[] = [];
  if (res?.skippedNotDiscarded) skippedParts.push(`${res.skippedNotDiscarded} still loaded`);
  if (res?.skippedProtected) skippedParts.push(`${res.skippedProtected} protected`);
  if (res?.skippedNonHttp) skippedParts.push(`${res.skippedNonHttp} internal/non-http`);
  if (res?.failed) skippedParts.push(`${res.failed} failed`);
  const detail = skippedParts.length > 0 ? ` (${skippedParts.join(", ")})` : "";
  showActionStatus(`Archived ${res?.archived ?? 0} discarded tab(s)${detail}.`);
  btnArchive.disabled = false;
});

btnOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  const [status] = await Promise.all([refreshStatus(), refreshArchive("")]);
  setActiveView(status.archivedCount > 0 ? "archived" : "loaded");
  searchInput.focus();
}

void init();
