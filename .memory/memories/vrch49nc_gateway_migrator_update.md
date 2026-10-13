---
{
  "id": "vrch49nc",
  "file_name": "vrch49nc_gateway_migrator_update",
  "tags": [
    "foundation-migrator",
    "opfield",
    "updates"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1782790943895,
  "updated_at": 1791851906372
}
---
In the Opfield repository, the Opfield self-update path now uses a target-image foundation migrator (`packages/backend/src/foundation-migrator.ts` -> `src/foundation/foundation-migrator.ts`) before compose recreate. The migrator backs up and patches host `.env` and `docker-compose.yml`, manages `GATEWAY_VERSION`, `GATEWAY_IMAGE_REF`, `SANDBOX_RUNNER_WORKSPACE_DIR`, and the managed sandbox volume block, validates through `UpdateService`, prepares the sandbox workspace host bind, and rolls back backups if later preparation/compose validation fails. Verification sequence used: backend `biome check` on changed files, targeted Vitest for foundation/update tests, backend `npm run typecheck`, backend `npm run build`, full backend `vitest run`, and root `git diff --check`.
