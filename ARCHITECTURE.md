# TabCurb — Architecture

## Purpose

A Chrome Manifest V3 extension that keeps browser RAM bounded with memory-banded tab discarding, speeds up Chrome startup, and provides conflict-free session backup through optional Folder Sync.

## Design Constraints and Feasibility

Every capability below has been validated against stable Chrome Manifest V3 APIs.

| Requirement | Mechanism | Status | Hard Platform Limit |
| --- | --- | --- | --- |
| Enforce Chrome RAM budget (default `totalRAM / 2`) | **Primary (local):** Optional Native Messaging Host reads real Chrome PSS/RSS from `/proc` (Linux), `proc_pid_rusage` `phys_footprint` (macOS, matching Activity Monitor), or Win32 `K32GetProcessMemoryInfo` (Windows). **Fallback (extension-only):** system memory pressure from `chrome.system.memory` `availableCapacity`, with per-OS thresholds and no budget. | Feasible | Stable Chrome has no per-process or per-tab RAM API (`chrome.processes` is dev-only and deprecated). Exact Chrome-only GB caps require the optional Native Host. |
| Memory-banded discarding (`idleEvictionPercent` / `sizeEvictionPercent`, defaults `80%` / `100%`) | Periodic `chrome.alarms` sweep and event-driven checks using `chrome.tabs.discard()`. | Feasible | Tabs sharing a SiteInstance renderer only release the OS process when all tabs in that origin are discarded. |
| Evict heaviest tabs first at the configured size threshold | **Primary (Local Companion):** Native host maps each renderer's `--renderer-client-id` to its OS memory (`PSS` on Linux, `phys_footprint` on macOS, `PrivateUsage` on Windows), matched against `chrome.webNavigation.getAllFrames()` `processId` without injecting scripts into pages. **Fallback (extension-only):** on-demand `chrome.scripting.executeScript` aggregates `performance.memory.usedJSHeapSize` (deduplicated per origin), DOM node count, and `iframe`/`canvas`/`video` count across frames. | Feasible | Shared GPU process VRAM is not split per tab (matching Chrome Task Manager). Without the Local Companion, `usedJSHeapSize` measures V8 heap only (excludes WASM, Workers, WebRTC buffers, GPU textures, decoded images), and restricted pages (`chrome://`, Web Store) fall back to oldest idle first. |
| Fast, low-memory Chrome startup | `chrome.runtime.onStartup` immediately discards non-protected background tabs (`startupSweep`, default `true`). Only profiles with page access and form protection enabled register an edit observer. | Feasible | Chrome controls the first ~100-300 ms before the service worker wakes. |
| Protect active, audible, pinned, kept, unsaved-form, and allowlisted tabs | Filter `tab.active`, `tab.audible`, `tab.pinned`, kept state, unsaved form edits, and user domain allowlist before discard. | Feasible | `tabId` resets on browser restart, so `lastActiveAt` is persisted in `chrome.storage.local` and reconciled by URL on startup. |
| Fast open-tabs palette | `chrome.commands` (`Alt+Shift+K`) opens the TabCurb open-tabs palette focused on search. | Feasible | None. |
| Conflict-free session snapshots | Gated on optional Folder Sync via the local companion (`com.tabcurb.host`). Captures windows, tab order, pinned/kept state, and tab groups. | Feasible | Requires installing the optional native host and selecting a sync folder. |

## Tab Lifecycle

Every non-protected tab moves between two states:

1. **Active (Loaded):** Running in RAM.
2. **Discarded:** `chrome.tabs.discard(tabId)` destroys the renderer process while keeping the tab stub, title, favicon, and session history in the tab strip.

TabCurb does not close or archive tabs to bookmarks.

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

On Chrome startup (`startupSweep`, default `true`), TabCurb still discards non-protected background tabs immediately so the browser starts with minimal RAM.

Each check reads memory again before selecting the next batch. Even after reaching the size threshold, eviction continues across checks until the reading falls below the lower threshold or no eligible tabs remain. The two-tab cap gives Chrome time to release discarded renderers between checks.

