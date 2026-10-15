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
- Source fields: `connectorId`, `projectId` (the allowlisted repository), `branch`, `dockerfilePath`, `contextPath`, `autoBuild`, `autoDeploy`, non-secret `buildArgs`, `buildSecretNames`, and `policy`.
- `policy.vulnerabilityThreshold` is the lowest severity that blocks a deployment (`critical` default, `high`, `medium`, `low`, `none` to report only, `disabled` to skip scanning). `policy.vulnerabilityScope` picks the findings that count: `all` (default), `application` (OS packages report-only), `fixable_application` (only findings with a released fix, OS packages report-only), or `fixable_all` (only findings with a released fix, any package). Both keys go inside `policy`; unknown or misplaced keys are refused.
- `upsert` of an existing source changes only the fields you pass; omitted fields and policy keys keep their saved values. It returns the saved source, including `policy`. `create` also takes the new resource's name, folder, restart policy, runtime profile, routes, and health settings.
- Attaching a source to an existing Container, Deployment, or Compose Project (`upsert` of a new source) is all it takes: the next successful build deploys into it. A Container keeps its settings and gets the build's image, a Deployment gets a blue/green release, a Compose Project a new revision. With `autoBuild`, attaching a source or changing its connector, repository, or branch queues the build of the branch head at once.
- `get` and `upsert` return `latestBuild` (`latestBuilds` for every service build of a Compose commit) and `state`, a plain sentence of what the latest build did and what runs on the target.
- When `deployedCommitSha` is null, read `state` and `latestBuild` before anything else (`pending` answers the same for a Container its first build has not created; `list_docker_builds` with `nodeId` and `containerName` lists its builds). A failed build says why in `errorCode` and `errorMessage`. `BUILD_ARTIFACT_POLICY_REJECTED` means the vulnerability policy blocked the image; the message lists the blocking counts and top findings and names the fix: update the packages, set `policy.vulnerabilityScope` to `application`, `fixable_application`, or `fixable_all`, or raise `vulnerabilityThreshold`. Fix the cause and build again (`build`, or `manage_docker_build` `retry`).
- A Compose service container or a blue/green slot container takes no source of its own: `create` and `upsert` refuse it with `SOURCE_TARGET_OWNED` (409), naming the owner. Attach the source to that Compose Project (`targetType: "compose"`, `composeProjectId`) or Deployment (`targetType: "deployment"`, `deploymentId`). A source attached to one earlier never recreates it: its builds fail with `SOURCE_TARGET_OWNED` and the container is left untouched. Such a source shows `invalidTarget` and an "Invalid target" `state` in `get`; remove it and attach one to the owner.
- Never replace a source-managed workload by hand: no recreating its Container from the node console or Docker CLI, no pulling a build artifact into it by digest. Opfield then no longer manages what runs, and the next build replaces it anyway.
- Build Secrets are encrypted, source-scoped, and write-only. Never pass them as build arguments or copy them into the build context.
- A successful build produces a digest-pinned artifact in the internal registry. Automatic deployment recreates from that digest; the source branch is never the runtime identity.
- `list_docker_builds` and `find_resource({ types: ["docker_build"] })` give build history; `manage_docker_build` reads one build's status and incremental logs, cancels, or retries it.
- How to write the Dockerfile itself (volumes, ports, health, signals, secrets, build limits, migrations): [Dockerfile for Opfield](dockerfile-for-opfield.md).
