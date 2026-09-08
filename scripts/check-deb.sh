#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/meeting-recorder.deb" >&2
  exit 2
fi

if ! command -v dbus-run-session >/dev/null 2>&1; then
  echo "Missing required command: dbus-run-session" >&2
  exit 1
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
DBUS_SERVICE="${TEST_DIR}/root/usr/share/dbus-1/services/com.timokuehne.MeetingRecorder1.service"
DBUS_INTERFACE="${TEST_DIR}/root/usr/share/dbus-1/interfaces/com.timokuehne.MeetingRecorder1.xml"
SYSTEMD_USER_SERVICE="${TEST_DIR}/root/usr/lib/systemd/user/meeting-recorder.service"

test -x "${BINARY}"
test -f "${EXTENSION_DIR}/extension.js"
test -f "${EXTENSION_DIR}/prefs.js"
test -f "${EXTENSION_DIR}/settings.js"
test -f "${EXTENSION_DIR}/dbus-client.js"
test -f "${SCHEMA_DIR}/${SCHEMA_ID}.gschema.xml"
test -f "${DBUS_SERVICE}"
test -f "${DBUS_INTERFACE}"
test -f "${SYSTEMD_USER_SERVICE}"
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
case "${depends}" in
  *dbus-user-session*) ;;
  *)
    echo "Package does not depend on dbus-user-session: ${depends}" >&2
    exit 1
    ;;
esac

grep -Fqx 'Exec=/usr/bin/meeting-recorder service' "${DBUS_SERVICE}"
grep -Fqx 'SystemdService=meeting-recorder.service' "${DBUS_SERVICE}"
grep -Fqx 'Type=dbus' "${SYSTEMD_USER_SERVICE}"
grep -Fqx 'BusName=com.timokuehne.MeetingRecorder1' "${SYSTEMD_USER_SERVICE}"
grep -Fqx 'ExecStart=/usr/bin/meeting-recorder service' "${SYSTEMD_USER_SERVICE}"
if command -v systemd-analyze >/dev/null 2>&1; then
  sed 's|ExecStart=/usr/bin/meeting-recorder service|ExecStart=/bin/true|' \
    "${SYSTEMD_USER_SERVICE}" >"${TEST_DIR}/meeting-recorder.service"
  systemd-analyze verify "${TEST_DIR}/meeting-recorder.service" >/dev/null
fi

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
    PATH="${TEST_DIR}/bin:${PATH}" \
    dbus-run-session -- bash -c '
      binary="$1"
      "$binary" service >/dev/null 2>&1 &
      service_pid=$!
      trap '\''kill "$service_pid" 2>/dev/null || true'\'' EXIT
      for attempt in 1 2 3 4 5 6 7 8 9 10; do
        "$binary" status >/dev/null 2>&1 && break
        sleep 0.1
      done
      "$binary" start
    ' _ "${BINARY}" 2>&1
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
case "${help}" in
  *$'\n  monitor-capture '*)
    echo "Removed monitor-capture command is still present in CLI help" >&2
    exit 1
    ;;
esac
