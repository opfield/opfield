#!/usr/bin/env bash
set -euo pipefail

# Reuse the database node's verified storage preflight and Docker installer,
# including when this entry point is downloaded and piped directly to bash.
export GATEWAY_DOCKER_MODE=storage
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "$script_dir/setup-database-node.sh" ]]; then
    exec bash "$script_dir/setup-database-node.sh" "$@"
fi

command -v curl >/dev/null || { echo 'curl is required to fetch the node installer.' >&2; exit 1; }
# A release publishes this file with its own tag here, so the sibling installer comes from the same release.
INSTALLER_RELEASE=latest
version="${GATEWAY_SETUP_VERSION:-$INSTALLER_RELEASE}"
base="${GATEWAY_RELEASE_DOWNLOAD_BASE:-https://get.opfield.dev/gateway/releases}"
if [[ "$version" == latest ]]; then
    release_url="${base%/}/latest/download"
else
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || { echo 'Invalid release tag.' >&2; exit 1; }
    release_url="${base%/}/download/$version"
fi
stage=$(mktemp -d /tmp/gateway-setup-storage.XXXXXX)
trap 'rm -rf "$stage"' EXIT
curl -fsSL "$release_url/gateway-daemon-installers.sha256" -o "$stage/checksums"
curl -fsSL "$release_url/setup-database-node.sh" -o "$stage/setup-database-node.sh"
expected=$(awk '$2 == "setup-database-node.sh" { print $1 }' "$stage/checksums")
if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$stage/setup-database-node.sh" | awk '{print $1}')
elif command -v shasum >/dev/null; then
    actual=$(shasum -a 256 "$stage/setup-database-node.sh" | awk '{print $1}')
else
    actual=$(openssl dgst -sha256 "$stage/setup-database-node.sh" | awk '{print $NF}')
fi
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { echo 'Checksum verification failed for setup-database-node.sh.' >&2; exit 1; }
bash "$stage/setup-database-node.sh" "$@"
