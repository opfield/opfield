#!/usr/bin/env bash
# Builds one downloadable PostgreSQL extension bundle (packages/daemons/postgres-image/bundle) for one PostgreSQL major.
# The base is the official image of the oldest catalog version of that major
# (packages/daemons/docker/internal/pgext/catalog/versions.json); every catalog version of a major shares its Debian release.
#   scripts/build-postgres-bundle.sh --resolve <id> <major>
#       prints "<base> <debian> <package version> <bundle version>": what PGDG serves now for the bundle's first package
#   scripts/build-postgres-bundle.sh <id> <major> [tag]
#       local bundle for this machine's platform, loaded into Docker
#   scripts/build-postgres-bundle.sh --push <tag> <id> <major> <package version>
#       multi-arch bundle pushed as <tag> (CI), the first package pinned to <package version>
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
context="$repo/packages/daemons/postgres-image/bundle"
versions="$repo/packages/daemons/docker/internal/pgext/catalog/versions.json"
list="$context/bundles.list"

base_of() {
  jq -er --arg m "$1" '[.versions[] | select(.major == $m)] | sort_by(.version | split(".") | map(tonumber)) | first | .base' "$versions" || {
    echo "PostgreSQL $1 is not in $versions" >&2
    exit 1
  }
}
debian_of() {
  jq -er --arg m "$1" '[.versions[] | select(.major == $m) | .debian] | unique | if length == 1 then .[0] else error("several Debian releases") end' "$versions"
}
field() { # field <id> <column 2=requires 3..=packages>
  awk -v id="$1" -v col="$2" '$1 == id { if (col == 3) { out = $3; for (i = 4; i <= NF; i++) out = out " " $i; print out } else print $col; found = 1 } END { exit !found }' "$list" || {
    echo "bundle $1 is not in $list" >&2
    exit 1
  }
}
requires_of() { local r; r="$(field "$1" 2)"; [[ "$r" == "-" ]] || echo "$r"; }
requires_packages() {
  local id out=""
  for id in $(requires_of "$1"); do
    out="$out $(requires_packages "$id") $(field "$id" 3)"
  done
  echo "$out" | xargs
}
build_args() { # build_args <id> <major> <package version>
  args=(
    --build-arg "BASE=$(base_of "$2")"
    --build-arg "BUNDLE_ID=$1"
    --build-arg "BUNDLE_PACKAGES=$(field "$1" 3)"
    --build-arg "BUNDLE_PACKAGE_VERSION=$3"
    --build-arg "BUNDLE_REQUIRES=$(requires_of "$1" | xargs)"
    --build-arg "BUNDLE_REQUIRES_PACKAGES=$(requires_packages "$1")"
  )
}

case "${1:-}" in
  --resolve)
    id="${2:?usage: $0 --resolve <id> <major>}"
    major="${3:?usage: $0 --resolve <id> <major>}"
    base="$(base_of "$major")"
    package="$(field "$id" 3 | awk '{ print $1 }')"
    package="${package//\{major\}/$major}"
    package_version="$(docker run --rm --entrypoint bash "$base" -c \
      "apt-get update -qq >/dev/null && apt-cache show --no-all-versions '$package' | awk '/^Version:/ { print \$2; exit }'")"
    [[ -n "$package_version" ]] || { echo "PGDG has no $package" >&2; exit 1; }
    echo "$base $(debian_of "$major") $package_version $(echo "$package_version" | sed -E 's/^[0-9]+://; s/[-+~].*$//')"
    ;;
  --push)
    tag="${2:?usage: $0 --push <tag> <id> <major> <package version>}"
    build_args "${3:?}" "${4:?}" "${5:?}"
    exec docker buildx build \
      --platform linux/amd64,linux/arm64 \
      "${args[@]}" \
      --tag "$tag" \
      --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-opfield/opfield}" \
      --provenance=false \
      --sbom=false \
      --push "$context"
    ;;
  *)
    id="${1:?usage: $0 <id> <major> [tag]}"
    major="${2:?usage: $0 <id> <major> [tag]}"
    build_args "$id" "$major" ""
    # DOCKER_BUILD_NETWORK=host for a Docker engine without a bridge network (the build fetches from PGDG).
    if [[ -n "${DOCKER_BUILD_NETWORK:-}" ]]; then args+=(--network "$DOCKER_BUILD_NETWORK"); fi
    exec docker buildx build --load "${args[@]}" --tag "${3:-opfield-postgres-ext-$id:pg$major-local}" "$context"
    ;;
esac
