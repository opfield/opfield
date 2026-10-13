#!/usr/bin/env bash

classify_release_tag() {
  local tag=${1:?release tag is required}
  local component_pattern='relay|nginx|docker|monitoring|watchdog'

  RELEASE_KIND=''
  RELEASE_COMPONENT=''
  RELEASE_VERSION=''
  RELEASE_PRERELEASE='false'

  if [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-rc\.([0-9]+))?$ ]]; then
    RELEASE_KIND='opfield'
    RELEASE_VERSION="$tag"
    [[ -n "${BASH_REMATCH[2]}" ]] && RELEASE_PRERELEASE='true'
  elif [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-rc\.([0-9]+))?-(${component_pattern})$ ]]; then
    RELEASE_KIND='component'
    RELEASE_COMPONENT="${BASH_REMATCH[4]}"
    RELEASE_VERSION="${tag%-${RELEASE_COMPONENT}}"
    [[ -n "${BASH_REMATCH[2]}" ]] && RELEASE_PRERELEASE='true'
  else
    printf 'Tag %s is not a supported Opfield release tag\n' "$tag" >&2
    return 1
  fi

  export RELEASE_KIND RELEASE_COMPONENT RELEASE_VERSION RELEASE_PRERELEASE
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  classify_release_tag "${1:?release tag is required}"
  printf 'kind=%s\n' "$RELEASE_KIND"
  printf 'component=%s\n' "$RELEASE_COMPONENT"
  printf 'version=%s\n' "$RELEASE_VERSION"
  printf 'prerelease=%s\n' "$RELEASE_PRERELEASE"
fi
