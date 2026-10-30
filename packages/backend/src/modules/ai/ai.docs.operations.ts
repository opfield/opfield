export const OPERATIONS_DOCS: Record<string, string> = {
  folders: `# Foldered Resources

Opfield uses shared folder views for several resource lists. Use folder tools instead of guessing REST paths.

## Tools
- list_resource_folders({ resourceType, dockerResourceType? }) lists the folders you can use and visible assignments. Each folder carries access.actions (the actions you hold in it, broad grants included) and access.canCreate. Without dockerResourceType, Docker lists the first Docker type you can use.
- manage_resource_folder({ resourceType, operation, ... }) mutates folder trees and item placement.

## Resource Types
- nodes
- databases
- storage
- domains
- ssl_certificates
- pki_cas (internal CAs; a folder holds whole hierarchies)
- pki_certificates (internal PKI certificates)
- pki_templates (custom certificate templates)
- nginx_templates (custom nginx templates)
- logging_environments
- logging_schemas
- admin_users
- permission_groups
- routes
- pages (Page Projects)
- docker with dockerResourceType: container, compose, image, network, or volume

## Operations
- create: { name, parentId? }
- update: { folderId, name?, parentId? }
- delete: { folderId }
- reorder_folders: { items: [{ id, sortOrder }] }
- move_resources: { folderId, resourceIds }
- reorder_resources: { items: [{ id, sortOrder }] }
- move_folder: { folderId, parentId } (parentId null moves it to the top level). Refused (409 FOLDER_NAME_CONFLICT) when the destination already has a folder with the same name, and (400) when it would move a folder into itself or its own subfolder.

## Scope Rules
Listing needs the module's view scope, its create scope, its folder-management scope, or a folder grant of any of its scopes. A caller without broad access sees the folders holding the resources it can view plus every folder it holds a folder grant on (\`<scope>:folder/<folderId>\` for any scope of the family: view, create, edit, query, deploy, console, ...), including a granted folder that is still empty; broad create or folder management lists every folder.
Folder management of every family (domains, routes, SSL certificates, PKI CAs, certificates and templates, nginx templates, nodes, users, groups, databases, storage, Pages, logging environments and schemas, alert rules, notification webhooks, access lists, Docker) can be limited to a folder (\`<module>:folders:manage:folder/<folderId>\`): it manages that folder's subfolders and the placement of resources in them, never the granted folder itself or the top level. create needs it at parentId; update and delete at the folder's parent; move_folder at the current parent and at the new one; reorder_folders at each folder's parent; move_resources at the destination and at each resource's current folder; reorder_resources at each resource's folder.
Folder-limited access is normal: when a root-level list is empty or a create at the root is refused, call get_my_access, pick a folder from it or from this list, and pass folderId (and nodeId) when creating.
- nodes: list with nodes:details, nodes:create, or nodes:folders:manage; mutate with nodes:folders:manage.
- databases: list with databases:view, databases:create, or databases:folders:manage; mutate with databases:folders:manage.
- storage: list with storage:view, storage:create, or storage:folders:manage; mutate with storage:folders:manage; moving connections also checks storage:edit for each connection and the destination.
- domains: list with domains:view or domains:create; mutate with domains:folders:manage.
- ssl_certificates: list with ssl:cert:view, ssl:cert:issue, or ssl:cert:renew; mutate with ssl:cert:folders:manage.
- pki_cas: list with pki:ca:view, pki:cert:issue, or pki:ca:folders:manage; mutate with pki:ca:folders:manage. Only root CAs move (an intermediate answers 400) and their intermediates follow; moving checks pki:ca:edit for each root CA and the destination. reorder_resources also orders intermediates under their parent. System CAs never move. create_root_ca takes folderId (needs pki:ca:edit on that folder); create_intermediate_ca lands in the folder of its root CA.
- pki_certificates: list with pki:cert:view or pki:cert:folders:manage; mutate with pki:cert:folders:manage. Moving or reordering a certificate checks pki:cert:issue on its issuing CA. Certificates of system CAs never move. issue_certificate and manage_certificate issue_from_csr take folderId (needs pki:cert:folders:manage).
- pki_templates: list with pki:templates:view or pki:templates:folders:manage; mutate with pki:templates:folders:manage; moving templates also checks pki:templates:edit. Built-in templates never move (400). create_template takes folderId (needs pki:templates:folders:manage).
- nginx_templates: list with proxy:templates:view, proxy:templates:manage, or proxy:templates:folders:manage; mutate with proxy:templates:folders:manage; moving templates also checks proxy:templates:manage for each template and the destination. Built-in templates never move (400). manage_proxy_template create takes folderId; proxy:templates:manage on that folder is enough to create there.
- logging_environments: list with logs:environments:view, logs:environments:create, or logs:environments:folders:manage; mutate with logs:environments:folders:manage.
- logging_schemas: list with logs:schemas:view, logs:schemas:create, or logs:schemas:folders:manage; mutate with logs:schemas:folders:manage.
- notification_alert_rules: list with notifications:alerts:view, notifications:alerts:manage, or notifications:alerts:folders:manage; mutate with notifications:alerts:folders:manage; moving rules also checks notifications:alerts:manage for each rule and the destination. Built-in rules never move (400). create_alert_rule takes folderId; notifications:alerts:manage on that folder is enough to create there.
- access_lists: list with acl:view, acl:create, or acl:folders:manage; mutate with acl:folders:manage; moving access lists also checks acl:edit for each list and the destination. create_access_list takes folderId (needs acl:create there).
- notification_webhooks: list with notifications:webhooks:view, notifications:webhooks:manage, or notifications:webhooks:folders:manage; mutate with notifications:webhooks:folders:manage; moving webhooks also checks notifications:webhooks:manage for each webhook and the destination. create_webhook takes folderId; notifications:webhooks:manage on that folder is enough to create there.
- admin_users: list with admin:users or admin:users:folders:manage; mutate with admin:users:folders:manage.
- permission_groups: list with admin:groups or admin:groups:folders:manage; mutate with admin:groups:folders:manage.
- routes: list with proxy:view, proxy:create, or proxy:folders:manage; mutate folders with proxy:folders:manage; moving routes also checks proxy:edit for each route.
- docker: list uses dockerResourceType-specific view or create scope: docker:containers:view, docker:compose:view, docker:images:view, docker:networks:view, or docker:volumes:view. Folder mutation uses docker:folders:manage (broad, or on a folder: it then manages that folder's subfolders in its own Docker list). Moving or reordering container placements also checks docker:containers:edit for each item node; Compose, image, network, and volume placement follows the shared Docker folder route and does not require container edit scope. move_folder { folderId, parentId } (parentId null moves to the root) works inside one Docker resource type tree, never moves or targets protected compose deployment folders, keeps the 3-level depth limit and rejects a duplicate sibling name (409); it also requires the per-resource move scope (docker:containers:edit, docker:networks:edit, docker:images:delete, docker:volumes:delete, docker:compose:manage) for every resource inside the folder and its subfolders, plus the same destination scope as move_resources.`,

  'node-files': `# Node File Management

Use manage_node_file for node filesystem operations. This works through the node daemon and follows the same validation as the node Files UI.

## Operations
- list: { nodeId, operation: "list", path? }
- read: { nodeId, operation: "read", path, encoding?: "auto"|"utf8"|"base64", limitBytes? }
- write: { nodeId, operation: "write", path, content? or contentBase64? }
- create: { nodeId, operation: "create", path, content? or contentBase64? }
- mkdir: { nodeId, operation: "mkdir", path }
- delete: { nodeId, operation: "delete", path }
- move: { nodeId, operation: "move", fromPath, toPath }
- upload_init: { nodeId, operation: "upload_init", path, totalBytes }
- upload_chunk: { nodeId, operation: "upload_chunk", uploadId, offset, contentBase64 }
- upload_complete: { nodeId, operation: "upload_complete", uploadId, path, totalBytes }
- upload_abort: { nodeId, operation: "upload_abort", uploadId } answers aborted true, or aborted false for an id with no session (finished, expired, or begun before an Opfield restart).

An upload session expires 30 minutes after its last chunk. Opfield removes the partial file (.opfield-upload-<id>.tmp next to the target) of an expired or abandoned upload within about 5 minutes, also after a restart.

Read output is capped and returns { encoding, content, sizeBytes, returnedBytes, truncated }. Use base64 for binary files.`,

  sandbox: `# Sandbox Runner

Sandbox tools run bounded commands in Docker containers owned by the current user. They are AI-only and intentionally not exposed through MCP.

## Execution Tools
- execute_script: run a short script in a fresh container, return output, then remove the container.
- run_process: start a longer process with a TTL.
- read_process_output: read stdout/stderr from a running process.
- write_process_stdin: send stdin to a running process.
- kill_process: stop a running sandbox process.
- list_sandbox_jobs: list current user's running sandbox jobs.

## Network and Artifacts
Sandbox containers have no direct network access. Use Opfield-mediated helpers:
- fetch: read network content through Opfield, capped at 10 MB.
- download_artifact: download a URL through Opfield and place it in a running sandbox under /workspace, capped at 200 MB.
- list_artifact_files: list files/directories already present in a running sandbox workspace without starting another process.
- read_artifact: read a file from the sandbox in chunks, capped per read.
- send_artifact: save a sandbox file as an Opfield-managed downloadable artifact for the user.

Artifact path rules:
- The sandbox process working directory is /workspace.
- Files that must be read_artifact or send_artifact must be written under /workspace.
- Artifact tool path arguments are relative to /workspace. Example: write /workspace/report.txt, then send_artifact with path "report.txt".
- If a sandbox-backed tool returns a processId and path, use list_artifact_files and read_artifact with that same processId/path to inspect files; do not launch another run_process just to run ls/find/os.walk/cat.
- Do not write deliverable files under /tmp, and do not pass absolute paths such as "/workspace/report.txt" or relative paths like "tmp/report.txt" for files created in /tmp.
- run_process returns as soon as the process starts. If a file is created by a running process, wait briefly and verify it with read_process_output or read_artifact before send_artifact.

When send_artifact succeeds, do not print the download URL in a markdown table or manual link. The chat UI automatically attaches the file card from the tool result; respond with a short confirmation such as "Attached the file."

Resource tiers are low, medium, and high. TTL is capped by tier. The agent may request ttlSeconds but cannot exceed the tier cap.`,

  conversations: `# Work Sessions and AI Workspace

AI conversations are stored on the backend. Tool discovery is conversation-scoped, so discovered toolsets remain available when returning to a saved conversation.

## Provider State
- The selected provider model and reasoning effort are pinned to the conversation when its first run starts.
- A model cannot be changed while the assistant is responding.
- Changing the model later requires a user confirmation because it can increase cost and reduce continuity or provider cache efficiency.
- Persisted model changes appear as timeline events. Consecutive changes collapse to the final transition, and a chain that returns to the original model is hidden.
- In Opfield Inference mode, model choices are filtered by the user's model access and effective API/subscription budget. A zero API budget hides API-only models.

## Context
- get_current_context returns the current UI route and focused resource when the user says "this page" or "current resource".
- compact summarizes older conversation history when context grows.
- Recent conversations are loaded from the backend, not local storage.
- manage_ai_conversation can list, read, and delete the current user's saved conversations:
  - { operation: "list" }
  - { operation: "get", conversationId }
  - { operation: "delete", conversationId }
  - { operation: "delete_by_title", title }
- manage_ai_conversation never creates, rewrites, or repairs conversation history. Use the chat UI/runtime for saving active messages.
- end_conversation closes the current chat with a localized reason. Use it only when the conversation should stop, especially after the third unrelated/off-topic request in the same conversation.
- If context is exhausted, the UI can block the composer and offer to clear the oldest saved context. Do not keep retrying the same oversized request.

## Attachments And Artifacts
- The composer accepts up to three supported images when the selected model advertises image input.
- Uploaded attachments become Opfield-managed artifacts tied to the conversation.
- Tool-generated files are attached through send_artifact and should not be duplicated as manual download links.

## AI Workspace
AI Workspace is Opfield's intent-driven desktop interface. The Work Session becomes the main screen, the sidebar shows a separate Dashboard link, Sidebar-pinned resources, and recent/pinned Work Sessions. Dashboard pins are not duplicated there: use the Sidebar placement for frequent navigation. Settings, Administration, and top-level pages keep a back button to return to the Work Session.

Do not assume the current page from chat text. Use get_current_context when the user refers to their visible page.`,

  'status-page': `# Status Pages

Opfield can publish status-page data from monitored services and incidents. Use manage_status_page for settings, services, incidents, updates, proxy-template choices, and preview.

## Resources and Operations
- settings: { resource: "settings", operation: "get"|"update", payload? }
- proxy_templates: { resource: "proxy_templates", operation: "list" }
- services: { resource: "services", operation: "list"|"create"|"update"|"delete", serviceId?, payload? }
- incidents: { resource: "incidents", operation: "list"|"create"|"update"|"delete"|"resolve"|"promote", incidentId?, status?, limit?, payload? }
- incident_updates: { resource: "incident_updates", operation: "create_update", incidentId, payload }
- preview: { resource: "preview", operation: "preview" }

Scopes: status-page:view for reads/preview, status-page:manage for settings/services, and status-page:incidents:create, status-page:incidents:update, status-page:incidents:resolve, or status-page:incidents:delete for incident mutations.`,

  api: `# Opfield REST API

Opfield provides REST access for external scripts, CI/CD pipelines, CLI tools, and integrations without a browser session.
Programmatic REST clients can use either Opfield API tokens (\`opf_\`) or OAuth Authorization Code + PKCE access tokens (\`opfo_\`). API/OAuth tokens can hold every resource scope, including user and group administration, Opfield settings, raw nginx config and bypass flags, node config and files, integrations, hosting and inference administration. Only account-bound scopes cannot be delegated: AI Workspace and sandbox access, AI configuration and skills, \`mcp:use\` and \`admin:users:impersonate\`. A token never exceeds its owner's current scopes. MCP clients use OAuth access tokens for the MCP resource with ordinary delegated API scopes; the owning user account must have \`mcp:use\`.

## Current-User OAuth Authorizations
The assistant can manage existing OAuth authorizations for the current browser user with manage_oauth_authorization:
- { operation: "list" }
- { operation: "update", authorizationId, scopes?, expiresAt?, allowedIps? }
- { operation: "update_scopes", authorizationId, scopes }
- { operation: "revoke", authorizationId }

expiresAt (ISO date-time in the future, null removes it) ends every token of the authorization at that moment; allowedIps (up to 20 IPv4/IPv6 addresses or CIDR ranges, [] for any address) refuses its tokens, including refreshes, from other addresses.

Pending OAuth consent remains browser-only. Do not try to approve a new OAuth client through tools.

## Current-User Opfield API Tokens
The assistant can manage the current browser user's Opfield API tokens with manage_api_token:
- { operation: "list" }
- { operation: "create", name, scopes, registryAccess?, expiresAt?, allowedIps? }
- { operation: "update", tokenId, name?, scopes?, registryAccess?, expiresAt?, allowedIps? }
- { operation: "revoke", tokenId }

expiresAt is an ISO date-time in the future (null or omitted on create: no expiry; null on update removes it). An expired token is refused like a revoked one, listed with expired: true and removed by housekeeping after the Expired Tokens period (7 days by default). allowedIps limits the token to up to 20 IPv4/IPv6 addresses or CIDR ranges, checked against the client address Opfield resolves (trusted proxies only); [] allows any address. Existing tokens have neither limit.

Token scopes must be a subset of the current user's scopes. registryAccess is the token's internal registry access for docker login: { pull?: "all" | [repositories], push?: "all" | [repositories] } (exact repository names; {} removes it). "all" needs the broad (unqualified) docker:containers:view, docker:compose:view or docker:images:view for pull and docker:containers:edit, docker:containers:manage or docker:compose:manage for push (or the legacy docker:registries:internal:pull/push); with folder, node or single-workload grants list the repositories instead: each needs view (pull) or edit/manage (push) on a container, deployment or Compose project that is built into or runs an image of it, or the legacy scope for that repository. Every docker login rechecks this against the owner's current permissions. A token may have registry access and no scopes. Token secrets are returned only by create and cannot be read later. manage_api_token is browser-session-only and is not exposed through MCP.

## Creating an API Token
1. Open **Profile** from the account menu (avatar at the bottom of the sidebar) → **Authorizations** → **API Tokens**
2. Click **Create Token** → enter a name, choose when it expires (15 minutes to 1 year, Never, or a custom date), optionally restrict it to IP addresses (**Restrict by IP**), and select the scopes (permissions) the token should have
3. Token scopes must be a subset of your own group's scopes — you cannot grant permissions you don't have
4. The token is shown **once** after creation (prefixed with \`opf_\`) — copy and store it securely
5. Tokens cannot be retrieved after creation — if lost, revoke and create a new one

## Authentication
Programmatic API requests authenticate via the \`Authorization\` header:

\`\`\`bash
curl -H "Authorization: Bearer opf_your_token_here" https://opfield.example.com/api/cas
\`\`\`

Token format: \`opf_\` followed by 64 hex characters.
OAuth access tokens use the \`opfo_\` prefix and the same Bearer header. Browser-only endpoints still require the HttpOnly session cookie and CSRF token where applicable.

## Base URL
All endpoints are under \`/api/\`. Example: \`https://opfield.example.com/api/cas\`

## Safe Retries (Idempotency-Key)
Selected create endpoints accept an optional \`Idempotency-Key\` header (1-255 printable ASCII characters, for example a UUID): Docker containers (create and duplicate), deployments, Compose projects, source resources, volumes, networks and registries; routes (\`/api/proxy-hosts\`) and route folders; domains; ACME certificates; certificate authorities; database connections and managed databases; storage connections and managed storage; Page Projects; alert rules; and SIEM destinations. The OpenAPI document lists the header on exactly these operations. Send a new key per logical operation and reuse it only when retrying that same request after a timeout or dropped connection:

\`\`\`bash
curl -X POST -H "Authorization: Bearer opf_your_token_here" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 5f0c6c1e-8a55-4c43-9d4e-2f1f8c3d9b10" \\
  -d '{"domain":"app.example.com"}' https://opfield.example.com/api/domains
\`\`\`

- Keys are bound to the API/OAuth token or browser session, its current effective scopes, the method and the path. After a scope change a key starts fresh. Results are kept encrypted for 24 hours, and every replay is written to the audit log.
- Same key and same request (query and JSON body): the original response is replayed with \`Idempotency-Replayed: true\`; nothing is created twice.
- Same key with a different request: \`422 IDEMPOTENCY_KEY_REUSED\`. Same key while the first request still runs: \`409 IDEMPOTENCY_KEY_IN_PROGRESS\` with \`Retry-After\`.
- A completed request whose response was not stored (it looked like it carried a secret, or was over 1 MiB) answers \`409 IDEMPOTENCY_RESPONSE_WITHHELD\` with the original status and \`Location\` when known: look the resource up instead of retrying.
- Only 2xx and deterministic 400/404/409/422 JSON responses are recorded. 401, 403, 5xx, streamed and non-JSON responses are not, so a retry runs again.
- Endpoints that return a secret once (API, inference, ingest and Pages deploy tokens, node enrollment, keys, credentials, bindings) never take the header, and neither do other endpoints outside the list. Bodies over 1 MiB, non-JSON uploads and WebSocket routes run without idempotency, and so does everything while the idempotency store (Redis) is unavailable.
- MCP create tools (containers, deployments, Compose projects, routes, domains, ACME certificates, databases, storage, Page Projects and similar; not nodes or other secret-returning tools) take an optional \`idempotencyKey\` argument with the same semantics, bound to the MCP token, its scopes and the owner's live scopes; a replayed result carries \`_meta.idempotencyReplayed: true\`. Over MCP the errors are tool errors that start with the code: \`IDEMPOTENCY_KEY_REUSED\`, \`IDEMPOTENCY_KEY_IN_PROGRESS\`, and \`IDEMPOTENCY_RESULT_WITHHELD\` (the MCP name of the withheld-response case; look the resource up instead of retrying).

## Key Endpoints

### PKI & Certificates
- \`GET /api/cas\` — list certificate authorities
- \`GET /api/cas/:id\` — get CA details
- \`POST /api/cas\` — create root CA
- \`POST /api/cas/:id/intermediate\` — create intermediate CA
- \`GET /api/certificates\` — list certificates
- \`POST /api/certificates/issue\` — issue a certificate
- \`POST /api/certificates/:id/revoke\` — revoke a certificate
- \`GET /api/certificates/:id/export\` — download cert + key
- \`GET /api/templates\` — list certificate templates

### SSL Certificates
- \`GET /api/ssl-certificates\` — list SSL certificates
- \`POST /api/ssl-certificates/acme\` — request ACME (Let's Encrypt) certificate
- \`POST /api/ssl-certificates/upload\` — upload custom certificate
- \`POST /api/ssl-certificates/internal\` — link PKI cert as SSL

### Ingress Routes
The UI calls these resources Routes; stable API paths keep the \`proxy-hosts\` name.
- \`GET /api/proxy-hosts\` — list routes
- \`POST /api/proxy-hosts\` — create route
- \`PUT /api/proxy-hosts/:id\` — update route
- \`DELETE /api/proxy-hosts/:id\` — delete route
- \`GET /api/nginx-templates\` — list nginx config templates
Programmatic clients read and write raw nginx config with the same \`proxy:raw:*\` scopes as browser users.

### Domains
- \`GET /api/domains\` — list domains
- \`POST /api/domains\` — register domain
- \`POST /api/domains/:id/check-dns\` — trigger DNS re-check

### Nodes
- \`GET /api/nodes\` — list daemon nodes
- \`POST /api/nodes\` — create node (returns enrollment token and opfieldCertSha256)
- \`DELETE /api/nodes/:id\` — delete node

### Docker
- \`GET /api/docker/nodes/:nodeId/containers\` — list containers
- \`GET /api/docker/nodes/:nodeId/source-resources/admission\` — check internal-registry and Build Worker admission
- \`POST /api/docker/nodes/:nodeId/source-resources\` — create a container/deployment source reservation and queue its first immutable build
- \`POST /api/docker/nodes/:nodeId/compose-projects/from-source\` — create a Compose Project source reservation and queue one immutable child build per build-enabled service
- \`GET /api/docker/builds\` — list visible Git-source builds
- \`GET /api/docker/builds/:buildId\` — inspect one build and its artifact/policy result
- \`GET /api/docker/builds/:buildId/logs\` — read persisted build logs
- \`POST /api/docker/builds/:buildId/cancel\` — request build cancellation
- \`POST /api/docker/builds/:buildId/retry\` — queue a new attempt
- \`POST /api/docker/nodes/:nodeId/containers/:id/start\` — start container
- \`POST /api/docker/nodes/:nodeId/containers/:id/stop\` — stop container
- \`POST /api/docker/nodes/:nodeId/containers/:id/restart\` — restart container
- \`POST /api/docker/nodes/:nodeId/containers/:id/recreate\` — recreate with new config (supports \`image\` field for tag change)
- \`POST /api/docker/nodes/:nodeId/images/pull-sync\` — pull image synchronously (validates image exists)

### Docker Webhooks
- \`GET /api/docker/nodes/:nodeId/containers/:name/webhook\` — get webhook config with its token (\`tokenLost: true\` and no token for a webhook whose URL 2.13.0 did not keep; regenerate it)
- \`PUT /api/docker/nodes/:nodeId/containers/:name/webhook\` — enable/update webhook
- \`DELETE /api/docker/nodes/:nodeId/containers/:name/webhook\` — disable webhook
- \`POST /api/webhooks/docker/:token\` — trigger webhook update (no auth header needed, token is in URL)

### Access Lists
- \`GET /api/access-lists\` — list access lists
- \`POST /api/access-lists\` — create access list
- \`GET /api/access-lists/:id\` — access list detail (sign-in methods, rules, skip ranges; usernames and \`sharedPasswordSet\`, never hashes)
- \`PUT /api/access-lists/:id\` — update access list (omitted fields keep their value; topic access-lists)
- \`POST /api/access-lists/:id/ip-rules/move\` — legacy: move one rule of the list's legacy ipRules view (\`{ fromIndex, toIndex }\`, 0-based); 409 \`ACCESS_LIST_NOT_LEGACY\` for a list with sign-in rules
- \`DELETE /api/access-lists/:id\` — delete access list (refused while a route or Pages project uses it)

### Browser-only administration
- \`/auth/*\`, \`/api/oauth/consent/*\`, \`/api/oauth/authorizations/*\`, \`/api/admin/users\`, \`/api/admin/groups\`, \`/api/tokens\`, \`/api/ai/*\`, raw nginx config endpoints, and system update mutations require a browser session.
- \`GET /api/audit\` — query audit log

## Response Format
- Success: JSON body with the resource data
- Errors: \`{ "code": "ERROR_CODE", "message": "Human-readable description" }\`
- List endpoints return: \`{ "data": [...], "total": N, "page": 1, "totalPages": N }\`

## Rate Limits & Pagination
- Default page size: 20 items. Use \`?page=N&limit=N\` for pagination (max 100).
- Search: \`?search=term\` on list endpoints for text filtering.
- Filter by type: \`?type=nginx\` on nodes, \`?status=running\` on containers.

## Scopes
Token permissions are controlled by scopes. Each endpoint requires specific scopes. A token with only \`pki:cert:view\` can list certificates but cannot issue or revoke them. See the permissions topic for the full scope list.

## Token Management
- Tokens are tied to the user who created them
- Revoking a token invalidates it immediately
- Token last-used timestamp is tracked for auditing
- Tokens inherit the user's resource restrictions (if the user's group restricts a scope to specific resources, the token is similarly restricted)`,
};
