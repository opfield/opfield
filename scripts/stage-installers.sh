#!/usr/bin/env bash
# Stages the installers an Opfield release publishes into a directory: the server installer (install.sh, which
# get.opfield.dev serves for the latest stable release), every installer Opfield's setup commands reference, the
# wrappers stamped with the release tag so they fetch their sibling installers from the same release, and
# opfield-node-installers.sha256 over the staged files.
#
# Usage: scripts/stage-installers.sh <vX.Y.Z[-rc.N]> <directory>

set -euo pipefail

tag=${1:?release tag is required}
out=${2:?output directory is required}
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || {
  printf 'Tag %s is not an Opfield release tag\n' "$tag" >&2
  exit 1
}

installers=(
  install.sh
  setup-daemon.sh
  setup-node.sh
  setup-docker-node.sh
  setup-database-node.sh
  setup-storage-node.sh
  setup-monitoring-node.sh
  setup-relay-node.sh
)
# Installers that download sibling installers; each carries one INSTALLER_RELEASE=latest line.
wrappers=(setup-daemon.sh setup-database-node.sh setup-storage-node.sh)

scripts_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$out"
# Every installer runs on its own (curl | bash), so the compatibility include it sources from a checkout is put in
# place of that line.
include_line='. "$(dirname -- "${BASH_SOURCE[0]}")/legacy-compat.sh"'
for installer in "${installers[@]}"; do
  if grep -qxF "$include_line" "${scripts_dir}/${installer}"; then
    awk -v line="$include_line" -v incfile="${scripts_dir}/legacy-compat.sh" '
      $0 == line { while ((getline l < incfile) > 0) print l; close(incfile); next }
      { print }
    ' "${scripts_dir}/${installer}" >"${out}/${installer}"
    chmod 755 "${out}/${installer}"
  else
    cp "${scripts_dir}/${installer}" "${out}/${installer}"
  fi
done
for wrapper in "${wrappers[@]}"; do
  sed -i "s/^INSTALLER_RELEASE=latest\$/INSTALLER_RELEASE=${tag}/" "${out}/${wrapper}"
  if [[ "$(grep -c '^INSTALLER_RELEASE=' "${out}/${wrapper}")" != 1 ]] ||
    ! grep -qx "INSTALLER_RELEASE=${tag}" "${out}/${wrapper}"; then
    printf '%s does not take its sibling installers from %s\n' "$wrapper" "$tag" >&2
    exit 1
  fi
done
(cd "$out" && sha256sum "${installers[@]}") > "${out}/opfield-node-installers.sha256"
