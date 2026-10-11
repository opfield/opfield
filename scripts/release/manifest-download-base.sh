# shellcheck shell=bash
# The host that signed update manifests (daemon binaries, relay supervisor/worker, witness binaries) name as their
# downloadUrl. Sourced by scripts/github-release.sh and scripts/release/witness-artifacts.sh.
#
# It stays updates.thesqlabs.com: installs update from 2.11.4 straight to 2.12, and a 2.11.4 backend accepts a
# daemon manifest only when its downloadUrl equals the artifact under its own updates.thesqlabs.com base.
# get.opfield.dev serves the same bytes. Switch to https://get.opfield.dev/gateway only in a release after which
# every supported component is >= 2.12: all components >= 2.12 accept both hosts (LEGACY_UPDATES_BASE_URLS in
# packages/backend/src/config/vendor-urls.ts). Guarded by release-manifest-host.test.ts.
MANIFEST_DOWNLOAD_BASE_URL="https://updates.thesqlabs.com/gateway"
