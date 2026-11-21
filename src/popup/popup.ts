import type { ArchivedTab, StatusPayload } from "../shared/types.ts";

const searchInput = document.getElementById("search-input") as HTMLInputElement;
const archiveList = document.getElementById("archive-list") as HTMLElement;
const memoryBadge = document.getElementById("memory-badge") as HTMLElement;
const memoryBar = document.getElementById("memory-bar") as HTMLElement;
const statLoaded = document.getElementById("stat-loaded") as HTMLElement;
const statDiscarded = document.getElementById("stat-discarded") as HTMLElement;
const statArchived = document.getElementById("stat-archived") as HTMLElement;
const btnDiscard = document.getElementById("btn-discard") as HTMLButtonElement;
const btnArchive = document.getElementById("btn-archive") as HTMLButtonElement;
const btnOptions = document.getElementById("btn-options") as HTMLButtonElement;

let currentItems: ArchivedTab[] = [];
let selectedIndex = 0;

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAge(timestamp: number): string {
  const diffMin = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 48) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

async function refreshStatus(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusPayload;
  statLoaded.textContent = `${status.loadedCount} (cap ${status.config.maxActiveTabs})`;
  statDiscarded.textContent = String(status.discardedCount);
  statArchived.textContent = String(status.archivedCount);

  if (status.memory) {
    const modeLabel = status.memory.source === "native_host" ? "Chrome PSS" : "System RAM";
    memoryBadge.textContent = `${formatGb(status.memory.usedBytes)} / ${formatGb(status.memory.budgetBytes)} (${modeLabel})`;
    memoryBadge.classList.toggle("over", status.memory.overBudget);

    const pct = Math.min(100, Math.round((status.memory.usedBytes / Math.max(1, status.memory.budgetBytes)) * 100));
    memoryBar.style.width = `${pct}%`;
    memoryBar.classList.toggle("over", status.memory.overBudget);
  }
}

async function refreshArchive(query = searchInput.value): Promise<void> {
  currentItems = (await chrome.runtime.sendMessage({ type: "get_archive", query })) as ArchivedTab[];
  selectedIndex = Math.min(selectedIndex, Math.max(0, currentItems.length - 1));
  renderArchive();
}

function renderArchive(): void {
  archiveList.replaceChildren();

  if (currentItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = searchInput.value.trim()
      ? "No archived tabs match your query."
      : "No archived tabs yet. Tabs idle beyond your archive threshold will appear here.";
    archiveList.appendChild(empty);
    return;
  }

  currentItems.forEach((item, index) => {
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
    archiveList.appendChild(row);
  });
}

searchInput.addEventListener("input", () => {
  selectedIndex = 0;
  void refreshArchive(searchInput.value);
});

searchInput.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (currentItems.length > 0) {
      selectedIndex = (selectedIndex + 1) % currentItems.length;
      renderArchive();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (currentItems.length > 0) {
      selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
      renderArchive();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    const target = currentItems[selectedIndex];
    if (target) {
      await chrome.runtime.sendMessage({ type: "restore_archived", id: target.id });
      window.close();
    }
  } else if (event.key === "Escape") {
    window.close();
  }
});

btnDiscard.addEventListener("click", async () => {
  btnDiscard.disabled = true;
  await chrome.runtime.sendMessage({ type: "discard_idle_now" });
  await refreshStatus();
  btnDiscard.disabled = false;
});

btnArchive.addEventListener("click", async () => {
  btnArchive.disabled = true;
  await chrome.runtime.sendMessage({ type: "archive_old_now" });
  await Promise.all([refreshStatus(), refreshArchive()]);
  btnArchive.disabled = false;
});

btnOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void Promise.all([refreshStatus(), refreshArchive()]);
searchInput.focus();
