#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="tnkuehne/heimdall"
PACKAGE="meeting-recorder"
RELEASES_URL="https://github.com/${REPOSITORY}/releases"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
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

cat <<'EOF'
Meeting Recorder is installed.

Log out and back in to make GNOME Shell load the extension. Then enable it with:
  gnome-extensions enable meeting-recorder@timokuehne.com
EOF
