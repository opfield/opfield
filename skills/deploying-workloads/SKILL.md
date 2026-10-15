---
name: deploying-workloads
description: Deploy and operate Docker workloads on Opfield, including standalone Containers, blue/green Deployments with rollback, Compose Projects, Git-source builds into Opfield's internal registry, images, registries, volumes, networks, folders, and cross-node migration. Use when asked to run, update, roll out, roll back, recreate, migrate, or inspect a container, Deployment, or Compose Project on an Opfield-managed Docker Node, or to deploy a repository with a Dockerfile or Compose file through Opfield, or to group an application's resources into an App with environments. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Deploying Workloads

Opfield manages Docker on enrolled Docker Nodes and adds three native models: blue/green **Deployments**, **Compose Projects** with immutable revisions, and **Git sources** that build digest-pinned artifacts into Opfield's internal registry. Every Docker tool acts on a Docker Node: pass the full `nodeId` of a Node with `type: "docker"` (`list_nodes({ type: "docker" })`). Storage, databases, and builder Nodes report `daemonType: "docker"` but are not Docker Nodes, and Docker tools refuse them. To survey workloads, call `list_docker_containers`, `list_docker_deployments`, `list_docker_images`, `list_docker_volumes`, or `list_docker_networks` without `nodeId`: they list across every Docker Node you can see. Resolve names, images, and domains with `find_resource` first.

Start with `using-opfield` for connection, discovery, and safety rules. Read `read_opfield_documentation({ topic: "docker" })` before a multi-step workflow; it documents argument shapes this skill only summarizes. Exact tool names and operation enums: [Docker tool catalog](references/docker-tools.md).

## Pick the resource model

| The application is | Use |
| --- | --- |
| One ordinary service | Standalone Container (`create_docker_container`, lifecycle tools) |
| A service that needs health-checked cutover and rollback | Blue/green Deployment (`manage_docker_deployment`, `deploy_docker_deployment`, `switch_docker_deployment_slot`, `rollback_docker_deployment`) |
| Several services, or a repository that already defines Compose | Compose Project (`manage_docker_compose`, Personal plan or higher; every plan can read label-detected projects) |
| A repository to build rather than a published image | A Git source attached to any of the above (`manage_docker_source`, Business or Enterprise for new builds) |
| The same workload on several Docker Nodes with failover | The above plus `high-availability` |

If an existing Container, Deployment, or Compose Project already represents the application, update it or attach a source to it instead of creating a duplicate. If the repository already has a healthy release pipeline, keep it unless the user asks to replace it.

## Git source builds

1. `manage_docker_source({ operation: "admission", ... })` before promising a build. Admission needs the entitlement, a writable internal registry, an allowlisted Git connector, and an online Build Worker advertising the enforced capabilities. If it fails, report the returned prerequisite; never create an external CI pipeline as a silent workaround.
2. `connectors` and `repositories` list the allowlisted sources. Resolve the requested branch to an exact commit.
3. `create` makes a new Container, Deployment, or Compose Project from the source (`targetType: "container" | "deployment" | "compose"`); `upsert` attaches or changes the source of an existing one. Keep non-secret `buildArgs`, Build Secrets (`secret_upsert`, write-only), and runtime secrets separate. Connecting a source, or changing its connector, repository or branch, needs `integrations:<provider>:use` on the repository (a project-level grant is enough); other source settings need only the workload's scopes. Automatic builds never depend on anyone's current Git permissions.
4. `build` queues a build of the configured branch head and needs only the workload's build scope; follow it with `list_docker_builds` and `manage_docker_build` (status, incremental logs, cancel, retry). While a build rollout deploys, other changes to its target are refused with `409 BUILD_ROLLOUT_IN_PROGRESS`.
5. The runtime identity is the approved, digest-pinned artifact, never a branch or mutable tag. With `autoDeploy`, Opfield recreates the workload from that digest.

Compose sources and bounded build fields: [Compose and Git builds](references/compose-and-git-builds.md). When you write or review the Dockerfile a source builds (no `VOLUME`, config from Opfield env and secrets, `0.0.0.0` on one exposed port, health endpoint, `SIGTERM`, non-root, pinned slim images, migrations safe to run twice): [Dockerfile for Opfield](references/dockerfile-for-opfield.md).

## Standalone Containers

1. Check `list_docker_images({ nodeId })`. If the image is missing, `pull_docker_image` and wait for the pull Task to finish; a failed create is not an image-existence probe. Public Docker Hub images need no registry.
2. `create_docker_container({ nodeId, image, name, ports?, volumes?, env?, networks?, restartPolicy?, ... })` with Opfield-managed volumes and explicit networks.
3. Change the image with `update_docker_container_image`: it pulls fully on the target Node, then recreates; a failed pull leaves the old Container running. Restart policy and CPU, memory, and PID limits apply live; ports, volumes, entrypoint, command, working directory, hostname, labels, and image require recreate.
4. Lifecycle: `start_docker_container`, `stop_docker_container`, `restart_docker_container`, `kill_docker_container`, `rename_docker_container`, `remove_docker_container` (stopped Containers only; volumes stay), and `duplicate_docker_container` (clones configuration and secrets under a new name, without reserved Compose and Opfield labels; a Docker daemon too old to drop them refuses with `UNSUPPORTED_DAEMON`). A name reserved by a Git source still waiting for its first build cannot be taken by create, duplicate or rename (`NAME_IN_USE`).
5. Inspect with `get_docker_container`, `get_docker_container_stats`, and `get_docker_container_logs`.