Chrome Memory Saver offers three levels with different inactivity periods. TabCurb uses explicit memory thresholds so a minimum idle time cannot prevent it from reclaiming memory under pressure. [Chrome Memory Saver](https://support.google.com/chrome/answer/12929150?hl=en)

### Memory Measurement Modes

1. **Exact Chrome RAM (Native Host connected):**
   - Extension calls `chrome.runtime.sendNativeMessage('com.tabcurb.host', { cmd: 'chrome_memory' })`.
   - Native host sums the memory of the browser that launched it: its parent process (past the `cmd.exe` Chrome interposes on Windows) and every descendant, excluding the host. Not by process name, because that also counts Canary, Chrome for Testing and other Chromium browsers. When the launching browser cannot be determined it returns `ok: false` and the extension uses the fallback below. Per-process metric: PSS (Linux `/proc/<pid>/smaps_rollup`, fallback to RSS), `phys_footprint` (macOS `proc_pid_rusage`), or Working Set for total Chrome RAM and `PrivateUsage` per renderer on Windows (`K32GetProcessMemoryInfo` with `PROCESS_MEMORY_COUNTERS_EX`), returning `{ chromeBytes, systemTotalBytes, systemAvailableBytes, renderers }`.
   - For each `--type=renderer` child in the browser tree, the host extracts `--renderer-client-id=<N>` from argv (Linux `/proc/<pid>/cmdline`, macOS `sysctl` `KERN_PROCARGS2` stopping after `argc` so `envp` is never read, Windows `NtQueryInformationProcess` `ProcessCommandLineInformation`) and returns only `{ [clientId]: bytes }`.
   - Budget percentage is `chromeBytes / memoryBudgetBytes`.
2. **System memory pressure (extension only):**
   - Extension calls `chrome.system.memory.getInfo()`. `availableCapacity` is a different metric on each OS, so the thresholds are absolute free bytes per OS from `chrome.runtime.getPlatformInfo()`, not a share of the budget.
   - Windows uses Chrome's own default pressure thresholds on the same value (moderate at 1000 MiB, critical at 400 MiB). macOS leaves inactive and compressible pages out of `availableCapacity`, so a healthy 8 GiB Mac reports under 1 GiB. It uses 800/400 MiB as an approximation of the kernel pressure levels, which only native code can read. Linux uses 10% of RAM for moderate and 5% or 200 MiB for critical, following Firefox's low-memory rule. ChromeOS discards tabs under pressure itself, so memory-based eviction is off there.
   - Moderate pressure is the least-recently-used band and critical pressure is the size band. The budget and the band percentages do not apply.
   - Other apps can hold the memory, so discards may not relieve pressure. A pressure episode, kept in `chrome.storage.session`, allows four discards until free memory rises 128 MiB above the episode's baseline, and resets when pressure ends.
   - Not the budget against system-wide use: on an 8 GiB Mac that put nearly every background tab to sleep, because the OS normally uses more than 40% of RAM.
   - Settings and the palette show only what applies to the current mode, with live numbers.

### Per-Tab Memory and Weighted Eviction

When memory reaches the size threshold (default `100%` of budget) or when opening the tab palette:

1. **OS renderer memory (primary, Local Companion connected):**
   - The extension queries `chrome.webNavigation.getAllFrames({ tabId })` for loaded tabs (no `http://*/*` / `https://*/*` host access or script injection required) and joins each frame's `processId` against the `renderers` map returned by `chrome_memory` (`--renderer-client-id` equals Chromium's `RenderProcessHost` ID).
   - **Shared renderer attribution:** A renderer hosting one or more active top-level frames (`frameId === 0`) splits its memory equally across those top-level tabs so an embedded iframe on another tab never steals memory credit from a top-level tab in the same SiteInstance. A renderer hosting only active subframes (an isolated cross-origin OOPIF) splits its memory across the embedding tabs. Live BFCache/prerender frames count only when no active frame owns that renderer.
   - **Reclaimability-aware eviction:** In the size band, tabs whose discard can free a renderer process (not pinned alive by a protected peer tab sharing that renderer) rank ahead of tabs whose shared renderer is kept alive by a protected peer. Not `chrome.debugger` or CDP remote debugging, because `chrome.debugger` displays a browser-wide debugging banner and CDP exposes full browser control.
2. **In-page fallback heuristics (without Local Companion or on older companions):**
   - When optional page access (`scripting` + `http://*/*` and `https://*/*`) is enabled, an on-demand sample cached for 2 minutes in `chrome.storage.session` aggregates across all accessible frames:
     - `usedJSHeapSize` from `performance.memory` (deduplicated per concrete origin to sum cross-origin iframes without double-counting same-origin or opaque `srcdoc`/`about:blank` frames)
     - DOM node count (`document.getElementsByTagName('*').length`)
     - Heavy media elements (`iframe`, `canvas`, `video` count)
   - Ranking uses a composite fallback weight (`jsHeapBytes + domNodes * 2 KiB + mediaNodes * 16 MiB`) so DOM/media-heavy tabs are not masked by small JS heap differences. Pages where scripting is disallowed receive default weight (`1.0`). When neither companion renderer data nor page access is available, the size band falls back to oldest idle first.

