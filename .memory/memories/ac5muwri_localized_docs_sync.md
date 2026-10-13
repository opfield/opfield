---
{
  "id": "ac5muwri",
  "file_name": "ac5muwri_localized_docs_sync",
  "tags": [
    "ai-docs",
    "database-nodes",
    "documentation",
    "localization",
    "mcp-docs",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785878943106,
  "updated_at": 1791851365560
}
---
Documentation maintenance rule: when Opfield adds or changes a user-visible feature, update all three root README locales (EN/RU/CN), docs/capabilities.md, the relevant operational guide, and packages/backend/src/modules/ai/ai.docs.ts together. Database-node work specifically requires documenting the restricted docker-daemon profile, root-only service user, storage-root selection/preflight, and the difference from ordinary Docker nodes. Verify relative Markdown links and backend typecheck after changing embedded AI documentation.

For internal assistant/MCP documentation, packages/backend/src/modules/ai/ai.docs.ts is the local source of truth. Compare every accessible live documentation topic with the corresponding local INTERNAL_DOCS topic, preferably by exact content length/hash, and audit scope-restricted topics locally. A local source edit does not make the live MCP documentation current: backend deployment and a post-deploy live comparison are required before claiming publication parity.
