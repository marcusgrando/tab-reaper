#!/usr/bin/env bash
set -euo pipefail

REPO="${TABCURB_REPO:-marcusgrando/tabcurb}"
VERSION="${TABCURB_VERSION:-latest}"
FROM_SOURCE=0
RUN_TEST=0
EXT_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    --test)
      RUN_TEST=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--from-source] [--test] <chrome-extension-id>"
      echo "Downloads and verifies the prebuilt tabcurb-host binary from GitHub Releases (or builds locally with --from-source)."
      exit 0
      ;;
    *)
      EXT_ID="$1"
      shift
      ;;
  esac
done

if [ -z "$EXT_ID" ]; then
  echo "Usage: $0 [--from-source] [--test] <chrome-extension-id>" >&2
  echo "Copy the full 32-character Extension ID from chrome://extensions or the TabCurb Settings page." >&2
  exit 1
fi

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: invalid Chrome extension ID '$EXT_ID' (got ${#EXT_ID} chars; expected 32 lowercase letters a-p)." >&2
  echo "Copy the full ID from chrome://extensions or the TabCurb Settings page." >&2
  exit 1
fi

BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/tabcurb-host"
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

release_url() {
  local asset="$1"
  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    echo "https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "Error: neither shasum nor sha256sum found." >&2
    exit 1
  fi
}

verify_checksum() {
  local sums_file="$1"
  local asset="$2"
  local file="$3"
  local expected
  expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1; exit}' "$sums_file")"
  if [ -z "$expected" ]; then
    echo "Error: checksum for ${asset} not found in SHA256SUMS.txt." >&2
    return 1
  fi
  local actual
  actual="$(sha256_file "$file")"
  if [ "$actual" != "$expected" ]; then
    echo "Error: SHA-256 mismatch for ${asset} (expected ${expected}, got ${actual})." >&2
    return 1
  fi
}

build_from_source() {
  if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/Cargo.toml" ]; then
    echo "Error: local Cargo.toml not found for --from-source build." >&2
    exit 1
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: cargo not found. Install Rust from https://rustup.rs or omit --from-source to download a prebuilt binary." >&2
    exit 1
  fi
  local target_dir="${CARGO_TARGET_DIR:-$HOME/.cache/tabcurb/target}"
  mkdir -p "$target_dir"
  echo "Building tabcurb-host (release)..."
  CARGO_TARGET_DIR="$target_dir" cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"
  install -m 755 "$target_dir/release/tabcurb-host" "$BIN_PATH"
}

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

download_prebuilt() {
  local asset="tabcurb-host-${PLATFORM}-${ARCH_NAME}"
  TMP_DIR="$(mktemp -d)"

  echo "Downloading release checksums..."
  curl -fsSL "$(release_url SHA256SUMS.txt)" -o "$TMP_DIR/SHA256SUMS.txt"

  echo "Downloading ${asset} from GitHub Releases..."
  curl -fsSL "$(release_url "$asset")" -o "$TMP_DIR/tabcurb-host"

  verify_checksum "$TMP_DIR/SHA256SUMS.txt" "$asset" "$TMP_DIR/tabcurb-host"
  install -m 755 "$TMP_DIR/tabcurb-host" "$BIN_PATH"
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  build_from_source
else
  download_prebuilt
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

ESCAPED_BIN_PATH="$(json_escape "$BIN_PATH")"
REGISTERED=0
for DIR in "${HOST_DIRS[@]}"; do
  PARENT_DIR="$(dirname "$DIR")"
  if [ -d "$PARENT_DIR" ]; then
    mkdir -p "$DIR"
    cat > "$DIR/com.tabcurb.host.json" <<EOF
{
  "name": "com.tabcurb.host",
  "description": "TabCurb exact Chrome memory reporter",
  "path": "$ESCAPED_BIN_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
    echo "Registered native host manifest at $DIR/com.tabcurb.host.json"
    REGISTERED=1
  fi
done

if [ "$REGISTERED" -eq 0 ]; then
  DIR="${HOST_DIRS[0]}"
  mkdir -p "$DIR"
  cat > "$DIR/com.tabcurb.host.json" <<EOF
{
  "name": "com.tabcurb.host",
  "description": "TabCurb exact Chrome memory reporter",
  "path": "$ESCAPED_BIN_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
  echo "Registered native host manifest at $DIR/com.tabcurb.host.json"
fi

if [ "$RUN_TEST" -eq 1 ]; then
  echo "Self-test (--once):"
  "$BIN_PATH" --once
fi
