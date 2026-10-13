# Opfield update service

Cloudflare Worker for the stable public Opfield update namespace at
`get.opfield.dev/gateway`. The same Worker keeps serving the earlier name `updates.thesqlabs.com/gateway`, which
releases up to 2.11 use; both answer identically.

It exposes:

- `GET /health`
- `GET /gateway/releases` (stable by default)
- `GET /gateway/releases?channel=stable|preview`
- `GET /gateway/releases?component=<package>&current=<version>&channel=stable|preview`
- `GET|HEAD /gateway/<package>/<tag>/<artifact>` for allow-listed signed Opfield artifacts
- `GET|HEAD /gateway/releases/download/<tag>/<installer>` and `/gateway/releases/latest/download/<installer>`: the
  installers an Opfield release carries (`install.sh`, `setup-*.sh`, `gateway-daemon-installers.sha256`), in GitHub's
  release download layout
- `GET|HEAD /` and `/install.sh`: `install.sh` of the latest stable release (cached for 5 minutes)
- `GET|HEAD /gateway/license-endpoints.json`: the signed list of license service addresses
  (`scripts/release/license-endpoints.mjs`), an asset of the latest stable release (cached for 5 minutes)

`stable` is the default and excludes GitHub prereleases. `preview` additionally accepts release-candidate tags such as `v2.10.0-rc.1`, `v2.10.0-rc.1-relay`, and matching daemon component tags. Component-aware requests return the newest patch on the current minor first, otherwise the baseline release of the next minor; no update returns `204` with `Cache-Control: no-store`. Inference Core ignores the requested channel and remains stable-only. Its tags are `vX.Y.Z-opfield.N`, earlier `-thesqlabs.N` and `-wiolett.N`; on the same base version every build of a later line is newer than every build of an earlier one.

GitHub lists releases newest first, 100 per page. The Worker reads further pages only until the answer is settled: a component request stops at the first page that reaches a candidate not newer than `current` (any candidate without `current`), the list stops once it holds a Gateway release on the channel. It reads at most 10 pages per repository.

The Worker aggregates GitHub Releases from the public
`opfield/opfield` repository and the private
`opfield/inference-core` repository (`GITHUB_OWNER`, `GITHUB_OPFIELD_REPO` and `GITHUB_INFERENCE_CORE_REPO` in
`wrangler.jsonc`; deploy them only after both repositories moved to the opfield organization, GitHub redirects the
old names but not the new ones before the move). It keeps the GitHub token only in
the `GITHUB_INFERENCE_CORE_TOKEN` Worker secret. The token provides private core
access and authenticated public Gateway API reads that avoid shared anonymous
rate limits. The service does not use R2. Release metadata is cached briefly,
while immutable release assets use long-lived edge caching.

```bash
pnpm --filter @opfield/update-service test
pnpm --filter @opfield/update-service typecheck
pnpm --filter @opfield/update-service build
```

Deployment uses the custom domain and the `get.opfield.dev` routes declared in `wrangler.jsonc`:

```bash
pnpm --filter @opfield/update-service deploy
```
