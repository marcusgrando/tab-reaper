# Tab Reaper — Architecture

## Purpose

A Chrome Manifest V3 extension that keeps browser RAM bounded with memory-banded tab discarding, speeds up Chrome startup, and provides conflict-free session backup through optional Folder Sync.

## Design Constraints and Feasibility

Every capability below has been validated against stable Chrome Manifest V3 APIs.

| Requirement | Mechanism | Status | Hard Platform Limit |
| --- | --- | --- | --- |
| Enforce Chrome RAM budget (default `totalRAM / 2`) | **Primary (local):** Optional Native Messaging Host reads real Chrome PSS/RSS from `/proc` (Linux), `proc_pid_rusage` `phys_footprint` (macOS, matching Activity Monitor), or Win32 `K32GetProcessMemoryInfo` (Windows). **Fallback (extension-only):** system memory pressure from `chrome.system.memory` `availableCapacity`, with per-OS thresholds and no budget. | Feasible | Stable Chrome has no per-process or per-tab RAM API (`chrome.processes` is dev-only and deprecated). Exact Chrome-only GB caps require the optional Native Host. |
| Memory-banded discarding (`idleEvictionPercent` / `sizeEvictionPercent`, defaults `80%` / `100%`) | Periodic `chrome.alarms` sweep and event-driven checks using `chrome.tabs.discard()`. | Feasible | Tabs sharing a SiteInstance renderer only release the OS process when all tabs in that origin are discarded. |
| Evict heaviest tabs first at the configured size threshold | On-demand `chrome.scripting.executeScript` samples `performance.memory.usedJSHeapSize`, DOM node count, and `iframe`/`canvas`/`video` count. | Feasible | `usedJSHeapSize` measures V8 heap only (excludes GPU textures, decoded images, cross-origin iframes). Restricted pages (`chrome://`, Web Store) and disabled Weighted Eviction fall back to oldest idle first. |
| Fast, low-memory Chrome startup | `chrome.runtime.onStartup` immediately discards non-protected background tabs (`startupSweep`, default `true`). Only profiles with page access and form protection enabled register an edit observer. | Feasible | Chrome controls the first ~100-300 ms before the service worker wakes. |
| Protect active, audible, pinned, kept, unsaved-form, and allowlisted tabs | Filter `tab.active`, `tab.audible`, `tab.pinned`, kept state, unsaved form edits, and user domain allowlist before discard. | Feasible | `tabId` resets on browser restart, so `lastActiveAt` is persisted in `chrome.storage.local` and reconciled by URL on startup. |
| Fast open-tabs palette | `chrome.commands` (`Alt+Shift+K`) opens the Tab Reaper open-tabs palette focused on search. | Feasible | None. |
| Conflict-free session snapshots | Gated on optional Folder Sync via the local companion (`com.tabreaper.host`). Captures windows, tab order, pinned/kept state, and tab groups. | Feasible | Requires installing the optional native host and selecting a sync folder. |

## Tab Lifecycle

Every non-protected tab moves between two states:

1. **Active (Loaded):** Running in RAM.
2. **Discarded:** `chrome.tabs.discard(tabId)` destroys the renderer process while keeping the tab stub, title, favicon, and session history in the tab strip.

Tab Reaper does not close or archive tabs to bookmarks.

## Memory and Eviction Engine

### Memory-Banded Eviction

An eviction sweep runs on:
- `chrome.runtime.onStartup` (immediate startup sweep when `startupSweep` is enabled, default `true`)
- `chrome.alarms` every 30 seconds (memory budget check)
- Tab creation and activation (memory check only, with no scheduled backup or folder sync)

With the Native Host, periodic sweeps evaluate Chrome's memory as a percentage of `memoryBudgetBytes`. Without it, the bands follow system memory pressure (see Memory Measurement Modes):

1. **Below `idleEvictionPercent` (default `80%`) of budget:** No background tabs are discarded by periodic sweeps.
2. **From `idleEvictionPercent` up to but excluding `sizeEvictionPercent` (defaults 80% and 100%).** Each pass discards up to two eligible tabs in least-recently-used order, regardless of how recently they were used.
3. **At or above `sizeEvictionPercent` (default `100%`) of budget:** Discards heaviest loaded tabs first (by JS heap, DOM node count, and media weight) when optional Weighted Eviction is enabled, falling back to oldest idle first when Weighted Eviction is disabled, up to 2 tabs per sweep pass.

