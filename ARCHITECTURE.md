# Tab Reaper — Architecture

## Purpose

A Chrome Manifest V3 extension that keeps browser RAM strictly bounded, speeds up Chrome startup, and automatically turns long-unused tabs into searchable bookmarks.

## Design Constraints and Feasibility

Every capability below has been validated against stable Chrome Manifest V3 APIs.

| Requirement | Mechanism | Status | Hard Platform Limit |
| --- | --- | --- | --- |
| Enforce Chrome RAM budget (default `totalRAM / 2`) | **Primary (local):** Optional Native Messaging Host reads real Chrome PSS/RSS from `/proc` (Linux) or `ps` (macOS). **Fallback (extension-only):** `chrome.system.memory` OS pressure (`availableCapacity`). | Feasible | Stable Chrome has no per-process or per-tab RAM API (`chrome.processes` is dev-only and deprecated). Exact Chrome-only GB caps require the optional Native Host. |
| Keep at most `X` loaded tabs (default `10`) | Event-driven `chrome.tabs.discard()` on `onActivated` / `onCreated` + `chrome.alarms` sweep. | Feasible | Tabs sharing a SiteInstance renderer only release the OS process when all tabs in that origin are discarded. |
| Evict heaviest tabs first | On-demand `chrome.scripting.executeScript` samples `performance.memory.usedJSHeapSize`, DOM node count, and `iframe`/`canvas`/`video` count. | Feasible | `usedJSHeapSize` measures V8 heap only (excludes GPU textures, decoded images, cross-origin iframes). Restricted pages (`chrome://`, Web Store) fall back to LRU. |
| Fast, low-memory Chrome startup | Auto-archive keeps open tab count low. `chrome.runtime.onStartup` immediately discards non-protected background tabs. Zero permanent `content_scripts` in manifest. | Feasible | Chrome controls the first ~100-300 ms before the service worker wakes. |
| Protect active, audible, and pinned tabs | Filter `tab.active`, `tab.audible`, `tab.pinned`, and user domain allowlist before discard/archive. | Feasible | None. |
| Auto-archive old tabs to both Bookmarks and extension UI | `chrome.tabs.remove()` + `chrome.bookmarks.create()` + rich index in `chrome.storage.local`. | Feasible | `tabId` resets on browser restart, so `lastActiveAt` must be persisted in `chrome.storage.local` and reconciled by URL on startup. |
| Fast recovery via shortcut and address bar | `chrome.commands` opens popup focused on search input. `chrome.omnibox` provides keyword search. Native Chrome address bar searches the synced bookmark folder. | Feasible | None. |

## Tab Lifecycle

Every non-protected tab moves through three stages:

1. **Active (Loaded):** In RAM. Count is capped at `maxActiveTabs` (default `10`) and total memory is capped at `memoryBudget` (default `systemRAM / 2`).
2. **Discarded:** `chrome.tabs.discard(tabId)` destroys the renderer process while keeping the tab stub, title, favicon, and session history in the tab strip.
3. **Archived (Auto-Bookmark):** After `archiveAfterHours` without activation (default `72` hours / 3 days), the tab is saved to the archive index and the Chrome bookmark folder, then closed via `chrome.tabs.remove(tabId)`.

## Memory and Eviction Engine

### Dual Cap Enforcement

An eviction sweep runs on:
- `chrome.runtime.onStartup` (immediate startup sweep)
- `chrome.tabs.onActivated` and `chrome.tabs.onCreated` (instant cap enforcement)
- `chrome.alarms` every 1 minute (idle timeout and memory budget check)

A sweep evicts eligible loaded tabs until **both** hold:
- `eligibleLoadedCount <= config.maxActiveTabs`
- `currentMemoryBytes <= config.memoryBudgetBytes`

To avoid over-discarding while Chrome asynchronously tears down a renderer process (~200-500 ms), memory-triggered sweeps discard at most 2 tabs per pass and re-check on the next tick (or after a short settle delay) instead of dumping all loaded tabs at once.

### Memory Measurement Modes

1. **Exact Chrome RAM (Native Host connected):**
   - Extension calls `chrome.runtime.sendNativeMessage('com.tabreaper.host', { cmd: 'chrome_memory' })`.
   - Native host sums PSS (Linux `/proc/<pid>/smaps_rollup`, fallback to RSS) across all Chrome processes (`chrome`, `chromium`, `google-chrome`) and returns `{ chromeBytes, systemTotalBytes, systemAvailableBytes }`.
   - Budget check compares `chromeBytes > memoryBudgetBytes`.
2. **OS Pressure Fallback (Pure Extension):**
   - Extension calls `chrome.system.memory.getInfo()`.
   - Uses `osUsedBytes = capacity - availableCapacity` against `memoryBudgetBytes` (or triggers aggressive cap reduction when `availableCapacity < capacity - memoryBudgetBytes`).
   - UI clearly indicates whether it is running in **Exact (Native Host)** or **System Memory (Extension-only)** mode.

### Weighted Eviction Score

When multiple eligible loaded tabs exist, candidates are ranked by:

```text
score = idleMinutes * weightMultiplier
```

