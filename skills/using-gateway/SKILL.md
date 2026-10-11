---
name: using-gateway
description: Entry point and router for deploying, publishing, configuring, diagnosing, or operating applications through a user-owned Good Gateway instance and its authenticated remote MCP. Use first in any Gateway task for setup, MCP connection, tool discovery, safety rules, asynchronous Tasks, and verification, and to choose the domain skill for Pages, Docker workloads, high availability, ingress and TLS, internal PKI, databases, object storage, Nodes, observability, or access control. Do not use for generic Docker or hosting work that is not targeting Gateway.
---

# Using Gateway

Turn the user's application intent into one native Gateway workflow. Gateway owns deployment state, builds, artifacts, Compose revisions, Domains, certificates, Routes, permissions, Tasks, and rollback-capable resources. Do not build a parallel orchestrator around shell access when Gateway MCP exposes the operation. MCP is not a back door: every call passes the same authorization, validation, and audit as a person in the Console.

## Connect and discover

Use existing Gateway MCP tools when they are already available. If no usable Gateway instance exists, setup is incomplete, or the user wants a new installation, read [New instance setup](references/instance-setup.md). If the instance is ready but MCP is unavailable, unauthenticated, or points at the wrong instance, read [MCP connection](references/connection.md).

Never ask the user to paste an OAuth token, API token, setup code, Node enrollment token, deploy token, registry password, database credential, or other secret into chat.

- **Tools.** With Extended MCP compatibility (the default) every scoped tool is listed. Otherwise activate only the toolsets the request needs with `discover_tools({ category })` and list tools again; `find_resource`, `get_my_access`, and `read_gateway_documentation` are always visible. Toolset IDs and exclusions: [MCP toolsets](references/mcp-toolsets.md).
- **Your access.** Read the server instructions: when the connection is limited to folders, Nodes, or resources, they end with a short summary of those grants. `get_my_access` (also the `gateway://access` resource) returns the full picture by area: broad or limited, the granted folders (id, name, path), Nodes and resources with their actions, and where you may create.
- **Documentation.** Before complex or recently added operations, read `read_gateway_documentation({ topic })` or `gateway://docs/<topic>` instead of relying on remembered arguments. The connected release is the source of truth.
- **Resources.** Use `find_resource` for names, domains, images, containers, deployments, Compose Projects, Page Projects, certificates, Nodes, databases, and builds. Never invent resource IDs.

## Route the request

Each domain has its own skill in this package. If one is not installed, install the set with `npx skills add the-square-labs/gateway-skills`, or read it from the connected Gateway at `gateway://skills/<name>/SKILL.md` when that release serves skills.

- New control plane, unfinished onboarding, or missing first Nodes: [New instance setup](references/instance-setup.md).
- MCP connection, OAuth, or missing tools: [MCP connection](references/connection.md) and [MCP toolsets](references/mcp-toolsets.md).
- Static output, a generated HTML report, or a frontend build, from a local artifact or a Git source: `publishing-html-pages`.
- Git repository with a Dockerfile, existing image, blue/green Deployment, or Compose application: `deploying-workloads`.
- The same workload on several Docker Nodes with failover or replicas: `high-availability`.
- Public hostname, DNS, TLS, Route, Access List, Secure Link, maintenance mode, or reachability: `ingress-and-domains`.
- Private certificate authority or internal certificates: `internal-pki`.
- Managed or external PostgreSQL, key-value stores, ClickHouse, application bindings, queries, or backups: `databases`.
- Object storage, external S3, FTP, or SFTP, copy jobs, or the MinIO to SeaweedFS migration: `storage`.
- Adding, updating, or repairing Nodes, daemon health, Node console or files: `managing-nodes`.
- Logs, SIEM export, alert rules, webhooks, status pages, or the audit log: `observability`.
- Users, groups, scopes, API tokens, or OAuth grants: `access-control`.
- Incident, warning, failed Task, offline Node, or unexplained state: [Diagnosis](references/diagnosis.md), then the skill that owns the failing boundary.

If an existing Gateway resource already represents the application, update or attach its source instead of creating a duplicate.

## Choose the native resource model

Prefer Pages for static output. Prefer a standalone Container for one ordinary service. Prefer a blue/green Deployment when health-checked cutover and rollback matter. Prefer a Compose Project when the application has multiple services or the repository already defines Compose. Prefer a private database binding over distributing owner credentials.

Inspect whether the repository already has a healthy deployment pipeline. If Gateway Git-source builds are admitted and no deployment CI exists, use Gateway source bindings, Build Workers, `autoBuild`, and `autoDeploy` instead of authoring CI solely to deploy through Gateway. Preserve an existing release pipeline unless the user asks to replace it.

## Limited access is normal

If you can't see or do something at the root, check `get_my_access`; folder-limited access is normal, so work inside the granted folders. Many users and grants hold scopes only on some folders, Nodes, or resources (`docker:containers:create:folder/<id>`), never at the root.

