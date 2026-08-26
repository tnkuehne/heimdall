#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="meeting-recorder"
UUID="meeting-recorder@timokuehne.com"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "${ROOT_DIR}/backend/Cargo.toml" | head -n 1)"
ARCH="${DEB_ARCH:-$(dpkg --print-architecture)}"
OUT_DIR="${ROOT_DIR}/build/deb"
STAGE_DIR="${OUT_DIR}/stage"
DEB_PATH="${OUT_DIR}/${PACKAGE}_${VERSION}_${ARCH}.deb"
EXTENSION_DIR="${STAGE_DIR}/usr/share/gnome-shell/extensions/${UUID}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need cargo
need dpkg
need dpkg-deb
need pnpm

CI=true pnpm install --frozen-lockfile
pnpm run build
cargo build --release --manifest-path "${ROOT_DIR}/backend/Cargo.toml"

rm -rf "${STAGE_DIR}"
mkdir -p \
  "${STAGE_DIR}/DEBIAN" \
  "${EXTENSION_DIR}/bin" \
  "${STAGE_DIR}/usr/bin" \
  "${STAGE_DIR}/usr/share/doc/${PACKAGE}"

install -m 0644 "${ROOT_DIR}/build/extension/metadata.json" "${EXTENSION_DIR}/metadata.json"
install -m 0644 "${ROOT_DIR}/build/extension/"*.js "${EXTENSION_DIR}/"
install -m 0755 "${ROOT_DIR}/backend/target/release/meeting-recorder" "${EXTENSION_DIR}/bin/meeting-recorder"
install -m 0644 "${ROOT_DIR}/README.md" "${STAGE_DIR}/usr/share/doc/${PACKAGE}/README.md"
ln -s "../share/gnome-shell/extensions/${UUID}/bin/meeting-recorder" "${STAGE_DIR}/usr/bin/meeting-recorder"

for required_file in metadata.json extension.js prefs.js backend-client.js bin/meeting-recorder; do
  if [ ! -e "${EXTENSION_DIR}/${required_file}" ]; then
    echo "Package staging is missing ${required_file}" >&2
    exit 1
  fi
done

cat >"${STAGE_DIR}/DEBIAN/control" <<EOF
Package: ${PACKAGE}
Version: ${VERSION}
Section: gnome
Priority: optional
Architecture: ${ARCH}
Maintainer: Timo Kühne <contact@timokuehne.com>
Depends: ffmpeg, wireplumber, gnome-shell (>= 46), xdg-utils, libc6, libgcc-s1
Homepage: https://timokuehne.com
Description: GNOME Shell meeting recorder
 Records the default microphone and current system audio from the GNOME top bar.
 Audio is saved as stereo MP3 with microphone audio on the left channel and
 system audio on the right channel.
EOF

cat >"${STAGE_DIR}/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e

cat <<MSG
Meeting Recorder installed.

Enable it for your user with:
  gnome-extensions enable ${UUID}

Then log out and back in if the icon does not appear.
MSG

exit 0
EOF
chmod 0755 "${STAGE_DIR}/DEBIAN/postinst"
find "${STAGE_DIR}" -type d -exec chmod 0755 {} +

dpkg-deb --build --root-owner-group "${STAGE_DIR}" "${DEB_PATH}"

echo "Built ${DEB_PATH}"
