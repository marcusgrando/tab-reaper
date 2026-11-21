# Tab Reaper

Keep Chrome fast and bounded in RAM. Tab Reaper enforces a strict memory budget (`RAM / 2` by default), caps loaded tabs (default `10`), discards background tabs immediately on startup, and archives long-unused tabs into both a fast keyboard palette and Chrome Bookmarks.

Everything runs locally on your machine. No accounts, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md).

## Install

### Option 1: Chrome Web Store (Recommended)

> Coming soon — `tab-reaper-extension.zip` is ready for Chrome Web Store submission.

### Option 2: Manual Install (No Developer Tools Needed)

Works on **macOS, Windows, and Linux** in Chrome, Chromium, and Brave:

1. Download **`tab-reaper-extension.zip`** from the [latest GitHub Release](https://github.com/marcusgrando/tab-reaper/releases/latest).
2. Unzip the file to a folder you will keep (for example, `Documents/tab-reaper`).
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.

Tab Reaper works immediately out of the box using Chrome's built-in memory API — no extra software required.

## Optional: Exact Chrome RAM (macOS, Linux, Windows)

By default, Chrome only exposes total system RAM to extensions. If you want Tab Reaper to measure **exact Chrome process memory** (PSS/RSS on Linux, RSS on macOS, Working Set on Windows), install the lightweight native helper (~300 KB, zero dependencies):

1. Open Tab Reaper **Settings** -> **Optional Capabilities**.
2. Click **Copy** next to **Exact Chrome RAM** and run the command in your terminal:
   - **macOS / Linux (Terminal):**
     ```bash
     curl -fsSL https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/native-host/install.sh | bash -s -- <your-extension-id>
     ```
   - **Windows (PowerShell):**
     ```powershell
     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/marcusgrando/tab-reaper/main/native-host/install.ps1))) <your-extension-id>
     ```
3. Back in Tab Reaper **Settings**, click **Enable** and then **Test**.

Prebuilt binaries are downloaded automatically from GitHub Releases (no Rust required).

## Optional: Weighted Eviction

In **Settings** -> **Optional Capabilities**, click **Enable** next to **Weighted Eviction** to discard heavier tabs (higher JS heap, DOM size, or media elements) before lightweight ones. Tab Reaper samples candidate tabs on demand with zero content scripts loaded at startup.

## Shortcuts

- `Alt+Shift+K` (`Option+Shift+K` on macOS): Open the archived tabs search palette (configurable at `chrome://extensions/shortcuts`).
- Address bar `ar <query>`: Search and reopen archived tabs directly from the Omnibox.

## Development

Requirements: [Bun](https://bun.sh) and [Rust](https://rustup.rs) (only needed to build the native host from source).

```bash
bun install
bun run typecheck
bun test
bun run build        # outputs unpacked extension to dist/
bun run package      # creates dist/tab-reaper-extension.zip (for CWS / manual install)
bun run test:rust    # runs native-host unit tests
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
