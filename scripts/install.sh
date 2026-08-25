#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="tnkuehne/heimdall"
PACKAGE="meeting-recorder"
UUID="meeting-recorder@timokuehne.com"
RELEASES_URL="https://github.com/${REPOSITORY}/releases"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

gsettings_strv_contains() {
  local values="$1"
  local value="$2"

  [[ "${values}" == *"'${value}'"* ]]
}

enable_extension_for_current_user() {
  local schema="org.gnome.shell"
  local enabled_extensions
  local disabled_extensions
  local updated_extensions

  if [ "$(id -u)" -eq 0 ]; then
    echo "Cannot enable the GNOME extension automatically when the installer is run as root." >&2
    return 1
  fi

  if ! command -v gsettings >/dev/null 2>&1; then
    echo "Cannot enable the GNOME extension automatically: gsettings is unavailable." >&2
    return 1
  fi

  enabled_extensions="$(gsettings get "${schema}" enabled-extensions)" || return 1
  disabled_extensions="$(gsettings get "${schema}" disabled-extensions)" || return 1

  if ! gsettings_strv_contains "${enabled_extensions}" "${UUID}"; then
    case "${enabled_extensions}" in
      "[]"|"@as []")
        updated_extensions="['${UUID}']"
        ;;
      \[*\])
        updated_extensions="${enabled_extensions%]}, '${UUID}']"
        ;;
      *)
        echo "Cannot enable the GNOME extension automatically: unexpected GSettings value." >&2
        return 1
        ;;
    esac

    gsettings set "${schema}" enabled-extensions "${updated_extensions}" || return 1
  fi

  if gsettings_strv_contains "${disabled_extensions}" "${UUID}"; then
    updated_extensions="${disabled_extensions//"'${UUID}', "/}"
    updated_extensions="${updated_extensions//", '${UUID}'"/}"
    updated_extensions="${updated_extensions//"'${UUID}'"/}"
    gsettings set "${schema}" disabled-extensions "${updated_extensions}" || return 1
  fi

  enabled_extensions="$(gsettings get "${schema}" enabled-extensions)" || return 1
  disabled_extensions="$(gsettings get "${schema}" disabled-extensions)" || return 1

  if ! gsettings_strv_contains "${enabled_extensions}" "${UUID}" ||
    gsettings_strv_contains "${disabled_extensions}" "${UUID}"; then
    echo "Cannot enable the GNOME extension automatically: GSettings did not save the changes." >&2
    return 1
  fi
}

need apt-get
need curl
need dpkg

architecture="$(dpkg --print-architecture)"
if [ "${architecture}" != "amd64" ]; then
  echo "Meeting Recorder currently supports only amd64 systems." >&2
  exit 1
fi

latest_url="$(curl --fail --silent --show-error --location \
  --output /dev/null \
  --write-out '%{url_effective}' \
  "${RELEASES_URL}/latest")"
tag="${latest_url##*/}"

if [[ ! "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not determine the latest Meeting Recorder version from: ${latest_url}" >&2
  exit 1
fi

version="${tag#v}"
filename="${PACKAGE}_${version}_${architecture}.deb"
download_url="${RELEASES_URL}/download/${tag}/${filename}"
temporary_directory="$(mktemp -d)"
package_path="${temporary_directory}/${filename}"
trap 'rm -rf "${temporary_directory}"' EXIT

echo "Downloading Meeting Recorder ${version}..."
curl --fail --location --show-error --output "${package_path}" "${download_url}"
chmod 755 "${temporary_directory}"
chmod 644 "${package_path}"

echo "Installing ${filename}..."
if [ "$(id -u)" -eq 0 ]; then
  apt-get install --yes "${package_path}"
else
  need sudo
  sudo apt-get install --yes "${package_path}"
fi

enable_status=0
enable_extension_for_current_user || enable_status=$?

case "${enable_status}" in
  0)
    cat <<'EOF'
Meeting Recorder is installed and enabled for your user.

Log out and back in to make GNOME Shell load the extension.
EOF
    ;;
  *)
    cat <<'EOF'
Meeting Recorder is installed, but it could not be enabled automatically.

Log out and back in, then enable it with:
  gnome-extensions enable meeting-recorder@timokuehne.com
EOF
    ;;
esac