Where `weightMultiplier` (1.0 to 5.0) is computed from an on-demand sample cached for 2 minutes in `chrome.storage.session`:
- `usedJSHeapSize` (MB) from `performance.memory`
- DOM node count (`document.getElementsByTagName('*').length`)
- Heavy media elements (`iframe`, `canvas`, `video` count)
- Optional domain weight overrides configured by the user

Pages where scripting is disallowed receive `weightMultiplier = 1.0` (pure LRU). No permanent content scripts are ever registered.

### Protections

A tab is never discarded or archived if any enabled protection matches:
- `tab.active` (active tab in any window)
- `tab.audible` (currently playing audio)
- `tab.pinned` (pinned tab)
- URL matches user allowlist (domain or glob pattern)
- Internal browser pages (`chrome://`, `chrome-extension://`, `edge://`, `about:`) are never archived.

## Persistent Activity Tracking Across Restarts

Because Chrome reassigns all `tabId` values on restart and wipes `chrome.storage.session`:
- Active tab timestamps are stored in `chrome.storage.local` in two structures:
  - `byTabId[tabId] = { url, lastActiveAt }` for fast runtime lookups
  - `byUrl[normalizedUrl] = lastActiveAt` for restart reconciliation
- On `onStartup`, open tabs are matched against `byUrl` so multi-day idle counters survive browser restarts accurately.

## Auto-Bookmark (Dual Storage)

Archived tabs live in two synchronized places:

1. **Extension Archive Index (`chrome.storage.local`):**
   - Stores `{ id, url, title, favIconUrl, groupTitle, groupColor, lastActiveAt, archivedAt, bookmarkId }`.
   - Powers the instant fuzzy-search popup (triggered via keyboard shortcut, e.g. `Alt+Shift+K`) and `chrome.omnibox` (`ar <query>`).
2. **Chrome Bookmark Folder (`chrome.bookmarks`):**
   - Dedicated folder under `Other Bookmarks` (configurable name, default `Auto-Archived Tabs`).
   - Automatically searchable from Chrome's native address bar and synced via Chrome Sync.

### Sync and Hygiene Invariants

- **Deduplication on archive:** If `normalizedUrl` already exists in the archive, update `archivedAt` and `lastActiveAt` instead of creating a duplicate bookmark.
- **Auto-cleanup on restore/visit:** Restoring from the popup/Omnibox or navigating to an archived URL removes the entry from both `chrome.storage.local` and the bookmark folder.
- **Two-way bookmark deletion:** `chrome.bookmarks.onRemoved` removes the matching record from `chrome.storage.local`.

## Permissions and Distribution

- **Core permissions:** `tabs`, `storage`, `alarms`, `bookmarks`, `system.memory`, `tabGroups`, `scripting`.
- **Optional permissions (single-codebase Chrome Web Store compatibility):**
  - `optional_permissions`: `nativeMessaging` for exact Chrome process RAM reporting via the local Rust host binary (`native-host/`). Users who do not install the native host automatically run in System Memory fallback mode.
  - `optional_host_permissions`: `<all_urls>` for on-demand tab weight sampling. Users who skip granting page access fall back to pure LRU ordering.
  - Both optional permissions can be toggled with one click on the Options page, avoiding broad install-time permission warnings on the Chrome Web Store.

## Configuration Defaults

All values are user-configurable on the Options page:

| Setting | Default | Description |
| --- | --- | --- |
| `memoryBudgetMode` | `fraction` (`0.5`) | `memory / 2` of total system RAM, or explicit GB value |
| `maxActiveTabs` | `10` | Maximum non-protected loaded tabs kept in RAM |
| `discardAfterMinutes` | `15` | Idle timeout before discarding a loaded tab |
| `archiveAfterHours` | `72` | Idle timeout (3 days) before closing and auto-bookmarking |
| `startupSweep` | `true` | Discard non-protected background tabs on Chrome startup |
| `protectActive` | `true` | Never discard/archive active tabs |
| `protectAudible` | `true` | Never discard/archive tabs playing audio |
| `protectPinned` | `true` | Never discard/archive pinned tabs |
| `bookmarkFolderName` | `Auto-Archived Tabs` | Target folder under Other Bookmarks |
| `allowlist` | `[]` | Domains/patterns excluded from discard and archive |

## Proposed Project Layout

```text
tab-reaper/
├── ARCHITECTURE.md
├── package.json              # Bun scripts (build, test, lint, typecheck)
├── tsconfig.json
├── manifest.json             # MV3 manifest
├── src/
│   ├── background/
│   │   ├── index.ts          # Event listeners (tabs, alarms, startup, bookmarks, omnibox)
│   │   ├── eviction.ts       # Dual-cap eviction engine + scoring
│   │   ├── sampler.ts        # On-demand scripting weight sampler
│   │   ├── memory.ts         # Native host client + chrome.system.memory fallback
│   │   ├── archive.ts        # Dual archive (storage.local + chrome.bookmarks) sync
│   │   └── tracker.ts        # Persistent lastActiveAt tracking across restarts
│   ├── popup/                # Fast Command Palette UI (keyboard-first search & stats)
│   ├── options/              # Configuration UI
│   └── shared/               # Types, config defaults, URL normalization
├── native-host/              # Optional lightweight Linux/macOS Chrome RAM reporter + installer
└── tests/                    # Functional/unit tests (Bun test runner)
```
