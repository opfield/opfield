# Compose Projects and Git builds

## Compose paths

- `manage_docker_compose` handles manual, image-only YAML and the project lifecycle: `project` list, get, validate, create, adopt, delete; `revision` list, get, create, delete; operation history; lifecycle starts; masked-secret lifecycle. `find_resource({ types: ["docker_compose_project"] })` resolves a project by name.
- `manage_docker_source` with `targetType: "compose"` builds a repository Compose file (`composeFilePath`, `composeVariables`, `composeSecretKeys`) that uses the supported build subset.

## Compose invariants

- One project is placed on one Docker Node.
- Revisions are immutable. Each `create` makes a new revision; apply it explicitly with pull and apply.
- Repository builds create one isolated child build per build-enabled service. A revision is applied only after every expected child artifact is approved.
- Routes and Secure Links target the project and service identity, not a child Container name.
- Child Containers, project-owned networks, and volumes are protected from standalone mutation.
- Persistent volumes are never deleted unless the user explicitly selects them.
- External Compose Projects stay read-only until adopted with complete YAML.

## Validation rules for supplied YAML

- Manual YAML is image-only. `build` is rejected even next to `image`; Git sources are the only build path, limited to the bounded `context`, `dockerfile`, and `args` subset.
- Host bind mounts, privileged mode, device access, and Swarm or PaaS features are rejected.
- Report unsupported fields from validation instead of silently dropping them.

## Lifecycle operations

Start, stop, restart, apply, pull and apply, `down`, cancellation, project deletion, and volume deletion are separate operations with separate consequences. `down` and `delete_volumes` destroy state and require explicit user intent; a request to redeploy or update never implies them.

## Git sources in detail

- `manage_docker_source` operations: `get`, `pending` (a Container that exists only as a queued first build), `create`, `upsert`, `remove`, `resolve`, `build`, `sync`, `admission`, `connectors`, `repositories`, `secret_list`, `secret_upsert`, `secret_delete`.
- `sync` polls the source's branch once right away, also when automatic builds are off, and returns `{ source, changed, build }`. It queues a build only when the branch head changed and automatic builds are on; otherwise `build` is null. It needs the same scope as `build`, and a repeat within about 10 seconds returns the current state without polling.
- Source fields: `connectorId`, `projectId` (the allowlisted repository), `branch`, `dockerfilePath`, `contextPath`, `autoBuild`, `autoDeploy`, non-secret `buildArgs`, and `buildSecretNames`. `create` also takes the new resource's name, folder, restart policy, runtime profile, routes, and health settings.
- Build Secrets are encrypted, source-scoped, and write-only. Never pass them as build arguments or copy them into the build context.
- A successful build produces a digest-pinned artifact in the internal registry. Automatic deployment recreates from that digest; the source branch is never the runtime identity.
- `list_docker_builds` and `find_resource({ types: ["docker_build"] })` give build history; `manage_docker_build` reads one build's status and incremental logs, cancels, or retries it.
- How to write the Dockerfile itself (volumes, ports, health, signals, secrets, build limits, migrations): [Dockerfile for Opfield](dockerfile-for-opfield.md).
