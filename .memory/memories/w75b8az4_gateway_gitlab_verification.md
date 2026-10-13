---
{
  "id": "w75b8az4",
  "file_name": "w75b8az4_gateway_gitlab_verification",
  "tags": [
    "ai-tools",
    "approval",
    "gitlab",
    "integrations",
    "opfield",
    "redirects",
    "secrets",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1783125493749,
  "updated_at": 1791851921471
}
---
Opfield GitLab/VCS connector safety contract:

- AI approval UI, runtime tool-call history, saved history, snapshots, audit rows, and MCP-visible data persist only display-safe/redacted arguments.
- Raw one-time PAT, deploy-token, variable, or webhook values needed for approval continuation may exist only in short-lived protected server-side checkpoint state and are cleared on terminal transitions.
- Never persist raw secret arguments into tool-call ledgers or return them to frontend/MCP surfaces.
- Every approval mode, including immediate auto-approved paths, must follow the same secret-handling contract.
- Native archive/binary requests must not forward authentication across origin changes or HTTPS-to-HTTP downgrade. Strip credentials or fail closed, and cover redirect behavior with separate-origin fixtures.
- Historical exposure assessment and credential rotation are evidence-driven; do not claim production compromise without verifying persisted rows and redirect usage.
