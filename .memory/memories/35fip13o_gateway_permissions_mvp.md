---
{
  "id": "35fip13o",
  "file_name": "35fip13o_gateway_permissions_mvp",
  "tags": [
    "apps",
    "architecture",
    "health",
    "lifecycle",
    "permissions",
    "routing"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1780866370686,
  "updated_at": 1791851145466
}
---
Status (verified 2026-10-01): the App entity is NOT in main. It exists only on the unmerged branch `app-entity-mvp` (2026-06-09; its .workflow plan is marked complete). Main has no App tables or `app_id` columns, and the accepted Compose Projects design (2026-08-24) says not to introduce or depend on an Apps model. Use this contract only if the owner revives Apps.

Opfield App contract (branch-only), merged from the former ownership and lifecycle notes:

Ownership and resource model
- A supported app-scoped resource belongs to at most one App, modelled with a nullable app_id on each supported resource table, not a many-to-many link table.
- Resources are either global/standalone or app-scoped. Creating or linking a resource in an App sets app_id; app-scoped resources are hidden from global/common lists and APIs and managed through App UI/API routes.
- Supported App-owned resources: Docker containers and blue/green deployments, database connections, logging environments, access lists, proxy hosts, SSL certificates, and PKI leaf certificates.
- Nodes and PKI certificate authorities remain Opfield-owned root infrastructure. Apps may reference Nodes only as placement/runtime targets or service bindings.
- Linking or creating one resource never moves referenced dependencies (certificates, access lists, Nodes, other resources) into the App.

Lifecycle, routing, permissions and health
- MVP flow: create a simple App, then create supported resources with the standard domain flow or explicitly link existing global resources. App creation sets app_id immediately; logging may prefill a namespace from App context.
- App detail uses /apps/:id. App slugs are globally unique for display/search and possible future human-readable links, but stable IDs remain the route/API key.
- App-level permissions govern management of app-scoped resources inside the App without separately requiring each underlying resource-domain scope. Moving a resource global -> App, App -> global, or App -> App requires explicit permission and audit.
- No archive/unarchive lifecycle. Delete an App only when it has no app-scoped resources; never cascade-delete or silently detach resources.
- App health derives only from participating app-scoped resources with health checks enabled: offline wins over degraded, degraded wins over online, all healthy is online, and no participating resources is unknown.
