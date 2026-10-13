---
{
  "id": "2tjfa2g5",
  "file_name": "2tjfa2g5_gateway_route_verification",
  "tags": [
    "docker",
    "opfield",
    "permissions",
    "realtime",
    "routing",
    "slugs",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1783637960104,
  "updated_at": 1791851138113
}
---
Opfield human-readable main detail routes use this contract:
- Persist backend-generated collision-safe slugs (base limited to 60 characters before adding -1/-2 suffixes) only for nodes, database connections, proxy hosts, plus the existing logging environment/schema slug fields.
- Docker containers, deployments, and volumes use their exact case-sensitive names as the child route identity, scoped by node slug. Technical APIs, mutations, and popouts remain ID-based.
- Do not add slug systems for PKI, domains, certificates/ CAs, or templates unless separately requested. Frontend never computes canonical slugs.
- Slug rename events travel over the notification bus; the current tab updates from mutation responses and other tabs update from real-time while retaining their active tab.
- Route resolver requests must keep transient failures local (retry UI) rather than triggering global outage or rate-limit blockers; the resolved page context remains owner-safe for AI and command palette.
- Compact Docker node responses must be filtered client-side by requested Docker scope bases. Broad nodes:details access must not expand resource-scoped Docker authorization.

Reusable verification: full backend/frontend tests, lint/typecheck/build, git diff --check, migration against current and fresh PostgreSQL, authenticated browser smoke for all eight route families, transient resolver retry, two-tab node slug rename, and a Docker-only scoped user.
