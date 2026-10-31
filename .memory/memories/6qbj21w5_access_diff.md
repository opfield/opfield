---
{
  "id": "6qbj21w5",
  "file_name": "6qbj21w5_access_diff",
  "tags": [
    "access",
    "gate",
    "permissions",
    "release"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1793402957791,
  "updated_at": 1793402957791
}
---
scripts/access-diff/run.mjs (branch feat/access-diff, 2026-10-31) compares every credential kind (session, full and narrow opf_, opfo_ API/MCP, opfi_, impersonation, anonymous) across both installations' OpenAPI documents and MCP tool lists. A narrowing (past auth before, 401/403 now) or a removal fails the run unless approved.json lists it with reason, approvedBy and date. It was built after 2.13.0 shipped OAuth 403 on POST /api/inference/tokens unnoticed.
Safety rules:
- writes carry malformed JSON plus non-existent ids;
- writes with no path id are sent only when the JSON body is required with required fields, and never for global action paths;
- MCP tools get wrong-typed arguments.
Gotchas found while building it:
- some handlers do `c.req.json().catch(() => ({}))`, so malformed JSON alone does not stop every route;
- refusals that happen after validation (2.13.0's MCP inference-key/service-token refusals) are visible only through probes.json, which takes valid bodies on the fake UUID 00000000-0000-4000-8000-00000000ad1f;
- 503 *_DISABLED and 501 are feature answers, not errors.
Run it before every stable (README in the folder).