On Chrome startup (`startupSweep`, default `true`), Tab Reaper still discards non-protected background tabs immediately so the browser starts with minimal RAM.

Each check reads memory again before selecting the next batch. Even after reaching the size threshold, eviction continues across checks until the reading falls below the lower threshold or no eligible tabs remain. The two-tab cap gives Chrome time to release discarded renderers between checks.

Chrome Memory Saver offers three levels with different inactivity periods. Tab Reaper uses explicit memory thresholds so a minimum idle time cannot prevent it from reclaiming memory under pressure. [Chrome Memory Saver](https://support.google.com/chrome/answer/12929150?hl=en)

### Memory Measurement Modes

1. **Exact Chrome RAM (Native Host connected):**
   - Extension calls `chrome.runtime.sendNativeMessage('com.tabreaper.host', { cmd: 'chrome_memory' })`.
   - Native host sums the memory of the browser that launched it: its parent process (past the `cmd.exe` Chrome interposes on Windows) and every descendant, excluding the host. Not by process name, because that also counts Canary, Chrome for Testing and other Chromium browsers. When the launching browser cannot be determined it returns `ok: false` and the extension uses the fallback below. Per-process metric: PSS (Linux `/proc/<pid>/smaps_rollup`, fallback to RSS), `phys_footprint` (macOS `proc_pid_rusage`), or Working Set (Windows `K32GetProcessMemoryInfo`), and returns `{ chromeBytes, systemTotalBytes, systemAvailableBytes }`.
   - Budget percentage is `chromeBytes / memoryBudgetBytes`.
2. **System memory pressure (extension only):**
   - Extension calls `chrome.system.memory.getInfo()`. `availableCapacity` is a different metric on each OS, so the thresholds are absolute free bytes per OS from `chrome.runtime.getPlatformInfo()`, not a share of the budget.
   - Windows uses Chrome's own default pressure thresholds on the same value (moderate at 1000 MiB, critical at 400 MiB). macOS leaves inactive and compressible pages out of `availableCapacity`, so a healthy 8 GiB Mac reports under 1 GiB. It uses 800/400 MiB as an approximation of the kernel pressure levels, which only native code can read. Linux uses 10% of RAM for moderate and 5% or 200 MiB for critical, following Firefox's low-memory rule. ChromeOS discards tabs under pressure itself, so memory-based eviction is off there.
   - Moderate pressure is the least-recently-used band and critical pressure is the size band. The budget and the band percentages do not apply.
   - Other apps can hold the memory, so discards may not relieve pressure. A pressure episode, kept in `chrome.storage.session`, allows four discards until free memory rises 128 MiB above the episode's baseline, and resets when pressure ends.
   - Not the budget against system-wide use: on an 8 GiB Mac that put nearly every background tab to sleep, because the OS normally uses more than 40% of RAM.
   - Settings and the palette show only what applies to the current mode, with live numbers.

### Weighted Eviction

When memory reaches the size threshold (default `100%` of budget) and optional Weighted Eviction (`scripting` + `<all_urls>`) is enabled, eligible loaded tabs are ranked heaviest first using an on-demand sample cached for 2 minutes in `chrome.storage.session`:
- `usedJSHeapSize` (MB) from `performance.memory`
- DOM node count (`document.getElementsByTagName('*').length`)
- Heavy media elements (`iframe`, `canvas`, `video` count)

Pages where scripting is disallowed receive default weight (`1.0`). When Weighted Eviction is disabled, the size band falls back to oldest idle first.

### Detecting pending edits

With `protectUnsavedForms` enabled and Weighted Eviction page access granted, Chrome loads an isolated content script at `document_start` in each accessible frame. Enabling protection also attaches it to loaded tabs. A frame asks the worker for access on its first trusted `focusin` or `beforeinput` on an eligible field, and again on the first one after Chrome restores the document from the back/forward cache. Loading a page sends no messages. The observer stops if access is denied, and it cannot reconstruct edits made before it starts.

Trusted edit events on visible text inputs, textareas and editable HTML count on every site. Native selections, toggles and other non-text inputs require a form owner. Search, navigation and toolbar controls and password fields are excluded. Before a field's first edit, the observer records a local fingerprint or selection. A keystroke only marks the field as edited. Reading the flag compares each edited field still in the document with its recording and clears the ones that match. This covers the user undoing an edit, a form reset, and a chat or e-mail app clearing its composer by script after sending. Removing an edited element leaves the document protected because an app can keep the draft while rebuilding its UI. A submission or silent autosave has no universal browser acknowledgment.

The palette and eviction planner read each frame's edit flag independently of the two-minute weight cache. A failed read can reuse the last positive result until the sample expires. The final discard check reads the live document again. Only the boolean crosses from a frame to the worker.

### Protections

A tab is never discarded if any enabled protection matches:
- `tab.active` (active tab in any window)
- `tab.audible` (currently playing audio)
- `tab.pinned` (pinned tab)
- `tab.kept` (explicitly kept by the user in the palette)
- Unsaved form edits (`protectUnsavedForms`, when Weighted Eviction is enabled)
- URL matches user allowlist (domain or glob pattern)
- Loading tabs (`tab.status === "loading"`)
- Internal browser pages (`chrome://`, `chrome-extension://`, `chrome-search://`, `devtools://`, `edge://`, `about:`)
- Offline state when `skipWhenOffline` is enabled (default `true`)

## Persistent Activity Tracking Across Restarts

Because Chrome reassigns all `tabId` values on restart and wipes `chrome.storage.session`:
- Active tab timestamps are stored in `chrome.storage.local` in two structures:
  - `byTabId[tabId] = { url, lastActiveAt }` for fast runtime lookups
  - `byUrl[normalizedUrl] = lastActiveAt` for restart reconciliation
- On `onStartup`, open tabs are matched against `byUrl` so tabs retain their recency order across browser restarts.

## Local Companion (Exact Chrome RAM + Folder Sync)

The optional Rust Native Messaging host (`native-host/`) serves both exact Chrome RAM reporting and conflict-free Folder Sync (session snapshots and settings) to any local or cloud-synced directory (iCloud Drive, Google Drive, OneDrive, Dropbox, Syncthing).

### Session Snapshots (Gated on Folder Sync)

Session snapshots are only active when Folder Sync is configured. When enabled, Tab Reaper supports:
- Automatic periodic captures on a configurable interval from `1` to `1440` minutes (up to 24 hours, default `5` minutes) under Settings -> Folder Sync.
- Window-close recovery snapshots (backed by `src/background/window-cache.ts` in `chrome.storage.session`).
- Pre-restore safety snapshots captured before restoring another snapshot.
- Manual on-demand snapshots with optional labels.

### Device Identity

Each Chrome profile has a stable `deviceId`. Its display name (`deviceName`) defaults to and follows the computer's hostname automatically. Users can set an optional override in Settings.

### Multi-Device Concurrency Model

During pre-release development, the extension supports one storage format at a time. Developers can start with fresh extension data and a new sync folder when that format changes.

Cloud-synced folders propagate files asynchronously, so distributed locks are unreliable and shared mutable files produce conflicted copies. To eliminate conflicts by construction, **every writable file is strictly single-writer per `deviceId`** under `devices/<deviceId>/`:

- `devices/<deviceId>/meta.json` — device identity (including `deviceName`) and last seen timestamp.
- Devices write settings to `devices/<deviceId>/config-v2.json`. The highest `updatedAt` wins, with `deviceId` breaking ties. This version applies to the whole configuration except `memoryBudgetMode` and `memoryBudgetGb`, which each device keeps, because a GB budget sized for one machine's RAM can stop discarding on a smaller one.
- `devices/<deviceId>/snapshots/<iso>_<id>.json` + `devices/<deviceId>/index.json` — full session snapshots (window geometry/state, tab index, pinned, kept, active, collapsed tab groups, and sanitized favicon URL) retained under a GFS policy (unlimited manual, 20 recent auto, 1/hour for 24h, 1/day for 30d). New captures record `complete` in the snapshot and index. Window-close captures and copies truncated to fit the local quota set it to `false`. Rotation keeps the newest complete session. In the sync folder, the replacement must be published in the index before the writer removes older files. Once a snapshot index spans multiple files, `index.json` points to overflow parts under `index-parts/<generation>-p<N>.json`. The writer publishes the manifest only after writing every part. A reader that cannot assemble the published generation retries without replacing the index.

Each native file request carries the directory selected at the start of the operation. The host checks it against the profile's approval in `host.json` while holding a shared lock on `host.lock`. Changing a profile's approval takes an exclusive lock through the atomic replacement of `host.json`. A request for a previous directory fails before accessing backup files. File operations use directory handles rooted at the approved path.

## Permissions and Distribution

- **Core permissions:** `tabs`, `storage`, `alarms`, `system.memory`, `tabGroups`.
- **Optional permissions (single-codebase Chrome Web Store compatibility):**
  - `optional_permissions`: `nativeMessaging` for exact Chrome process RAM reporting and Folder Sync via the local Rust host binary (`native-host/`), and `scripting` paired with `<all_urls>` for on-demand weight sampling and the optional form edit observer.
  - `optional_host_permissions`: `<all_urls>` for sampling and observing accessible pages. Users who skip granting page access fall back to oldest idle first ordering.
  - Both optional capabilities can be toggled with one click on the Options page, avoiding broad install-time permission warnings on the Chrome Web Store.

## Configuration Defaults

All values are user-configurable on the Options page:

| Setting | Default | Description |
| --- | --- | --- |
| `memoryBudgetMode` | `fraction` (`0.5`) | `memory / 2` of total system RAM, or explicit GB value (`fixed_gb`, default `4` GiB) |
| `idleEvictionPercent` | `80` | Budget percentage at which idle-tab discarding starts (`10` to `100`) |
| `sizeEvictionPercent` | `100` | Budget percentage at which size-based discarding starts (`10` to `100`, `>= idleEvictionPercent`) |
| `startupSweep` | `true` | Discard non-protected background tabs on Chrome startup |
| `protectActive` | `true` | Never discard active tabs |
| `protectAudible` | `true` | Never discard tabs playing audio |
| `protectPinned` | `true` | Never discard pinned tabs |
| `protectUnsavedForms` | `true` | Protect tabs with unsaved non-password form edits (when Weighted Eviction is enabled) |
| `skipWhenOffline` | `true` | Pause automatic discarding while offline |
| `enableSessionSnapshots` | `true` | Automatic session snapshots (active only when Folder Sync is configured) |
| `snapshotIntervalMinutes` | `5` | Automatic snapshot interval in minutes (`1` to `1440`, configurable under Folder Sync) |
| `allowlist` | `[]` | Domains or glob patterns excluded from discard |

## Project Layout

```text
tab-reaper/
├── ARCHITECTURE.md
├── PRIVACY.md
├── README.md
├── package.json              # Bun scripts (build, test, typecheck)
├── tsconfig.json
├── manifest.json             # MV3 manifest
├── src/
│   ├── background/
│   │   ├── index.ts          # Event listeners (tabs, alarms, startup, messages)
│   │   ├── eviction.ts       # Memory-banded eviction engine and protections
│   │   ├── sampler.ts        # On-demand scripting weight and form sampler
│   │   ├── memory.ts         # Native host client and chrome.system.memory fallback
│   │   ├── session.ts        # Session snapshot capture and restore
│   │   ├── window-cache.ts   # Session-storage window cache for window-close recovery
│   │   ├── badge.ts          # Extension toolbar badge state and formatting
│   │   ├── tracker.ts        # Persistent lastActiveAt and kept-tab tracking across restarts
│   │   ├── sync.ts           # Folder Sync barrel exports
│   │   └── sync/
│   │       ├── client.ts     # Native host Folder Sync RPC client and device identity
│   │       ├── config.ts     # Deterministic multi-device config sync
│   │       └── snapshots.ts  # Snapshot upload, sharded index, and GFS retention
│   ├── popup/                # Open-tabs command palette UI (keyboard-first search & stats)
│   ├── options/              # Configuration and Folder Sync UI
│   └── shared/               # Types, config defaults, URL normalization
├── native-host/              # Optional Rust native host (exact Chrome RAM + Folder Sync)
└── tests/                    # Functional and unit tests (Bun test runner)
```