Container IDs change on every recreate. If a tool returns "No such container", re-resolve by name before concluding anything was deleted. Permission grants follow the stable name across recreate and update; an explicit deletion drops them.

## Blue/green Deployments

Operate the Deployment, never its slot Containers. `deploy_docker_deployment` rolls a new image to the inactive slot (its `env` sets variables over the saved environment and `removeEnv` removes keys; the rest stays); verify that slot's health; `switch_docker_deployment_slot` moves traffic; keep the previous slot warm; `rollback_docker_deployment` returns to the previous release. Never switch before the new slot meets its health condition.

## Compose Projects

`manage_docker_compose` covers projects, immutable revisions, operation history, lifecycle, and masked secrets. One project runs on one Docker Node. Manual YAML is image-only; repository Compose files may use the bounded build subset through a Git source. Start, stop, restart, apply, pull and apply, `down`, cancellation, project deletion, and volume deletion are distinct operations: `down` and volume deletion need explicit user intent. Never mutate a project-owned child Container, network, or volume directly. Invariants and validation rules: [Compose and Git builds](references/compose-and-git-builds.md).

## Private links between workloads

`manage_container_link` links a consumer (Container, Deployment, or Compose service) to one port of another workload: the consumer reaches it as `alias:port` on its own internal network, on the same node or across nodes, and the target needs no published port and no route. `list` (`nodeId`, `type`, `resourceId`, `direction: "outgoing" | "incoming"`), `create` (source and target `nodeId`/`type`/`resourceId`, `targetPort`; optional `alias` and `environment: { host, port, url }`), `get_runtime` and `delete` (`linkId`). Without variable names a Container joins the link without a restart, a Deployment joins its running slots, and a Compose service gets a new revision; variable names recreate the consumer once. It needs `docker:containers:edit` on the consumer (`docker:compose:manage` for a Compose service, plus `docker:containers:environment` with variables) and `docker:containers:link` on the target. `waiting` means the target does not run (connections are refused until it does); `update_required` means a node's Docker daemon must be updated. An Availability Deployment target is reached through its router, so `targetPort` must be one of its ports.

## Apps and environments

When the application belongs to an App, create its resources inside the right environment (`folderId` from `get_app` `placementFolderIds`, a node from `allowedNodeIds`) instead of at the top level, and move existing ones with `manage_app_members`. Environment variables, maintenance, shutdown and kill switch, and promotion by image digest: [Apps and environments](references/apps.md).

## Images, volumes, networks, registries, and migration

Registries, Opfield-managed volumes, networks, folders, cross-node migration (`preflight` before `start`), archive export and import, and Secure Runtime limits: [Resources and migration](references/resources-and-migration.md).

## Secrets and interactive access

- Secret environment values are encrypted at rest, keyed by Container name so they survive recreate, and visible only with `docker:containers:secrets` (`docker:containers:environment` lists their keys). Never ask for a value in chat: let the user enter it in the Opfield Console, or pass it from a local source the user named without echoing it.
- `execute_docker_container_console_command` runs a real command in the Container. It needs `docker:containers:console` (an OAuth manual-approval scope); Opfield blocks obviously catastrophic patterns, but treat every command as a mutation that needs user intent.

## Verify

- Container or Deployment: reported running state, clean recent logs, health, and, when routed, an external HTTPS response.
- Build: terminal success in `manage_docker_build` and the produced artifact digest, not "queued".
- Compose: the new revision applied, every expected service healthy, drift clean.
- Migration: the resource healthy on the target Node and source cleanup completed.

## Pitfalls

- Transitions (stopping, restarting, recreating, deploying, switching) block concurrent operations on the same resource. Follow the Task instead of retrying.
- Never change a managed Container, Deployment, Compose project, volume or network with `docker` commands on the Node console or over SSH: Opfield loses track of it (a container run again by hand gets a new access identity and its Git-source builds refuse it). Such agent commands are refused with `MANAGED_RESOURCE_CONSOLE_FORBIDDEN`, which names the tool to use. A container changed outside Opfield shows in the audit log and raises the built-in alert "Container changed outside Opfield"; remove it with `remove_docker_container` so the next build creates it from the source, or recreate it in Opfield.
- Pulls use the target Node's registry access; images are not copied between Docker Nodes.
- Stop, restart, kill, recreate, update, build, and migration are Tasks. Stop, restart, and SIGKILL answer once the container has stopped or started again, so a delete right after a stop works. A request waits at most 45 s: an operation still running then answers `pending: true` with its task (a delete of a stopping container: a remove task that removes it once the stop ends). Wait as the result says; do not repeat the request. A slow response is not a failure; never repeat a create or delete after a timeout before reconciling.
- Never introduce host bind mounts, privileged mode, device access, or Docker socket access.

Further reading: [Docker overview](https://docs.opfield.dev/en/docker/overview/), [Git builds](https://docs.opfield.dev/en/docker/git-builds/).
