#!/usr/bin/env bash
set -euo pipefail

# Reuse the database node's verified storage preflight and Docker installer,
# including when this entry point is downloaded and piped directly to bash.
export OPFIELD_DOCKER_MODE=storage
# legacy-name: pre-2.12.1 names of the variables for a setup-database-node.sh of a release before 2.12.1 (a pinned
# OPFIELD_SETUP_VERSION) — remove once the installers no longer install such a release
export GATEWAY_DOCKER_MODE=storage
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "$script_dir/setup-database-node.sh" ]]; then
    exec bash "$script_dir/setup-database-node.sh" "$@"
fi

command -v curl >/dev/null || { echo 'curl is required to fetch the node installer.' >&2; exit 1; }
# A release publishes this file with its own tag here, so the sibling installer comes from the same release.
INSTALLER_RELEASE=latest
# legacy-name: pre-2.12.1 names of the variables installer environment — customer automation; drop
# with a changelog notice (the OPFIELD_* name wins)
version="${OPFIELD_SETUP_VERSION:-${GATEWAY_SETUP_VERSION:-$INSTALLER_RELEASE}}"
base="${OPFIELD_RELEASE_DOWNLOAD_BASE:-${GATEWAY_RELEASE_DOWNLOAD_BASE:-https://get.opfield.dev/gateway/releases}}"
if [[ "$version" == latest ]]; then
    release_url="${base%/}/latest/download"
else
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || { echo 'Invalid release tag.' >&2; exit 1; }
    release_url="${base%/}/download/$version"
fi
stage=$(mktemp -d /tmp/opfield-setup-storage.XXXXXX)
trap 'rm -rf "$stage"' EXIT
# legacy-name: the legacy checksum list, the only checksum list of releases before 2.12.1 (a pinned
# OPFIELD_SETUP_VERSION) — remove once the installers no longer install such a release
curl -fsSL "$release_url/opfield-node-installers.sha256" -o "$stage/checksums" 2>/dev/null ||
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
if ! grep -Eq '^[[:space:]]*--opfield[|)]' "$stage/setup-database-node.sh"; then
    # legacy-name: --gateway flags for a setup-database-node.sh of a release before 2.12.1 (a pinned
    # OPFIELD_SETUP_VERSION) — remove once the installers no longer install such a release
    args=()
    for arg in "$@"; do
        case "$arg" in
            --opfield) args+=("--gateway") ;;
            --opfield-cert-sha256) args+=("--gateway-cert-sha256") ;;
            *) args+=("$arg") ;;
        esac
    done
    set -- ${args[@]+"${args[@]}"}
fi
bash "$stage/setup-database-node.sh" "$@"
