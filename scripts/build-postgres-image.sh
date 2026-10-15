#!/usr/bin/env bash
# Builds Opfield's managed PostgreSQL image (packages/daemons/postgres-image/image) for one catalog version of
# packages/daemons/docker/internal/pgext/catalog/versions.json.
#   scripts/build-postgres-image.sh <version> [tag]          local image for this machine's platform, loaded into Docker
#   scripts/build-postgres-image.sh --push <tag> <version>   multi-arch image pushed as <tag> (CI)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
context="$repo/packages/daemons/postgres-image/image"
versions="$repo/packages/daemons/docker/internal/pgext/catalog/versions.json"

base_of() {
  local base
  base="$(jq -er --arg v "$1" '.versions[] | select(.version == $v) | .base' "$versions")" || {
    echo "version $1 is not in $versions" >&2
    exit 1
  }
  echo "$base"
}

if [[ "${1:-}" == "--push" ]]; then
  tag="${2:?usage: $0 --push <image:tag> <version>}"
  version="${3:?usage: $0 --push <image:tag> <version>}"
  exec docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg "BASE=$(base_of "$version")" \
    --tag "$tag" \
    --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-opfield/opfield}" \
    --label "org.opencontainers.image.version=$version" \
    --provenance=false \
    --sbom=false \
    --push "$context"
fi
version="${1:?usage: $0 <version> [tag]}"
# DOCKER_BUILD_NETWORK=host for a Docker engine without a bridge network (the RUN steps fetch from PGDG).
network=()
if [[ -n "${DOCKER_BUILD_NETWORK:-}" ]]; then network=(--network "$DOCKER_BUILD_NETWORK"); fi
exec docker buildx build --load "${network[@]}" \
  --build-arg "BASE=$(base_of "$version")" \
  --tag "${2:-opfield-postgres:$version-local}" \
  "$context"
