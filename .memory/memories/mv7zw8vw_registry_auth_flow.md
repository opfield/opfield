---
{
  "id": "mv7zw8vw",
  "file_name": "mv7zw8vw_registry_auth_flow",
  "tags": [
    "docker",
    "gitlab",
    "opfield",
    "rbac",
    "registry"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786618689309,
  "updated_at": 1791851751875
}
---
Opfield Docker registry RBAC contract:
- There is no provider-specific `integrations:gitlab:registry:use` permission.
- Using saved registry credentials is an internal step of an already-authorized Docker action. The initiating route/tool scope is authoritative: `docker:images:pull`, `docker:containers:create`, `docker:containers:edit`, or `docker:containers:manage` depending on the operation.
- `docker:registries:view` governs listing/selecting saved registries and must not itself grant a Docker mutation.
- Testing either manual or integration-managed registry connectivity requires the existing `docker:registries:edit` route permission.
- Keep `integrations:gitlab:registry:view` for GitLab Registry API visibility and `integrations:gitlab:registry:manage` for GitLab project/credential management.
- Manual and GitLab integration-managed registry credentials must behave identically during Docker operations; credentials remain server-side and trusted registry/auth-realm protections remain enforced.
