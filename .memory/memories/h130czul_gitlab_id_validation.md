---
{
  "id": "h130czul",
  "file_name": "h130czul_gitlab_id_validation",
  "tags": [
    "ai-tools",
    "error-handling",
    "gitlab",
    "integrations",
    "opfield",
    "uuid",
    "validation"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1783270157285,
  "updated_at": 1791851588986
}
---
Opfield GitLab connector-ID validation contract:
- Before performing any getConnectorRow/database query, GitLab AI tools must validate connectorId, since integration_connectors.id is a UUID column.
- Invalid IDs must return a stable tool/input validation error, not a raw Drizzle/Postgres error.
- GitLab AI tool schemas must declare the UUID format and instruct the assistant to use the exact IDs returned by gitlab_list_connectors.
- Regression coverage should ensure malformed IDs do not propagate raw database errors or query metadata to the caller; such IDs should be handled through the standard validation path.
