#!/usr/bin/env bash
set -euo pipefail

REPO="${TABCURB_REPO:-marcusgrando/tabcurb}"
VERSION="${TABCURB_VERSION:-latest}"
UNINSTALL=0
RUN_TEST=0
NON_INTERACTIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --test)
      RUN_TEST=1
      shift
      ;;
    -y|--yes|--non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--uninstall] [--test] [--yes]"
      echo "Installs TabCurb (extension + Local Companion) into a permanent app directory."
      echo ""
      echo "Options:"
      echo "  --uninstall          Remove TabCurb files and native host manifests"
      echo "  --test               Print full JSON output from the companion self-test"
      echo "  -y, --yes            Run without interactive prompts"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

INTERACTIVE=0
if [ "$NON_INTERACTIVE" -eq 0 ] && [ -t 1 ] && [ -r /dev/tty ]; then
  INTERACTIVE=1
fi

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""
  C_BLUE=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_DIM=""
  C_RESET=""
fi

step() {
  printf '%s[%s]%s %s\n' "$C_BLUE$C_BOLD" "$1" "$C_RESET" "$2"
}

ok() {
  printf '  %sOK%s %s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$1"
}

note() {
  printf '  %sNote:%s %s\n' "$C_YELLOW$C_BOLD" "$C_RESET" "$1"
}

fail() {
  printf '%sError:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$1" >&2
  exit 1
}

prompt_yes_no() {
  local question="$1"
  local reply=""
  printf '%s%s [Y/n]: %s' "$C_BOLD" "$question" "$C_RESET"
  if ! IFS= read -r reply < /dev/tty; then
    return 1
  fi
  case "$reply" in
    ""|[Yy]|[Yy][Ee][Ss]|[Ss]|[Ss][Ii][Mm]) return 0 ;;
    *) return 1 ;;
  esac
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    PLATFORM="darwin"
    APP_DIR="$HOME/Library/Application Support/TabCurb"
    HOST_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    HOST_LABELS=(
      "Google Chrome"
      "Chromium"
      "Brave"
    )
    ;;
  Linux)
    PLATFORM="linux"
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tabcurb"
    HOST_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    HOST_LABELS=(
      "Google Chrome"
      "Chromium"
      "Brave"
    )
    ;;
  *)
    fail "Unsupported OS '$OS'. On Windows, use install.ps1."
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_NAME="arm64" ;;
  x86_64|amd64)  ARCH_NAME="x86_64" ;;
  *)
    fail "Unsupported architecture '$ARCH'."
    ;;
esac

EXT_DIR="$APP_DIR/extension"
BIN_PATH="$APP_DIR/tabcurb-host"

if [ "$UNINSTALL" -eq 1 ]; then
  for DIR in "${HOST_DIRS[@]}"; do
    rm -f "$DIR/com.tabcurb.host.json"
  done
  rm -rf "$APP_DIR"
  rm -f "$HOME/.local/bin/tabcurb-host"
  printf '%sTabCurb removed.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  echo "Removed $APP_DIR, ~/.local/bin/tabcurb-host, and native host manifests."
  echo "If TabCurb is still listed in chrome://extensions, click Remove there."
  exit 0
fi

for cmd in curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Required command '$cmd' not found."
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
    fail "Neither shasum nor sha256sum found."
  fi
  printf '%s' "${hex:0:32}" | tr '0-9a-f' 'a-p'
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    fail "Neither shasum nor sha256sum found."
  fi
}

verify_checksum() {
  local sums_file="$1"
  local asset="$2"
  local file="$3"
  local expected
  expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1; exit}' "$sums_file")"
  if [ -z "$expected" ]; then
    fail "Checksum for ${asset} not found in SHA256SUMS.txt."
  fi
  local actual
  actual="$(sha256_file "$file")"
  if [ "$actual" != "$expected" ]; then
    fail "SHA-256 mismatch for ${asset} (expected ${expected}, got ${actual})."
  fi
}

detect_browser() {
  DETECTED_BROWSER_NAME=""
  DETECTED_BROWSER_TARGET=""
  if [ "$PLATFORM" = "darwin" ]; then
    local app
    for app in "Google Chrome" "Brave Browser" "Chromium"; do
      if [ -d "/Applications/${app}.app" ] || [ -d "$HOME/Applications/${app}.app" ]; then
        DETECTED_BROWSER_NAME="$app"
        DETECTED_BROWSER_TARGET="$app"
        return 0
      fi
    done
  else
    local bin
    for bin in google-chrome google-chrome-stable brave-browser chromium chromium-browser; do
      if command -v "$bin" >/dev/null 2>&1; then
        DETECTED_BROWSER_NAME="$bin"
        DETECTED_BROWSER_TARGET="$bin"
        return 0
      fi
    done
  fi
  return 1
}

open_browser_extensions() {
  if [ -z "$DETECTED_BROWSER_TARGET" ]; then
    return 1
  fi
  if [ "$PLATFORM" = "darwin" ]; then
    open -a "$DETECTED_BROWSER_TARGET" "chrome://extensions" >/dev/null 2>&1 || return 1
  else
    "$DETECTED_BROWSER_TARGET" "chrome://extensions" >/dev/null 2>&1 &
  fi
  return 0
}

open_extension_folder() {
  if [ "$PLATFORM" = "darwin" ]; then
    open -R "$CANON_EXT_DIR" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_DIR" >/dev/null 2>&1 &
  fi
}

IS_UPDATE=0
if [ -f "$EXT_DIR/manifest.json" ]; then
  IS_UPDATE=1
fi

