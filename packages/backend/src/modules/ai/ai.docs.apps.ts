export const APP_DOCS: Record<string, string> = {
  apps: `# Apps

An app groups resources of several types into environments (production, staging, ...): containers, deployments, Compose projects, routes, databases, storage and Pages. Use list_apps, get_app, manage_app, manage_app_environment, manage_app_members, manage_app_variables, manage_app_incident, promote_app_environment, get_app_overview and get_app_activity (REST: /api/apps).

## Model
- A new app has one environment, production, marked as Production. Exactly one environment holds the marker (manage_app_environment mark_production moves it); the Production environment cannot be deleted.
- Members sit in hidden folders of their own type: each environment has one folder per type, listed in get_app as placementFolderIds. Normal folder tools never show these folders, and Move to folder refuses a member (RESOURCE_IN_APP): use manage_app_members place instead.
- Normal list tools return members with an \`app\` field ({id, slug, name, environmentId, environmentName, environmentSlug}); pass excludeAppMembers true to leave them out or appId to list one app's members.

## Creating inside an environment
- Pass folderId = placementFolderIds[type] of the environment to the normal create tool (create_docker_container, manage_docker_deployment, manage_docker_compose, create_route, manage_managed_database, manage_database_connection, manage_managed_storage, manage_storage_connection, manage_pages).
- Each environment allows a set of nodes (allowedNodeIds in get_app; manage_app_environment allow_node, remove_node, list_nodes). A create or import on another node is refused with APP_NODE_NOT_ALLOWED, or APP_ENV_NO_ALLOWED_NODE when no node of the needed type is allowed (Docker for containers, deployments and Compose; Nginx for routes and Pages; database or storage nodes for managed databases and storage). Removing a node keeps what runs there.

## Membership
- manage_app_members place moves members into an environment (target {appId, environmentId}) or out of their app (target null). It needs apps:env:manage on the target environment and on the environment a member leaves, plus edit permission on each member. Each member is placed or refused on its own (system routes, the route of the Opfield public URL, non-allowed nodes, deployment slot and Compose service containers are refused).
- Deleting an environment or an app leaves its members running at the top level of their lists.

## Environment variables and secrets
- manage_app_variables: variables (values readable by managers) and secrets (write-only) every container, deployment and Compose project of the environment receives on its next create, recreate, deploy or apply. Nothing restarts on save; get lists pendingWorkloads still running older values. A container recreate is only queued (it answers a taskId): follow it with manage_app_variables workload_task until succeeded or failed before reporting it done. Precedence, lowest first: image ENV, environment variables, environment secrets, the workload's own env, the workload's own secrets.

## Maintenance
- manage_app_environment set_maintenance puts every proxy route of the environment in maintenance; manage_app update maintenanceOverride does it for every environment. Each route keeps its own maintenance switch: turning the overlay off restores exactly what each route had. Routes show appMaintenanceMode.
- manage_app_environment create_access_code issues one Maintenance Access Code for every route of the environment (or app) in maintenance: one user, 5 minutes, once per route.

## Shutdown and kill switch
- manage_app_incident shutdown stops what runs (containers, deployments, Compose projects stop; managed databases and storage pause; routes and Pages routes show the maintenance page); start brings back what ran at shutdown and still exists. While shut down, members can be changed freely (edits, deletes, unbinding, renames, migration, Compose down, Availability, moves between environments); start still starts a member renamed, migrated or moved meanwhile, skips one deleted meanwhile (item gone, detail "Deleted while the app was shut down; not started") and lists those in the incident's skipped. A shutdown of an isolated app or environment answers 409 APP_ISOLATED: release the kill switch first.
- manage_app_incident isolate (confirmName = the app name) is the kill switch for a security incident: routes lock down (maintenance page, no team access, no access code), links, bindings and Secure Links touching members close, direct publications are suspended, member containers lose their networks. Members are frozen: every change answers 409 APP_ISOLATED (recreate, update, rename, deploy, Compose apply/down, migration, Availability, route edits and deletes, deleting the member or its links, bindings and Secure Links, settings, new resources in the environment, membership); reads, logs, console, stop, restart and start still work. release restores every item from its recorded prior state.
- Both run in the background; status shows each incident with its items and errors (failed items are retried every 30 seconds and when nodes reconnect). preview counts what would change. Scope: environmentIds (apps:operate on each) or every environment (apps:operate on the app). Deleting an app or environment is refused while a shutdown or kill switch is open (APP_INCIDENT_ACTIVE): start it or release first.

## Promote
- promote_app_environment preview (sourceEnvironmentId, targetEnvironmentId) pairs members by name (same name, or the name without a trailing -<environment>) and shows what the target would run: image digests (Git builds by artifact digest, never rebuilt), Compose revision with pinned images and YAML changes, Pages artifact. execute (items = pairKeys, previewDigest) runs the selected items one by one in the background; status / list show progress. Variables, secrets, databases and storage are never promoted. apps:promote on the target environment.

## Permissions
- apps:view, apps:create, apps:edit, apps:delete, apps:env:manage, apps:promote, apps:operate. Qualifiers: <appId> (whole app) and env/<envId> (view, env:manage, promote, operate). Renaming, environment changes and deleting need the permission on the whole app. Members still need their own permissions; grants on an environment folder (<scope>:folder/<placementFolderId>) cover its members, grants on an app root folder (rootFolderIds) cover every environment.
`,
};
