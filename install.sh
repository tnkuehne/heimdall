#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="meeting-recorder@timokuehne.com"
EXTENSION_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need cargo
need ffmpeg
need wpctl
need gnome-extensions
need pnpm
need xdg-open

CI=true pnpm install --frozen-lockfile
pnpm run build
cargo build --release --manifest-path "${ROOT_DIR}/backend/Cargo.toml"

mkdir -p "${EXTENSION_DIR}/bin"
rm -f \
  "${EXTENSION_DIR}/metadata.json" \
  "${EXTENSION_DIR}/extension.js" \
  "${EXTENSION_DIR}/prefs.js" \
  "${EXTENSION_DIR}/bin/meeting-recorder"
cp "${ROOT_DIR}/build/extension/metadata.json" "${EXTENSION_DIR}/metadata.json"
cp "${ROOT_DIR}/build/extension/extension.js" "${EXTENSION_DIR}/extension.js"
cp "${ROOT_DIR}/build/extension/prefs.js" "${EXTENSION_DIR}/prefs.js"
cp "${ROOT_DIR}/backend/target/release/meeting-recorder" "${EXTENSION_DIR}/bin/meeting-recorder"

gnome-extensions enable "${UUID}" || true

cat <<EOF
Installed ${UUID} to:
  ${EXTENSION_DIR}

If the icon does not appear immediately, log out and back in.
The recordings folder can be changed in Preferences.
Default recordings folder:
  ${HOME}/Recordings/Meetings
EOF