printf '\n%sTabCurb %s%s\n' "$C_BOLD" "$([ "$IS_UPDATE" -eq 1 ] && echo "Updater" || echo "Installer")" "$C_RESET"
printf '%sPlatform: %s (%s) | Release: %s%s\n\n' "$C_DIM" "$PLATFORM" "$ARCH_NAME" "$VERSION" "$C_RESET"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

step "1/4" "Downloading extension and verifying checksum..."
curl -fsSL "$(release_url SHA256SUMS.txt)" -o "$TMP_DIR/SHA256SUMS.txt"
curl -fsSL "$(release_url tabcurb-extension.zip)" -o "$TMP_DIR/extension.zip"
verify_checksum "$TMP_DIR/SHA256SUMS.txt" "tabcurb-extension.zip" "$TMP_DIR/extension.zip"

mkdir -p "$TMP_DIR/extracted"
unzip -qo "$TMP_DIR/extension.zip" -d "$TMP_DIR/extracted"

mkdir -p "$APP_DIR"
rm -rf "$EXT_DIR"
mv "$TMP_DIR/extracted" "$EXT_DIR"

CANON_EXT_DIR="$(cd "$EXT_DIR" && pwd -P)"
EXT_ID="$(compute_extension_id "$CANON_EXT_DIR")"
ok "Extension installed to $CANON_EXT_DIR"

HOST_ASSET="tabcurb-host-${PLATFORM}-${ARCH_NAME}"
step "2/4" "Installing Local Companion (${HOST_ASSET})..."
curl -fsSL "$(release_url "$HOST_ASSET")" -o "$TMP_DIR/tabcurb-host"
verify_checksum "$TMP_DIR/SHA256SUMS.txt" "$HOST_ASSET" "$TMP_DIR/tabcurb-host"
install -m 755 "$TMP_DIR/tabcurb-host" "$BIN_PATH"
ok "Local Companion installed to $BIN_PATH"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

step "3/4" "Registering Local Companion with browsers..."
ESCAPED_BIN_PATH="$(json_escape "$BIN_PATH")"
REGISTERED_LIST=""
for i in "${!HOST_DIRS[@]}"; do
  DIR="${HOST_DIRS[$i]}"
  LABEL="${HOST_LABELS[$i]}"
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
    if [ -z "$REGISTERED_LIST" ]; then
      REGISTERED_LIST="$LABEL"
    else
      REGISTERED_LIST="$REGISTERED_LIST, $LABEL"
    fi
  fi
done

if [ -z "$REGISTERED_LIST" ]; then
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
  REGISTERED_LIST="${HOST_LABELS[0]} (default)"
fi
ok "Registered for $REGISTERED_LIST (Extension ID: $EXT_ID)"

step "4/4" "Verifying Local Companion..."
if SELF_TEST_OUT="$("$BIN_PATH" --once 2>&1)"; then
  ok "Companion self-test passed."
  if [ "$RUN_TEST" -eq 1 ]; then
    echo "$SELF_TEST_OUT"
  fi
else
  note "Companion binary installed. Memory reporting activates once Chrome is running."
  if [ "$RUN_TEST" -eq 1 ]; then
    echo "$SELF_TEST_OUT"
  fi
fi

COPIED_NOTE=""
if [ "$PLATFORM" = "darwin" ] && command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | pbcopy
  COPIED_NOTE=" (already copied to clipboard — press Cmd+Shift+G then Cmd+V in the file picker)"
elif command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | wl-copy 2>/dev/null && COPIED_NOTE=" (copied to clipboard)" || true
elif command -v xclip >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | xclip -selection clipboard 2>/dev/null && COPIED_NOTE=" (copied to clipboard)" || true
elif command -v xsel >/dev/null 2>&1; then
  printf '%s' "$CANON_EXT_DIR" | xsel --clipboard --input 2>/dev/null && COPIED_NOTE=" (copied to clipboard)" || true
fi

detect_browser || true
echo ""

if [ "$IS_UPDATE" -eq 1 ]; then
  printf '%sUpdate complete.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  echo "  1. Open chrome://extensions"
  echo "  2. Click the Reload icon on the TabCurb card."
  if [ "$INTERACTIVE" -eq 1 ] && [ -n "$DETECTED_BROWSER_NAME" ]; then
    echo ""
    if prompt_yes_no "Open ${DETECTED_BROWSER_NAME} at chrome://extensions now?"; then
      open_browser_extensions || true
    fi
  fi
else
  printf '%sFinal step in Chrome (one-time):%s\n' "$C_BOLD" "$C_RESET"
  echo "  1. Open chrome://extensions and turn on Developer mode (top right)."
  echo "  2. Drag the 'extension' folder onto the chrome://extensions page"
  echo "     or click 'Load unpacked' and select:"
  echo "     $CANON_EXT_DIR${COPIED_NOTE}"
  echo "  3. TabCurb Settings will open automatically to finish setup in 1 click."

  if [ "$INTERACTIVE" -eq 1 ]; then
    echo ""
    if [ -n "$DETECTED_BROWSER_NAME" ]; then
      if prompt_yes_no "Open ${DETECTED_BROWSER_NAME} (chrome://extensions) and the extension folder now?"; then
        open_browser_extensions || true
        open_extension_folder
        echo ""
        ok "Opened ${DETECTED_BROWSER_NAME} and the extension folder. Drag 'extension' onto chrome://extensions."
      fi
    else
      if prompt_yes_no "Open the extension folder now?"; then
        open_extension_folder
        echo ""
        ok "Opened the extension folder. Drag 'extension' onto chrome://extensions."
      fi
    fi
  fi
fi

echo ""
printf '%sTo uninstall later:%s\n' "$C_DIM" "$C_RESET"
echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall"
