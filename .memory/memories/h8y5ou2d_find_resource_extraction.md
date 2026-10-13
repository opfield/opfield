---
{
  "id": "h8y5ou2d",
  "file_name": "h8y5ou2d_find_resource_extraction",
  "tags": [
    "ai-service",
    "backend",
    "opfield",
    "refactor",
    "resource-search"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1781992344550,
  "updated_at": 1791851595849
}
---
Opfield AI `find_resource` implementation lives in `packages/backend/src/modules/ai/ai.resource-search.ts` (moved out of ai.service.ts in June 2026) and is reached through the public executeTool path. Current behaviour, re-verified 2026-10-01 (the June notes about "query is required" and list_proxy_hosts are outdated):
- A call with neither `query` nor `types` is rejected ("query or types is required").
- Each resource type is searched only when the caller holds its base scope (e.g. `proxy:view`, `proxy:templates:view`), by delegating to the ordinary list tools through `executeToolInternal` (proxy hosts via `list_routes` with the search term, templates via `manage_proxy_template` list, CAs via `list_cas`, and so on), so results never exceed what the caller could list directly.
- Docker resources are searched per allowed Docker node derived from resource-scoped grants.
