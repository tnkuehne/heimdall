#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_ID="com.timokuehne.meeting-recorder"
TEST_SCHEMA_DIR="$(mktemp -d)"
TEST_CONFIG_DIR="${TEST_SCHEMA_DIR}/config"
trap 'rm -rf "${TEST_SCHEMA_DIR}"' EXIT
mkdir -p "${TEST_CONFIG_DIR}"

install -m 0644 \
  "${ROOT_DIR}/data/${SCHEMA_ID}.gschema.xml" \
  "${TEST_SCHEMA_DIR}/${SCHEMA_ID}.gschema.xml"
glib-compile-schemas --strict "${TEST_SCHEMA_DIR}"

settings() {
  GSETTINGS_BACKEND=keyfile \
    GSETTINGS_SCHEMA_DIR="${TEST_SCHEMA_DIR}" \
    XDG_CONFIG_HOME="${TEST_CONFIG_DIR}" \
    gsettings "$@"
}

assert_setting() {
  local key="$1"
  local expected="$2"
  local actual

  actual="$(settings get "${SCHEMA_ID}" "${key}")"
  if [ "${actual}" != "${expected}" ]; then
    echo "Unexpected default for ${key}: ${actual}; expected ${expected}" >&2
    exit 1
  fi
}

assert_setting transcription-provider "'disabled'"
assert_setting xai-base-url "'https://api.x.ai'"
assert_setting deepgram-base-url "'https://api.deepgram.com'"
assert_setting recordings-directory "''"
assert_setting post-transcribe-hook "''"
assert_setting meeting-detection-reminder-enabled "true"

settings set "${SCHEMA_ID}" transcription-provider xai
assert_setting transcription-provider "'xai'"
if settings set "${SCHEMA_ID}" transcription-provider unsupported 2>/dev/null; then
  echo "GSettings accepted an unsupported transcription provider" >&2
  exit 1
fi
assert_setting transcription-provider "'xai'"
