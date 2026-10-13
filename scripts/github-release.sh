#!/usr/bin/env bash

set -euo pipefail

tag=${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}
commit_sha=${GITHUB_SHA:?GITHUB_SHA is required}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
# Primary repository, mirror and the repository signed manifests name (installs pull it): see
# scripts/release/image-repositories.sh.
# shellcheck source=release/image-repositories.sh
source scripts/release/image-repositories.sh
opfield_image="$OPFIELD_IMAGE"
opfield_image_mirror="$OPFIELD_IMAGE_MIRROR"
signed_image="$OPFIELD_SIGNED_IMAGE"
source_url="https://github.com/${repository}"

release_notes_file=release-notes.md
release_already_published=0

source scripts/release-tag.sh
# shellcheck source=release/manifest-download-base.sh
source scripts/release/manifest-download-base.sh
classify_release_tag "$tag"

# Only a stable Gateway release is the repository's Latest: releases/latest/download serves the
# Gateway installers, which a component release does not carry.
latest_args=(--latest=false)
if [[ "$RELEASE_KIND" == "opfield" && "$RELEASE_PRERELEASE" != "true" ]]; then
  latest_args=(--latest)
fi

write_release_notes() {
  local fallback=$1
  git for-each-ref "refs/tags/${tag}" --format='%(contents)' > "$release_notes_file"
  if ! grep -q '[^[:space:]]' "$release_notes_file"; then
    printf '%s\n' "$fallback" > "$release_notes_file"
  fi
}

prepare_release() {
  local title=$1 fallback=$2 is_draft
  local release_args=(--title "$title" --notes-file "$release_notes_file")
  release_already_published=0
  write_release_notes "$fallback"
  if [[ "$RELEASE_PRERELEASE" == "true" ]]; then
    release_args+=(--prerelease --latest=false)
  elif [[ "$RELEASE_KIND" == "opfield" ]]; then
    release_args+=(--prerelease=false)
  else
    release_args+=(--prerelease=false --latest=false)
  fi
  if gh release view "$tag" >/dev/null 2>&1; then
    is_draft=$(gh release view "$tag" --json isDraft --jq .isDraft)
    if [[ "$is_draft" != "true" ]]; then
      release_already_published=1
      return
    fi
    gh release edit "$tag" "${release_args[@]}"
    return
  fi
  gh release create "$tag" --draft --verify-tag "${release_args[@]}"
}

verify_release_assets() {
  local asset expected actual_assets
  actual_assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
  for asset in "$@"; do
    expected=$(basename "$asset")
    if ! grep -Fxq "$expected" <<<"$actual_assets"; then
      printf 'GitHub Release %s is missing expected asset %s\n' "$tag" "$expected" >&2
      exit 1
    fi
  done
}

