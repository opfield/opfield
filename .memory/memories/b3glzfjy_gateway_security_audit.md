---
{
  "id": "b3glzfjy",
  "file_name": "b3glzfjy_gateway_security_audit",
  "tags": [
    "opfield",
    "remediation-decisions",
    "security",
    "security-audit"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1782693736671,
  "updated_at": 1791851406079
}
---
Opfield security remediation boundaries:
- Docker webhook environment corruption prevention is distinct from repair. Existing data cleanup is not implied; prevention requires a safe container-config edit permission boundary.
- AI conversations are user-owned. Do not broadly strip user-owned history or generic sensitive-looking tool arguments. Protect one-time raw secrets and explicitly secret-returning results whose product contract says they must not remain recoverable; preserve ordinary history/search usefulness.
- Installation/bootstrap hardening must remain non-breaking unless a stricter migration is explicitly approved. Prefer removing silent mutable/latest fallback where safe, preserve checksum verification, use warnings or explicit opt-in, and test shell syntax.
- Keep Docker lockfile hardening concrete.
- Non-expiring MCP OAuth access tokens are an accepted design; expiry/refresh applies to standard API OAuth, not MCP-resource grants.
- Treat these as durable policy boundaries; current implementation status and task ordering belong in .workflow artifacts, not memory.
