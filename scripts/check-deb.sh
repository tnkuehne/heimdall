#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/meeting-recorder.deb" >&2
  exit 2
fi

DEB_PATH="$1"
SCHEMA_ID="com.timokuehne.meeting-recorder"
UUID="meeting-recorder@timokuehne.com"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

dpkg-deb -x "${DEB_PATH}" "${TEST_DIR}/root"
dpkg-deb -e "${DEB_PATH}" "${TEST_DIR}/control"

EXTENSION_DIR="${TEST_DIR}/root/usr/share/gnome-shell/extensions/${UUID}"
SCHEMA_DIR="${TEST_DIR}/root/usr/share/glib-2.0/schemas"
BINARY="${EXTENSION_DIR}/bin/meeting-recorder"

test -x "${BINARY}"
test -f "${EXTENSION_DIR}/extension.js"
test -f "${EXTENSION_DIR}/prefs.js"
test -f "${EXTENSION_DIR}/settings.js"
test -f "${SCHEMA_DIR}/${SCHEMA_ID}.gschema.xml"
test -x "${TEST_DIR}/control/postinst"
test -x "${TEST_DIR}/control/postrm"

depends="$(dpkg-deb -f "${DEB_PATH}" Depends)"
case "${depends}" in
  *libglib2.0-bin*) ;;
  *)
    echo "Package does not depend on libglib2.0-bin: ${depends}" >&2
    exit 1
    ;;
esac

glib-compile-schemas --strict "${SCHEMA_DIR}"
mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/home" "${TEST_DIR}/config" "${TEST_DIR}/state"
ln -s /usr/bin/true "${TEST_DIR}/bin/ffmpeg"
ln -s /usr/bin/true "${TEST_DIR}/bin/wpctl"

GSETTINGS_BACKEND=keyfile \
  GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" \
  XDG_CONFIG_HOME="${TEST_DIR}/config" \
  gsettings set "${SCHEMA_ID}" recordings-directory relative/path

if output="$(
  HOME="${TEST_DIR}/home" \
    XDG_CONFIG_HOME="${TEST_DIR}/config" \
    XDG_STATE_HOME="${TEST_DIR}/state" \
    GSETTINGS_BACKEND=keyfile \
    GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" \
    PATH="${TEST_DIR}/bin" \
    "${BINARY}" start 2>&1
)"; then
  echo "Backend accepted an invalid recordings directory" >&2
  exit 1
fi

case "${output}" in
  *"GSettings key recordings-directory must contain an absolute path"*) ;;
  *)
    echo "Backend returned an unexpected settings error: ${output}" >&2
    exit 1
    ;;
esac

help="$(${BINARY} --help)"
case "${help}" in
  *$'\n  config '*)
    echo "Removed config command is still present in CLI help" >&2
    exit 1
    ;;
esac
