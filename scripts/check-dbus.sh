#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need cargo
need dbus-run-session
need gjs
need glib-compile-schemas
need pnpm

pnpm --dir "${ROOT_DIR}" run build
cargo build --manifest-path "${ROOT_DIR}/backend/Cargo.toml"

mkdir -p \
  "${TEST_DIR}/bin" \
  "${TEST_DIR}/config" \
  "${TEST_DIR}/home" \
  "${TEST_DIR}/schemas" \
  "${TEST_DIR}/state"
install -m 0755 "${ROOT_DIR}/tests/fixtures/bin/ffmpeg" "${TEST_DIR}/bin/ffmpeg"
install -m 0755 "${ROOT_DIR}/tests/fixtures/bin/pw-dump" "${TEST_DIR}/bin/pw-dump"
install -m 0755 "${ROOT_DIR}/tests/fixtures/bin/wpctl" "${TEST_DIR}/bin/wpctl"
install -m 0644 \
  "${ROOT_DIR}/data/com.timokuehne.meeting-recorder.gschema.xml" \
  "${TEST_DIR}/schemas/com.timokuehne.meeting-recorder.gschema.xml"
glib-compile-schemas --strict "${TEST_DIR}/schemas"
install -m 0644 \
  "${ROOT_DIR}/build/extension/dbus-client.js" \
  "${TEST_DIR}/dbus-client.js"
install -m 0644 \
  "${ROOT_DIR}/tests/dbus-client.integration.js" \
  "${TEST_DIR}/dbus-client.integration.js"

HOME="${TEST_DIR}/home" \
  XDG_CONFIG_HOME="${TEST_DIR}/config" \
  XDG_STATE_HOME="${TEST_DIR}/state" \
  GIO_USE_VFS=local \
  GSETTINGS_BACKEND=keyfile \
  GSETTINGS_SCHEMA_DIR="${TEST_DIR}/schemas" \
  PATH="${TEST_DIR}/bin:${PATH}" \
  dbus-run-session -- \
  gjs -m "${TEST_DIR}/dbus-client.integration.js" \
  "${ROOT_DIR}/backend/target/debug/meeting-recorder"
