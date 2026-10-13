# Permission Scopes

All scopes follow `domain:resource:action[:qualifier]`. Resource-scopable scopes may be limited with a resource suffix, for example `logs:schemas:view:<schemaId>`.

## Built-in Groups

| Group | Description |
|-------|-------------|
| `system-admin` | All canonical scopes, including protected `admin:system`. |
| `admin` | Curated broad access: every scope except `admin:system`, `admin:users:impersonate`, `settings:opfield:edit`, `housekeeping:configure`, `nodes:console`, `ai:skills:manage`, the `hosting:*` and `integrations:hosting:*` scopes, Docker registry create, edit, and delete, and the legacy `docker:registries:internal:*` scopes (registry access is set per API token). |
| `operator` | Operational access for day-to-day storage (with `storage:credentials:use`, without credential reveal, IAM keys, or bucket admin), database backups (without restore) and backup execution, PKI, proxy, Pages, SSL, ACL, node, database, notification, and logging read/query work. Creates and deploys Docker containers, deployments and Compose projects (image pull, secrets, console, GitLab, GitHub and Git connectors with `use` for build sources), without delete, mounts, export, migration, container file writes, or repository content (`repo:read`/`repo:write`). |
| `viewer` | Read-only view/discovery access, including GitLab, GitHub, Git, and Cloudflare connectors. Reads that can reveal secrets stay out: Docker volume files, notification webhooks, and logging ingest tokens. |
| `guest` | Authenticated account access without infrastructure permissions. |

## Access Lines

The Console shows the scopes of a permission group, a user, an API token, and an OAuth request as access lines. A line is a view over ordinary scopes: saving stores plain scopes, and the API and MCP stay scope-based.

