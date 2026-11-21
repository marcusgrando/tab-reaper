# Privacy Policy — Tab Reaper

**Last updated:** 2026-11-21

Tab Reaper runs entirely on your device. It does not collect, transmit, sell, or share any personal data, browsing history, or telemetry with any server.

## Data Stored Locally

All data used by Tab Reaper stays inside your browser profile:

- **Extension settings** (`chrome.storage.local`): your memory budget, tab limits, timeouts, and protected domain allowlist.
- **Tab activity timestamps** (`chrome.storage.local`): last-active timestamps and URLs used to decide when an idle tab should be discarded or archived across browser restarts.
- **Archived tabs** (`chrome.storage.local` and `chrome.bookmarks`): titles, URLs, and favicon URLs of tabs archived by Tab Reaper. Bookmarks stored in your chosen folder follow your browser's own Chrome Sync settings if you have Chrome Sync enabled.
- **Local session snapshots** (`chrome.storage.local`, key `tabReaper.sessionSnapshots`): up to 5 recent snapshots (capped at 1 MB total) of open `http(s)` tabs (URL, title, pinned/kept state, window ID, and tab group title/color) captured locally every 5 minutes when tabs change for crash recovery. Snapshots never sync via Chrome Sync and can be disabled or cleared at any time in Settings.
- **Transient weight cache** (`chrome.storage.session`): short-lived numeric metrics (JS heap size, DOM node count, media element count) cleared when Chrome closes.

## Permissions

### Core Permissions

- `tabs`: list open tabs, discard inactive tabs to free RAM, close tabs after archiving, and restore saved snapshots.
- `storage`: persist settings, activity timestamps, local session snapshots, and the local archive index.
- `alarms`: run periodic memory, snapshot, and idle-tab checks in the background.
- `bookmarks`: save and remove archived tabs in your dedicated bookmark folder.
- `system.memory`: read total and available system RAM to enforce the memory budget without external software.
- `tabGroups`: preserve and restore tab group metadata for archived tabs and local session snapshots.

### Optional Permissions (Off by Default)

- `nativeMessaging`: connects only to the local `com.tabreaper.host` binary if you choose to install it, returning only numeric Chrome memory totals and OS RAM counters.
- `scripting` and `<all_urls>`: used only when you opt into Weighted Eviction to read numeric `performance.memory.usedJSHeapSize`, DOM element count, `iframe`/`canvas`/`video` counts, and a local boolean indicating whether visible non-password form inputs have unsaved edits. Password inputs (`type="password"`), cookies, and page text are never read, and no field values are ever stored or transmitted.

## Incognito Mode

Tab Reaper declares `"incognito": "not_allowed"` and does not run in or persist data from Incognito windows.

## Third Parties

Tab Reaper makes zero outbound network requests and includes no analytics, crash reporters, or third-party SDKs.

## Contact

Questions or issues can be filed at https://github.com/marcusgrando/tab-reaper/issues.
