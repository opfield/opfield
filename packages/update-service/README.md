# Opfield update service

Cloudflare Worker for the stable public Opfield update namespace at
`get.opfield.dev/opfield`. The same Worker keeps serving the earlier path namespace (releases up to 2.12.2 use it) and
the earlier host `updates.thesqlabs.com` (releases up to 2.11); all answer identically. The earlier namespace is kept
in `src/legacy-compat.ts`.

It exposes:

- `GET /health`
- `GET /opfield/releases` (stable by default)
- `GET /opfield/releases?channel=stable|preview`
- `GET /opfield/releases?component=<package>&current=<version>&channel=stable|preview`
- `GET|HEAD /opfield/<package>/<tag>/<artifact>` for allow-listed signed Opfield artifacts
- `GET|HEAD /opfield/releases/download/<tag>/<installer>` and `/opfield/releases/latest/download/<installer>`: the
  installers an Opfield release carries (`install.sh`, `setup-*.sh`, `opfield-node-installers.sha256`; releases before 2.12.1 carry
  the earlier checksum list instead, and later ones carry it too), in GitHub's release download layout
- `GET|HEAD /` and `/install.sh`: `install.sh` of the latest stable release (cached for 5 minutes)
- `GET|HEAD /opfield/license-endpoints.json`: the signed list of license service addresses
  (`scripts/release/license-endpoints.mjs`), an asset of the latest stable release (cached for 5 minutes)

`stable` is the default and excludes GitHub prereleases. `preview` additionally accepts release-candidate tags such as `v2.10.0-rc.1`, `v2.10.0-rc.1-relay`, and matching daemon component tags. Component-aware requests return the newest patch on the current minor first, otherwise the baseline release of the next minor; no update returns `204` with `Cache-Control: no-store`. The inference core answers under two component ids: `opfield-inference` (Opfield 2.12.1 and later ask for it first) and its earlier name `inference-core` (Opfield 2.11.5 to 2.12.0 ask only for it; it keeps answering). Both read the same core repository and give the same answer. The core ignores the requested channel and remains stable-only. Its tags are `vX.Y.Z-opfield.N`, earlier `-thesqlabs.N` and an older line; on the same base version every build of a later line is newer than every build of an earlier one. Core artifacts (`/opfield/<package>/<tag>/<artifact>`): package `opfield-inference` serves `opfield-inference-image.update.json` and `opencodex-image.update.json`, package `inference-core` only `opencodex-image.update.json`.

GitHub lists releases newest first, 100 per page. The Worker reads further pages only until the answer is settled: a component request stops at the first page that reaches a candidate not newer than `current` (any candidate without `current`), the list stops once it holds an Opfield release on the channel. It reads at most 10 pages per repository.

The Worker aggregates GitHub Releases from the public
`opfield/opfield` repository and the private
`opfield/opfield-inference` repository, earlier `opfield/inference-core` (`GITHUB_OWNER`, `GITHUB_OPFIELD_REPO` and
`GITHUB_INFERENCE_CORE_REPO` in `wrangler.jsonc`; deploy a new name only after the repository was renamed, GitHub
redirects the old names but not the new ones before the rename). It keeps the GitHub token only in
the `GITHUB_INFERENCE_CORE_TOKEN` Worker secret. The token provides private core
access and authenticated reads of the public Opfield repository that avoid shared anonymous
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
