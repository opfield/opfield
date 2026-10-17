# Image repository a build or release publishes to and signs for. Sourced by scripts/github-release.sh and the
# Release workflow; the Image and Release workflows set the same defaults from repository variables.
#
#   OPFIELD_IMAGE          repository every build and release tag is pushed to (default ghcr.io/opfield/opfield)
#   OPFIELD_SIGNED_IMAGE   repository signed release manifests name, which installs pull from (default OPFIELD_IMAGE)

OPFIELD_IMAGE="${OPFIELD_IMAGE:-ghcr.io/opfield/opfield}"
OPFIELD_SIGNED_IMAGE="${OPFIELD_SIGNED_IMAGE:-$OPFIELD_IMAGE}"
export OPFIELD_IMAGE OPFIELD_SIGNED_IMAGE
