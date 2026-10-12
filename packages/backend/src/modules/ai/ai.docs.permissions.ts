export const PERMISSIONS_DOC = `# Permissions & Scopes

Opfield uses a scope-based permission system with nested group inheritance. Each user belongs to a permission group and may also have additional user-specific scopes. Effective permissions are the union of inherited group scopes and these additive user scopes. Groups can inherit from parent groups, forming a hierarchy.

## All Scopes

### PKI: Certificate Authorities
| Scope | Description |
|-------|-------------|
| pki:ca:view | List and view root and intermediate CAs (resource-scopable) |
| pki:ca:create:root | Create root CAs |
| pki:ca:create:intermediate | Create intermediate CAs (resource-scopable) |
| pki:ca:edit | Update CA settings and the OCSP responder (resource-scopable) |
| pki:ca:export | Export a CA private key as PKCS#12 (resource-scopable) |
| pki:ca:revoke:root | Revoke root CAs |
| pki:ca:revoke:intermediate | Revoke intermediate CAs |
| pki:ca:folders:manage | Manage internal CA folders and the placement of root CAs (intermediates follow their root) |

### PKI: Certificates
| Scope | Description |
|-------|-------------|
| pki:cert:view | List PKI certificates and view their details (resource-scopable) |
| pki:cert:issue | Issue certificates from a CA (resource-scopable) |
| pki:cert:revoke | Revoke certificates |
| pki:cert:export | Download certificate files and private keys |
| pki:cert:deploy | Attach a TLS server certificate to a route or link it into the SSL store (link_internal_cert, also needs ssl:cert:issue); nginx uses the private key, the caller never receives it. Resource-scopable by certificate or issuing CA; implied by pki:cert:export |
| pki:cert:folders:manage | Manage internal PKI certificate folders and placement |

### PKI: Certificate Templates
| Scope | Description |
|-------|-------------|
| pki:templates:view | List certificate templates and view their details |
| pki:templates:create | Create templates |
| pki:templates:edit | Edit templates |
| pki:templates:delete | Delete templates |
| pki:templates:folders:manage | Manage certificate template folders and placement of custom templates |

### Ingress Routes
| Scope | Description |
|-------|-------------|
| proxy:view | List routes and view their details (resource-scopable) |
| proxy:create | Create routes (resource-scopable) |
| proxy:edit | Update routes (resource-scopable) |
| proxy:delete | Delete routes (resource-scopable) |
| proxy:folders:manage | Manage route folders and folder placement |
| proxy:raw:read | View raw nginx config (resource-scopable) |
| proxy:raw:write | Write raw nginx config and enable/disable raw config mode (resource-scopable) |
| proxy:advanced | Edit advanced nginx snippets (resource-scopable) |
| proxy:unrestricted | Bypass the dangerous advanced snippet and raw directive restrictions (resource-scopable) |
| proxy:maintenance:bypass | Create temporary browser access codes for routes in maintenance; implies nothing else (resource-scopable) |
| proxy:templates:view | List and view nginx proxy templates (resource-scopable) |
| proxy:templates:manage | Create, edit, test, clone, and delete nginx proxy templates (resource-scopable) |
| proxy:templates:folders:manage | Manage nginx template folders and placement of custom templates |

### Pages
| Scope | Description |
|-------|-------------|
| pages:view | View Page Projects, Deployments, Tags, previews, and usage (resource-scopable by Project) |
| pages:create | Create Page Projects (accepts folder/ and node/ destinations) |
| pages:edit | Rename Page Projects, edit retention, quota, and preview settings, and rotate preview links (resource-scopable) |
| pages:delete | Delete Page Projects after their dependencies and retained Deployments are removed (resource-scopable) |
| pages:deploy | Create and upload Deployments and start Git-source builds (resource-scopable) |
| pages:deployments:manage | Pin, unpin, clean up, and delete eligible Deployments (resource-scopable) |
| pages:tags:manage | Create, move, and delete Tags (resource-scopable) |
| pages:tokens:manage | Create, restrict, and revoke Project deploy tokens (resource-scopable) |
| pages:folders:manage | Manage Page Project folders; moving a Project also needs pages:edit on it |
| pages:settings:view | View the wildcard Pages profile and storage defaults |
| pages:settings:edit | Configure and migrate the wildcard Pages profile and storage defaults |

Every resource-qualified Pages scope uses the Page Project ID, including Deployment, Tag, and deploy-token operations.

### SSL Certificates
| Scope | Description |
|-------|-------------|
| ssl:cert:view | List SSL certificates and view their details (resource-scopable) |
| ssl:cert:issue | Request ACME / upload / link internal certs in the destination folder; also renews (implies ssl:cert:renew, not ssl:cert:view) |
| ssl:cert:renew | Renew or reissue a certificate, verify its DNS-01 challenge, cancel a pending ACME order, set auto-renew (resource-scopable) |
| ssl:cert:folders:manage | Manage SSL certificate folders and placement |
| ssl:cert:delete | Delete SSL certificates (resource-scopable) |

### Domains
| Scope | Description |
|-------|-------------|
| domains:view | List and view managed domains; with ssl:cert:issue on the destination, issue an ACME certificate for the domain (resource-scopable) |
| domains:create | Register domains |
| domains:edit | Edit/check managed domains (resource-scopable) |
| domains:delete | Delete managed domains (resource-scopable) |
| domains:folders:manage | Manage domain folders and placement |

### Access Control Lists
| Scope | Description |
|-------|-------------|
| acl:view | List access lists and view their details (resource-scopable) |
| acl:create | Create access lists |
| acl:edit | Edit access lists (resource-scopable) |
| acl:delete | Delete access lists (resource-scopable) |

### Nodes
| Scope | Description |
|-------|-------------|
| nodes:details | List daemon nodes and view their details, health, and stats (resource-scopable) |
| nodes:create | Create/enroll new nodes |
| nodes:rename | Rename a node (resource-scopable) |
| nodes:delete | Delete a node (resource-scopable) |
| nodes:config:view | View node nginx config (resource-scopable) |
| nodes:manage | Node control: edit nginx config, install the secure runtime, change service addresses, hosting power/resize/snapshot restore (resource-scopable) |
| nodes:logs | View daemon/nginx logs (resource-scopable) |
| nodes:console | Open interactive shell (resource-scopable) |
| nodes:files:read | Browse, open, copy, and download node files (resource-scopable) |
| nodes:files:write | Create, edit, upload, move, and delete node files (resource-scopable) |
| nodes:lock | Lock or unlock service creation on a node, which stops new routes and containers from being placed there (resource-scopable) |
| nodes:backups:execute | Use a Storage node as the executor of database backups, restores and storage copy jobs (resource-scopable) |
| nodes:folders:manage | Manage node folders and folder placement |

### Ingress Groups
| Scope | Description |
|-------|-------------|
| ingress:groups:view | List ingress groups and view their members, routes, domains and delivery; place routes and domains on them (folder-scopable by node folder only) |
| ingress:groups:manage | Create, change and delete ingress groups, add, remove and reorder members; implies ingress:groups:view (folder-scopable by node folder only). Adding a member also needs nodes:manage on that node |

### Apps
| Scope | Description |
|-------|-------------|
| apps:view | View apps, environments, overview and activity (resource-scopable: <appId> or env/<envId>); members still need their own view scopes. Without it an app is still listed when you can view one of its members (own grants, including folder grants on its environment or app folders), limited to the environments holding those members and to those members (access members) |
| apps:create | Create apps |
| apps:edit | Rename the app, create, rename and delete environments, move the Production marker (resource-scopable: <appId>) |
| apps:delete | Delete an app; members keep running and leave it (resource-scopable: <appId>) |
| apps:env:manage | Environment variables and secrets, allowed nodes, environment maintenance and access codes, moving resources in or out together with the resource's own edit scope (resource-scopable: <appId> or env/<envId>) |
| apps:promote | Promote one environment into another (resource-scopable on the target: <appId> or env/<envId>) |
| apps:operate | Shutdown, start and isolation; the app maintenance override needs it on the whole app (resource-scopable: <appId> or env/<envId>) |

### Administration
| Scope | Description |
|-------|-------------|
| admin:users | Manage users and permission groups |
| admin:users:impersonate | Temporarily act as another active user from a browser session |
| admin:groups | Manage permission groups |
| admin:users:folders:manage | Manage administration user folders and placement |
| admin:groups:folders:manage | Manage permission group folders and placement |
| admin:audit | View audit log |
| audit:siem:view | View SIEM destinations and the audit delivery history |
| audit:siem:manage | Create, edit, test, and delete SIEM destinations and requeue failed deliveries |
| admin:details:certificates | View Opfield's internal system PKI and SSL certificates read-only; audit_system_pki_leaves also needs it |
| admin:system | System-level administration (protected) |
| admin:update | Apply system updates |
| admin:alerts | View and manage alerts |

### Opfield Settings
| Scope | Description |
|-------|-------------|
| settings:gateway:view | View Opfield settings: public URL, sign-in, SMTP, OAuth and MCP, network, environment, and relay settings |
| settings:gateway:edit | Edit those settings; SMTP, the OIDC provider, the public URL, and relaxing OIDC verified-email enforcement also need admin:system |

### Housekeeping
| Scope | Description |
|-------|-------------|
| housekeeping:view | View housekeeping config, stats, and history |
| housekeeping:run | Run housekeeping manually |
| housekeeping:configure | Edit housekeeping config and schedule |

### Opfield diagnostics
| Scope | Description |
|-------|-------------|
| diagnostics:view | Opfield's own state and 48-hour history: host, process, Postgres, Redis, stack containers, background jobs, API latency |
| diagnostics:logs | Read the logs of Opfield's own containers; implies diagnostics:view |

### Licensing
| Scope | Description |
|-------|-------------|
| license:view | View license state |
| license:manage | Activate, update, or remove the license |

### Features
| Scope | Description |
|-------|-------------|
| ai:workspace:use | Access AI Workspace |
| feat:ai:use | Access Opfield Inference, personal usage, and personal inference token management |
| feat:ai:configure | Configure AI Workspace settings |
| ai:skills:manage | Create, edit, enable, disable, and delete shared AI Workspace skills |
| ai:sandbox:use | Use AI sandbox runner tools |
| ai:sandbox:tier:medium | Allow medium sandbox resource tier |
| ai:sandbox:tier:high | Allow high sandbox resource tier |
| ai:sandbox:manage | View/manage sandbox jobs beyond the current user |
| mcp:use | Allow a user account to access the remote MCP server with OAuth |

### Opfield Inference
| Scope | Description |
|-------|-------------|
| inference:setup | OAuth-only authorization for the Opfield companion CLI setup resource; do not assign it to users or groups |
| feat:ai:use | Use Opfield Inference, view personal usage, and create or revoke dedicated gwi_ inference tokens for the current user |
| inference:providers:view | View provider templates, connections, masked credentials, discovery, and quota |
| inference:providers:manage | Connect, update, synchronize, route, and disconnect inference providers |
| inference:models:manage | Atomically create, replace, publish, or delete logical inference models |
| inference:limits:manage | Configure default and per-user inference budgets |
| inference:usage:view | View system/user inference activity and raw accounting metadata |

### Docker: Containers
| Scope | Description |
|-------|-------------|
| docker:containers:view | List containers and deployments on a node and view their details (resource-scopable) |
| docker:containers:create | Create/deploy containers |
| docker:containers:edit | Edit container settings (resource-scopable) |
| docker:containers:manage | Start/stop/restart/kill/update containers (resource-scopable) |
| docker:containers:environment | View/edit container environment variables and list secret keys (not values). An env-only change needs only this scope, including the container recreate it causes and saving a deployment's env alone (resource-scopable) |
| docker:containers:link | Be the target of a container link: other workloads reach one port of this container or deployment privately (resource-scopable). Creating a link also needs docker:containers:edit on the consumer (docker:compose:manage for Compose), plus docker:containers:environment when it sets variables |
| docker:containers:delete | Remove containers (resource-scopable) |
| docker:containers:console | Open exec terminal (resource-scopable) |
| docker:containers:files:read | Browse/read container files (resource-scopable) |
| docker:containers:files:write | Create/edit/move/delete container files (resource-scopable) |
| docker:containers:export | Export portable container archives (resource-scopable) |
| docker:containers:secrets | Reveal and manage encrypted secrets; implies docker:containers:environment (resource-scopable) |
| docker:containers:webhooks | Configure CI/CD webhook URLs |
| docker:containers:migrate | Migrate containers and deployments between Docker nodes (resource-scopable) |
| docker:availability:manage | Enable, update, scale, heal, and disable multi-node Availability; implies docker:containers:view (resource-scopable; folder grants resolve through the container or Compose folder) |
| docker:containers:mounts | Change or remove legacy host bind mounts of a container/deployment; new host bind mounts are prohibited. Managed volumes need no mounts scope: attaching one needs docker:volumes:view on that volume plus the workload's own create or edit. Also required to give a workload with legacy host bind mounts a new image, command or runtime; environment, label, network and link changes that keep its image need none. Automatic Git deployments check it on the account that last saved the source, and webhook calls on the account that last saved the webhook (resource-scopable) |
| docker:folders:manage | Manage folders and placement for containers, deployments, Compose projects, networks, volumes, and images |

### Docker: Compose Projects
| Scope | Description |
|-------|-------------|
| docker:compose:view | Discover and inspect Compose projects, services, monitoring, logs, revisions, and activity (resource-scopable) |
| docker:compose:create | Validate and deploy a managed Compose project on an allowed node |
| docker:compose:manage | Adopt projects and manage lifecycle, revisions, secrets, and bindings (resource-scopable) |
| docker:compose:delete | Delete projects or run destructive down/delete-volume actions (resource-scopable) |

### Docker: Images
| Scope | Description |
|-------|-------------|
| docker:images:view | List images on a node |
| docker:images:pull | Pull images from registries into a node or image folder. Not needed to create or update a container or deployment: the workload's own create, edit or manage authorizes pulling its image |
| docker:images:delete | Remove/prune images |

### Docker: Volumes
| Scope | Description |
|-------|-------------|
| docker:volumes:view | List volumes; attach a managed volume to a container or deployment the caller may create or edit (resource-scopable) |
| docker:volumes:create | Create volumes |
| docker:volumes:edit | Rename, relabel, resize and adopt volumes |
| docker:volumes:delete | Remove volumes |
| docker:volumes:export | Export portable volume archives |
| docker:volumes:files:read | Browse/read volume files |
| docker:volumes:files:write | Create/edit/upload/move/delete volume files |

### Docker: Networks
| Scope | Description |
|-------|-------------|
| docker:networks:view | List networks |
| docker:networks:create | Create networks |
| docker:networks:edit | Connect/disconnect containers |
| docker:networks:delete | Remove networks |

### Docker: Registries
| Scope | Description |
|-------|-------------|
| docker:registries:view | List private registries |
| docker:registries:create | Add registries |
| docker:registries:edit | Edit/test registries |
| docker:registries:delete | Remove registries |
| docker:registries:internal:pull | Legacy: lets the holder's API tokens pull these repositories without workload access. Registry access is a property of each API token now (manage_api_token registryAccess) |
| docker:registries:internal:push | Legacy: lets the holder's API tokens push to these repositories without workload access |

### Docker: Tasks
| Scope | Description |
|-------|-------------|
| docker:tasks | View background tasks |
| docker:tasks:manage | Force-cancel active background tasks |

### Databases
| Scope | Description |
|-------|-------------|
| databases:view | List external connections and managed database instances and view their details (resource-scopable) |
| databases:create | Create external connections or deploy managed database instances |
| databases:edit | Edit external connections, managed instances and publication settings (resource-scopable); implies databases:bind |
| databases:bind | Link and unlink workload bindings of a managed database without changing the database; the target also needs docker:containers:environment + docker:containers:secrets (or docker:compose:manage for a Compose service) (resource-scopable) |
| databases:delete | Delete external connections or managed instances (resource-scopable) |
| databases:query:read | Run read-only queries (resource-scopable); implies databases:view for the same database |
| databases:query:write | Run write queries (resource-scopable); implies databases:query:read |
| databases:query:admin | Run admin queries with the connection's full credentials (resource-scopable); implies databases:query:write |
| databases:credentials:reveal | Reveal explicitly requested external or managed owner/published credentials (resource-scopable); does not reveal per-binding injected secrets by default |
| databases:folders:manage | Manage database folders and placement |

### Database Backups
| Scope | Description |
|-------|-------------|
| databases:backups:view | List backup policies and run history (resource-scopable by database) |
| databases:backups:manage | Create, edit, and delete backup policies and remove runs from history (resource-scopable) |
| databases:backups:run | Start and cancel backup runs (resource-scopable) |
| databases:backups:restore | Restore a backup; restoring into an existing connection also needs it on the target (resource-scopable) |

Backups, restores, retention and history deletion also need storage:credentials:use on the destination storage and nodes:backups:execute on the executor Storage node. Restoring into a new managed database needs databases:create on the Storage node or the chosen folder.

### Storage
| Scope | Description |
|-------|-------------|
| storage:view | List and view external or managed storage connections (resource-scopable) |
| storage:create | Create external connections or managed object storage on an allowed folder/node |
| storage:edit | Edit/test connections and manage managed-storage lifecycle (resource-scopable) |
| storage:delete | Delete external or managed storage resources (resource-scopable) |
| storage:credentials:reveal | Reveal explicitly requested stored storage credentials or managed-storage root credentials (resource-scopable) |
| storage:credentials:use | Let backups send the saved credentials to the backup runner on an authorized Storage node without revealing them to the caller (resource-scopable); implied by storage:credentials:reveal |
| storage:iam | Create/remove scoped IAM keys and move links between clusters (resource-scopable); implies storage:bind |
| storage:bind | Create/delete managed-storage workload links without issuing access keys (resource-scopable); target workload scopes are also required |
| storage:objects:read | List buckets/objects, read metadata or objects, and create signed GET URLs (resource-scopable) |
| storage:objects:write | Upload objects, create prefixes, and delete objects (resource-scopable) |
| storage:objects:admin | Create or delete buckets (resource-scopable) |
| storage:folders:manage | Manage storage folders and placement |

### Logging
| Scope | Description |
|-------|-------------|
| logs:environments:view | List and view logging environments (resource-scopable) |
| logs:environments:create | Create logging environments |
| logs:environments:edit | Edit logging environments (resource-scopable) |
| logs:environments:delete | Delete logging environments (resource-scopable) |
| logs:environments:folders:manage | Manage logging environment folders and placement |
| logs:tokens:view | List ingest tokens (resource-scopable by environment or environment folder) |
| logs:tokens:create | Create ingest tokens (resource-scopable by environment or environment folder) |
| logs:tokens:delete | Delete ingest tokens (resource-scopable by environment or environment folder) |
| logs:schemas:view | List and view logging schemas (resource-scopable by schema ID) |
| logs:schemas:create | Create logging schemas |
| logs:schemas:edit | Edit logging schemas (resource-scopable by schema ID) |
| logs:schemas:delete | Delete logging schemas (resource-scopable by schema ID) |
| logs:schemas:folders:manage | Manage logging schema folders and placement |
| logs:read | Search and inspect logs (resource-scopable by environment) |

### Notifications
| Scope | Description |
|-------|-------------|
| notifications:alerts:view | List and view alert rules |
| notifications:alerts:manage | Create, edit, and delete alert rules |
| notifications:webhooks:view | List and view notification webhooks and their delivery log |
| notifications:webhooks:manage | Create, edit, test, and delete webhooks; reveals webhook URLs, headers, and delivery payloads |

### Git Integrations
Every Git provider (\`<p>\` = gitlab, github, git) uses the same verbs.
| Scope | Description |
|-------|-------------|
| integrations:<p>:view | List and view connectors |
| integrations:<p>:manage | Create, edit, sync, test, and delete connectors |
| integrations:<p>:use | Use the connector's system credential instead of a personal credential |
| integrations:gitlab:view | List GitLab connectors and their synced projects |
| integrations:<p>:repo:read | Read repositories, files, CI pipelines and job logs, and GitLab CI/CD variable keys (never values) |
| integrations:<p>:repo:write | Commit files and change CI config, variables, secrets, webhooks, and registry settings; read GitHub Actions variable values |
| integrations:gitlab:sandbox:clone | Clone a GitLab repository into the AI sandbox |

Git scopes can be limited with stable IDs: \`<scope>:<connectorId>\` (every repository of one connector), GitLab \`<connectorId>/group/<groupId>\` (the group, its subgroups and their projects) or \`<connectorId>/project/<projectId>\`, GitHub \`<connectorId>/owner/<ownerId>\` or \`<connectorId>/repo/<repoId>\`. Generic Git and \`:manage\` take the connector only; creating connectors needs unqualified \`:manage\`.
- To grant by path, call find_git_scope_target (provider, connectorId, kind group/project/owner/repo, path such as \`team/sub\`) for the stable qualifier, or pass \`<connectorId>/<kind>/path/<path>\` to create_group/update_group or additional user permissions: the save stores the resolved ID. A group grant covers its subgroups, so one group qualifier is enough for a subtree.
- A repository operation is allowed by the unqualified scope, the connector, any containing group/owner, or the exact project/repository; implied view applies per qualifier (\`repo:write:<connectorId>/project/42\` also grants \`view\` there).
- The connector credential is used when \`:use\` covers the repository the same way, the personal credential otherwise.
- Connector, project and repository lists only show what the caller's grants cover; the build source repository list shows what \`:use\` covers.
- Connecting a Docker or Pages build source, or changing its connector, repository or branch, needs \`integrations:<provider>:use\` on the repository (any covering qualifier), not \`repo:read\` or a personal credential. Saving other source settings, manual builds and automatic builds (poll, webhook) need only the workload's own permissions and never depend on anyone's current Git scopes; builds use the connector credential, limited to the repositories the connector itself reaches.
- Tokens and MCP grants are bounded per qualifier by the owner's grants; for repository operations both the token and the owner's current scopes must cover the repository (a token limited to a project inside the owner's group works; a token limited to a group whose owner holds one project reaches that project only).

### Other Integrations
| Scope | Description |
|-------|-------------|
| integrations:ssh:view | View configured external SSH servers |
| integrations:ssh:manage | Add, configure, and delete external SSH servers and jump hosts |
| integrations:ssh:use | Run commands and file operations on configured external SSH servers |
| integrations:cloudflare:view | View Cloudflare connectors and their synchronization status |
| integrations:cloudflare:manage | Create, edit, test, rotate, and delete Cloudflare connectors |
| integrations:cloudflare:sync | Refresh Cloudflare zones and token capabilities with the connector credential |
| integrations:hosting:view | View hosting provider accounts (restrictable to connector ID) |
| integrations:hosting:manage | Create, reconfigure, and synchronize hosting accounts and read their secrets (restrictable to connector ID) |

### Hosting
| Scope | Description |
|-------|-------------|
| hosting:resources:view | View provider inventory (restrictable to connector ID) |
| hosting:resources:create | Create hosted nodes (restrictable to connector ID); also needs nodes:create |
| hosting:resources:power | Start, shut down, or reboot a hosted VM (restrictable to resource ID) |
| hosting:resources:resize | Resize a hosted VM (restrictable to resource ID) |
| hosting:resources:delete | Destroy a hosted VM or cancel a HOSTKEY rental (restrictable to resource ID) |
| hosting:resources:recover | Restart a hosted daemon through an independent provider channel (restrictable to resource ID) |
| hosting:snapshots:view | View VM snapshots and snapshot folders (restrictable to resource ID); also needs VM inventory and bound-node details access |
| hosting:snapshots:create | Create a VM snapshot (restrictable to resource ID); also needs configuration access to bound nodes |
| hosting:snapshots:delete | Delete a VM snapshot (restrictable to resource ID) |
| hosting:snapshots:restore | Restore a VM snapshot, replacing disk data (restrictable to resource ID) |
| hosting:snapshots:folders:manage | Create folders and organize VM snapshots (restrictable to resource ID) |
| hosting:billing:view | Read account finances (restrictable to connector ID); never implied by node access |
| hosting:billing:topup | Create a HOSTKEY deposit invoice (restrictable to connector ID) |

### Status Page
| Scope | Description |
|-------|-------------|
| status-page:view | View status page config, services, incidents, and preview |
| status-page:manage | Edit status page settings and exposed services |
| status-page:incidents:create | Create or promote incidents |
| status-page:incidents:update | Edit incidents and post updates |
| status-page:incidents:resolve | Resolve active incidents |
| status-page:incidents:delete | Delete incidents |

## Built-in Groups

| Group | Description |
|-------|-------------|
| system-admin | Every scope, including admin:system |
| admin | Every scope except admin:system, admin:users:impersonate, settings:gateway:edit, housekeeping:configure, nodes:console, ai:skills:manage, inference:setup, the hosting:* and integrations:hosting:* scopes, Docker registry create/edit/delete, and the legacy docker:registries:internal:* scopes |
| operator | Day-to-day operations: storage connections and objects (no credential reveal, IAM keys, or bucket admin) with storage:credentials:use for backups, database backup policies and runs (no restore) and backup execution, PKI certificates and templates, domains, routes and Pages without delete, SSL, ACL, node details, config view, logs, and files, Docker containers, deployments and Compose with create, image pull, secrets and console but without delete, mounts, export, migration or file writes, GitLab, GitHub and Git connectors with use for build sources but no repository content, read-only images, volumes, networks, and registries, databases with queries, notifications, log search and ingest tokens, alerts, AI Workspace, and MCP |
| viewer | Read-only: storage, backups, PKI, domains, routes, nginx templates, Pages, SSL, ACL, Docker without volume file contents, databases, notification alerts without webhooks, logging including log search without ingest tokens, GitLab, GitHub, Git and Cloudflare connectors, plus AI Workspace |
| guest | Account access only — no infrastructure permissions |

Custom groups can be created with any combination of scopes.

## Nested Groups & Inheritance
Groups can have a parent group. Inherited scopes from all ancestors are added to the effective scopes. Cycle detection prevents circular inheritance. Built-in groups cannot be modified.

## Resource-Scoped Permissions
Scopes marked "resource-scopable" support resource-level suffixes (e.g., "pki:cert:issue:ca-uuid" or "nodes:details:node-uuid"). Docker container scopes use "docker:containers:<action>:<node-id>" for a whole node or "docker:containers:<action>:<node-id>/<stable-resource-id>" for one container or deployment. Compose scopes use "docker:compose:<action>:<node-id>" for a whole node or "docker:compose:<action>:<node-id>/<project-id>" for one project. Without a suffix, the scope applies to all resources.

Folder grants: scopes of foldered resources accept "<scope>:folder/<folder-id>". The grant covers every resource in that folder and its subfolders, including resources created or moved there later, and stops covering a resource that leaves the folder. Creation scopes accept a destination instead: "proxy:create:folder/<folder-id>" or "proxy:create:node/<node-id>" lets the caller create in that folder or on that node only; pass the folderId (and nodeId) when creating. list_resource_folders shows a folder-scoped caller its granted folders even while they are empty, and list_nodes with a type shows creators the nodes they may create on. Route creators can also use list_route_ingress_nodes, and create_route may omit nodeId when a registered domain pins the ingress node or only one node is eligible.

Implied scopes: any action scope in a family except creation scopes (\`*:create*\`, \`docker:images:pull\`, \`ssl:cert:issue\`, \`pki:cert:issue\`) implies that family's view scope with the same suffix, including delete scopes, so "proxy:edit:<route-id>" also lets the caller view that route and "databases:query:read:<database-id>" lets it view that database. ssl:cert:issue implies ssl:cert:renew (not view), pki:cert:export implies pki:cert:deploy, and docker:containers:secrets also implies docker:containers:environment with the same suffix.

## Limited Access (folders, nodes, resources)
Access limited to folders, nodes or resources is normal. If you can't see or do something at the root, check get_my_access; folder-limited access is normal, so work inside the granted folders.
- get_my_access (MCP also serves it as the gateway://access resource; REST: GET /api/auth/me/access) groups the caller's access by area: broad or limited, the granted folders (id, name, path), nodes, accounts and specific resources with their actions, and where it may create (create.atRoot, create.folders, create.nodes). Tokens and OAuth/MCP grants are reported as bounded by the owner's current access.
- MCP adds a short summary of limited access to the server instructions at connect time.
- List tools return the subset the caller can access; an empty list is not a denial. list_resource_folders shows every folder the caller holds any grant on (even an empty one) with access.actions and access.canCreate.
- A create without a destination targets the root. With folder- or node-limited create access, pass folderId (and nodeId where the tool takes one); a refused root create names the folders and nodes that hold the grant.
- A permission error that says the access is limited is not "no access": retry inside the listed folders, nodes or resources. Report a missing permission only when get_my_access shows no grant for the action anywhere.

## Scope Containment Rule
A user can only manage another user whose scopes are a subset of their own.`;
