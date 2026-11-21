# Tab Reaper

Keep Chrome fast and bounded in RAM. Tab Reaper enforces a strict memory budget (`RAM / 2` by default), caps loaded tabs (default `10`), discards background tabs immediately on startup, and archives long-unused tabs into both a fast keyboard palette and Chrome Bookmarks.

Everything runs locally on your machine. No accounts, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md).

## Quick Install (macOS, Linux, Windows)

One command downloads the extension into a permanent app folder (never `Downloads` or `/tmp`), pre-installs the optional native memory host with your Extension ID already registered, and copies the extension folder path to your clipboard:

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

- **Exact Chrome RAM:** Measures exact Chrome process memory (PSS/RSS on Linux, RSS on macOS, Working Set on Windows) instead of OS-wide RAM. Pre-installed by the Quick Install command above; if you installed via manual ZIP or CWS, copy the one-liner shown in Tab Reaper **Settings** -> **Optional Capabilities**.
- **Weighted Eviction:** In **Settings** -> **Optional Capabilities**, enable **Weighted Eviction** to discard heavier tabs (higher JS heap, DOM size, or media elements) before lightweight ones. Zero content scripts at startup.

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
bun run package      # creates dist/tab-reaper-extension.zip
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