### Detecting pending edits

With `protectUnsavedForms` enabled and Weighted Eviction page access granted, Chrome loads an isolated content script at `document_start` in each accessible frame. Enabling protection also attaches it to loaded tabs. A frame asks the worker for access on its first trusted `focusin` or `beforeinput` on an eligible field, and again on the first one after Chrome restores the document from the back/forward cache. Loading a page sends no messages. The observer stops if access is denied, and it cannot reconstruct edits made before it starts.

Trusted edit events on visible text inputs, textareas and editable HTML count on every site. Native selections, toggles and other non-text inputs require a form owner. Search, navigation and toolbar controls and password fields are excluded. Before a field's first edit, the observer records a local fingerprint or selection. A keystroke only marks the field as edited. Reading the flag compares each edited field still in the document with its recording and clears the ones that match. This covers the user undoing an edit, a form reset, and a chat or e-mail app clearing its composer by script after sending. Removing an edited element leaves the document protected because an app can keep the draft while rebuilding its UI. A submission or silent autosave has no universal browser acknowledgment.

The palette and eviction planner read each frame's edit flag independently of the two-minute weight cache. A failed read can reuse the last positive result until the sample expires. The final discard check reads the live document again. Only the boolean crosses from a frame to the worker.

### Detecting active uploads (opt-in)

With `protectActiveUploads` enabled (off by default) and optional `webRequest` plus `http://*/*` and `https://*/*` access granted, the background service worker observes `POST`, `PUT`, and `PATCH` requests across `xmlhttprequest`, `main_frame`, `sub_frame`, and `other` resource types. Direct file references in `onBeforeRequest` (`requestBody.raw[].file`) protect the tab immediately. All other `POST`/`PUT` bodies are correlated with `onBeforeSendHeaders` by `requestId` so Chromium's `requestBody.error` marker (which fires for empty-string `""` bodies and `Blob`-wrapped JSON/text/form requests as well as real `Blob`/`file.slice()` chunks) and text-only `FormData` (`requestBody.formData` with `multipart/form-data`) are filtered using `Content-Type`. A request is flagged when it carries resumable upload headers (`Content-Range`, `Upload-Offset`, `application/offset+octet-stream`), non-text-only `multipart/form-data`, an opaque/Blob body whose `Content-Type` is omitted or not a text/JSON/form/protobuf API type, raw binary bytes of at least `64 KiB` (or `1 MiB` for text/JSON/form/protobuf payloads), or a `PATCH` request with no `Content-Type` and no small `Content-Length`. Small binary RPCs (`< 64 KiB` raw bytes), empty/text/JSON/protobuf requests, `GET` polling, SSE, and `ping` beacons are ignored so persistent connections do not block sleeping.

In-flight upload entries stay protected until response streaming starts (`onResponseStarted`), completion, error, tab removal, feature disable, or permission revocation. A 20-second post-completion cooldown bridges gaps between chunks in resumable uploads only on `2xx`/`3xx` responses (including `308 Resume Incomplete`), not on `4xx`/`5xx` or aborted requests. State is persisted in `chrome.storage.session` and orphaned entries for closed tabs are pruned on reconcile. This protection is off by default because Chrome's `webRequest` filter cannot filter by HTTP method, so enabling it wakes the service worker on background XHR/fetch traffic. It cannot observe uploads sent from Service Workers (`tabId: -1`), WebSockets, or WebRTC.

### Protections

A tab is never discarded if any enabled protection matches:
- `tab.active` (active tab in any window, or a companion pane visible in Split View)
- `tab.audible` (currently playing audio)
- `tab.pinned` (pinned tab)
- `tab.kept` (explicitly kept by the user in the palette)
- `tab.autoDiscardable === false` (tabs explicitly marked non-auto-discardable by Chrome or another extension)
- Screen-shared / mirrored background tabs (`!tab.active` while the top frame still reports `document.visibilityState === "visible"`, when page access is enabled). Not `chrome.tabCapture.getCapturedTabs()`, because it only reports extension-initiated captures, not web `getDisplayMedia()`.
- Picture-in-Picture tabs (`document.pictureInPictureElement` or `window.documentPictureInPicture.window`, when page access is enabled)
- Unsaved form edits (`protectUnsavedForms`, when Weighted Eviction is enabled)
- Active HTTP uploads (`protectActiveUploads`, off by default, when Active upload detection is enabled)
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

