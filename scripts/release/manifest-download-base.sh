# shellcheck shell=bash
# The host that signed update manifests (daemon binaries, relay supervisor/worker, witness binaries) name as their
# downloadUrl. Sourced by scripts/github-release.sh and scripts/release/witness-artifacts.sh.
#
# The Opfield namespace of get.opfield.dev. Installed backends accept a daemon manifest naming its artifact under it
# (UPDATES_BASE_URL in packages/backend/src/config/vendor-urls.ts), and daemons download the URL the manifest names.
# Guarded by release-manifest-host.test.ts.
MANIFEST_DOWNLOAD_BASE_URL="https://get.opfield.dev/opfield"
