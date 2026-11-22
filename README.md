# Tab Reaper

Keep Chrome fast and bounded in RAM. Tab Reaper enforces a memory-banded RAM budget (`RAM / 2` by default), discards background tabs on startup, provides a keyboard-first open-tabs palette, and backs up sessions via optional Folder Sync.

Everything runs locally on your machine. No accounts, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md).

## How Memory-Banded Eviction Works

Tab Reaper requests a memory check every 30 seconds and checks again when you open or switch tabs. The default budget is half your system RAM.

- **Below the sleep threshold (default 80%).** Memory checks leave tabs loaded.
- **At or above the sleep threshold.** Each check puts up to two eligible tabs to sleep, starting with the least recently used. There is no minimum idle time.
- **At or above the size threshold (default 100%).** With Weighted Eviction enabled, the heaviest tabs go first. As usage drops below the size threshold, checks resume least-recently-used order until usage falls below the sleep threshold or all remaining tabs are protected. Both thresholds are configurable.
- **Chrome startup:** Non-protected background tabs are discarded immediately on startup (`startupSweep`, enabled by default).

With the extension alone, these percentages compare system-wide memory use with your budget. Other apps can keep usage above the target even after all eligible tabs sleep. The optional Local Companion measures Chrome memory separately.

Tab Reaper protects active, audible, pinned, kept, and allowlisted tabs by default. With Weighted Eviction page access and form protection enabled, the palette shows `Form` after an observed edit. A title or filter filled in by the page leaves the tab eligible for sleep. Undoing the edit in the same field clears its protection. An app that saves silently or replaces the edited field can keep the tab protected until reload.

## Quick Install (macOS, Linux, Windows)

One command downloads the extension into a permanent app folder (never `Downloads` or `/tmp`), pre-installs the optional native companion with your Extension ID already registered, and copies the extension folder path to your clipboard:

- **macOS / Linux (Terminal):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/install.sh | bash
  ```
- **Windows (PowerShell):**
  ```powershell
  irm https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/install.ps1 | iex
  ```

Then do the one-time Chrome step:
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and paste the path already copied to your clipboard (`Cmd+Shift+G` then `Cmd+V` on macOS).
3. *(Optional)* Open Tab Reaper **Settings** -> **Optional Capabilities** -> click **Enable** and **Test** next to **Exact Chrome RAM** (no extra command needed).

### Uninstall

- **macOS / Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/install.sh | bash -s -- --uninstall
  ```
- **Windows (PowerShell):**
  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/install.ps1))) -Uninstall
  ```

### Alternative: Chrome Web Store / Manual ZIP

- **Chrome Web Store:** Coming soon (`tab-reaper-extension.zip` is ready for submission).
- **Manual ZIP (extension only, no native host):** Download `tab-reaper-extension.zip` from the [latest GitHub Release](https://github.com/marcusgrando/tab-reaper/releases/latest), unzip to a permanent folder, and load via `chrome://extensions` -> **Developer mode** -> **Load unpacked**.

## Optional Capabilities

- **Exact Chrome RAM:** Measures exact Chrome process memory (PSS/RSS on Linux, `phys_footprint` on macOS, Working Set on Windows) instead of OS-wide RAM. Pre-installed by the Quick Install command above. If you installed via manual ZIP or CWS, copy the one-liner shown in Tab Reaper **Settings** -> **Optional Capabilities**.
- **Weighted Eviction:** In **Settings** -> **Optional Capabilities**, enable **Weighted Eviction** to discard heavier tabs (higher JS heap, DOM size, or media elements) first when memory reaches your size threshold (default `100%`). Memory measurements run on demand. Form protection uses the same permission and works without the Local Companion.
- **Folder Sync & Session Snapshots:** Choose any local or cloud-synced directory (iCloud Drive, Google Drive, OneDrive, Dropbox, Syncthing) in **Settings** -> **Folder Sync** to sync session snapshots (`snapshots/`, `index.json`, `index-parts/`) and settings (`config-v2.json`). Session snapshots (automatic periodic captures, window-close recovery, pre-restore safety snapshots, and manual saves) are active only when Folder Sync is configured. The automatic snapshot interval is configurable from `1` to `1440` minutes (default `5` minutes). Your device name defaults to and follows the computer's hostname automatically, and can be overridden in Settings.

## Shortcuts

- `Alt+Shift+K` (`Option+Shift+K` on macOS): Open the Tab Reaper open-tabs palette (configurable at `chrome://extensions/shortcuts`).

## Development

Requirements: [Bun](https://bun.sh) and [Rust](https://rustup.rs) (only needed to build the native host from source).

```bash
bun install
bun run typecheck
bun test
bun run build        # outputs unpacked extension to dist/
bun run package      # creates dist/tab-reaper-extension.zip
bun run test:rust    # runs native-host unit tests
bun x playwright-core install chromium --no-shell  # once for the UI test
bun run test:ui      # tests the unpacked extension in Chromium
```

To build and install the native host locally from source:

```bash
./native-host/install.sh --from-source <chrome-extension-id>
```

On Windows PowerShell:

```powershell
.\native-host\install.ps1 -FromSource <chrome-extension-id>
```

## License

[MIT](LICENSE)
