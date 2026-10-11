# Projects, Tags, and Git builds

Everything here goes through `manage_pages({ operation, projectId, ... })` unless noted. Pages must be licensed and enabled for operations that change runtime state; reads and deletions keep working after a license grace period ends.

## Choose local upload or Git source

Use a Git source when the repository is reachable through an allowlisted connector and repeatable push-to-deploy is wanted. Use the MCP artifact upload for generated reports, local-only changes, an already built output directory, or source that should stay disconnected from Opfield.

## Projects

- `project_create`: `name`, `nodeId` (a Pages-capable Nginx node from `project_placement_options`), optional `description`, `folderId`, `maxDeployments` (1 to 500, default 20), and `storageQuotaBytes` (default 1 GiB). Needs `pages:create` for the destination folder or node.
- `project_update`: `name`, `description`, `appearanceColor`, `previewsEnabled`, `spaFallback`, `fallbackUrl`, `maxDeployments`, `storageQuotaBytes`, and `accessListId`. Needs `pages:edit`; attaching an Access List also needs `acl:view` on it.
- `project_migrate` with `targetNodeId` moves the Project to another Nginx node and needs `pages:create` for that node.
- `project_delete` removes an empty Project only, and `pages:delete` is an OAuth manual-approval scope. Never delete a Project to "clean up" without explicit intent.
- `project_rotate_preview_hash` revokes and reissues every preview link of the Project; see the main skill before using it.

## Deployments and retention

- `deployment_list` (`includeDeleted: true` also lists Deployments whose files retention already removed), `deployment_get`, `deployment_links`.
- Retention keeps the newest `maxDeployments` successful Deployments within the storage quota and removes older ones that nothing protects. A Deployment is protected while it is pinned, serves a Tag or Route, or is being published or migrated.
- `deployment_pin` with `pinned: true` protects one Deployment from retention and expiry. `deployment_delete` removes an unprotected one. Both need `pages:deployments:manage`.

## Tags, rollback, and custom domains

- `tag_list` returns every Tag with its Deployment and preview link.
- `tag_move({ projectId, tag, deploymentId })` points a Tag at a ready Deployment, creating the Tag when needed. Rolling back means moving the Tag to an earlier ready Deployment. Needs `pages:tags:manage`.
- `tag_delete` removes the Tag, its runtime-configuration override, and its Tag preview. A Tag a Route still uses must be detached from that Route first.
- The system `latest` Tag follows every successful publication. Use a named Tag such as `production` when the user needs an explicit release pointer or rollback control.
- A custom domain is a Route with `upstreamKind: "pages"`, `pageProjectId`, and `pageTagId` of a ready Tag; an Additional Route uses `targetKind: "pages"`. Follow `ingress-and-domains` for the Domain, certificate, Route, and verification. Routes never target an immutable Deployment.
- Disabling Pages stops preview publication, but existing Tag Routes and stored content keep working.

## Runtime configuration

Runtime configuration is a JSON object served to the browser as `window.runtime.config`.

- `config_list`; `config_save_default` with `source` (a JSON object as a string); `config_save_tag` with `tagId` and `source`; `config_reset_tag` with `tagId` and `expectedGeneration`.
- Previews serve the default configuration; Tag Routes serve the Tag override when one exists.
- It is public data. Never put secrets, tokens, or private endpoints in it.

## Git-backed Pages

Git source builds require the applicable entitlement (Business or Enterprise for new builds), an allowlisted Git connector, a writable internal registry, and an online Build Worker.

1. Find or create the Project on a Pages-capable Nginx node.
2. `source_repositories` with `sourceConnectorId` lists repositories the connector can use.
3. `source_discover` with `sourceConnectorId`, `repositoryProjectId`, `branch`, and `applicationRoot` inspects the repository and `package.json`.
4. `source_upsert` configures `applicationRoot`, `packageManager` (`npm`, `pnpm`, or `yarn`), `packageManagerVersion`, `nodeVersion` (`20`, `22`, or `24`), `buildScript`, `artifactDirectory`, `publishTag`, `autoBuild` and `autoDeploy` (both default true), public `buildArgs`, `buildSecretNames`, and the vulnerability `policy`. It needs `pages:edit` and `pages:deploy`.
5. Store Build Secret values only through `source_secret_upsert` (`secretName`, write-only `secretValue`). Never ask for the value in chat: let the user enter it in the Opfield Console, or pass it from a local source the user named without echoing it. `source_secret_list` shows names only.
6. Start a build with `source_build` (optional `commitSha`, `force`) when one is not queued automatically. `source_sync` instead polls the branch once right away and returns `{ source, changed, build }`; it builds only when the head changed and automatic builds are on. Both need `pages:deploy`.
7. Follow it with `list_docker_builds` and `manage_docker_build` until the immutable artifact is approved and the Pages Deployment is ready.
8. Confirm that the publication Tag points at the new ready Deployment and verify its link or Route.

Frontend-prefixed build variables are compiled into public JavaScript. Never put secrets in them, and never expose Build Secret values in chat.

If Git admission fails, report the missing entitlement, connector, registry, or Build Worker prerequisite. Do not create an external CI pipeline as a silent workaround.

## Deploy tokens for CI

Deploy tokens let a CI system call the REST resumable deploy API without a user session. An agent connected through MCP never needs one for its own uploads.

- `token_list`, `token_create` (`name`, `allowedTagPatterns`, `allowUserTag`, optional `expiresAt`), and `token_revoke` need `pages:tokens:manage`, an OAuth manual-approval scope.
- `token_create` returns the raw token once. Prefer letting the user create it in the Opfield Console so it is shown only to them. If the user asks you to wire CI, write the token straight into the CI provider's secret store and never print it, log it, or repeat it later.
- Restrict `allowedTagPatterns` to the Tags that CI should publish and set an expiry when the pipeline is temporary.

## Profile

`profile_get` and `profile_options` read the Pages wildcard profile (`pages:settings:view`). `profile_configure` and `profile_disable` change the wildcard domain, certificate, and preview label template for every Project (`pages:settings:edit`, an OAuth manual-approval scope). Change the profile only on an explicit request.

## Permissions

| Scope | Allows |
| --- | --- |
| `pages:view` | Read Projects, Deployments, Tags, links, and runtime configuration |
| `pages:create` | Create Projects in a folder or on a node |
| `pages:deploy` | Upload through MCP or REST, attach a Git source, queue builds |
| `pages:edit` | Project settings, Access List, preview-link rotation, runtime configuration |
| `pages:tags:manage` | Move and delete Tags |
| `pages:deployments:manage` | Pin and delete Deployments |
| `pages:tokens:manage` | Deploy tokens (manual approval) |
| `pages:delete` | Delete Projects (manual approval) |
| `pages:settings:view`, `pages:settings:edit` | Pages profile |

Project scopes are resource-scopable per Project and follow Project folders.

Further reading: [Pages overview](https://docs.opfield.dev/en/pages/overview/), [Git deployments](https://docs.opfield.dev/en/pages/git-deployments/), [Static site journey](https://docs.opfield.dev/en/journeys/static-site/).