- A resource line is a role in a place: everywhere (unqualified scopes), in a project folder (`<scope>:folder/<folderId>` in each covered type's own folder tree, picked by the same folder path), or on specific resources (`<scope>:<resourceId>`; creation scopes are left out, since they name a destination). A type whose tree has no folder with that path is left out of the line.
- "May delete resources" adds the type's delete scope. Only Developer and Operator can delete.
- A Git line is a level on one connector (or on every connector of a provider), for every repository, one GitLab group or GitHub owner (with the repositories added later), or some repositories. Use is `view` and `use`; Read code adds `repo:read`; Edit code and CI adds `repo:write`.
- Scopes no line covers show as one Custom scopes line. Review scopes opens the scope picker over the raw scopes; applying it rebuilds the lines.
- A user's own lines are their additional permissions; lines from their groups show with the group name and change in the group. A group shows its parent group's lines the same way.
- An API token line wider than its owner's access shows what it really does, and saving keeps only that part, since a token never holds more than its owner.

| Type | Viewer | Deployer | Developer | Operator | May delete |
|------|--------|----------|-----------|----------|------------|
| Containers and deployments | `docker:containers:view` | + `manage` | + `create`, `edit`, `environment`, `link` | + `secrets`, `console`, `webhooks` | `docker:containers:delete` |
| Compose projects | `docker:compose:view` | + `manage` | + `create` | same as Developer | `docker:compose:delete` |
| Routes | `proxy:view` | same as Viewer | + `create`, `edit` | + `maintenance:bypass` | `proxy:delete` |
| Domains | `domains:view` | same as Viewer | same as Viewer | + `create`, `edit` | `domains:delete` |
| SSL certificates | `ssl:cert:view` | same as Viewer | + `issue` | + `renew` | `ssl:cert:delete` |
| Databases | `databases:view` | same as Viewer | + `bind`, `query:read` | `view`, `create`, `edit`, `query:read`, `query:write`, `query:admin` | `databases:delete` |
| Object storage | `storage:view` | same as Viewer | + `objects:read` | + `create`, `edit`, `credentials:use`, `objects:write` | `storage:delete` |
| Pages | `pages:view` | + `deploy` | + `create`, `deployments:manage`, `tags:manage` | + `edit` | `pages:delete` |

Viewer and Operator match the built-in `viewer` and `operator` groups type by type. Stored scopes become lines in a fixed order: roles everywhere, then per folder path, then on resources, then Git, then custom scopes; equal scope sets take the smaller role.

## Programmatic Access

Opfield has four token families:

| Prefix | Purpose |
|--------|---------|
| `gw_` | API token for REST API automation. |
| `gwo_` | OAuth access token for one OAuth resource. |
| `gwl_` | External logging ingest token. |
| `gwi_` | Dedicated Opfield Inference runtime token. |

OAuth tokens are bound to exactly one resource:

| Resource | URL path | Accepted by |
|----------|----------|-------------|
| Opfield API | `/api` | REST API routes |
| Opfield MCP | `/api/mcp` | Remote MCP endpoint |

The REST API accepts browser sessions, `gw_` API tokens, and `gwo_` OAuth tokens issued for the Opfield API resource. The MCP endpoint accepts only `gwo_` OAuth tokens issued for the Opfield MCP resource; API tokens, browser cookies, logging tokens, and inference tokens are rejected. Inference data-plane routes accept only `gwi_` tokens.

OAuth lifetime behavior is resource-specific:

- Opfield API OAuth uses expiring access tokens and refresh-token renewal.
- Opfield MCP OAuth is intended for long-lived MCP access and does not rely on refresh-token churn during normal use.

Delegated API/OAuth scopes are always bounded by the owning user's current effective scopes. Revoking or editing a user's group permissions also reduces the effective permissions of that user's existing tokens.

## Scope Evaluation Behavior

Opfield evaluates scopes with exact, broad, resource-scoped, and implied-scope rules:

- A broad resource-scopable scope grants access to every resource for that base scope. For example, `proxy:view` grants `proxy:view:<hostId>`.
- A resource-scoped scope grants access only to that resource. For example, `proxy:edit:<hostA>` grants read/edit access to `hostA`, but not to `hostB` and not to broad `proxy:view`.
- List APIs and list pages are derived from view/detail permissions. Broad view lists every visible resource of that type; resource-scoped view lists only matching rows.
- Every scope belongs to a family named by its longest prefix that has a view scope (`proxy:*` → `proxy:view`, `docker:containers:*` → `docker:containers:view`, `nodes:*` → `nodes:details`, `docker:tasks:manage` → `docker:tasks`). Any action scope in a family implies the family's view scope, including delete scopes: `proxy:edit` and `proxy:delete` both satisfy `proxy:view`. The rule is generated from the catalog (`packages/backend/src/lib/scopes-implications.ts`) and shipped unchanged to the web UI.
- Creation scopes (every `*:create*` scope, `docker:images:pull`, `ssl:cert:issue`, and `pki:cert:issue`) name a destination and never imply any view, whatever their qualifier (broad, `folder/`, `node/`, `account/`, or a bare node ID): `proxy:create` does not satisfy `proxy:view`, and `proxy:create:folder/F` does not satisfy `proxy:view:folder/F`. Folder trees and node pickers accept creation scopes on their own to show the destinations a creator may use. The one kept rule is `hosting:snapshots:create:<vmId>` implying that VM's snapshot view. `ssl:cert:issue` also implies `ssl:cert:renew` with the same qualifier, but never what renewal implies.
- `proxy:maintenance:bypass` (a browser maintenance code) and the legacy `docker:registries:internal:pull` / `:push` imply nothing.
- API tokens and OAuth/MCP grants expand their own folder and node targets before they are bounded by the owner's current (expanded) permissions, and are never expanded afterwards, so a token can never reach a resource its owner cannot.
- A few explicit rules complete it: access tiers (`storage:objects:admin` ⊇ `write` ⊇ `read`, `databases:query:admin` ⊇ `write` ⊇ `read`, `storage:credentials:reveal` ⊇ `storage:credentials:use`), `logs:read` and `logs:tokens:*` imply `logs:environments:view`, `nodes:manage` implies `nodes:config:view`, which implies `nodes:details`, `inference:models:manage` implies `inference:providers:view`, `docker:availability:manage` implies `docker:containers:view`, `pki:cert:export` implies `pki:cert:deploy`, `docker:containers:secrets` implies `docker:containers:environment` (secret values reach the workload as environment variables), and `databases:edit` and `storage:iam` imply `databases:bind` and `storage:bind` (linking workloads used to need them). View scopes never imply another family's view otherwise; for example `proxy:templates:view` does not grant `proxy:view`.
- Implied scopes keep the same resource boundary. For example, `databases:query:read:<databaseId>` makes that database visible in a filtered database list, but does not grant global `databases:view`; `docker:containers:manage:<nodeId>` satisfies `docker:containers:view:<nodeId>/<resourceId>`.
- `logs:schemas:view:<schemaId>` does not imply global `logs:schemas:view`. Resource-scoped schema view/edit access can list only the matching schema rows.
- Folder-tree scopes (`proxy:folders:manage`, `docker:folders:manage`, and the other `*:folders:manage` scopes except hosting snapshot folders) grant full folder-tree visibility and folder mutation rights, but not item visibility. Moving or reordering items still requires the matching item edit or manage scope.
- Folder management can be limited to a folder: `<scope>:folder/<folderId>` for `domains:folders:manage`, `proxy:folders:manage`, `ssl:cert:folders:manage`, `pki:ca:folders:manage`, `pki:cert:folders:manage`, `pki:templates:folders:manage`, `proxy:templates:folders:manage`, `nodes:folders:manage`, `admin:users:folders:manage`, `admin:groups:folders:manage`, `docker:folders:manage`, `databases:folders:manage`, `storage:folders:manage`, `pages:folders:manage`, `logs:environments:folders:manage` and `logs:schemas:folders:manage` (folder qualifier only; a Docker folder grant covers the subtree in that folder's own Docker list). Such a grant shows that folder and its subfolders and manages what is inside it: creating, renaming, moving, reordering and deleting its subfolders, and moving or reordering items in them. It never renames, moves or deletes the granted folder itself and never touches the top level. Moving a folder needs folder management where it leaves and where it lands; moving items needs it at each item's current folder and at the destination.
- A folder cannot be moved next to a folder with the same name (compared case-insensitively, ignoring surrounding spaces).
- `pages:folders:manage` grants full Page Project folder-tree visibility and folder mutation rights, but moving or reordering Projects also requires `pages:edit:<projectId>` for every affected Project.
- Every resource-qualified Pages scope uses the Page Project ID, including Deployment, Tag, and deploy-token operations.
- Docker container scopes accept either `<nodeId>` for every container and deployment on a node or `<nodeId>/<stableResourceId>` for exactly one standalone container or blue/green deployment. Node grants cover their child resources; child grants do not cover siblings.
- Changing an existing container or deployment is authorized on the workload itself. A new image or tag (container update or recreate, deployment deploy or update, AI/MCP tools) needs `docker:containers:edit`, `docker:containers:environment` and `docker:containers:secrets` (deploy also `manage`) on the workload, because the new code receives its environment and secrets; those scopes authorize pulling the image, as `docker:containers:create` does at creation, so `docker:images:pull` is not needed. A Compose revision needs `docker:compose:manage`. An environment-only change needs only `docker:containers:environment` and a secrets-only change only `docker:containers:secrets`, including the container recreate it causes (`PUT .../env`, an update with `env` alone, AI `update_env`) and saving a deployment's environment alone; the deploy that rolls a deployment's saved environment out keeps `manage`. The secret list returns the keys with `docker:containers:environment` and the values only with `docker:containers:secrets`. Attaching an Opfield-managed volume (create, recreate, duplicate, deployment create or update, archive import into an existing volume) needs `docker:volumes:view` (or `edit`) on each newly attached volume plus the workload's own create or edit; `docker:containers:mounts` is needed only for legacy host bind mounts.
- Recreate and in-place update workflows preserve a standalone container's stable resource ID. Cross-node migration rewrites child grants to the target node. Explicit container or deployment deletion removes child grants, so a later same-name resource does not inherit access.
- When an API/OAuth token asks for a broad scope but the owning user has only resource-scoped access, Opfield narrows the effective token scope to the resource-scoped variant.
- Folder-scopable scopes accept `<scope>:folder/<folderId>`; the grant covers the folder, its subfolders, and every resource currently inside them. Node-bound families (routes, Pages, storage, databases, Docker, hosted VM snapshots and resources) and every creation scope accept `<scope>:node/<nodeId>`. Logging token scopes resolve folder grants through logging environment folders; `docker:availability:manage` through the granted container or Compose folder. `pki:ca:view`, `pki:ca:edit` and `pki:ca:export` folder grants cover each root CA in the folder and its intermediates; `pki:cert:view`, `pki:cert:revoke` and `pki:cert:export` folder grants the certificates in a PKI certificate folder; `proxy:templates:view` and `proxy:templates:manage` folder grants the nginx templates in the folder; `ingress:groups:view` and `ingress:groups:manage` accept only node folder grants, which cover the ingress groups in the folder and its subfolders. Certificate templates are not resource-scopable, so their folders only organize the list.
- With "assign created resource permissions" enabled, the creator of a resource keeps only the per-resource scopes they already hold for it (broadly, on the destination folder or node, or through an existing grant), and always view of the created resource itself, so the grant survives a later move without adding capabilities. The destination is read from the created resource when the caller does not pass it.

## Git Integration Restrictions

Git integration scopes can be limited to one connected account and, below it, to GitLab groups and projects or GitHub owners and repositories. Qualifiers are stable provider IDs, never names or paths, so renaming or moving a group or repository never changes a grant.

| Qualifier | Grants |
|-----------|--------|
| `<scope>:<connectorId>` | Every repository of that connector. |
| `<scope>:<connectorId>/group/<groupId>` | GitLab: the group, its subgroups, and every project under them. Group ancestry comes from the GitLab API (the project's namespace and its parent groups, cached for a few minutes), so a moved project follows its new group. A parent group the connector credential cannot open is taken from the project's ancestor list; when the ancestry still cannot be read completely, the check fails with 409 `GITLAB_GROUP_ANCESTRY_UNAVAILABLE` (and an audit entry) instead of silently not matching, and lists leave such projects out. |
| `<scope>:<connectorId>/project/<projectId>` | GitLab: that project. |
| `<scope>:<connectorId>/owner/<ownerId>` | GitHub: every repository of that organization or user. |
| `<scope>:<connectorId>/repo/<repoId>` | GitHub: that repository. |

- Restrictable scopes: `integrations:{gitlab,github,git}:{view,use,repo:read,repo:write}` and `integrations:gitlab:sandbox:clone`. Generic Git takes connector qualifiers only. `integrations:<provider>:manage` is unqualified or limited to a connector: managing the connection (settings, tokens, allowlist, sync, test, delete) needs it on the connector or unqualified, and creating connectors needs it unqualified.
- An operation on a repository is allowed with the unqualified scope, the connector qualifier, any group or owner qualifier that contains the repository, or the exact project or repository qualifier. Implied view applies per qualifier: `integrations:gitlab:repo:write:<connectorId>/project/42` also grants `integrations:gitlab:view:<connectorId>/project/42`. Folder qualifiers do not apply to integrations.
- Every repository operation checks the repository: files, trees, branches, commits, CI pipelines, job logs and variables, webhooks, deploy tokens, registry settings, sandbox clones, and Docker or Pages build sources, in the REST API, the AI assistant and Opfield MCP alike.
- The connector's system credential is used when `integrations:<provider>:use` covers the repository the same way; otherwise the caller's personal credential. Without either, AI Workspace users are asked to authorize a personal credential and every other caller gets a 403 naming `integrations:<provider>:use` and the repository.
- Lists show only what the caller may view: connector lists and GitLab connector details and capabilities are open to callers with any Git scope on the connector (connectors seen only through group, owner, project or repository grants leave out their allowlist), and project and repository lists hold the projects and repositories the grants cover, decided by the same group ancestry (by ID) as the checks.
- Connecting a Docker or Pages build source to a repository, or changing its connector, repository or branch, needs `integrations:<provider>:use` on the repository (any qualifier covering it) next to the workload's own permissions; `repo:read`, an unqualified `view`, or a personal credential are not needed, because builds run with the connector credential. The source picker lists the connectors and repositories the caller's `use` grants cover, the same check saving applies. GitLab and generic Git list every synced or allowlisted repository; GitHub lists up to 1000 of the connector's repositories (allowlisted ones, unless it takes every visible repository) and finds others with `?search=` (GitHub's search API and the exact `owner/name`); the response carries `truncated` while the list may be incomplete. Saving other source settings and manual builds (Build now, rebuild, deploying a commit) need only the workload's own permissions. Polling, webhook and deferred builds never depend on anyone's current permissions; the repositories a source can build stay limited to what its connector reaches (synced or allowlisted projects that are still accessible).
- A GitLab project outside the caller's grant answers exactly like a project that is not synced (404, no path), so project IDs cannot be probed. Writes, secrets (CI/CD variables, webhooks, deploy tokens), sandbox clones and the connector-credential decision read group ancestry and repository ownership fresh from the provider; reads may use the cached value for up to five minutes. GitHub ownership is cached by repository ID, never by path. Connector syncs and source webhook deliveries drop the cached data.
- Connector change events over the WebSocket reach only callers who may see that connector.
- The scope picker reads `GET /api/integrations/{gitlab|github}/{connectorId}/scope-targets?search=&limit=50` (groups and projects, or owners and repositories) and `GET .../scope-targets/resolve?ids=group/123,project/456` (labels for stored qualifiers; `missing` when the target no longer exists). Both need `integrations:<provider>:view` on the connector or anything in it and return only targets the caller may view and the connector includes (its allowlist, unless it takes every visible repository); a stored qualifier the caller cannot view keeps its raw ID as the label. Picker requests are limited per account (60 a minute, then 429), and one request makes at most 60 uncached provider lookups; later targets stay unlabeled. `search` matches names and full paths (`team/sub`, `owner/repo`); a search reads a bounded number of provider pages (GitHub also uses its search API past that bound), and `truncated: { more, exact }` reports matches left out so the caller can refine the search.
- `GET .../scope-targets/lookup?kind=group&path=team/sub` (GitLab `group`/`project`, GitHub `owner`/`repo`) returns the stable qualifier of a path the caller may view (Opfield MCP: `find_git_scope_target`). Permission group saves and additional user permissions also accept `<scope>:<connectorId>/<kind>/path/<path>` and store the resolved ID qualifier; a path that does not resolve fails the save. Only IDs are stored, so a later rename never changes what a grant covers.
- API tokens and OAuth/MCP grants are bounded by the owner's current scopes per qualifier: a broader token is narrowed to the owner's qualifiers, and a token limited to a group, owner, project or repository keeps that qualifier when its owner holds the same scope (or one implying it) unqualified, on the connector, or with any group, owner, project or repository qualifier on the same connector. Containment is provider data, so every repository operation of a token or OAuth caller requires both the token's scopes and the owner's current scopes to cover the repository: a token limited to project P works when its owner holds the group containing P, and a token limited to group G whose owner holds only project P reaches P alone. Such narrow token scopes never count when the token grants permissions to users or groups.

## Retired Scope Names

The v2.11 catalog cleanup renamed, merged, or removed these scopes. Migration `0200_scope_catalog_cleanup` added the replacement to every stored grant (qualifiers are kept: `old:<suffix>` gains `new:<suffix>`) and left the retired name next to it, so an Opfield installation rolled back to 2.10 keeps working with the names it knows. Retired names grant nothing in 2.11 and are not shown by the API; when 2.11 starts after an older release has run, it repeats this conversion. Holders of `pki:ca:create:root` also received `pki:ca:edit` and `pki:ca:export`, holders of `integrations:{github,git}:view` received `:repo:read`, holders of `integrations:{github,git}:manage` received `:repo:read` and `:repo:write`, and holders of `docker:volumes:create` (broad or on a bare node ID; not folder or `node/` destinations, and not delete-only holders) received `docker:volumes:edit` with the same qualifier. For two releases Opfield still accepts the old names on input (OAuth `scope`, API token create/update, permission group create/update, user additional permissions, and OAuth authorization edits) and rewrites them the same way; a request whose scopes were all removed is rejected. New API tokens and OAuth requests also receive these additions when the requester holds them, except manual-approval scopes such as `pki:ca:export` or `integrations:github:repo:write`, which must be requested explicitly (OAuth consent shows the additions and they can be unticked). Permission checks use only the current names.

| Retired | Replacement |
|---------|-------------|
| ssl:cert:revoke, ssl:cert:export | Removed (never enforced). |
| notifications:view | notifications:alerts:view, notifications:webhooks:view |
| notifications:manage | notifications:alerts:manage, notifications:webhooks:manage |
| notifications:alerts:create, :edit, :delete | notifications:alerts:manage |
| notifications:webhooks:create, :edit, :delete | notifications:webhooks:manage |
| notifications:deliveries:view | notifications:webhooks:view |
| logs:manage | Every logs:* scope. |
| docker:containers:config | Removed. Duplicate and recreate require environment and secrets; a Docker node's service address requires nodes:manage. |
| nodes:config:edit | nodes:manage |
| pki:ca:view:root, pki:ca:view:intermediate | pki:ca:view |
| integrations:gitlab:sync, :github:sync, :git:sync | integrations:<provider>:manage |
| integrations:gitlab:system, :github:system, :git:system | integrations:<provider>:use |
| integrations:gitlab:projects:view | integrations:gitlab:view (listing synced projects is connector metadata) |
| integrations:gitlab:ci:view, :variables:view | integrations:gitlab:repo:read (repository files, CI pipelines and job logs, and CI/CD variable keys) |
| integrations:gitlab:ci:edit, :variables:edit, :variables:delete, :webhooks:manage, :registry:manage | integrations:gitlab:repo:write |
| proxy:raw:toggle | Removed; toggling raw mode requires proxy:raw:write. |
| proxy:advanced:bypass, proxy:raw:bypass | proxy:unrestricted |
| proxy:templates:create, :edit, :delete | proxy:templates:manage |
| docker:containers:folders:manage | docker:folders:manage |

Legacy global nginx management routes under `/api/monitoring/nginx/*` are no longer exposed. Node-specific nginx monitoring, config, and logs remain governed by node scopes.

## Scope List

| Scope | Resource-scopable |
|-------|-------------------|
| `storage:view` | Resource-scopable storage or backup permission. |
| `storage:create` | Create storage in permitted folders or nodes. |
| `storage:edit` | Resource-scopable storage or backup permission. |
| `storage:delete` | Resource-scopable storage or backup permission. |
| `storage:credentials:reveal` | Resource-scopable storage or backup permission. |
| `storage:credentials:use` | Resource-scopable storage or backup permission. Lets backups use the saved credentials without revealing them; implied by `storage:credentials:reveal`. |
| `storage:iam` | Resource-scopable storage or backup permission. Creates and removes scoped IAM keys and moves workload links between clusters; implies `storage:bind`. |
| `storage:objects:read` | Resource-scopable storage or backup permission. |
| `storage:objects:write` | Resource-scopable storage or backup permission. |
| `storage:objects:admin` | Resource-scopable storage or backup permission. |
| `storage:folders:manage` | Manage storage resource folders. |
| `storage:bind` | Resource-scopable storage permission. Creates and deletes managed-storage workload links without issuing access keys; the target workload also needs its environment and secrets scopes. |
| `databases:backups:view` | Resource-scopable storage or backup permission. |
| `databases:backups:manage` | Resource-scopable storage or backup permission. |
| `databases:backups:run` | Resource-scopable storage or backup permission. |
| `databases:backups:restore` | Resource-scopable storage or backup permission. |
| `nodes:backups:execute` | Resource-scopable storage or backup permission. |
| `pki:ca:view` | Yes. View certificate authorities; restrictable to CA ID. Replaces `pki:ca:view:root` and `pki:ca:view:intermediate`. |
| `pki:ca:create:root` |  |
| `pki:ca:create:intermediate` | Yes |
| `pki:ca:edit` | Yes. Edit CA settings (CRL and CA issuer URLs, maximum validity) and the OCSP responder; restrictable to CA ID. |
| `pki:ca:export` | Yes. Export a CA private key; restrictable to CA ID. Requires manual OAuth approval. |
| `pki:ca:revoke:root` |  |
| `pki:ca:revoke:intermediate` |  |
| `pki:ca:folders:manage` | Manage CA folders. A folder holds whole CA hierarchies: only root CAs move, their intermediates follow. Moving a root CA also needs `pki:ca:edit` on it and on the destination. |
| `pki:cert:view` | Yes |
| `pki:cert:issue` | Yes |
| `pki:cert:revoke` | Yes |
| `pki:cert:export` | Yes |
| `pki:cert:deploy` | Yes. Attach a TLS server certificate to a Route or link it into the SSL store (with `ssl:cert:issue` on the destination): nginx receives the private key, the caller never does, and the SSL store never returns it. Restrictable to the certificate or its issuing CA. Implied by `pki:cert:export`. |
| `pki:cert:folders:manage` | Manage PKI certificate folders. Moving a certificate also needs `pki:cert:issue` on its issuing CA. |
| `pki:templates:view` |  |
| `pki:templates:create` |  |
| `pki:templates:edit` |  |
| `pki:templates:delete` |  |
| `pki:templates:folders:manage` | Manage certificate template folders. Moving a custom template also needs `pki:templates:edit`; built-in templates never move. |
| `domains:view` | Yes. With `ssl:cert:issue` on the destination, also issues an ACME certificate for that domain. |
| `domains:create` |  |
| `domains:edit` |  |
| `domains:delete` |  |
| `domains:folders:manage` |  |
| `proxy:view` | Yes |
| `proxy:create` | Yes |
| `proxy:edit` | Yes |
| `proxy:delete` | Yes |
| `proxy:raw:read` | Yes |
| `proxy:raw:write` | Yes |
| `proxy:advanced` | Yes |
| `proxy:unrestricted` | Yes. Apply unrestricted advanced nginx snippets and raw configs that bypass dangerous-directive validation. Replaces `proxy:advanced:bypass` and `proxy:raw:bypass`. |
| `proxy:maintenance:bypass` | Yes |
| `proxy:folders:manage` |  |
| `pages:view` | Yes |
| `pages:create` |  |
| `pages:edit` | Yes |
| `pages:delete` | Yes |
| `pages:deploy` | Yes |
| `pages:deployments:manage` | Yes |
| `pages:tags:manage` | Yes |
| `pages:tokens:manage` | Yes |
| `pages:folders:manage` |  |
| `pages:settings:view` |  |
| `pages:settings:edit` |  |
| `proxy:templates:view` | Yes |
| `proxy:templates:manage` | Yes. Create, edit, and delete nginx templates, including template content. Replaces `proxy:templates:create`, `:edit`, and `:delete`. |
| `proxy:templates:folders:manage` | Manage nginx template folders. Moving a custom template also needs `proxy:templates:manage` on it and on the destination; built-in templates never move. `proxy:templates:manage:folder/<id>` also creates templates in that folder. |
| `ssl:cert:view` | Yes |
| `ssl:cert:issue` | Create certificates (ACME, upload, PKI link) in permitted folders. Also renews existing certificates (implies `ssl:cert:renew`, never `ssl:cert:view`). |
| `ssl:cert:renew` | Yes. Renew or reissue an existing certificate, complete its DNS-01 verification, cancel a pending ACME order, and set automatic renewal. |
| `ssl:cert:folders:manage` | Yes |
| `ssl:cert:delete` | Yes |
| `acl:view` | Yes |
| `acl:create` |  |
| `acl:edit` | Yes |
| `acl:delete` | Yes |
| `nodes:details` | Yes |
| `nodes:create` |  |
| `nodes:rename` | Yes |
| `nodes:delete` | Yes |
| `nodes:manage` | Yes. General node control: global nginx config, Docker secure runtime install, the service addresses of Docker, Nginx, database, and storage nodes (no `nodes:rename` needed), and hosted VM power, resize, and snapshot restore. Replaces `nodes:config:edit`. |
| `nodes:config:view` | Yes |
| `nodes:logs` | Yes |
| `nodes:console` | Yes |
| `nodes:files:read` | Yes |
| `nodes:files:write` | Yes |
| `nodes:lock` | Yes |
| `nodes:folders:manage` |  |
| `ingress:groups:view` | Node folders only (`folder/<nodeFolderId>`). View ingress groups and place routes and domains on them; node permissions do not reveal them. |
| `ingress:groups:manage` | Node folders only (`folder/<nodeFolderId>`). Create, change, and delete ingress groups and their members; implies `ingress:groups:view`. Adding a member also needs `nodes:manage` on that node. |
| `apps:view` | Yes: `<appId>` or `env/<envId>`. View apps, their environments, overview and activity; members still need their own view scopes. |
| `apps:create` |  |
| `apps:edit` | Yes: `<appId>`. Rename the app, add, rename and delete environments, move the Production marker. |
| `apps:delete` | Yes: `<appId>`. Delete the app; members keep running and leave the app. |
| `apps:env:manage` | Yes: `<appId>` or `env/<envId>`. Environment variables and secrets, allowed nodes, environment maintenance and access codes, moving resources in or out (with the resource's own edit scope). |
| `apps:promote` | Yes: `<appId>` or `env/<envId>` (the target environment). |
| `apps:operate` | Yes: `<appId>` or `env/<envId>`. Shutdown, start and isolation; the app maintenance override needs it on the app. |
| `admin:users` |  |
| `admin:users:impersonate` |  |
| `admin:users:folders:manage` |  |
| `admin:groups` |  |
| `admin:groups:folders:manage` |  |
| `admin:audit` |  |
| `audit:siem:view` |  |
| `audit:siem:manage` |  |
| `admin:system` |  |
| `admin:details:certificates` |  |
| `admin:update` |  |
| `admin:alerts` |  |
| `settings:opfield:view` |  |
| `settings:opfield:edit` |  |
| `integrations:gitlab:view` | View GitLab connectors, their sync status, and their synced projects. Absorbs `projects:view`. Restrictable to a connector, group, or project. |
| `integrations:gitlab:manage` | Configure, test, and synchronize GitLab connectors. Restrictable to a connector. |
| `integrations:gitlab:use` | Use the GitLab connector system credential; connect Docker and Pages build sources to a repository. Replaces `integrations:gitlab:system`. Restrictable to a connector, group, or project. |
| `integrations:gitlab:repo:read` | Read GitLab repository content, CI pipelines and job logs, and CI/CD variable keys (never values; these can still be sensitive). Absorbs `ci:view` and `variables:view`. Restrictable to a connector, group, or project. |
| `integrations:gitlab:repo:write` | Write GitLab repository content, CI configuration, CI/CD variables, webhooks, and container registry state. Absorbs `ci:edit`, `variables:edit`, `variables:delete`, `webhooks:manage`, and `registry:manage`. Restrictable to a connector, group, or project. |
| `integrations:gitlab:sandbox:clone` | Clone a GitLab repository into the AI sandbox. Restrictable to a connector, group, or project. |
| `integrations:github:view` | View GitHub connectors. Restrictable to a connector, owner, or repository. |
| `integrations:github:manage` | Configure, test, and synchronize GitHub connectors. Restrictable to a connector. |
| `integrations:github:use` | Use GitHub connector system credentials; connect Docker and Pages build sources to a repository. Replaces `integrations:github:system`. Restrictable to a connector, owner, or repository. |
| `integrations:github:repo:read` | List and read GitHub repositories and their files; no Actions variable values. Restrictable to a connector, owner, or repository. |
| `integrations:github:repo:write` | Write GitHub repository files and secrets, and read or change Actions variables. Restrictable to a connector, owner, or repository. |
| `integrations:git:view` | View generic Git connectors. Restrictable to a connector. |
| `integrations:git:manage` | Configure, test, and synchronize generic Git connectors. Restrictable to a connector. |
| `integrations:git:use` | Use generic Git connector system credentials; connect Docker and Pages build sources to a repository. Replaces `integrations:git:system`. Restrictable to a connector. |
| `integrations:git:repo:read` | List and read generic Git repositories and their files. Restrictable to a connector. |
| `integrations:git:repo:write` | Write generic Git repository files. Restrictable to a connector. |
| `integrations:ssh:view` |  |
| `integrations:ssh:manage` |  |
| `integrations:ssh:use` |  |
| `integrations:cloudflare:view` |  |
| `integrations:cloudflare:manage` |  |
| `integrations:cloudflare:sync` |  |
| `integrations:hosting:view` | View hosting accounts; restrictable to connector ID. |
| `integrations:hosting:manage` | Configure and synchronize hosting accounts; restrictable to connector ID. |
| `hosting:resources:view` | View provider inventory; restrictable to connector ID. |
| `hosting:resources:create` | Create hosted nodes; restrictable to connector ID. Also requires `nodes:create`. |
| `hosting:resources:power` | Start, shut down or reboot a hosted VM; restrictable to resource ID. |
| `hosting:resources:resize` | Resize a hosted VM; restrictable to resource ID. |
| `hosting:snapshots:view` | View VM snapshots and folders; restrictable to resource ID. Snapshot mutation permissions imply view only for the same resource. Also requires VM inventory and bound-node details access. |
| `hosting:snapshots:create` | Create a VM snapshot without requiring shutdown; restrictable to resource ID. Also requires configuration access to bound nodes. Optional `includeRam` is supported only for running Proxmox VMs and defaults to disk-only snapshots. |
| `hosting:snapshots:delete` | Delete a VM snapshot; restrictable to resource ID. |
| `hosting:snapshots:restore` | Restore a VM snapshot, replacing disk data; restrictable to resource ID. Proxmox handles stopping a running VM during rollback; Opfield requests restart if it was running immediately before dispatch. Other providers currently require a stopped VM. |
| `hosting:snapshots:folders:manage` | Create folders and organize VM snapshots; restrictable to resource ID. |
| `hosting:resources:delete` | Destroy a hosted VM or cancel a HOSTKEY rental; restrictable to resource ID. |
| `hosting:resources:recover` | Restart a hosted daemon through an available independent channel; restrictable to resource ID. |
| `hosting:billing:view` | Read account finances; restrictable to connector ID. Never implied by node access. |
| `hosting:billing:topup` | Create a HOSTKEY deposit invoice; restrictable to connector ID. |
| `housekeeping:view` |  |
| `housekeeping:run` |  |
| `housekeeping:configure` |  |
| `diagnostics:view` | Opfield's own state and its 48-hour minute history: host CPU, memory and disk, the backend process, its Postgres and Redis, the stack containers, background jobs and API latency. Granted to the built-in admin groups. |
| `diagnostics:logs` | Read the logs of Opfield's own containers (app, Postgres, Redis, relay, registry, update runs). Implies `diagnostics:view`. Granted to the built-in admin groups; not to demo-admin. |
| `license:view` |  |
| `license:manage` |  |
| `ai:workspace:use` | Use AI Workspace. Granted to the built-in viewer group and above. |
| `feat:ai:use` | Use Opfield Inference, view personal usage, and create or revoke personal inference tokens. |
| `feat:ai:configure` |  |
| `ai:skills:manage` | Manage shared user-defined AI Workspace skills. |
| `ai:sandbox:use` |  |
| `ai:sandbox:tier:medium` |  |
| `ai:sandbox:tier:high` |  |
| `ai:sandbox:manage` |  |
| `mcp:use` |  |
| `inference:providers:view` |  |
| `inference:providers:manage` |  |
| `inference:models:manage` |  |
| `inference:limits:manage` |  |
| `inference:usage:view` |  |
| `docker:containers:view` | Yes |
| `docker:containers:create` | Yes |
| `docker:containers:edit` | Yes |
| `docker:containers:manage` | Yes |
| `docker:containers:environment` | Yes |
| `docker:containers:link` | Yes. Lets other workloads reach one port of this container or deployment through a container link; the consumer side needs `docker:containers:edit` (Compose: `docker:compose:manage`). |
| `docker:containers:delete` | Yes |
| `docker:containers:console` | Yes |
| `docker:containers:files:read` | Yes |
| `docker:containers:files:write` | Yes |
| `docker:containers:export` | Yes |
| `docker:containers:secrets` | Yes |
| `docker:containers:webhooks` | Yes |
| `docker:containers:mounts` | Yes |
| `docker:containers:migrate` | Yes |
| `docker:availability:manage` | Yes. Folder grants resolve through the granted container or Compose folder. |
| `docker:folders:manage` | Manage folders for Docker containers, deployments, Compose projects, networks, volumes, and images. Replaces `docker:containers:folders:manage`. |
| `docker:compose:view` | Yes |
| `docker:compose:create` | Yes |
| `docker:compose:manage` | Yes |
| `docker:compose:delete` | Yes |
| `docker:images:view` | Yes |
| `docker:images:pull` | Yes |
| `docker:images:delete` | Yes |
| `docker:volumes:view` | Yes |
| `docker:volumes:create` | Yes |
| `docker:volumes:edit` | Yes. Rename, relabel, resize, and adopt one volume; restrictable to node, volume, or folder. |
| `docker:volumes:delete` | Yes |
| `docker:volumes:export` | Yes |
| `docker:volumes:files:read` | Yes |
| `docker:volumes:files:write` | Yes |
| `docker:networks:view` | Yes |
| `docker:networks:create` | Yes |
| `docker:networks:edit` | Yes |
| `docker:networks:delete` | Yes |
| `docker:registries:view` |  |
| `docker:registries:create` |  |
| `docker:registries:edit` |  |
| `docker:registries:delete` |  |
| `docker:registries:internal:pull` | Legacy, repository-scopable. Lets the holder's API tokens pull these repositories without workload access; see Internal Registry Access. |
| `docker:registries:internal:push` | Legacy, repository-scopable. Lets the holder's API tokens push to these repositories without workload access; see Internal Registry Access. |
| `docker:tasks` |  |
| `docker:tasks:manage` | Yes |
| `databases:view` | Yes |
| `databases:create` |  |
| `databases:edit` | Yes |
| `databases:delete` | Yes |
| `databases:query:read` | Yes |
| `databases:query:write` | Yes |
| `databases:query:admin` | Yes |
| `databases:credentials:reveal` | Yes |
| `databases:folders:manage` |  |
| `databases:bind` | Yes. Links and unlinks workloads to a managed database without changing the database; implied by `databases:edit`. The target workload also needs its environment and secrets scopes (`docker:compose:manage` for a Compose service). |
| `notifications:alerts:view` | View alert rules. |
| `notifications:alerts:manage` | Create, edit, and delete alert rules. |
| `notifications:webhooks:view` | View notification webhooks and their delivery history. |
| `notifications:webhooks:manage` | Create, edit, test, and delete notification webhooks. |
| `logs:environments:view` | Yes |
| `logs:environments:create` |  |
| `logs:environments:edit` | Yes |
| `logs:environments:delete` | Yes |
| `logs:environments:folders:manage` |  |
| `logs:tokens:view` | Yes. Folder grants resolve through logging environment folders. |
| `logs:tokens:create` | Yes. Folder grants resolve through logging environment folders. |
| `logs:tokens:delete` | Yes. Folder grants resolve through logging environment folders. |
| `logs:schemas:view` | Yes |
| `logs:schemas:create` |  |
| `logs:schemas:edit` | Yes |
| `logs:schemas:delete` | Yes |
| `logs:schemas:folders:manage` |  |
| `logs:read` | Yes |
| `status-page:view` |  |
| `status-page:manage` |  |
| `status-page:incidents:create` |  |
| `status-page:incidents:update` |  |
| `status-page:incidents:resolve` |  |
| `status-page:incidents:delete` |  |

## Internal Registry Access

External Docker clients (`docker login` to the internal registry, Business+ external access) authenticate with an Opfield API token. Registry access is a property of the token, chosen when it is created or edited: none, pull, or pull and push, each for every repository or for listed repository names (exact match, `team/app` does not cover `team/app-two` or `team`). A token may carry registry access without any scope.

- Pull can be given by a user who can view a Docker workload or image anywhere (`docker:containers:view`, `docker:compose:view` or `docker:images:view`, broad or limited to a node, folder or resource).
- Push can be given by a user who can change a workload (`docker:containers:edit`, `docker:containers:manage` or `docker:compose:manage`).
- Every token request at `/api/docker/registry/token` checks the token's access and the owner's current permissions, so a demoted owner's tokens lose push (or everything) at once.
- API: `registryAccess` on `POST /api/tokens` and `PATCH /api/tokens/{id}`, for example `{ "pull": "all", "push": ["team/app"] }`; an absent action is not granted and `{}` removes the access.

Compatibility: tokens created before this carry `docker:registries:internal:pull` / `:push` (with or without a repository) in their scopes; Opfield reads them as the token's registry access and shows them that way. Requests that still send these names in `scopes` get the same registry access. The two scopes remain in the catalog only as legacy user grants: a holder may give tokens access to the repositories the grant covers even without workload access. Built-in groups no longer include them.

## API Token Delegation

API tokens and OAuth grants (for both the Opfield API and Opfield MCP resources) can carry every scope a user can hold, so programmatic clients and MCP agents can do everything a user can do with Opfield resources: node enrollment and configuration, raw nginx config, users and permission groups, Opfield settings, integrations, hosting resources, inference administration, relay control, and updates. Only browser- or identity-bound capabilities are excluded. They cannot be granted:

| Scope | Reason |
|-------|--------|
| `ai:workspace:use` | User-only AI Workspace chat access. |
| `feat:ai:configure` | User-only AI Workspace configuration. |
| `ai:skills:manage` | User-only shared AI skill management. |
| `ai:sandbox:use` | User-only AI sandbox runner access. |
| `ai:sandbox:tier:medium` | User-only AI sandbox runner tier access. |
| `ai:sandbox:tier:high` | User-only AI sandbox runner tier access. |
| `ai:sandbox:manage` | User-only AI sandbox runner management. |
| `mcp:use` | User-account capability gate for remote MCP. |
| `admin:users:impersonate` | Impersonation replaces the caller's browser session with another user's session. |
| `integrations:gitlab:sandbox:clone` | Clones repositories into the AI sandbox working copy and also requires `ai:sandbox:use`. |

`mcp:use` is not a token scope. It gates whether the owning user account may use the MCP endpoint at all. MCP tokens use ordinary delegated Opfield scopes such as `nodes:details`, `proxy:view`, or `docker:containers:view` to determine which MCP tools and resources are available.

Opfield MCP delegates the same scopes as API tokens, including GitLab, GitHub, generic Git, Cloudflare, hosting, and external SSH connector administration and operations. Managed DNS access uses the ordinary `domains:*` scopes.

Some operations stay browser-only regardless of scopes because they are bound to the caller's identity or browser: sign-in, password, MFA, passkeys, the caller's own sessions and preferences, starting impersonation, OAuth consent, creating or editing API tokens and OAuth authorizations (a token must not mint Opfield credentials), per-user Git credentials, AI Workspace chat, UI bootstrap, and the post-setup onboarding checklist. Opfield settings, user/group administration, node config, raw nginx config, hosting, inference administration and personal `gwi_` inference keys (with `feat:ai:use` on the token), relay control, and updates accept API and OAuth tokens.

Account-level baseline scopes that gate a whole route family (for example `feat:ai:use` in front of inference administration) are evaluated against the token owner's live permissions for bearer callers; the token still needs the route's own delegated scope. Personal inference key management requires `feat:ai:use` on the token itself.

Git providers (GitLab, GitHub, generic Git) share the same verbs: `integrations:<provider>:view` lists connectors, `:manage` configures, tests, and synchronizes them, `:use` uses the connector's system credential, and `:repo:read` / `:repo:write` read or write repository content (files, CI, secrets, webhooks, registry). Each can be limited to a connector and, for GitLab and GitHub, to groups/projects or owners/repositories (see Git Integration Restrictions); tokens and MCP grants carry those qualifiers too. Listing GitLab's synced projects is connector metadata under `integrations:gitlab:view`. GitLab `:repo:read` includes CI job logs and CI/CD variable keys (never values); GitHub Actions variable values are secrets, so reading them needs `integrations:github:repo:write`. `integrations:cloudflare:sync` lets API and OAuth tokens resync a Cloudflare connector without holding `integrations:cloudflare:manage`. External SSH has no sync scope: its connection re-test authenticates with the stored credential and stays under `integrations:ssh:manage`.

## OAuth Manual Approval Scopes

OAuth consent leaves high-risk scopes unchecked by default. The user must explicitly select them in the consent UI. Resource-scoped variants are covered by their base scope, for example `pki:cert:export:<certificateId>` is treated as `pki:cert:export`.

| Scope | Risk |
|-------|------|
| `storage:credentials:reveal` | Reveals storage credentials. |
| `storage:iam` | Issues and revokes credentials |
| `databases:backups:restore` | Restores database contents into an authorized target. |
| `pki:ca:create:root` | Can create trust anchors. |
| `pki:ca:create:intermediate` | Can create subordinate CAs. |
| `pki:ca:export` | Can export CA private keys. |
| `pki:ca:revoke:root` | Can revoke or delete root CAs. |
| `pki:ca:revoke:intermediate` | Can revoke or delete intermediate CAs. |
| `pki:cert:export` | Can export certificates with private key material. |
| `ssl:cert:issue` | Can upload/provision certificates and private keys. |
| `ssl:cert:delete` | Can remove deployed SSL certificates. |
| `proxy:raw:write` | Can write raw nginx server config for routes. |
| `proxy:unrestricted` | Can apply unrestricted advanced nginx snippets and raw configs that bypass dangerous-directive validation. |
| `proxy:templates:manage` | Can write nginx template content, which is raw nginx configuration. |
| `pages:delete` | Can delete Page Projects after their dependencies and retained Deployments are removed. |
| `pages:tokens:manage` | Can create and revoke Project deploy credentials. |
| `pages:settings:edit` | Can configure or migrate the public wildcard Pages profile. |
| `nodes:manage` | Can replace a node's global nginx config, install the Docker secure runtime, change a node's service addresses, and power, resize, or restore hosted VMs. |
| `nodes:console` | Can open an interactive shell on nodes. |
| `nodes:files:read` | Can read files from managed node filesystems. |
| `nodes:files:write` | Can create, modify, move, or delete files on managed nodes. |
| `docker:containers:console` | Can open an interactive console in containers. |
| `docker:containers:files:read` | Can browse and read container filesystem contents. |
| `docker:containers:files:write` | Can create, modify, move, or delete container filesystem contents. |
| `docker:containers:export` | Can export a container as a portable Opfield archive. |
| `docker:containers:secrets` | Can reveal and manage encrypted container/deployment secrets. Implies `docker:containers:environment`. |
| `docker:containers:mounts` | Can change or remove legacy host bind mounts of containers/deployments and give such workloads a new image. New host bind mounts are prohibited; managed volumes are attached with `docker:volumes:view` on each volume instead. |
| `docker:containers:migrate` | Can move containers or deployments and their data between Docker nodes. |
| `docker:volumes:export` | Can export a Docker volume as a portable archive. |
| `docker:volumes:files:read` | Can read files from Docker volumes. |
| `docker:volumes:files:write` | Can create, modify, move, or delete files in Docker volumes. |
| `databases:query:read` | Can read data from database resources. |
| `databases:query:write` | Can modify data in database resources. |
| `databases:query:admin` | Can run administrative database commands. |
| `databases:credentials:reveal` | Can reveal stored database credentials and connection strings. This does not reveal a binding's injected application secret by default. |
| `integrations:gitlab:use` | Can use the system GitLab credential. |
| `integrations:gitlab:repo:write` | Can modify repositories, CI configuration, CI/CD variables, webhooks, and registry state through connected GitLab projects. |
| `integrations:gitlab:sandbox:clone` | Can clone connected GitLab repositories into AI sandboxes. |
| `integrations:github:use` | Can use GitHub connector system credentials. |
| `integrations:github:repo:write` | Can modify GitHub repository files and secrets, and read or modify Actions variables. |
| `integrations:git:use` | Can use generic Git connector system credentials. |
| `integrations:git:repo:write` | Can modify generic Git repository files. |
| `integrations:ssh:use` | Can run commands on hosts behind external SSH connectors. |
| `integrations:hosting:manage` | Can create, reconfigure, and read secrets of hosting provider connectors. |
| `hosting:resources:create` | Can order paid VMs and install nodes on them. |
| `hosting:resources:delete` | Can destroy VMs or cancel rentals. |
| `hosting:snapshots:restore` | Can roll a VM back to a snapshot. |
| `hosting:billing:topup` | Can request provider deposit invoices. |
| `logs:tokens:create` | Can mint logging ingest tokens. |
| `feat:ai:use` | Can use Opfield Inference and mint or revoke the user's `gwi_` inference keys. |
| `admin:audit` | Can read audit history. |
| `audit:siem:manage` | Can configure authenticated SIEM endpoints and replay failed audit exports. |
| `admin:details:certificates` | Can view internal system PKI and SSL certificates. |
| `admin:update` | Can check for and apply Opfield/daemon updates. |
| `admin:system` | Protected system administration: deleted-user restore, MFA reset, relay control. |
| `admin:users` | Can create, reconfigure, block, and delete users and revoke their sessions. |
| `admin:groups` | Can create and change permission groups and their scopes. |
| `settings:opfield:edit` | Can change authentication and control-plane settings. |
| `storage:bind` | Gives a workload its own key to the managed storage cluster. |
