---
{
  "id": "412x4uua",
  "file_name": "412x4uua_gateway_api_client",
  "tags": [
    "api-client",
    "frontend",
    "opfield",
    "refactor",
    "tests-first"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1781991270180,
  "updated_at": 1791851216835
}
---
Opfield frontend API client structure: the former monolithic ApiClient in `packages/frontend/src/services/api.ts` is composed from domain mixin modules (`api-proxy.ts`, `api-databases.ts`, `api-docker.ts`, plus `api-docker-migrations.ts`, `api-docker-resources.ts`, `api-docker-webhooks.ts`) through `withProxyApi` / `withDatabaseApi` / `withDockerApi`-style wrappers, so the exported `api` singleton and its call sites stay unchanged. Add new domain methods to the matching mixin rather than back into api.ts. The split was done in June 2026 behind temporary contract tests; those test files were removed by the 2026-09-29 light-suite cut, so verify such moves with frontend typecheck, lint and build (structure re-verified 2026-10-01).
