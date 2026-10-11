# MCP toolsets, documentation, and resources

## Tool visibility

- With **Extended MCP compatibility** on (the default), `tools/list` returns every tool the OAuth scopes allow.
- With it off, a connection starts with the `core` toolset plus the always-visible `find_resource`, `get_my_access`, and `read_gateway_documentation`. Call `discover_tools({ category: "<id>" })` to activate a toolset, then list tools again. Activation lasts for the MCP session; call it again to add more toolsets.
- A missing tool is usually an inactive toolset or a missing scope, not a broken connection. Distinguish those from a missing entitlement, a disabled MCP server, an unavailable subsystem, or a client that cannot refresh its tool list.

## Toolset IDs

The list is defined by the server; never invent an ID.

| ID | Covers |
| --- | --- |
| `core` (default) | Node, Route, SSL certificate, Domain, Access List, database, CA, PKI certificate and template, and folder inventory reads |
| `folders` | Folder layout and foldered resource assignment |
| `nodes` | Node inventory, enrollment, lifecycle, global nginx config, console, filesystem |
| `proxy` | Domains, Routes, route folders, nginx templates, Access Lists, raw Route operations |
| `certificates` | CAs, PKI certificates and templates, SSL certificates, system PKI leaf audit |
| `docker` | Containers, Deployments, images, volumes, networks, registries, Tasks, config, migrations |
| `databases` | Database connections, managed databases and bindings, PostgreSQL and key-value data tools |
| `storage` | Storage connections, objects, server-side copy, managed SeaweedFS, workload links |
| `pages` | Page Projects, Deployments, Tags, runtime config, profile |
| `logging` | Logging backend, environments, tokens, schemas, metadata, search, facets |
| `status_page` | Status page services, incidents, settings, templates, preview |
| `integrations` | Connector inventory and resync for GitLab, GitHub, generic Git, Cloudflare, external SSH |
| `gitlab` | GitLab projects, repository files, CI pipelines, variables, webhooks, registry |
| `github` | GitHub repositories, branches, workflow runs, repository files, Actions settings |
| `git` | Generic HTTPS Git connectors, remote refs, trees, files |
| `external_ssh` | External SSH connectors and remote command execution |
| `hosting` | Hosting provider connectors, VMs, power and resize, snapshots, firewalls |
| `notifications` | Alert rules, webhooks, delivery logs, statistics |
| `administration` | Users, permission groups, audit log, system alerts |
| `maintenance` | Opfield settings, system updates, license, cloud account connection, housekeeping, and Opfield's own diagnostics (`manage_gateway_diagnostics`) |
| `inference` | Opfield Inference core, provider connections, published models, limits, usage, personal keys |
| `ai_assistant` | AI assistant provider, limits, tool access, web search, sandbox runner configuration |

## What MCP never exposes

Whatever the scopes, MCP does not expose tools that are bound to a browser session, the embedded assistant, or credential minting:

- embedded-assistant internals: the chat form of `discover_tools`, skill loading, tool-output paging, chat search and retrieval, `ask_question`, `get_current_context`, `internal_documentation`, `web_search`, `wait`, `send_comment`, `manage_ai_conversation`;
- the assistant's sandbox runner, its artifacts, and `gitlab_clone_repository_to_sandbox`;
- credential minting: `manage_api_token` and `manage_oauth_authorization`;
- Console UI actions: `open_node_enrollment`, `open_connector_setup`, `set_resource_pin`.

MCP uses `read_gateway_documentation` instead of `internal_documentation` and `find_resource` instead of chat-side search.

## Documentation

`read_gateway_documentation({ topic })` returns operator documentation for the connected release, filtered by the token's scopes. The tool's `topic` enum is authoritative. Useful topics include `discovery`, `overview`, `installation`, `authentication`, `permissions`, `users`, `audit`, `api`, `nodes`, `node-files`, `docker`, `availability`, `docker-registries`, `folders`, `proxy`, `domains`, `ingress-groups`, `access-lists`, `templates`, `nginx`, `ssl`, `acme`, `pki`, `pages`, `databases`, `postgres`, `redis`, `clickhouse`, `storage`, `storage-migration`, `logging`, `siem`, `notifications`, `status-page`, `gitlab`, `cloudflare`, `housekeeping`, `gateway-settings`, `licensing-updates`, `inference`, and `troubleshooting`.

Public product documentation at [docs.opfield.dev](https://docs.opfield.dev/) (with `llms.txt`) explains concepts and decisions. Use `read_gateway_documentation` for the exact behavior of the running instance.

## Resources and prompts

- `gateway://docs` indexes the same topics, readable as `gateway://docs/<topic>`.
- `gateway://access` is the caller's access summary (the same as `get_my_access`): granted folders, nodes, and resources, and where it may create.
- Live read-only resources: `gateway://overview`, `gateway://nodes`, `gateway://proxy/hosts`, `gateway://docker/nodes`, `gateway://logging/environments`, `gateway://status-page/summary`, `gateway://certificates/expiring`.
- Releases that ship these Agent Skills also serve them as `gateway://skills` (an index) and `gateway://skills/<name>/SKILL.md`, matching the connected Opfield version. Only Markdown files are served; bundled scripts are not.
- Workflow prompts, when the client surfaces them: `investigate-service-outage`, `rollout-container-image`, `create-status-incident`, `review-node-health`, `provision-proxy-host`, `renew-or-debug-certificate`, `plan-managed-database-access`.
