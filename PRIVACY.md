# Privacy Policy — Tab Reaper

**Last updated:** 2026-11-21

Tab Reaper runs entirely on your device. It does not collect, transmit, sell, or share any personal data, browsing history, or telemetry with any server.

## Data Stored Locally

By default, all data used by Tab Reaper stays inside your browser profile:

- **Extension settings** (`chrome.storage.local`): your memory budget, tab limits, timeouts, and protected domain allowlist.
- **Tab activity timestamps** (`chrome.storage.local`): last-active timestamps and URLs used to decide when an idle tab should be discarded or archived across browser restarts.
- **Archived tabs** (`chrome.storage.local` and `chrome.bookmarks`): titles, URLs, and favicon URLs of tabs archived by Tab Reaper. Bookmarks stored in your chosen folder follow your browser's own Chrome Sync settings if you have Chrome Sync enabled.
- **Local session snapshots** (`chrome.storage.local`, key `tabReaper.sessionSnapshots`): up to 5 recent auto snapshots (plus pending manual snapshots, capped at 1 MB total) of open `http(s)` tabs (URL, title, order, pinned/kept state, window state, and tab group metadata) captured locally every 5 minutes when tabs change, before restores, and on window close for crash recovery. Snapshots never sync via Chrome Sync and can be disabled or cleared at any time in Settings.
- **Window recovery cache** (`chrome.storage.session`): while automatic snapshots are enabled, Tab Reaper keeps open tabs’ URLs, titles, and window metadata in session storage to capture a closing window after the extension worker restarts.
- **Transient weight cache** (`chrome.storage.session`): short-lived numeric metrics (JS heap size, DOM node count, media element count) cleared when Chrome closes.

## Optional Folder Sync (Off by Default)

If you install the optional Local Companion (`com.tabreaper.host`) **and** explicitly select a sync folder for this Chrome profile in Settings, Tab Reaper writes JSON files inside that user-chosen directory under `devices/<deviceId>/`:

- **Session snapshots** (`snapshots/*.json`, `index.json`, and `index-parts/*.json` for larger collections): retained with up to 20 recent, 24 hourly, 30 daily, and unlimited manual snapshots.
- **Extension settings** (`config.json`): your Tab Reaper configuration and allowlist.
- **Archived tabs and deletion markers** (`archive.json` and its generation-specific part files): archived tab metadata and the normalized URLs of deleted entries. Turning off Folder Sync clears the deletion markers from your browser profile. If a deletion had not reached the folder, the entry can reappear from another device when you turn sync back on.

Tab Reaper itself makes zero network requests. If you choose a folder managed by an OS cloud client (such as iCloud Drive, Google Drive, OneDrive, Dropbox, or Syncthing), that provider replicates those files according to your own account settings and privacy policy. Each Chrome profile opts in independently via its own `deviceId`.

## Permissions

### Core Permissions

- `tabs`: list open tabs, discard inactive tabs to free RAM, close tabs after archiving, and restore saved snapshots.
- `storage`: persist settings, activity timestamps, local session snapshots, and the local archive index.
- `alarms`: run periodic memory, snapshot, and idle-tab checks in the background.
- `bookmarks`: save and remove archived tabs in your dedicated bookmark folder.
- `system.memory`: read total and available system RAM to enforce the memory budget without external software.
- `tabGroups`: preserve and restore tab group metadata for archived tabs and local session snapshots.

### Optional Permissions (Off by Default)

- `nativeMessaging`: connects only to the local `com.tabreaper.host` binary if you choose to install it, to read exact numeric Chrome process memory totals and, only if you explicitly select a sync folder for this profile, read and write Tab Reaper backup files strictly inside that folder.
- `scripting` and `<all_urls>`: used only when you opt into Weighted Eviction to read numeric `performance.memory.usedJSHeapSize`, DOM element count, `iframe`/`canvas`/`video` counts, and a local boolean indicating whether visible non-password form inputs have unsaved edits. Password inputs (`type="password"`), cookies, and page text are never read, and no field values are ever stored or transmitted.

## Incognito Mode

Tab Reaper declares `"incognito": "not_allowed"` and does not run in or persist data from Incognito windows.

## Third Parties

Tab Reaper makes zero outbound network requests and includes no analytics, crash reporters, or third-party SDKs.

## Contact

Questions or issues can be filed at https://github.com/marcusgrando/tab-reaper/issues.
