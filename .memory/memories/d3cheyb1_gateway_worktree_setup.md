---
{
  "id": "d3cheyb1",
  "file_name": "d3cheyb1_gateway_worktree_setup",
  "tags": [
    "go-tests",
    "pnpm",
    "sandbox",
    "setup-gotcha",
    "worktree"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790541257760,
  "updated_at": 1791851478014
}
---
Things needed before verifying code in a fresh git worktree of the Opfield repo:

1. **Go daemon modules** (`packages/daemons/{shared,relay,nginx,docker}`) do not compile until the embedded `update-signing-public-key.pem` exists (`packages/daemons/shared/updateauth` embeds it). Run `make -C packages/daemons/nginx trust-anchor` once (it calls `scripts/sync-update-trust-anchor.sh`); it leaves no tracked changes. Without it, `go test` fails with "pattern update-signing-public-key.pem: no matching files found" (setup failed).
2. **`pnpm install --frozen-lockfile --prefer-offline`** must run outside the macOS sandbox. Inside it fails with EPERM when a package tarball contains a `.idea` directory, for example iconv-lite. Also, `$TMPDIR` differs between sandboxed and unsandboxed shells, so write logs to an explicit path.
3. **Characterization digests (historical).** Until 2026-09-29, changes to AI tool descriptions or the notification catalog/EventBus mappings changed pinned digests in `tests/modules/ai/ai.tools.characterization.test.ts` and `tests/modules/notifications/notification.constants.characterization.test.ts`. Main deleted those tests in the light-suite cut (commit 49c72381); only branches cut before that still carry them. If you are on such a branch, confirm the change is intended and copy the "Received" digests from the failure output.
