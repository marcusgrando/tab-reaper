# Privacy Policy — Tab Reaper

**Last updated:** 2026-11-22

Tab Reaper runs entirely on your device. It does not collect, transmit, sell, or share any personal data, browsing history, or telemetry with any server.

## Data Stored Locally

By default, all data used by Tab Reaper stays inside your browser profile:

- **Extension settings** (`chrome.storage.local`): your memory budget, eviction thresholds, snapshot interval, and protected domain allowlist.
- **Tab activity timestamps** (`chrome.storage.local`): last-active timestamps and URLs used to rank tabs by recent activity across browser restarts.
- **Local session snapshot cache** (`chrome.storage.local`, key `tabReaper.sessionSnapshots`): active only when Folder Sync is configured. Stores up to 5 recent auto snapshots (plus pending manual snapshots, capped at 1 MB total) of open `http(s)` tabs (URL, title, order, pinned/kept state, window state, and tab group metadata) captured on your configured interval (`1` to `1440` minutes, default `5`), before restores, on window close, and on manual save. Snapshots never sync via Chrome Sync and can be cleared at any time in Settings.
- **Window recovery cache** (`chrome.storage.session`): active only when Folder Sync and automatic snapshots are enabled. Keeps open tabs' URLs, titles, and window metadata in session storage to capture a closing window after the extension worker restarts.
- **Transient weight cache** (`chrome.storage.session`): short-lived numeric metrics (JS heap size, DOM node count, media element count) and the last observed edit flag cleared when Chrome closes.
- **Transient active upload state** (`chrome.storage.session`, key `tabReaper.activeUploads`): used only when optional Active upload detection is enabled. Stores only Chrome tab IDs, request IDs, and timestamps for in-flight uploads and short post-chunk cooldowns. Never stores URLs, headers, filenames, or request bodies, and clears automatically when disabled, revoked, or when Chrome closes.
- **Update check cache** (`chrome.storage.local`, key `tabReaper.updateState`): stores the timestamp, ETag, latest release tag/URL, and any dismissed version from the optional daily GitHub Releases check.

## Optional Folder Sync (Off by Default)

Session snapshots are gated on Folder Sync. If you install the optional Local Companion (`com.tabreaper.host`) **and** explicitly select a sync folder for this Chrome profile in Settings, Tab Reaper writes JSON files inside that user-chosen directory under `devices/<deviceId>/`:

- **Device metadata** (`meta.json`): device ID, device name (defaults to and follows the computer's hostname automatically, or uses your optional Settings override), and last seen timestamp.
- **Session snapshots** (`snapshots/*.json`, `index.json`, and `index-parts/*.json` for larger collections): retained with up to 20 recent, 24 hourly, 30 daily, and unlimited manual snapshots. Rotation keeps the newest whole-session backup. Automatic capture interval is configurable from `1` to `1440` minutes (default `5`).
- **Extension settings** include your configuration and domain allowlist in `config-v2.json`.

Tab Reaper makes no telemetry, analytics, or user-data requests. When automatic update checks are enabled (default, configurable in Settings), it makes one read-only request per day to `https://api.github.com/repos/marcusgrando/tab-reaper/releases/latest` using an ETag header to check the latest release tag. No personal data, extension settings, or browsing information is sent. If you choose a folder managed by an OS cloud client (such as iCloud Drive, Google Drive, OneDrive, Dropbox, or Syncthing), that provider replicates those files according to your own account settings and privacy policy. Each Chrome profile opts in independently via its own `deviceId`.

## Permissions

### Core Permissions

- `tabs`: list open tabs, discard inactive tabs to free RAM, and restore saved snapshots.
- `storage`: persist settings, activity timestamps, and the local session snapshot cache when Folder Sync is configured.
- `alarms`: run periodic memory, snapshot, and idle-tab checks in the background.
- `system.memory`: read total and available system RAM to react to system memory pressure without external software.
- `tabGroups`: preserve and restore tab group metadata for session snapshots.

### Optional Permissions (Off by Default)

- `nativeMessaging`: connects only to the local `com.tabreaper.host` binary if you choose to install it, to read exact numeric Chrome process memory totals and, only if you explicitly select a sync folder for this profile, read and write Tab Reaper backup files strictly inside that folder.
- `scripting` and `http://*/*` / `https://*/*` let Weighted Eviction measure heap size and count DOM and media elements. When form protection is also enabled, an isolated script in each accessible frame compares edits with the field's value before editing. It keeps a fingerprint or selection state in that document's memory and reports only whether an edit is pending. Password inputs are excluded. Field contents and fingerprints never leave the document. Disabling protection or revoking page access stops observation.
- `webRequest` and `http://*/*` / `https://*/*` (off by default) let optional Active upload detection observe HTTP `POST`, `PUT`, and `PATCH` metadata (`Content-Type`, `Content-Range`, `Upload-Offset`, `Content-Length`, and whether Chrome reports a file reference or body size >= 64 KiB) to pause sleeping during active transfers. Request contents, URLs, filenames, and headers are never logged, persisted, or transmitted. Disabling upload protection or revoking permission removes all listeners and clears transient state.

## Incognito Mode

Tab Reaper declares `"incognito": "not_allowed"` and does not run in or persist data from Incognito windows.

## Third Parties

Tab Reaper includes no analytics, crash reporters, or third-party SDKs. The only outbound network request is the optional daily check to GitHub Releases (`api.github.com`) to detect new versions, which can be turned off in Settings.

## Contact

Questions or issues can be filed at https://github.com/marcusgrando/tab-reaper/issues.
