#!/usr/bin/env bash
# Builds Opfield's patched SeaweedFS runtime image (packages/daemons/seaweedfs-image).
#   scripts/build-seaweedfs-image.sh                 local image for this machine's platform, loaded into Docker
#   scripts/build-seaweedfs-image.sh --push <tag>    multi-arch image pushed as <tag> (CI)
set -euo pipefail
context="$(cd "$(dirname "$0")/.." && pwd)/packages/daemons/seaweedfs-image"
if [[ "${1:-}" == "--push" ]]; then
  tag="${2:?usage: $0 --push <image:tag>}"
  exec docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "$tag" \
    --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:-opfield/opfield}" \
    --provenance=false \
    --sbom=false \
    --push "$context"
fi
exec docker buildx build --load --tag "${1:-opfield-seaweedfs:local}" "$context"
