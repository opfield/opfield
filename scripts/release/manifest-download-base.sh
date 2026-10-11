# shellcheck shell=bash
# The host that signed update manifests (daemon binaries, relay supervisor/worker, witness binaries) name as their
# downloadUrl. Sourced by scripts/github-release.sh and scripts/release/witness-artifacts.sh.
#
# get.opfield.dev. The earlier name updates.thesqlabs.com serves the same bytes and stays served. A backend from
# 2.11.5 on accepts a daemon manifest naming its artifact under either host (LEGACY_UPDATES_BASE_URLS in
# packages/backend/src/config/vendor-urls.ts); the update feed takes every 2.11 install to 2.11.5 before 2.12.
# A 2.11.4 backend accepts only its own updates.thesqlabs.com base. Guarded by release-manifest-host.test.ts.
MANIFEST_DOWNLOAD_BASE_URL="https://get.opfield.dev/gateway"
