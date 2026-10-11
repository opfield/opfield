# Image repositories a build or release publishes to and signs for. Sourced by scripts/github-release.sh and the
# Release workflow; the Image and Release workflows set the same defaults from repository variables.
#
#   OPFIELD_GHCR=true      the opfield organization publishes images (repository variable): ghcr.io/opfield/opfield
#                          becomes the primary repository and ghcr.io/the-square-labs/gateway its mirror
#   GATEWAY_IMAGE          primary repository: every build and release tag is pushed here
#   GATEWAY_IMAGE_MIRROR   second repository that receives every release tag with the same digest (empty: none)
#   GATEWAY_SIGNED_IMAGE   repository signed release manifests name, which installs pull from. Defaults to
#                          GATEWAY_IMAGE: ghcr.io/opfield/opfield once the opfield organization publishes. Installs
#                          from 2.11.5 accept both official repositories, and the update feed takes every 2.11 install
#                          to 2.11.5 before 2.12; the earlier repository stays a published mirror for installs that
#                          still name it.

LEGACY_GATEWAY_IMAGE=ghcr.io/the-square-labs/gateway
OPFIELD_GATEWAY_IMAGE=ghcr.io/opfield/opfield

if [[ "${OPFIELD_GHCR:-}" == "true" ]]; then
  GATEWAY_IMAGE="${GATEWAY_IMAGE:-$OPFIELD_GATEWAY_IMAGE}"
  GATEWAY_IMAGE_MIRROR="${GATEWAY_IMAGE_MIRROR:-$LEGACY_GATEWAY_IMAGE}"
else
  GATEWAY_IMAGE="${GATEWAY_IMAGE:-$LEGACY_GATEWAY_IMAGE}"
  GATEWAY_IMAGE_MIRROR="${GATEWAY_IMAGE_MIRROR:-}"
fi
GATEWAY_SIGNED_IMAGE="${GATEWAY_SIGNED_IMAGE:-$GATEWAY_IMAGE}"
if [[ "$GATEWAY_IMAGE_MIRROR" == "$GATEWAY_IMAGE" ]]; then
  printf 'GATEWAY_IMAGE_MIRROR must differ from GATEWAY_IMAGE (%s)\n' "$GATEWAY_IMAGE" >&2
  exit 1
fi
if [[ "$GATEWAY_SIGNED_IMAGE" != "$GATEWAY_IMAGE" && "$GATEWAY_SIGNED_IMAGE" != "$GATEWAY_IMAGE_MIRROR" ]]; then
  printf 'GATEWAY_SIGNED_IMAGE %s is neither GATEWAY_IMAGE nor GATEWAY_IMAGE_MIRROR\n' "$GATEWAY_SIGNED_IMAGE" >&2
  exit 1
fi
export GATEWAY_IMAGE GATEWAY_IMAGE_MIRROR GATEWAY_SIGNED_IMAGE
