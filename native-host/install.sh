#!/usr/bin/env bash
set -euo pipefail

REPO="${TAB_REAPER_REPO:-marcusgrando/tab-reaper}"
VERSION="${TAB_REAPER_VERSION:-latest}"
FROM_SOURCE=0
EXT_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--from-source] <chrome-extension-id>"
      echo "Downloads the prebuilt tab-reaper-host binary from GitHub Releases (or builds locally with --from-source)."
      exit 0
      ;;
    *)
      EXT_ID="$1"
      shift
      ;;
  esac
done

if [ -z "$EXT_ID" ]; then
  echo "Usage: $0 [--from-source] <chrome-extension-id>" >&2
  echo "Copy the full 32-character Extension ID from chrome://extensions or the Tab Reaper Settings page." >&2
  exit 1
fi

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: invalid Chrome extension ID '$EXT_ID' (got ${#EXT_ID} chars; expected 32 lowercase letters a-p)." >&2
  echo "Copy the full ID from chrome://extensions or the Tab Reaper Settings page." >&2
  exit 1
fi

BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/tab-reaper-host"
mkdir -p "$BIN_DIR"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)
    echo "Error: unsupported OS '$OS'. On Windows, use native-host/install.ps1." >&2
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

build_from_source() {
  if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/Cargo.toml" ]; then
    echo "Error: local Cargo.toml not found for --from-source build." >&2
    exit 1
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: cargo not found. Install Rust from https://rustup.rs or omit --from-source to download a prebuilt binary." >&2
    exit 1
  fi
  local target_dir="${CARGO_TARGET_DIR:-$HOME/.cache/tab-reaper/target}"
  mkdir -p "$target_dir"
  echo "Building tab-reaper-host (release)..."
  CARGO_TARGET_DIR="$target_dir" cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"
  install -m 755 "$target_dir/release/tab-reaper-host" "$BIN_PATH"
}

download_prebuilt() {
  local asset="tab-reaper-host-${PLATFORM}-${ARCH_NAME}"
  local url
  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi

  local tmp_file
  tmp_file="$(mktemp)"
  echo "Downloading ${asset} from GitHub Releases..."
  if curl -fsSL "$url" -o "$tmp_file"; then
    install -m 755 "$tmp_file" "$BIN_PATH"
    rm -f "$tmp_file"
    return 0
  fi
  rm -f "$tmp_file"
  return 1
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  build_from_source
elif ! download_prebuilt; then
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/Cargo.toml" ] && command -v cargo >/dev/null 2>&1; then
    echo "Prebuilt binary not available yet; falling back to local Rust build..."
    build_from_source
  else
    echo "Error: failed to download prebuilt binary for ${PLATFORM}-${ARCH_NAME}." >&2
    echo "Check https://github.com/${REPO}/releases or build from source with --from-source." >&2
    exit 1
  fi
fi

if [ "$PLATFORM" = "darwin" ]; then
  HOST_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  )
else
  HOST_DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
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