Session snapshots are only active when Folder Sync is configured. When enabled, TabCurb supports:
- Automatic periodic captures on a configurable interval from `1` to `1440` minutes (up to 24 hours, default `5` minutes) under Settings -> Folder Sync.
- Window-close recovery snapshots (backed by `src/background/window-cache.ts` in `chrome.storage.session`).
- Pre-restore safety snapshots captured before restoring another snapshot.
- Manual on-demand snapshots with optional labels.

### Device Identity

Each Chrome profile has a stable `deviceId`. Its display name (`deviceName`) defaults to and follows the computer's hostname automatically. Users can set an optional override in Settings.

### Multi-Device Concurrency Model

During pre-release development, the extension supports one storage format at a time. Developers can start with fresh extension data and a new sync folder when that format changes.

Cloud-synced folders propagate files asynchronously, so distributed locks are unreliable and shared mutable files produce conflicted copies. To eliminate conflicts by construction, **every writable file is strictly single-writer per `deviceId`** under `devices/<deviceId>/`:

- `devices/<deviceId>/meta.json` — device identity (including `deviceName`, optional `hostname` to identify earlier installs or other profiles on the same computer) and last seen timestamp.
- Devices write settings to `devices/<deviceId>/config-v2.json`. The highest `updatedAt` wins, with `deviceId` breaking ties. This version applies to the whole configuration except `memoryBudgetMode`, `memoryBudgetGb`, `weightedEviction`, and `protectActiveUploads`, which each device keeps, because a GB budget sized for one machine's RAM can stop discarding on a smaller one and `weightedEviction` / `protectActiveUploads` depend on per-browser optional permissions.
- `devices/<deviceId>/snapshots/<iso>_<id>.json` + `devices/<deviceId>/index.json` — full session snapshots (window geometry/state, tab index, pinned, kept, active, collapsed tab groups, and sanitized favicon URL) retained under a GFS policy (unlimited manual, 20 recent auto, 1/hour for 24h, 1/day for 30d). New captures record `complete` in the snapshot and index. Window-close captures and copies truncated to fit the local quota set it to `false`. Rotation keeps the newest complete session. In the sync folder, the replacement must be published in the index before the writer removes older files. Once a snapshot index spans multiple files, `index.json` points to overflow parts under `index-parts/<generation>-p<N>.json`. The writer publishes the manifest only after writing every part. A reader that cannot assemble the published generation retries without replacing the index.
- **Explicit device and snapshot management (`manage_devices` capability):** Routine writes and GFS rotation remain strictly single-writer per `deviceId`. From Settings, a user can inspect tabs inside any snapshot on demand, delete an individual snapshot belonging to another device (restricted by the host to `snapshots/`, `index.json`, and `index-parts/` only — never `config-v2.json` or `meta.json`), remove an unused device's folder (`sync_delete_device`, refusing symlinks and the current device), or resume an earlier install from the same computer by approving and switching to its `deviceId`, merging any temporary snapshots, and removing the temporary device folder.

Each native file request carries the directory selected at the start of the operation. The host checks it against the profile's approval in `host.json` while holding a shared lock on `host.lock`. Changing a profile's approval takes an exclusive lock through the atomic replacement of `host.json`. A request for a previous directory fails before accessing backup files. File operations use directory handles rooted at the approved path.

## Permissions and Distribution

- **Core permissions:** `tabs`, `storage`, `alarms`, `system.memory`, `tabGroups`, `webNavigation`.
- **Optional permissions (single-codebase Chrome Web Store compatibility):**
  - `optional_permissions`: `nativeMessaging` for exact Chrome and per-tab process RAM reporting and Folder Sync via the local Rust host binary (`native-host/`), `scripting` paired with `http://*/*` and `https://*/*` for unsaved form protection, live screen-sharing/PiP checks, and fallback in-page weight sampling without the companion, and `webRequest` paired with `http://*/*` and `https://*/*` for optional active upload detection (off by default).
  - `optional_host_permissions`: `http://*/*` and `https://*/*` for observing accessible web pages, fallback weight sampling, and optional upload detection.
  - Revoking one optional capability preserves `http://*/*` and `https://*/*` when another granted capability still requires it.
