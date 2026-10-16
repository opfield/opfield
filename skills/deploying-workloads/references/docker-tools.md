# Docker tool catalog

Exact tool names in the MCP `docker` toolset. All require the `nodeId` of a Node with `type: "docker"` unless noted; the five `list_docker_*` tools list across every Docker Node you can see when `nodeId` is omitted. A refusal on a Node of another type names the Docker Nodes you can use. The connected instance's tool schemas are authoritative; re-read them when an argument is rejected.

## Instead of `docker` on the Node console

Agent console commands (`execute_node_console_command`) run without the container runtime: `docker`, `podman`, `nerdctl`, `ctr` and runtime sockets are refused (`MANAGED_RESOURCE_CONSOLE_FORBIDDEN` for a change to an Opfield-managed object, `NODE_CONSOLE_RUNTIME_UNAVAILABLE` otherwise), and `ssh_execute_command` refuses Opfield nodes. Use these tools:

| Console command | Tool |
| --- | --- |
| `docker rm` | `remove_docker_container` |
| `docker stop` / `start` / `restart` / `kill` | `stop_docker_container`, `start_docker_container`, `restart_docker_container`, `kill_docker_container` |
| `docker rename` | `rename_docker_container` |
| `docker update` | `manage_docker_container` `live_update` |
| `docker rm` + `docker run` with new image, ports, mounts or env | `manage_docker_container` `recreate`, `update_docker_container_image`, `manage_docker_container_config` `update_env` |
| a blue/green slot container | the Deployment tools |
| `docker compose up` / `down` / `restart` / `pull` | `manage_docker_compose` |
| `docker volume rm`, `docker network rm` / `connect` / `disconnect` | `manage_docker_volume`, `manage_docker_network` |
| `docker ps` / `inspect` / `logs` / `stats` / `images` | `list_docker_containers`, `get_docker_container`, `get_docker_container_logs`, `get_docker_container_stats`, `list_docker_images` |

## Standalone Containers

`create_docker_container`, `list_docker_containers`, `get_docker_container`, `start_docker_container`, `stop_docker_container`, `restart_docker_container`, `kill_docker_container`, `remove_docker_container`, `update_docker_container_image`, `rename_docker_container`, `duplicate_docker_container`, `get_docker_container_stats`, `get_docker_container_logs`, `execute_docker_container_console_command`, `manage_docker_container_config`, `manage_docker_container`, `upload_docker_container_archive`, `download_docker_archive`.

## Blue/green Deployments

`list_docker_deployments`, `get_docker_deployment`, `start_docker_deployment`, `stop_docker_deployment`, `restart_docker_deployment`, `kill_docker_deployment`, `deploy_docker_deployment`, `switch_docker_deployment_slot`, `rollback_docker_deployment`, `stop_docker_deployment_slot`, `manage_docker_deployment`.

## Compose

`manage_docker_compose` (single tool: `project`/`revision`/operation-history/lifecycle/secret resources with an `operation` field).

## Images

`list_docker_images`, `pull_docker_image`, `remove_docker_image`, `prune_docker_images`.

## Volumes and networks

`list_docker_volumes`, `manage_docker_volume`, `list_docker_networks`, `manage_docker_network`.

## Registries

`manage_docker_registry`.

## Git sources and builds

`list_docker_builds`, `manage_docker_build`, `manage_docker_source`.

## Tasks, migration, availability, runtime

`manage_docker_task`, `force_cancel_docker_task`, `manage_docker_migration`, `manage_docker_availability` (see `high-availability` skill), `manage_docker_runtime`.

## Folders

`list_resource_folders`, `manage_resource_folder` (shared cross-domain tool; `resourceType: "docker"` plus `dockerResourceType: "container"|"compose"|"image"|"network"|"volume"`).

## `manage_docker_availability` operations

`preflight`, `enable`, `get`, `get_by_resource`, `list_operations`, `update`, `disable`, `retry_operation`. Workflow and limits are in the `high-availability` skill.

## `manage_docker_migration` operations

`preflight`, `start`, `list`, `get`, `cancel`, `retry_cleanup`, `resolve`.
