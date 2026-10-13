---
{
  "id": "asy6c7bj",
  "file_name": "asy6c7bj_gateway_safe_refactor",
  "tags": [
    "backend",
    "docker",
    "frontend",
    "opfield",
    "proxy",
    "refactor",
    "testing"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1781739683142,
  "updated_at": 1791851390562
}
---
Opfield safe-refactor pattern for oversized detail/service files (June 2026 refactor series):
- Before extracting orchestration from a large page or service (DockerContainerDetail, SettingsTab, ProxyHostDetail were the originals), pin its behaviour first. The useful seams were: container mutation snapshots/settle detection, stopped-container live runtime save callbacks, recreate payload building, and proxy-host null-clearing plus resync after access-list/advanced-config saves.
- Frontend split that resulted: `docker-detail/mutation-transition.ts`, `docker-detail/useContainerDetailRealtime.ts`, `docker-detail/settings-payload.ts`, plus `proxy-detail/state.ts` and `proxy-detail/mutations.ts`. Keep page-level imports working by re-exporting moved helpers from the original page file when needed.
- Backend split: `docker-recreate-watch.ts` stays in this repo; the database pieces from that series (`database-error-mapping.ts`, `postgres-row-sql.ts`) now live in the private gateway-commercial repo.
- Under the test policy since 2026-09-29 (light suite only), behaviour pins for such refactors are temporary scaffolding or stand checks, not permanent unit tests; finish with compile checks, lint and `git diff --check`.
