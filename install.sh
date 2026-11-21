#!/usr/bin/env bash
set -euo pipefail

REPO="${TAB_REAPER_REPO:-marcusgrando/tab-reaper}"
VERSION="${TAB_REAPER_VERSION:-latest}"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--uninstall]"
      echo "Installs Tab Reaper (extension + optional native memory host) into a permanent app directory."
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    PLATFORM="darwin"
    APP_DIR="$HOME/Library/Application Support/TabReaper"
    HOST_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    ;;
  Linux)
    PLATFORM="linux"
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tab-reaper"
    HOST_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Error: unsupported OS '$OS'. On Windows, use install.ps1." >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_NAME="arm64" ;;
  x86_64|amd64)  ARCH_NAME="x86_64" ;;
  *)
    echo "Error: unsupported architecture '$ARCH'." >&2
    exit 1
    ;;
esac

EXT_DIR="$APP_DIR/extension"
BIN_PATH="$APP_DIR/tab-reaper-host"

if [ "$UNINSTALL" -eq 1 ]; then
  for DIR in "${HOST_DIRS[@]}"; do
    rm -f "$DIR/com.tabreaper.host.json"
  done
  rm -rf "$APP_DIR"
  echo "Tab Reaper removed from $APP_DIR and native host manifests cleaned up."
  echo "If still listed in chrome://extensions, click Remove there."
  exit 0
fi

for cmd in curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found." >&2
    exit 1
  fi
done

release_url() {
  local asset="$1"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
}

compute_extension_id() {
  local path="$1"
  local hex
  if command -v shasum >/dev/null 2>&1; then
    hex="$(printf '%s' "$path" | shasum -a 256 | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    hex="$(printf '%s' "$path" | sha256sum | awk '{print $1}')"
  else
    echo "Error: neither shasum nor sha256sum found." >&2
    exit 1
  fi
  printf '%s' "${hex:0:32}" | tr '0-9a-f' 'a-p'
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading Tab Reaper extension..."
curl -fsSL "$(release_url tab-reaper-extension.zip)" -o "$TMP_DIR/extension.zip"

mkdir -p "$TMP_DIR/extracted"
unzip -qo "$TMP_DIR/extension.zip" -d "$TMP_DIR/extracted"

mkdir -p "$APP_DIR"
rm -rf "$EXT_DIR"
mv "$TMP_DIR/extracted" "$EXT_DIR"

CANON_EXT_DIR="$(cd "$EXT_DIR" && pwd -P)"
EXT_ID="$(compute_extension_id "$CANON_EXT_DIR")"

HOST_ASSET="tab-reaper-host-${PLATFORM}-${ARCH_NAME}"
echo "Downloading native memory host (${HOST_ASSET})..."
curl -fsSL "$(release_url "$HOST_ASSET")" -o "$TMP_DIR/tab-reaper-host"
install -m 755 "$TMP_DIR/tab-reaper-host" "$BIN_PATH"

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
done

echo "Self-test (--once):"
"$BIN_PATH" --once

COPIED_NOTE=""
if [ "$PLATFORM" = "darwin" ] && command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | pbcopy
  COPIED_NOTE=" (already copied to your clipboard — press Cmd+Shift+G in the file picker and Cmd+V)"
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | xclip -selection clipboard 2>/dev/null && COPIED_NOTE=" (copied to clipboard)" || true
elif command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | wl-copy 2>/dev/null && COPIED_NOTE=" (copied to clipboard)" || true
fi

echo ""
echo "Tab Reaper installed to: $CANON_EXT_DIR"
echo "Pre-registered native host for Extension ID: $EXT_ID"
echo ""
echo "Final step in Chrome (required once for extensions outside the Web Store):"
echo "  1. Open chrome://extensions and enable Developer mode (top right)"
echo "  2. Click 'Load unpacked' and select:"
echo "     $CANON_EXT_DIR${COPIED_NOTE}"
echo "  3. (Optional) Open Tab Reaper Settings -> click Enable & Test on Exact Chrome RAM"
echo ""
echo "To uninstall later:"
echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall"
