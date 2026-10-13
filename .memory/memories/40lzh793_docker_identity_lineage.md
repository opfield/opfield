---
{
  "id": "40lzh793",
  "file_name": "40lzh793_docker_identity_lineage",
  "tags": [
    "access-identity",
    "compose",
    "design-contract",
    "docker",
    "managed-links"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.93,
  "created_at": 1790893661374,
  "updated_at": 1791851202345
}
---
Opfield Docker container identity and managed-link ownership contracts (fx/wl, 2026-10-02, for v2.11.0-rc.39):

- Access identity (docker_access_resources) across recreates: every Opfield recreate (updateContainer, updateContainerEnv incl. link apply/remove, recreateWithConfig) creates its docker_tasks row with containerId = the FULL runtime ID it replaces. ensureContainer, on a runtime that differs from the identity's, reads recent (1 h) update/recreate tasks of that name: identity runtime replaced by a task -> adopt the new runtime; the seen runtime was replaced by a task -> lagging snapshot, keep identity; otherwise a different container -> new identity, grants removed. Do not rely on in-memory transitions for this (the snapshot reconciler deliberately serves the old list item during a transition, and tasks can end before the watcher sees the replacement).
- Managed database/storage links target containers by name. They are released (DB: desiredState deleted; storage: status deleting; link secrets removed; teardown in background) whenever the name stops belonging to the container: Opfield removal, and before create/duplicate/rename-to/archive import/Git-source reservation takes a free name (DockerManagementService.releaseContainerLinks -> binding services' releaseContainerLinks; Community stubs are emptyMethods). A Git source's first activation (sourceBindingId) keeps the links saved for its reserved name. Link removal never touches a container that is not on the link network. Identity-based link ownership was rejected because pre-fix W2 bugs re-created identity rows of linked containers.
- Compose services carry wiolett.gateway.compose.revision = their own config digest (backend sends normalizedModelJson.serviceConfigDigests; daemon falls back to the revision digest). Drift and Availability checks must accept either (composeRevisionLabelMatches).
