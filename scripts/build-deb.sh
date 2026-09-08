#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="meeting-recorder"
UUID="meeting-recorder@timokuehne.com"
SCHEMA_ID="com.timokuehne.meeting-recorder"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "${ROOT_DIR}/backend/Cargo.toml" | head -n 1)"
ARCH="${DEB_ARCH:-$(dpkg --print-architecture)}"
OUT_DIR="${ROOT_DIR}/build/deb"
STAGE_DIR="${OUT_DIR}/stage"
DEB_PATH="${OUT_DIR}/${PACKAGE}_${VERSION}_${ARCH}.deb"
EXTENSION_DIR="${STAGE_DIR}/usr/share/gnome-shell/extensions/${UUID}"
SCHEMA_DIR="${STAGE_DIR}/usr/share/glib-2.0/schemas"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need cargo
need dpkg
need dpkg-deb
need glib-compile-schemas
need pnpm

CI=true pnpm install --frozen-lockfile
glib-compile-schemas --strict --dry-run "${ROOT_DIR}/data"
pnpm run build
cargo build --release --manifest-path "${ROOT_DIR}/backend/Cargo.toml"

rm -rf "${STAGE_DIR}"
mkdir -p \
  "${STAGE_DIR}/DEBIAN" \
  "${EXTENSION_DIR}/bin" \
  "${STAGE_DIR}/usr/bin" \
  "${STAGE_DIR}/usr/share/doc/${PACKAGE}" \
  "${SCHEMA_DIR}"

install -m 0644 "${ROOT_DIR}/build/extension/metadata.json" "${EXTENSION_DIR}/metadata.json"
find "${ROOT_DIR}/build/extension" -maxdepth 1 -type f -name '*.js' \
  -exec install -m 0644 {} "${EXTENSION_DIR}/" \;
install -m 0755 "${ROOT_DIR}/backend/target/release/meeting-recorder" "${EXTENSION_DIR}/bin/meeting-recorder"
install -m 0644 "${ROOT_DIR}/README.md" "${STAGE_DIR}/usr/share/doc/${PACKAGE}/README.md"
install -m 0644 \
  "${ROOT_DIR}/data/${SCHEMA_ID}.gschema.xml" \
  "${SCHEMA_DIR}/${SCHEMA_ID}.gschema.xml"
ln -s "../share/gnome-shell/extensions/${UUID}/bin/meeting-recorder" "${STAGE_DIR}/usr/bin/meeting-recorder"

cat >"${STAGE_DIR}/DEBIAN/control" <<EOF
Package: ${PACKAGE}
Version: ${VERSION}
Section: gnome
Priority: optional
Architecture: ${ARCH}
Maintainer: Timo Kühne <contact@timokuehne.com>
Depends: ffmpeg, wireplumber, gnome-shell (>= 46), libglib2.0-bin, libc6, libgcc-s1
Homepage: https://timokuehne.com
Description: GNOME Shell meeting recorder
 Records the default microphone and current system audio from the GNOME top bar.
 Audio is saved as stereo MP3 with microphone audio on the left channel and
 system audio on the right channel.
EOF

cat >"${STAGE_DIR}/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e

glib-compile-schemas /usr/share/glib-2.0/schemas || true

cat <<MSG
Meeting Recorder installed.

Enable it for your user with:
  gnome-extensions enable ${UUID}

Then log out and back in if the icon does not appear.
MSG

exit 0
EOF
chmod 0755 "${STAGE_DIR}/DEBIAN/postinst"

cat >"${STAGE_DIR}/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e

if [ -d /usr/share/glib-2.0/schemas ]; then
  glib-compile-schemas /usr/share/glib-2.0/schemas || true
fi

exit 0
EOF
chmod 0755 "${STAGE_DIR}/DEBIAN/postrm"
find "${STAGE_DIR}" -type d -exec chmod 0755 {} +

dpkg-deb --build --root-owner-group "${STAGE_DIR}" "${DEB_PATH}"
"${ROOT_DIR}/scripts/check-deb.sh" "${DEB_PATH}"

echo "Built ${DEB_PATH}"
