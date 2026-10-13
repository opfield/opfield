# Image repositories a build or release publishes to and signs for. Sourced by scripts/github-release.sh and the
# Release workflow; the Image and Release workflows set the same defaults from repository variables.
#
#   OPFIELD_GHCR=true      the opfield organization publishes images (repository variable): ghcr.io/opfield/opfield
#                          becomes the primary repository and ghcr.io/the-square-labs/gateway its mirror
#   OPFIELD_IMAGE          primary repository: every build and release tag is pushed here
#   OPFIELD_IMAGE_MIRROR   second repository that receives every release tag with the same digest (empty: none)
#   OPFIELD_SIGNED_IMAGE   repository signed release manifests name, which installs pull from. Defaults to
#                          OPFIELD_IMAGE: ghcr.io/opfield/opfield once the opfield organization publishes. Installs
#                          from 2.11.5 accept both official repositories, and the update feed takes every 2.11 install
#                          to 2.11.5 before 2.12; the earlier repository stays a published mirror for installs that
#                          still name it.

LEGACY_IMAGE_REPOSITORY=ghcr.io/the-square-labs/gateway
OPFIELD_IMAGE_REPOSITORY=ghcr.io/opfield/opfield

# legacy-name: GATEWAY_IMAGE, GATEWAY_IMAGE_MIRROR and GATEWAY_SIGNED_IMAGE, the names repository variables and forks
# set before 2.12.1; each is read when its OPFIELD_* name is unset — remove once the repository variables are renamed.
OPFIELD_IMAGE="${OPFIELD_IMAGE:-${GATEWAY_IMAGE:-}}"
OPFIELD_IMAGE_MIRROR="${OPFIELD_IMAGE_MIRROR-${GATEWAY_IMAGE_MIRROR-}}"
OPFIELD_SIGNED_IMAGE="${OPFIELD_SIGNED_IMAGE:-${GATEWAY_SIGNED_IMAGE:-}}"

if [[ "${OPFIELD_GHCR:-}" == "true" ]]; then
  OPFIELD_IMAGE="${OPFIELD_IMAGE:-$OPFIELD_IMAGE_REPOSITORY}"
  OPFIELD_IMAGE_MIRROR="${OPFIELD_IMAGE_MIRROR:-$LEGACY_IMAGE_REPOSITORY}"
else
  OPFIELD_IMAGE="${OPFIELD_IMAGE:-$LEGACY_IMAGE_REPOSITORY}"
  OPFIELD_IMAGE_MIRROR="${OPFIELD_IMAGE_MIRROR:-}"
fi
OPFIELD_SIGNED_IMAGE="${OPFIELD_SIGNED_IMAGE:-$OPFIELD_IMAGE}"
if [[ "$OPFIELD_IMAGE_MIRROR" == "$OPFIELD_IMAGE" ]]; then
  printf 'OPFIELD_IMAGE_MIRROR must differ from OPFIELD_IMAGE (%s)\n' "$OPFIELD_IMAGE" >&2
  exit 1
fi
if [[ "$OPFIELD_SIGNED_IMAGE" != "$OPFIELD_IMAGE" && "$OPFIELD_SIGNED_IMAGE" != "$OPFIELD_IMAGE_MIRROR" ]]; then
  printf 'OPFIELD_SIGNED_IMAGE %s is neither OPFIELD_IMAGE nor OPFIELD_IMAGE_MIRROR\n' "$OPFIELD_SIGNED_IMAGE" >&2
  exit 1
fi
export OPFIELD_IMAGE OPFIELD_IMAGE_MIRROR OPFIELD_SIGNED_IMAGE
