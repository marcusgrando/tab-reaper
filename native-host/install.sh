#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo "Find the extension ID at chrome://extensions after loading dist/ unpacked."
  exit 1
fi

EXT_ID="$1"
if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: invalid Chrome extension ID '$EXT_ID' (got ${#EXT_ID} chars; expected 32 lowercase letters a-p)." >&2
  echo "Copy the full ID from chrome://extensions or the Tab Reaper Settings page." >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/tab-reaper/target}"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/tab-reaper-host"

mkdir -p "$BIN_DIR" "$TARGET_DIR"

echo "Building tab-reaper-host (release)..."
CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"
install -m 755 "$TARGET_DIR/release/tab-reaper-host" "$BIN_PATH"

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  HOST_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
else
  HOST_DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
  )
fi

for DIR in "${HOST_DIRS[@]}"; do
  mkdir -p "$DIR"
  cat > "$DIR/com.tabreaper.host.json" <<EOF
{
  "name": "com.tabreaper.host",
  "description": "Tab Reaper exact Chrome memory reporter",
  "path": "$BIN_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
  echo "Registered native host manifest at $DIR/com.tabreaper.host.json"
done

echo "Self-test (--once):"
"$BIN_PATH" --once