- **Extension isolation and hardening:**
  - `manifest.json` declares an explicit strict `content_security_policy.extension_pages` (`default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `connect-src https://api.github.com`), declares no `externally_connectable` and no `web_accessible_resources`, and sets `"incognito": "not_allowed"`.
  - Both `chrome.storage.local` and `chrome.storage.session` restrict access to `TRUSTED_CONTEXTS`.
  - `chrome.runtime.onMessage` enforces a fail-closed sender allowlist (matching extension ID, extension origin, top-level `popup.html` or `options.html` only) and validates message parameter types before dispatching.
  - Per-tab `chrome.scripting.executeScript` calls run with a 500 ms timeout so a hung renderer cannot stall sweeps, discarding, or the tab palette. When `allFrames` inspection times out, ranking and the tab palette fall back to the main frame (`frameIds: [0]`), and the final pre-discard check fails closed (skipping that tab for the pass) rather than discarding an unverified page with unsaved forms, PiP, or screen sharing. In-page inspection reads built-in DOM APIs via prototype descriptors and stores the form observer handle on a `Symbol` key so DOM clobbering cannot spoof protections or break observation.

## Configuration Defaults

All values are user-configurable on the Options page:

| Setting | Default | Description |
| --- | --- | --- |
| `memoryBudgetMode` | `fraction` (`0.5`) | `memory / 2` of total system RAM, or explicit GB value (`fixed_gb`, default `4` GiB) |
| `idleEvictionPercent` | `80` | Budget percentage at which idle-tab discarding starts (`10` to `100`) |
| `sizeEvictionPercent` | `100` | Budget percentage at which size-based discarding starts (`10` to `100`, `>= idleEvictionPercent`) |
| `startupSweep` | `true` | Discard non-protected background tabs on Chrome startup |
| `weightedEviction` | `true` | Rank heaviest tabs first at the size threshold when optional page access is granted (per device) |
| `protectActive` | `true` | Never discard active tabs |
| `protectAudible` | `true` | Never discard tabs playing audio |
| `protectPinned` | `true` | Never discard pinned tabs |
| `protectUnsavedForms` | `true` | Protect tabs with unsaved non-password form edits (when Weighted Eviction is enabled) |
| `protectActiveUploads` | `false` | Opt-in `webRequest` heuristic to protect tabs with active HTTP uploads (requires Active upload detection permission) |
| `skipWhenOffline` | `true` | Pause automatic discarding while offline |
| `enableSessionSnapshots` | `true` | Automatic session snapshots (active only when Folder Sync is configured) |
| `snapshotIntervalMinutes` | `5` | Automatic snapshot interval in minutes (`1` to `1440`, configurable under Folder Sync) |
| `allowlist` | `[]` | Domains or glob patterns excluded from discard |
| `checkForUpdates` | `true` | Daily read-only check against GitHub Releases for newer versions |

## Project Layout

```text
tabcurb/
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
│   │   ├── form-observer.ts  # Optional isolated-world form edit observer registration
│   │   ├── upload-observer.ts # Opt-in webRequest active upload heuristic
│   │   ├── process-memory.ts # OS renderer-to-tab attribution via webNavigation + Local Companion
│   │   ├── sampler.ts        # On-demand scripting fallback weight and live protection sampler
│   │   ├── memory.ts         # Native host client and chrome.system.memory fallback
│   │   ├── session.ts        # Session snapshot capture and restore
│   │   ├── window-cache.ts   # Session-storage window cache for window-close recovery
│   │   ├── badge.ts          # Extension toolbar badge state and formatting
│   │   ├── update.ts         # Daily GitHub Releases update check, ETag cache, and dismissal
│   │   ├── tracker.ts        # Persistent lastActiveAt and kept-tab tracking across restarts
│   │   ├── sync.ts           # Folder Sync barrel exports
│   │   └── sync/
│   │       ├── client.ts     # Native host Folder Sync RPC client and device identity
│   │       ├── config.ts     # Deterministic multi-device config sync
│   │       └── snapshots.ts  # Snapshot upload, sharded index, and GFS retention
│   ├── content/              # Isolated-world form edit observer (`form-observer.ts`)
│   ├── popup/                # Open-tabs command palette UI (keyboard-first search & stats)
│   ├── options/              # Configuration and Folder Sync UI
│   └── shared/               # Types, config defaults, URL normalization
├── native-host/              # Optional Rust native host (exact Chrome RAM + Folder Sync)
└── tests/                    # Functional and unit tests (Bun test runner)
```
