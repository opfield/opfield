---
{
  "id": "lvklfxgs",
  "file_name": "lvklfxgs_gateway_release_upgrade",
  "tags": [
    "docker-compose",
    "e2e",
    "opfield",
    "release",
    "upgrade"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.94,
  "created_at": 1786843016045,
  "updated_at": 1791851736887
}
---
Before a stable Opfield tag, run `pnpm test:release-upgrade -- --candidate vX.Y.Z[-rc.N] --ssh root@<disposable host>` (or run `scripts/release-upgrade-e2e.sh` as root on the host; `--help` lists options). It is one self-contained bash file with embedded Python helpers, about 8 minutes per run, and exits non-zero on any FAIL. First passing run: v2.10.1 -> v2.11.0-rc.35, 108 PASS, 0 FAIL (paid path skipped without a license key).

What it does: installs the base stable (default v2.10.1) with that tag's own install.sh and node installers, completes setup through the API (Mailpit with its own CA via NODE_EXTRA_CA_CERTS, because password sign-in needs a verified SMTP), seeds a custom group with retired 2.10 scope names (plain and node/proxy-qualified), a user with additional scopes, an API token, an uploaded certificate, webhook + alert rule, docker and nginx nodes, a container and a proxy host with a health check; updates through /api/system/check-update + /api/system/update while probing /health and the route every second; checks sessions, token, effective access (GET /api/admin/users scopes, group, token), certificate, rule, foundation containers not recreated; updates daemons (/api/system/daemon-updates/{node}) and relay (/api/system/relay-update), expects the lease watchdog unit; runs the base updater's own sidecar rollback() (extracted from the base app's dist/services/update.service.js, forced failure) on the migrated DB, checks license policy not invalid, POST /api/nodes 201, scopes not lost, Pages insert with the base column set; updates again and requires identical effective access; then installs the candidate fresh (RC candidates: the installer's stable-only tag regexes are widened as a test-only patch) and completes setup and sign-in. `GATEWAY_E2E_LICENSE_KEY` adds the paid path (private core downloaded and loaded after the update).

Mechanics worth knowing: a local release-feed mock pins gateway/relay tags and forwards other components to the real feed for the channel without `current`; artifacts and signatures stay real. A local DNS forwarder set as Docker daemon.json "dns" answers NXDOMAIN for the license server; Community Opfield updates need the license server (the target image's migrate-legacy-settings authorizes the update strictly, even for Community), so by default the block opens only during Opfield updates (one Community registration per run, named after the public URL host gateway-e2e-<run>.invalid); `--license-server block-all` shows the refused update. Cleanup snapshots the host first and removes only what the run's installers created (apt history entries of those installers, product-named paths, units, users, interfaces, nft ruleset restore) and restores pre-existing product-named entries from a tar. The scope fixture at the top of the script is specific to the 2.10 -> 2.11 catalog cleanup; adjust it with the next catalog change. API token scopes must avoid programmatic-denied names (e.g. nodes:config:edit).