complete_release() {
  if [[ "$release_already_published" -eq 1 ]]; then
    verify_release_assets "$@"
    printf 'GitHub Release %s is already complete\n' "$tag"
    return
  fi
  if (($# > 0)); then
    gh release upload "$tag" "$@" --clobber
  fi
  verify_release_assets "$@"
  gh release edit "$tag" --draft=false "${latest_args[@]}"
}

docker_login() {
  test -n "${GH_TOKEN:-}" || { printf 'GH_TOKEN is required\n' >&2; exit 1; }
  # GHCR_PUSH_TOKEN (secret): a token that can write packages in both organizations, needed once the repository lives
  # in another organization than opfield_image or opfield_image_mirror.
  printf '%s' "${GHCR_PUSH_TOKEN:-$GH_TOKEN}" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
}

# mirror_image <primary repository> <digest> <tag>...: copies a pushed image to the mirror repository.
mirror_image() {
  [[ -n "$opfield_image_mirror" ]] || return 0
  local image=$1 digest=$2 target t
  shift 2
  target="${opfield_image_mirror}${image#"$opfield_image"}"
  # skopeo keeps the manifest as it is, so the mirror tag has the signed digest. buildx imagetools create would wrap a
  # single-platform manifest in a new index with another digest that carries no signature.
  for t in "$@"; do
    skopeo copy --all --preserve-digests "docker://${image}@${digest}" "docker://${target}:${t}"
  done
  printf 'Mirrored %s@%s to %s\n' "$image" "$digest" "$target"
}

require_signing_key() {
  test -n "${UPDATE_SIGNING_PRIVATE_KEY_PEM_B64:-}" || {
    printf 'UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 is required for signed releases\n' >&2
    exit 1
  }
}

# Keyless image signatures and SBOMs (scripts/release/supply-chain.sh, docs/verify-releases.md), on when the
# repository variable SIGN_IMAGES is true. The workflow installs cosign and syft first.
signing_enabled() {
  [[ "${SIGN_IMAGES:-}" == "true" ]]
}

# binary_sboms <binary>...: writes <binary>.spdx.json next to each release binary.
binary_sboms() {
  local binary
  for binary in "$@"; do
    scripts/release/supply-chain.sh sbom-file "$binary" "${binary}.spdx.json"
  done
}

push_image_with_digest() {
  local image_ref=$1 digest_file=$2 label=$3
  sh scripts/push-image-with-digest.sh "$image_ref" "$digest_file" "$label"
}

publish_opfield() {
  local digest
  local installers_dir=release-installers
  ./scripts/stage-installers.sh "$tag" "$installers_dir"
  local assets=(CONTINUITY-GRANT.md gateway-image.update.json "$installers_dir"/*)
  prepare_release "Opfield ${tag}" "Opfield release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi
  require_signing_key
  node scripts/verify-continuity-grant.mjs
  docker_login
  ./scripts/sync-update-trust-anchor.sh
  docker build \
    --tag "${opfield_image}:${tag}" \
    --build-arg "APP_VERSION=${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    .
  push_image_with_digest "${opfield_image}:${tag}" opfield-image.digest "Opfield image"
  digest=$(<opfield-image.digest)
  (
    cd packages/daemons
    go run ./shared/cmd/update-trust sign \
      --kind gateway-image \
      --version "$tag" \
      --tag "$tag" \
      --image "$signed_image" \
      --digest "$digest" \
      --git-commit-sha "$commit_sha" \
      --git-pipeline-id "$run_id" \
      --out ../../gateway-image.update.json
  )
  docker tag "${opfield_image}:${tag}" "${opfield_image}:${tag#v}"
  docker push "${opfield_image}:${tag#v}"
  local mirror_tags=("$tag" "${tag#v}")
  if [[ "$RELEASE_PRERELEASE" != "true" ]]; then
    docker tag "${opfield_image}:${tag}" "${opfield_image}:latest"
    docker push "${opfield_image}:latest"
    mirror_tags+=(latest)
  fi
  mirror_image "$opfield_image" "$digest" "${mirror_tags[@]}"
  complete_release "${assets[@]}"
}

build_daemon_assets() {
  local daemon_dir=$1 daemon_name=$2 daemon_suffix=$3 ldflags_version_pkg=$4
  local version=${tag%-${daemon_suffix}}
  local arch artifact sha

  ./scripts/sync-update-trust-anchor.sh
  (
    cd "packages/daemons/${daemon_dir}"
    for arch in amd64 arm64; do
      CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
        -ldflags "-s -w -X ${ldflags_version_pkg}.Version=${version}" \
        -o "../../../${daemon_name}-linux-${arch}" \
        "./cmd/${daemon_name}"
    done
  )
  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      (
        cd packages/relay
        CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
          -ldflags "-s -w -X main.buildVersion=${version}" \
          -o "../../relay-worker-linux-${arch}" \
          ./cmd/opfield-relay
      )
    done
  fi

  : > checksums.txt
  for arch in amd64 arm64; do
    sha256sum "${daemon_name}-linux-${arch}" >> checksums.txt
  done
  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      sha256sum "relay-worker-linux-${arch}" >> checksums.txt
    done
  fi

  for arch in amd64 arm64; do
    artifact="${daemon_name}-linux-${arch}"
    sha=$(sha256sum "$artifact" | awk '{print $1}')
    (
      cd packages/daemons
      go run ./shared/cmd/update-trust sign \
        --kind daemon-binary \
        --version "$version" \
        --tag "$tag" \
        --daemon-type "$daemon_suffix" \
        --arch "$arch" \
        --artifact-name "$artifact" \
        --download-url "${MANIFEST_DOWNLOAD_BASE_URL}/${daemon_name}/${tag}/${artifact}" \
        --sha256 "$sha" \
        --git-commit-sha "$commit_sha" \
        --git-pipeline-id "$run_id" \
        --out "../../${artifact}.update.json"
    )
  done

  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      artifact="relay-worker-linux-${arch}"
      sha=$(sha256sum "$artifact" | awk '{print $1}')
      (
        cd packages/daemons
        go run ./shared/cmd/update-trust sign \
          --kind daemon-binary \
          --version "$version" \
          --tag "$tag" \
          --daemon-type relay-worker \
          --arch "$arch" \
          --artifact-name "$artifact" \
          --download-url "${MANIFEST_DOWNLOAD_BASE_URL}/relay-supervisor/${tag}/${artifact}" \
          --sha256 "$sha" \
          --git-commit-sha "$commit_sha" \
          --git-pipeline-id "$run_id" \
          --out "../../${artifact}.update.json"
      )
    done
  fi
}

publish_daemon() {
  local daemon_dir=$1 daemon_name=$2 daemon_suffix=$3 daemon_label=$4 ldflags_version_pkg=$5
  local assets=(checksums.txt)
  local arch
  for arch in amd64 arm64; do
    assets+=("${daemon_name}-linux-${arch}" "${daemon_name}-linux-${arch}.update.json")
  done
  prepare_release "${daemon_label} ${tag}" "${daemon_label} release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi
  require_signing_key
  ./scripts/sync-update-trust-anchor.sh
  build_daemon_assets "$daemon_dir" "$daemon_name" "$daemon_suffix" "$ldflags_version_pkg"
  if signing_enabled; then
    for arch in amd64 arm64; do
      binary_sboms "${daemon_name}-linux-${arch}"
      assets+=("${daemon_name}-linux-${arch}.spdx.json")
    done
  fi
  complete_release "${assets[@]}"
}

publish_relay() {
  local relay_version=${tag%-relay}
  local relay_image="${opfield_image}/relay"
  local secure_link_image="${opfield_image}/secure-link-connector"
  local relay_digest secure_link_digest min_gateway_version arch
  local assets=(relay-image.update.json checksums.txt)

  for arch in amd64 arm64; do
    assets+=(
      "relay-supervisor-linux-${arch}"
      "relay-supervisor-linux-${arch}.update.json"
      "relay-worker-linux-${arch}"
      "relay-worker-linux-${arch}.update.json"
    )
  done
  prepare_release "Opfield Relay ${tag}" "Opfield Relay release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi

  require_signing_key
  docker_login
  ./scripts/sync-update-trust-anchor.sh

  docker build \
    --file packages/relay/Dockerfile \
    --build-arg "RELAY_BUILD_VERSION=${relay_version}" \
    --tag "${relay_image}:${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    .
  push_image_with_digest "${relay_image}:${tag}" relay-image.digest "relay image"

  docker build \
    --file packages/daemons/secure-link-connector/Dockerfile \
    --tag "${secure_link_image}:${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    packages/daemons
  push_image_with_digest "${secure_link_image}:${tag}" secure-link-connector.digest "secure-link connector image"

  relay_digest=$(<relay-image.digest)
  secure_link_digest=$(<secure-link-connector.digest)
  min_gateway_version=$(<config/relay/min-gateway-version)
  (
    cd packages/daemons
    go run ./shared/cmd/update-trust sign \
      --kind relay-image \
      --version "$relay_version" \
      --tag "$tag" \
      --image "${signed_image}/relay" \
      --digest "$relay_digest" \
      --relay-protocol-major 1 \
      --min-gateway-version "$min_gateway_version" \
      --secure-link-connector-image "${signed_image}/secure-link-connector@${secure_link_digest}" \
      --git-commit-sha "$commit_sha" \
      --git-pipeline-id "$run_id" \
      --out ../../relay-image.update.json
  )

  build_daemon_assets relay relay-supervisor relay "main"
  docker tag "${relay_image}:${tag}" "${relay_image}:${relay_version}"
  docker push "${relay_image}:${relay_version}"
  local mirror_tags=("$tag" "$relay_version")
  if [[ "$RELEASE_PRERELEASE" != "true" ]]; then
    docker tag "${relay_image}:${tag}" "${relay_image}:latest"
    docker push "${relay_image}:latest"
    mirror_tags+=(latest)
  fi
  mirror_image "$relay_image" "$relay_digest" "${mirror_tags[@]}"
  mirror_image "$secure_link_image" "$secure_link_digest" "$tag"
  if signing_enabled; then
    local relay_also=() connector_also=() binary
    if [[ -n "$opfield_image_mirror" ]]; then
      relay_also=(--also "${opfield_image_mirror}/relay")
      connector_also=(--also "${opfield_image_mirror}/secure-link-connector")
    fi
    scripts/release/supply-chain.sh sign "${relay_image}@${relay_digest}" \
      --sbom "relay-${tag}.spdx.json" "${relay_also[@]}"
    scripts/release/supply-chain.sh sign "${secure_link_image}@${secure_link_digest}" \
      --sbom "secure-link-connector-${tag}.spdx.json" "${connector_also[@]}"
    assets+=("relay-${tag}.spdx.json" "secure-link-connector-${tag}.spdx.json")
    for arch in amd64 arm64; do
      for binary in relay-supervisor relay-worker; do
        binary_sboms "${binary}-linux-${arch}"
        assets+=("${binary}-linux-${arch}.spdx.json")
      done
    done
  fi
  complete_release "${assets[@]}"
}

if [[ "$RELEASE_KIND" == "opfield" ]]; then
  publish_opfield
elif [[ "$RELEASE_COMPONENT" == "relay" ]]; then
  publish_relay
elif [[ "$RELEASE_COMPONENT" == "nginx" ]]; then
  publish_daemon nginx nginx-daemon nginx "Nginx Daemon" github.com/opfield/opfield/nginx-daemon/internal/daemon
elif [[ "$RELEASE_COMPONENT" == "docker" ]]; then
  publish_daemon docker docker-daemon docker "Docker Daemon" main
elif [[ "$RELEASE_COMPONENT" == "monitoring" ]]; then
  publish_daemon monitoring monitoring-daemon monitoring "Monitoring Daemon" main
elif [[ "$RELEASE_COMPONENT" == "watchdog" ]]; then
  # The lease watchdog is released independently of docker-daemon (A12.5).
  publish_daemon lease-watchdog lease-watchdog watchdog "Lease Watchdog" main
else
  printf 'Tag %s is not a supported Opfield release tag\n' "$tag" >&2
  exit 1
fi
