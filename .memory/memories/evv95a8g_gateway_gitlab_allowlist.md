---
{
  "id": "evv95a8g",
  "file_name": "evv95a8g_gateway_gitlab_allowlist",
  "tags": [
    "backend",
    "cache",
    "frontend",
    "gitlab",
    "integrations",
    "opfield"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.87,
  "created_at": 1783269480066,
  "updated_at": 1791851532961
}
---
In the Opfield repository, GitLab connector edit UI should not fetch available projects directly from GitLab on modal open or during edit search. Existing connector project options are backend-cached in integration_connector_projects and exposed via GET /api/integrations/gitlab/connectors/:id/allowlist/options. Manual refresh is explicit via POST /api/integrations/gitlab/connectors/:id/allowlist/options/refresh, which calls provider.listProjects, persists projects with persistProjects, audits connector.gitlab.project.list, and returns cached options. New connector creation should persist the initial project list so later edit opens from cache. Edit-mode search filters the cached options locally; create-mode preview search can still use the submitted PAT.
