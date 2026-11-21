# Tab Reaper

Chrome Manifest V3 extension + optional Rust Native Messaging host that enforces a strict Chrome memory budget (`memory / 2` by default), caps loaded tabs (default `10`), speeds up Chrome startup, and archives long-unused tabs into both a fast keyboard-driven palette and Chrome Bookmarks.

## Build and Test

```bash
bun install
bun run typecheck
bun test
bun run build
bun run test:rust
```

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` directory.
3. Copy the generated Extension ID.

## Optional: Enable Exact Chrome RAM (Rust Native Host)

On macOS or Linux, install the lightweight zero-dependency Rust host so Tab Reaper measures exact Chrome memory (RSS on macOS, PSS/RSS on Linux) instead of OS-wide memory:

```bash
./native-host/install.sh <chrome-extension-id>
```

Then open Tab Reaper **Settings** -> **Optional Capabilities** -> click **Enable** and **Test** next to **Exact Chrome RAM**.

## Shortcuts

- `Alt+Shift+K`: Open the archived tabs search palette (configurable at `chrome://extensions/shortcuts`).
- Address bar `ar <query>`: Search and reopen archived tabs directly from the Omnibox.