- An empty list means nothing visible matches, not that the tool is forbidden. Lists return only what you can access; do not conclude you have no access.
- To create, pass `folderId` (and `nodeId` where the tool takes one) for a destination listed under `create` in `get_my_access`, or a folder whose `access.canCreate` is true in `list_resource_folders`. A create without a destination targets the root and is refused unless `create.atRoot` is true.
- A permission error that names your folders or Nodes is telling you where to act: retry there. Report a missing permission only when `get_my_access` shows no grant for the needed action anywhere, and then name the exact scope the user should ask for.

## Preflight before promising success

Check only prerequisites relevant to the selected path:

- effective scopes (`get_my_access`: broad or limited to folders, Nodes, or resources), `mcp:use`, OAuth manual-approval scopes, and feature entitlement;
- suitable online Nodes and advertised capabilities;
- build admission, allowlisted Git connector, exact repository and branch, writable internal registry, and Build Worker readiness;
- existing resources, conflicting names, active Tasks, Domains, certificates, Routes, Tags, and ownership;
- application port, health endpoint, persistent storage, build variables, runtime configuration, and secrets;
- database engine, placement, backup and recovery expectation, and binding target;
- DNS control and the intended public hostname.

Ask one focused question only when a missing value changes the resource model, target environment, availability, data safety, or external mutation. A deployment request authorizes ordinary create, build, publish, and verification operations for the named application and target. It does not authorize overwriting conflicting DNS, replacing an unrelated live Route, deleting persistent volumes or databases, destructive Compose `down`, rotating secrets or preview links, broadening permissions, or adopting a resource with unclear ownership.

## Execute, reconcile, and verify

Use Gateway-native state transitions and read the resulting resource after each asynchronous boundary. An accepted (`202`) response means Gateway recorded the request, not that a daemon applied it. Do not treat a queued build, created Task, pending certificate, pending preview link, container start, Compose operation, database provisioning, migration, or rollout as completion.

1. Run the preflight or dry run where one exists (Docker migration, Docker Availability, storage copy) before the real operation.
2. Record returned resource, operation, request, build, and Task identifiers.
3. Follow the owning Task or status resource until a terminal state or concrete blocker is known.
4. Inspect structured failure details instead of retrying blindly: `401` authentication, `403` scope or entitlement (with limited access, the destination or target is outside your grants: check `get_my_access`), `404` not visible or not existing, `409` lifecycle or quota conflict, `422` validation, `429` back off, `5xx` or offline Node: reconcile the durable Task first.
5. Read the final desired and reported resource state.
6. Verify the external outcome from the real consumer path: HTTPS response, workload health, database connection through the binding, or a published Pages link.

Retry only when the failure is understood and the operation is safe to repeat. Never create duplicate resources as a retry strategy. After an ambiguous timeout, reconcile the first operation before repeating creation, deletion, migration, recovery, or credential rotation. Create tools that list an `idempotencyKey` argument are the exception: send a new key with each create and repeat the call with the same key and arguments; `IDEMPOTENCY_RESULT_WITHHELD` means the first call already succeeded, so look the resource up instead.

## Return a complete result

On success, report the environment, URL when applicable, resource identity, source commit or immutable artifact, Task or build result, verification evidence, and rollback path. On failure, report the exact missing prerequisite or failed boundary and the smallest safe next action. Never call a partial deployment successful.

## Safety invariants

- Diagnosis, inventory, explanation, and review requests remain read-only.
- Confirm before destructive or high-risk actions: deletion, credential reveal or rotation, restore, revocation, migration cutover, raw nginx config, and preview-link rotation. Read what a tool does not clean up; deleting a Container keeps its volume, and deleting a Route keeps its certificate and Access List.
- Keep secrets write-only and out of ordinary tool arguments, shell history, logs, memory, and final responses. When a tool needs a secret value, let the user enter it in the Gateway Console, or pass it from a local source the user named directly into the dedicated secret field without echoing it. Values a tool shows once (tokens, keys, revealed credentials) are never repeated.
- MCP cannot mint Gateway credentials (API tokens, OAuth grants) or impersonate users. Send the user to the Console for those.
- A disconnected Node shows a stale snapshot, and Gateway blocks mutations that need current state. Do not force a workaround.
- Use Gateway-managed volumes; do not introduce host bind mounts or Docker socket access.
- Git deployment uses exact commits and approved immutable artifacts, never a mutable branch or tag as runtime identity.
- Operate Compose Projects and Deployments through their owning resources, never their protected child containers or slots.
- Routes target stable Container names, Deployment IDs, Compose project and service identities, or ready Pages Tags, never immutable Pages Deployments.
- Preserve a healthy production resource until its replacement passes required health and ingress checks.
- Treat license, permission, entitlement, worker, registry, DNS, certificate, policy, Node connectivity, and application health failures as distinct blockers.
