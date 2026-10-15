# Apps

[Back to README](../README.md)

An app groups the resources of one application into environments, such as production and staging: containers, deployments, Compose projects, routes, domains, databases, storage, Pages, SSL certificates, and logging environments. Apps are available on every plan. Open **Apps** in the sidebar, or use the REST API under `/api/apps` and the MCP `apps` toolset.

## Environments

- A new app has one environment, **production**, marked as Production. Exactly one environment carries the marker, and that environment cannot be deleted.
- Each environment keeps its members in hidden folders, one per resource type. Create a resource inside an environment from the app page, or pass the environment's folder for that type (`placementFolderIds` of the app) to the normal create call.
- **Allowed nodes**: each environment lists the nodes its resources may run on. Creating or importing a resource on another node is refused. Removing a node from the list keeps what runs there. SSL certificates and logging environments run on no node.
- **Domain allowlist**: patterns on the app and on each environment, such as `api.example.com` or `*.example.com`, limit the domains and route hostnames used there. Empty lists allow every name.

## Members

- **Move to app** (in the row menu of a resource list) and the app page move existing resources into an environment, or out of their app. Each resource is placed or refused on its own: system routes and certificates, deployment slots, and Compose service containers stay outside apps.
- Normal lists show app members with their app and environment; filters hide them or show one app.
- Deleting an environment or an app leaves its members running, at the top level of their lists.

## Variables and secrets

Each environment holds variables (readable by managers) and secrets (write-only). Every container, deployment, and Compose project of the environment receives them on its next create, recreate, deploy, or apply; saving restarts nothing, and the environment lists the workloads still running older values. A workload's own values win over environment values with the same name.

## Maintenance, shutdown, and kill switch

- **Maintenance** puts every route of an environment, or of the whole app, into maintenance. Each route keeps its own switch: turning the overlay off restores what each route had. A Maintenance Access Code lets one person view the routes for 5 minutes.
- **Shut down** stops what runs (containers, deployments, and Compose projects stop, managed databases and storage pause, routes show the maintenance page). **Start** brings back what ran at shutdown.
- **Kill switch** isolates an app during a security incident: routes lock down, links, bindings, and Secure Links of its members close, members lose their networks, and every change to a member is refused until **Release** restores the recorded state. Reads, logs, console, stop, restart, and start keep working.

## Promote

**Promote** pairs the members of two environments by name and shows what the target would run: image digests (Git builds are promoted by artifact digest, never rebuilt), Compose revisions, and Pages artifacts. The selected items then run one by one in the background. Variables, secrets, databases, and storage are never promoted.

## Health and overview

An environment's health comes from its members: a crashed workload or an expired certificate fails it; a degraded member, a paused database, an unreachable node, or everything stopped degrades it. A workload stopped on request is shown but does not change the health. The overview shows requests, CPU, and memory for the last hour or day, and the activity log lists what changed.

## Permissions

`apps:view`, `apps:create`, `apps:edit`, `apps:delete`, `apps:env:manage`, `apps:promote`, and `apps:operate`, granted on every app, one app, or one environment (`env/<environmentId>`). Members still need their own permissions; a grant on an environment folder covers its members. A user who can view a member of an app also sees the app, limited to the members they can view. See [SCOPES.md](../SCOPES.md).

## API and MCP

REST `/api/apps`. MCP and AI Workspace tools: `list_apps`, `get_app`, `manage_app`, `manage_app_environment`, `manage_app_members`, `manage_app_variables`, `manage_app_incident`, `promote_app_environment`, `get_app_overview`, and `get_app_activity`; `read_opfield_documentation({ topic: "apps" })` documents their arguments.
