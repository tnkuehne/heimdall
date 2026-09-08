#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="meeting-recorder@timokuehne.com"
EXTENSION_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCHEMA_ID="com.timokuehne.meeting-recorder"
SCHEMA_DIR="${EXTENSION_DIR}/schemas"

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
need glib-compile-schemas
need pnpm

cd "${ROOT_DIR}"
CI=true pnpm install --frozen-lockfile
pnpm run build
cargo build --release --manifest-path "${ROOT_DIR}/backend/Cargo.toml"

mkdir -p "${EXTENSION_DIR}/bin" "${SCHEMA_DIR}"
rm -f \
  "${EXTENSION_DIR}/metadata.json" \
  "${EXTENSION_DIR}/bin/meeting-recorder"
find "${EXTENSION_DIR}" -maxdepth 1 -type f -name '*.js' -delete
cp "${ROOT_DIR}/build/extension/metadata.json" "${EXTENSION_DIR}/metadata.json"
find "${ROOT_DIR}/build/extension" -maxdepth 1 -type f -name '*.js' \
  -exec cp {} "${EXTENSION_DIR}/" \;
cp "${ROOT_DIR}/backend/target/release/meeting-recorder" "${EXTENSION_DIR}/bin/meeting-recorder"
install -m 0644 \
  "${ROOT_DIR}/data/${SCHEMA_ID}.gschema.xml" \
  "${SCHEMA_DIR}/${SCHEMA_ID}.gschema.xml"
glib-compile-schemas --strict "${SCHEMA_DIR}"

gnome-extensions enable "${UUID}" || true

cat <<EOF
Installed ${UUID} to:
  ${EXTENSION_DIR}

If the icon does not appear immediately, log out and back in.
The recordings folder can be changed in Preferences.
Default recordings folder:
  ${HOME}/Recordings/Meetings
EOF
