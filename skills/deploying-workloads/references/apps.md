# Apps and environments

An App groups one application's resources into environments (production, staging, ...). The `apps` toolset is active by default. Read `read_opfield_documentation({ topic: "apps" })` for every argument.

## Find and inspect

- `list_apps`, `get_app` (environments, `placementFolderIds` per resource type, `allowedNodeIds`, members, `access`: `full` or `members`), `get_app_overview` (health and 1h or 24h series), `get_app_activity`.
- Normal list tools mark members with an `app` field; pass `appId` to list one app's members or `excludeAppMembers: true` to hide them.

## Create inside an environment

1. `get_app` and take the environment's `placementFolderIds[<type>]`.
2. Pass it as `folderId` to the normal create tool (`create_docker_container`, `manage_docker_deployment`, `manage_docker_compose`, `create_route`, `manage_managed_database`, `manage_managed_storage`, `manage_pages`, ...).
3. Use a node from the environment's `allowedNodeIds`; another node is refused with `APP_NODE_NOT_ALLOWED` (`manage_app_environment` `allow_node` changes the list, with the user's consent).

## Operate

- `manage_app_members` `place` moves existing resources into an environment or out of their app (`apps:env:manage` plus edit on each member). Never use folder moves for members (`RESOURCE_IN_APP`).
- `manage_app_variables`: environment variables and write-only secrets that workloads receive on their next create, recreate, deploy, or apply. A container recreate answers a `taskId`: follow `workload_task` until it ends.
- `manage_app_environment` `set_maintenance` and `create_access_code`; `manage_app` `update` with `maintenanceOverride` for the whole app.
- `manage_app_incident` `shutdown` / `start`, and `isolate` / `release` (the kill switch, `confirmName` = the app name). Both need explicit user intent; `preview` counts what would change, `status` follows them.
- `promote_app_environment` `preview` then `execute` with the chosen `pairKeys` and the `previewDigest`. Variables, secrets, databases, and storage are never promoted.

## Pitfalls

- Deleting an app or environment leaves its members running; it is refused while a shutdown or kill switch is open (`APP_INCIDENT_ACTIVE`).
- An isolated app refuses every member change with `409 APP_ISOLATED` until `release`.
- Seeing an app through its members (`access: "members"`) does not grant app actions: those need the `apps:*` scopes.
