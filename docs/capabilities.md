# Opfield Capabilities

[Back to README](../README.md)

Opfield is an AI-first but not AI-dependent infrastructure control plane. Operators can work through AI Workspace or use the complete Operations Console, REST API, OAuth, and MCP surfaces without AI. The product is built around a central web app and host daemons that connect outbound to the app, so operators run the fleet without shell access to each server.

Feature availability and plan limits are documented separately in [Plans and licensing](licensing.md). Capabilities marked `In development` are not generally available runtime features until released.

For ready paid capabilities, Opfield enforces plan entitlements at the operation boundary as well as in the Operations Console. Plan changes preserve existing data and resources: after the grace period existing paid resources keep running and stay viewable and deletable, while creating paid resources, changing their configuration, and one-shot premium operations such as Git source builds are blocked. SIEM forwarding pauses and Business-only external registry access issues no new tokens until renewal; both keep their configuration and stored data (see [Grace periods and entitlement loss](licensing.md#grace-periods-and-entitlement-loss)). Personal, Business, and Enterprise expiration grace lasts 24 hours, 3 days, and 7 days respectively; the Dashboard shows a critical warning until the local deadline. See [Plans and licensing](licensing.md) for the ungrouped plan matrix and exact lifecycle rules.

## Ingress

Opfield uses managed nginx nodes as public ingress. The Ingress workspace is split into Domains, Routes, and SSL Certificates so placement, traffic forwarding, and TLS remain independently manageable while their relationship stays explicit.

Core ingress workflows:

- Serve every registered domain from one eligible nginx ingress node with a detected public service address, or from an [ingress group](#ingress-groups) of several nginx nodes.
- Create, edit, order, and delete routes. The REST API and persisted model retain the `proxy-host` name for compatibility.
- Keep each registered domain and every route using it on the same nginx node or ingress group; Opfield rejects a route whose node or group differs from its registered domain's.
- Configure SSL termination, manual upstream targets, or managed Docker container/deployment upstreams with published-port validation.
- Connect managed Docker workloads to nginx through Opfield Secure Links without exposing the workload port as a normal public management endpoint.
- Switch a route to Raw Config Mode to own its whole nginx configuration. Raw mode starts from the rendered config, and Opfield stops rendering the route until raw mode is switched off. A route to a Docker workload keeps its Secure Link in raw mode: the seeded `upstream` (the link's socket on the nginx node) keeps reaching the workload and follows it when its container is recreated. Edit it as needed, but keep proxying to that upstream.
- Put an enabled managed route into maintenance mode to return HTTP 503, pause managed health checks, preserve its TLS paths, and expose maintenance state to alerts and status pages. On a node with a current Nginx daemon, entering and leaving maintenance does not reload Nginx, so the other routes of the node keep their connections.
- Configure WebSocket support, custom headers, rewrites, and proxy behavior.
- Create proxy, redirect, and 404 routes.
- Group routes into folders and reorder them with drag-and-drop.
- Configure access lists with IP rules and basic authentication.
- Use nginx config templates with variables for repeatable route configuration.
- View real-time nginx logs and node stats.

Health checks:

- Configure expected status codes.
- Configure expected response body matching.
- Track health state and history.
- Surface failures in the UI and notification workflows.

Nginx integration:

- `managed` mode lets Opfield own a known-good base nginx config.
- `integrate` mode keeps an existing host nginx config and injects Opfield-managed includes.
- ACME HTTP-01 challenges are deployed only to the ingress node assigned to the registered domain, or to every online member of its ingress group. That node must be online, publicly reachable on port 80, and have a public service address.

### Ingress Groups

An ingress group is a set of nginx ingress nodes, normally one per site, that serve the same Routes, Domains, and Pages Routes. Ingress groups are available on Business and Enterprise; a group that exists keeps serving without the entitlement, and removing members or deleting the group is always allowed. Manage them under **Routes > Ingress Groups**, through `/api/ingress-groups`, or with the `manage_ingress_group` AI Workspace and MCP tool.

- Every member renders all routes of the group itself and keeps its own replica of every certificate, access list, and Pages artifact plus its own Secure Link sources, so a member keeps serving while Opfield or another member is down. A reconciler repairs missing or stale configs and certificate replicas every minute and when a member reconnects.
- Members are nginx nodes whose daemon advertises `ingress_group_v1` (the nginx daemon from 2.11), listed in site-preference order. A member is `joining` while it receives the group's configuration and is not yet published in DNS, `active` once it serves and is published, and `draining` while it is being removed: it keeps serving until no public name of the group resolves to it and the DNS TTL has passed (at most 24 hours), unless the removal is forced.
- A Route or Domain targets either one node or one group, and a route uses the same target as its registered domain. Converting an existing route or domain onto a group sends configuration and certificates to the new members first and changes DNS last; moving back to one node changes DNS first and cleans up the other members afterwards. A domain that backs the Pages wildcard preview profile stays on one node.
- Groups live in node folders and have their own permissions, granted broadly or on a node folder (which covers its subfolders): viewing needs `ingress:groups:view`, changes need `ingress:groups:manage` (which includes viewing), and adding a member also needs `nodes:manage` on that node. Node permissions alone do not show ingress groups. The built-in admin group has both, the built-in operator group has `ingress:groups:view`. Placing a route or domain on a group needs `ingress:groups:view` on the group and the create permission for every member; the route and domain forms offer only the groups you can view. On upgrade, custom groups, user permissions, API tokens and OAuth grants holding `nodes:details` or `nodes:manage` (broadly or on a folder) receive the matching ingress group permissions.
- DNS failover mode `none` is the only mode: the Cloudflare records of a group's domains list the address of every active member (round robin). Plain DNS records are not health-checked, so an unreachable member keeps receiving its share of clients until it leaves the group. External DNS stays operator-managed; list the members' addresses there.
- For health-based failover, put a load balancer in front of the members, for example Cloudflare Load Balancing; Opfield does not create it. Every Opfield-rendered server block and the node's default servers answer `/.well-known/opfield-ingress-health` (and its earlier name `/.well-known/gateway-ingress-health`, which keeps working for existing probes) with `200` and a JSON status while nginx runs the current configuration (and, on a node with Secure Link sources, at least one relay connection is usable), `503` otherwise, and `502` when the nginx daemon is not running. A probe that addresses a member by IP uses the host name `ingress-health.opfield.invalid` (as SNI and `Host`; the node answers it on ports 80 and 443 with a self-signed certificate), because the TLS catch-all refuses other unknown names.
- Certificates for names on a Cloudflare-managed group domain are issued and renewed with DNS-01 through the Cloudflare connector, so they do not depend on any one member. HTTP-01 challenges go to every online member.
- Route health is checked through every member: a route is degraded when some members fail it and offline when none serves it. The route shows which configuration and certificate each member confirmed, and its log view merges the members' nginx logs by time.

## Pages

Opfield Pages provides project-based static-site hosting on managed nginx ingress nodes. Pages is available on Personal and higher; Community installations cannot create or manage Pages projects, deployments, or Pages Routes.

Pages workflows:

- Model each site as a Project with immutable Deployments and mutable Tags. `latest` is system-managed, and custom Routes target Tags.
- Store source artifacts in Opfield and materialize replicas on managed nginx nodes through `nginx_pages_v1`.
- Configure one optional wildcard preview profile for immutable deployment hostnames. Its one-label template contains `{hash}` exactly once.
- Give every Tag a stable preview link, `https://<project hash>-<tag>.<Pages domain>`, that follows the Tag to each later Deployment and serves the Tag's runtime configuration. Protect a Project's previews with an access list (requires a Pages node daemon that supports preview access lists) and revoke every preview link at once by rotating the Project's links.
- Accept a build folder archive or a single HTML file as an upload, let uploaded Deployments expire after 5 minutes to 1 year, and cancel an unfinished upload.
- Enable or disable Pages globally from Settings. Disabled Pages is removed from navigation; Community users can inspect and edit the form, but saving opens the shared Personal upgrade flow.
- Serve public runtime configuration at `/_opfield/pages/config.js` as `window.runtime.config` (pages that load the earlier `/_gateway/pages/config.js` get the same script). It is capped at 64 KiB, served with `no-store`, and does not change Deployment identity or artifact hashes.
- Re-authorize resumable upload append/finalize requests and deploy-token Tag policy; publication verifies generation/status and rollback state before cleanup.
- Integrate Pages with scopes, folders, EventBus/WebSocket, notifications, audit/SIEM, retention, navigation, search, cache, and resource context.
- Operate Projects, Deployments, Tags, runtime configuration, placement migration, and profile settings through the scoped AI Workspace and remote MCP Pages toolset. Remote MCP clients upload artifact bytes with the authenticated `upload_pages_artifact` tool: a one-time upload link that a shell streams an archive or packed build folder to with curl, or the begin/chunk/finalize workflow (maximum 1 MiB decoded per chunk, no credential argument); ordinary API clients can keep using the resumable deploy API.
- On Business and Enterprise, connect an allowlisted GitLab, GitHub, or generic Git repository to a Page Project, discover `package.json`, configure the Node/package-manager build, queue or retry builds on isolated Build Workers, and publish approved immutable artifacts to the requested Tag. Source settings, Build Secrets, build history, logs, cancellation, and retry use the same scoped AI Workspace and MCP contracts as Docker sources.

## Route Extensions

Managed Routes can contain Additional Routes for literal path prefixes such as `/api` or `/assets`. Each location can target a manual address, standalone Docker container, Compose service, Docker deployment, or ready Pages Tag and can carry its own buffering, timeout, WebSocket, prefix-stripping, and advanced location directives. Custom proxy templates support them when they include `{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}` inside the intended `server` block. Docker and Compose targets own the Secure Link binding created for that location, so retry, edit, and delete follow the Additional Route lifecycle.

The AI Workspace and remote MCP Ingress route tools use the same managed-upstream contract as the Console and REST API: root Routes can target manual addresses, standalone Docker containers, Compose services, Docker deployments, or ready Pages Tags, and `set_route_maintenance` uses the canonical maintenance lifecycle instead of disabling or rewriting a Route.

Additional Secure Link Bindings are separate user-managed bindings to Docker workloads or ready managed Object Storage, intended for upstreams referenced from advanced nginx config as `{{additionalSecureLinks.<name>}}`. The value already includes the scheme (`http://…` or `https://…`), so write `proxy_pass {{additionalSecureLinks.<name>}};`, not `proxy_pass https://{{additionalSecureLinks.<name>}};`. Managed S3 destinations use the stable storage identity and private relay without a shared Docker network or published S3 port; creating or retrying one requires Route edit and canonical Storage view access. S3 authentication remains the caller's responsibility. Remove these bindings before deleting their storage. Route-owned bindings remain visible in the binding list but cannot be deleted independently. Both lifecycles are available through the scoped Operations Console, AI Workspace, REST/OAuth, and remote MCP Ingress toolset.

## Relay And Secure Links

The installed local relay is a long-lived data-plane service and the sole public owner of `9443/tcp`; the Opfield app keeps only an internal gRPC listener. Managed daemons use the relay for authenticated control connections and tunnel traffic, including private managed-database bindings and Docker-to-nginx Secure Links.

Opfield can extend the local relay into a Relay Pool without exposing pool topology to applications. Operators enroll remote supervisor/worker pairs and verify distinct physical fault domains; Opfield rebalances placement onto ready relays by itself (or on request), measures daemon round trips so routes use the nearest relays first, and operators drain members and apply signed rolling updates one member at a time. Remote supervisor management remains outbound-only, while each worker's advertised data endpoint must be reachable from assigned managed hosts. Opfield does not open firewalls, provide NAT traversal, or create an overlay network; the product continues to present one logical Secure Link.

## Docker

Opfield manages Docker through the `docker-daemon` installed on container hosts.

Container workflows:

- List containers across managed Docker nodes.
- Grant container permissions for an entire Docker node or narrow them to one standalone container or blue/green deployment.
- Start, stop, restart, recreate, duplicate, rename, and remove containers.
- Choose the Default (`runc`) isolation profile in every plan. Business and Enterprise plans can also use the Secure (`runsc` through gVisor) profile when the target node reports a healthy Secure Runtime capability. Secure workloads cannot use GPUs, device attachments, host bind mounts, cross-node migration, or `.gwca` export.
- Attach one or more node-discovered physical NVIDIA, AMD, or Intel GPUs to standalone containers and blue/green deployments. GPU devices are shared rather than reserved; changing a selection recreates the workload, duplicates preserve it, and both blue/green slots receive the same selection.
- Stream `.gwca` exports and imports on Personal and higher in either self-contained portable mode or smaller registry-backed mode. Export is protected by the dedicated, resource-scopable `docker:containers:export` permission in addition to file and environment access. Archives use an Opfield-supported configuration whitelist, always carry ordinary environment values, can optionally carry the container's own secrets (never the credentials of its database or storage links), and can optionally capture the writable layer without pausing. Registry-backed archives pull and verify an immutable digest. Volume contents are never included; source volumes are restored as empty managed local volumes unless an eligible existing managed local volume is selected. Host bind mounts are not portable. Networks and occupied ports can be remapped for the target node. Remote MCP agents export and import archives through one-time curl links (or small base64 chunks without a shell) under the same checks.
- Create, inspect, and remove images, volumes, and networks across managed nodes.
- Run durable cross-node migrations on Personal and higher for eligible containers and blue/green deployments, including image and volume transfer, capacity preflight, verification, cutover, cancellation, and cleanup recovery. GPU-attached workloads are intentionally not portable in v1.
- A migration reproduces the running workload on the target and needs a Docker daemon with `docker_migration_v2` on both nodes; the preflight names a node whose daemon must be updated first. A container's own environment moves with it, its image defaults come from the same image on the target, and its saved environment variables and secrets must be the ones it runs: the preflight refuses a variable or secret saved without a recreate (`MIGRATION_ENV_PENDING`, naming the keys) until the container is recreated. A deployment carries the environment its slots run; its saved environment applies at the next deploy as before. Local volumes created with driver options (a host path, a network share, tmpfs) and Secure Runtime workloads are not migratable.
- Move resource-scoped grants with a container or deployment during migration. Recreates preserve the stable access identity; explicit deletion removes its grants so a later same-name resource starts without inherited access.
- Edit image, command, environment variables, secrets, labels, ports, restart policy, and runtime limits. Labels under `com.docker.compose.` and `net.opfield.`, the earlier namespaces `wiolett.gateway.`, `net.wiolett.gateway.` and `com.wiolett.gateway.`, and `gateway.sandbox`, are reserved: create refuses them, recreate keeps existing ones only unchanged, and duplicates leave them out (a Docker daemon without `docker_duplicate_label_filter_v1` refuses to duplicate a container that carries them). A duplicate copies the container's own secrets but not its database or storage links: the variables they inject are left out of the copy (a Docker daemon without `docker_duplicate_env_removal_v1` refuses to duplicate a linked container). A name held by a Git source still waiting for its first build cannot be taken by create, duplicate, rename or archive import (`409 NAME_IN_USE`).
- Attach Opfield-managed local volumes with `docker:volumes:view` on each volume and the workload's own create or edit; changing legacy host bind mounts needs the dedicated `docker:containers:mounts` scope. New and changed mounts accept only Opfield-managed local volumes; new host bind mounts are rejected. Existing legacy mounts are preserved during normal image, environment, and webhook updates.
- Browse container logs with search and follow mode.
- On Community and every paid plan, discover externally created Docker Compose projects from canonical labels and inspect their inventory, status, monitoring, and logs as read-only Compose Projects. Opfield can adopt a project only after the user supplies its complete single-file YAML; Opfield never reads host Compose files from label paths.
- On Personal and higher, deploy and manage single-node Compose Projects with immutable revisions, validation, explicit Pull & Apply, start/stop/restart/down, aggregated logs, operation history, folders, masked secrets, drift reporting, ordinary non-Swarm CPU/memory/PID limits, managed database links, and Route/Secure Link targeting by project/service identity. Manual YAML revisions remain image-only: `build`, host bind mounts, privileged/device access, and swarm-only fields are rejected before mutation.
- Hide project-owned containers, named volumes, and non-external networks from standalone lists and block their direct mutations. Images and external/shared resources remain global. Compose resources are not eligible for cross-node migration.
- Applying a new revision recreates only the services whose own definition changed (image, environment, command, ports, volumes, networks, limits, labels, logging and the other service fields) or whose interpolated variables or secrets changed; the other services keep running. Each service carries the digest of its own configuration (`wiolett.gateway.compose.revision`), and a service whose label matches neither its digest in the active revision nor the revision digest is reported as drift. Pull & Apply also recreates a service whose image tag now points to a newer image. A service the new revision no longer declares is stopped and removed by the apply (its volumes stay); pass `removeOrphans: false` in the API or MCP to keep it running. The changed services of that revision start only after the removed service has stopped, up to its 10-second stop grace period. Placements of an Availability-managed project still carry the revision digest, so a new revision recreates all of their services.
- Open an interactive container console.
- Browse and edit container files when permitted.
- Keep sanitized inventory snapshots so read views can show the last synchronized Docker state while a node is offline or refreshing; mutations remain unavailable until the node reconnects.
- Manage Docker images and cleanup old images.
- Manage private registry credentials and image registry mappings.
- On Business and Enterprise, create a container, blue/green deployment, or Compose Project from an allowlisted GitLab, GitHub, or generic Git repository, or attach a repository directly to an existing Docker or Compose resource. Opfield resolves an exact branch commit, queues durable builds, stores approved artifacts by immutable digest, and uses safe container recreate, the existing health-checked blue/green path, or an immutable Compose revision. The UI permits configuring Repository mode before enforcing the plan when **Create and build** or **Connect** is pressed; the backend independently enforces Business at source mutation and build admission.
- A repository Compose file may use the supported single-node `build` subset (`context`, `dockerfile`, and `args`). Opfield creates one child build per service, waits until every expected artifact is approved, then creates one digest-pinned immutable revision and applies it atomically. A failed, rejected, cancelled, or superseded child prevents the project rollout. Repository service networks and managed database overlays are added to the runtime revision without rewriting the authored source file.
- Review global build history, Build Worker assignment, logs, vulnerability findings/policy results, desired and deployed commits, Compose service names, and per-resource source settings. Repository, integration, branch, Dockerfile/Compose-file path, build context, separate automatic-build and automatic-deploy controls, and source-scoped Build Secrets remain part of the Docker or Compose resource rather than a separate application entity.
- AI Workspace and remote MCP expose first-class Compose lifecycle/revision/secret/operation tools, Git-source management for containers, deployments, Compose Projects and Pages, Build Worker-filtered build history, build logs/cancel/retry, and resource search for Compose Projects and build jobs. Every operation reuses the same REST schemas, license checks, and resource-scoped permissions as the Console.
- Use the Opfield-managed internal Distribution registry on every plan without assigning a domain or publishing a host port. It keeps three successful artifacts plus active, rollback, in-progress, and manually pinned digests. Optional Business+ external Docker-client access is configured under **Settings > Features** and is exposed only through a selected nginx node, domain, TLS certificate, and an API token whose registry access (pull, or pull and push, optionally for listed repositories) its owner may give. Entitlement loss disables that ingress and every public token request rechecks the current plan.
- On Business and Enterprise, enable Availability for an existing standalone Container, managed Deployment, or whole Compose Project with no mounts. Replicated mode keeps 2–32 serving placements on independent eligible Docker nodes; Failover keeps one serving placement and replaces it on another node. Once every node and relay of the workload runs 2.11, failover runs in the data plane and keeps working while Opfield is down (see [Application Scaling](#application-scaling)). Opfield mirrors workload images into pinned immutable internal-registry digests, pre-pulls eligible standby nodes, projects managed-database bindings, managed storage links and Proxy Host/Additional Route/Advanced Secure Link targets per placement, and balances new ingress connections with least-connections. Each placement of a workload with a managed storage link gets the link on its own node (its connector, network and relay route, the link's key, the same variables); a Docker node whose daemon cannot host a storage link is left out of such a workload's candidates, and preflight refuses when a selected node, or too few nodes, remain. Disabling Availability leaves the link on the surviving copy and removes it from the other nodes; deleting the link removes it from every placement. The nodes remain independent: Opfield does not create Swarm state, an overlay, node-to-node trust, or inbound cluster ports. Published host ports are served only on the original node: copies on other nodes publish none and are reached through Routes, Container Links or Advanced Secure Links, and preflight warns about it (`AVAILABILITY_HOST_PORTS_NOT_REPLICATED`).
- Configure a trusted HTTPS token-service origin only for registries whose Bearer auth service is intentionally hosted on a separate origin.
- Track long-running Docker operations in the Tasks view.
- On Personal and higher, link a standalone container, deployment, or Compose service to one port of another workload on the same or another Docker node (container links). The consumer reaches the target as `alias:port` from its own internal link network through the node's shared secure-link connector, directly on one node and through the relay across nodes; the target needs no published port and cannot reach the consumer. Links are managed in the **Container Links** panel of the Environment (Compose: Variables) tab, `/api/docker/container-links`, and the MCP tool `manage_container_link`. Optional host, port, or URL variables recreate the consumer once. An Availability target is reached at its healthy placements, preferring one on the consumer's node; a link to an Availability deployment must use one of the deployment's ports. Both nodes need the 2.11.1 Docker daemon (`secure_link_egress_v1`); the target needs `docker:containers:link` (`docker:compose:manage` for a Compose service).

Deployment workflows:

- Create deployment definitions separate from running containers.
- Use deployment slots for rollout and rollback.
- Deploy, switch, rollback, stop slots, and monitor deployment health.
- Trigger image pull and recreate/deploy workflows from CI/CD webhooks.
- Store deployment secrets encrypted and reveal them only with explicit permission.

Safety controls:

- Mount editing is separated from normal container editing and constrained to Opfield-managed local volumes. Legacy mounts remain visible only where needed for compatibility and cannot be reintroduced after removal.
- Repository builds are admitted only while the internal registry is writable and an online Build Worker advertises BuildKit/containerd execution, dedicated-runtime, and enforced-resource-profile capabilities. A Build Worker is the existing `docker-daemon` in `builder` mode and has no Docker Engine socket.
- The current builder profile accepts one build at a time, uses a dedicated containerd namespace and runc runtime, disables OCI-worker and insecure entitlements, applies fixed CPU/RAM/PID limits, accounts job/runtime disk use, and clears BuildKit cache between jobs. The separate worker host or outer unprivileged container is the security boundary and must not contain unrelated workloads or credentials. Builder egress is installer-selectable and defaults to public internet with metadata/private/control-plane denial. Source-scoped Build Secrets use BuildKit secret mounts and log redaction; scanner SBOM data is ephemeral, and provenance is not published.
- Secrets are masked by default.
- Dangerous operations are permission-scoped and audited.

## Certificates And PKI

Opfield includes SSL certificate management and internal PKI.

ACME SSL:

- Issue Let's Encrypt certificates.
- Use HTTP-01 and DNS-01 challenge flows.
- Renew certificates on a configurable schedule.
- Attach certificates to routes. Opfield keeps the canonical certificate material and deploys node-local replicas only where enabled TLS routes use it.

Uploaded SSL:

- Upload existing certificates.
- Track expiration.
- Use uploaded certificates for routes.

Internal PKI:

Internal PKI is available on Enterprise. After the grace period existing CAs and certificates stay viewable, revocable, and exportable and CRLs keep publishing; creating and changing them needs the current plan. Authorities, certificates, templates, and audit history are never deleted by a plan change. Opfield's hidden system PKI remains available for internal platform transport.

- Create root and intermediate certificate authorities.
- Issue TLS server, TLS client, code-signing, and email certificates.
- Use certificate templates with custom extensions and policies.
- Generate and publish CRLs.
- Export certificates as PEM, PKCS#12, or JKS when the user has export scopes.

Private key material is encrypted at rest with the configured `PKI_MASTER_KEY`. Export and reveal operations are controlled by explicit scopes.

## Domains

Opfield keeps a central registry of public hostnames and their ingress placement.

Domain workflows:

- Track domains independently from routes and certificates.
- Use either external DNS or a Cloudflare connector. External DNS remains operator-managed; Cloudflare-managed domains can have their A/AAAA records created and reconciled automatically.
- Select an eligible nginx ingress node or an [ingress group](#ingress-groups) for every domain. Nodes without a detected public service address are not eligible, and a group member without one is not published in DNS.
- Validate DNS records such as A, AAAA, CNAME, CAA, MX, and TXT.
- Track domain usage across routes and SSL certificates.
- Surface DNS status in the UI.
- Use scheduled DNS checks for ongoing validation.
- Move a domain and its routes between eligible nginx nodes through the explicit ingress migration workflow, or onto an ingress group and back to one of its members without downtime. Cloudflare-managed DNS is updated during cutover; external DNS requires the operator to update records before completion.

## Databases

Opfield can store external PostgreSQL, key-value, and ClickHouse connections with encrypted credentials, and deploy managed Postgres, key-value store, and ClickHouse instances on dedicated Storage nodes. Key-value stores and key-value connections work with Redis clients. Enrolling Storage nodes is available in every plan; creating managed database instances requires Personal or higher.

External PostgreSQL and key-value connections that use TLS verify the server's certificate chain and host name. New connections verify by default; a connection to a server issued by a private CA takes that CA as a PEM bundle (`tlsCaCertificate`), and turning verification off (`tlsVerifyCertificate: false`) is an explicit, insecure choice per connection. Connections saved before 2.11 never verified the server certificate, so the upgrade keeps every existing external PostgreSQL and key-value connection with TLS working as unverified instead of breaking it. Such a connection shows **Enabled, not verified** and a **TLS certificate is not verified** notice with **Add CA certificate** and **Test and enable verification**; Opfield tests the connection with verification before it saves the change, so a certificate that does not verify leaves the connection as it was. Review these connections after the upgrade. ClickHouse connections already verified their certificate, and managed databases are verified against Opfield's Database CA. Backups of a verified external connection run only on a Storage node whose Docker daemon supports verification (2.11 or later); Opfield refuses to send the run to an older daemon rather than let it skip the check.

AI Workspace and the remote MCP Databases toolset can read the managed catalog, provision/retry/delete instances, and create or remove standalone-container, deployment, or Compose-service bindings under the same license and database/Docker scopes as the Operations Console. The Operations Console also exposes per-binding link runtime telemetry on the overview of linked standalone containers, deployments, and Compose projects, including active streams, throughput, setup latency, completion health, and admission rejects; the runtime of an Availability link is the sum of its placements. Managed storage links of standalone containers and deployments show the same section.

Managed instances are private by default. Opfield binds applications through the shared secure-link connector of their Docker node and an authenticated tunnel, with a separate engine identity per binding. Publishing TCP for external infrastructure is an explicit opt-in; it requires database authentication, Opfield does not open host firewalls automatically, and the path is not tunnel-encrypted unless native database TLS is configured.

The managed-database tunnel terminates in a dedicated long-lived relay container on the existing Opfield `9443/tcp` endpoint. Ordinary application updates do not recreate this relay, so established binding sessions and new opens for already-ready bindings can continue while the app is restarting. Relay updates are explicit data-plane maintenance and may interrupt tunnel sessions.

The same logical tunnel can use a Relay Pool without exposing pool topology to the workload. Operators may enroll remote relay supervisors, rebalance assignments across distinct physical fault domains (Opfield also does it by itself once the pool is stable), drain instances, and roll signed relay updates one member at a time. A global fixed-count or all-ready-relays spread can be overridden per workload. Daemons balance each new connection across the pre-registered active set and exclude draining members without interrupting existing streams; Opfield remains the control plane and does not forward payload bytes.

TCP publication can be switched on or off and its host port changed after provisioning (`PATCH /api/databases/managed/{id}` with `publishTcp` and `publishedPort`). Docker cannot change the port bindings of a running container, so Opfield recreates the engine container on the same data: open connections drop for about a second and reconnect, and workload bindings keep working. Without `publishedPort` Docker picks a free host port, which can differ from the previous one; set `publishedPort` to keep a fixed endpoint.

Each binding creates a dedicated Postgres role, key-value ACL user, or ClickHouse user; deleting the binding revokes that principal. For normal containers Opfield attaches a private binding network and recreates the workload with the selected connection variables. For blue/green deployments it adds the private network and encrypted variables to the desired configuration, then rolls a slot so future blue and green containers receive the same connector endpoint. From 2.11.1 every Docker node serves its database, storage, and container links through one shared secure-link connector, each link on its own internal network from `docker.secure_links.subnet_pool` (default `10.213.0.0/16`, a /26 per link); see [Updating To 2.11.1](operations.md#updating-to-2111).

A managed database link may carry as many concurrent connections as its database accepts: PostgreSQL's `max_connections` (100 unless changed with Configure PostgreSQL on the database page), the key-value store's `maxclients`, or 4096 for ClickHouse. The capacity belongs to the link, not to a container: every container the link serves shares it, and during a blue/green rollout the old and the new slot share it until the old slot stops. Availability gives each placement its own link. All links of a database also share the database's own limit, so past it a client gets the engine's own refusal (PostgreSQL: `sorry, too many clients already`). A managed storage link has no fixed connection limit: like a proxy Secure Link, it is bounded by relay admission, which shares a loaded relay fairly between routes and gives way to database traffic first. Relays keep idle pooled connections of database and storage links open; they no longer close them after five idle minutes. The node that runs the workload holds a database link at its capacity whichever relay of the pool carries each connection, and every relay caps the link's route at the same value. A connection over the capacity is accepted and closed at once, so clients report errors such as `Connection terminated unexpectedly` or `ECONNRESET`; the node logs it as `managed link connection rejected` with `reason=link_limit` (once per minute per link, with the count since the previous line) in the node's logs. The link runtime (`get_binding_runtime` of `manage_managed_database` and `manage_managed_storage`, `GET /api/databases/managed/{id}/bindings/{bindingId}/runtime`, `GET /api/managed-storage/{id}/bindings/{bindingId}/runtime`) reports `activeStreams` as the link's open connections as that node counts them, `openedTotal` and the byte counters as what the link carried through that node whichever relays carried it, and `throttledTotal` as the connections refused at the capacity by the node or a relay (completions, failures, setup latency and duration come from the relays); `connections` adds the limit, the node's refusals and the reason of the latest refused connection (null while the node runs a Docker daemon older than this release).

On a managed PostgreSQL instance, the database and every application object in it belong to the instance's application role, and each binding role works as that role. The SQL console runs write and admin requests as the application role too, so a table created or seeded from the console is immediately usable by every binding. Read-only query access keeps its read-only principal. An admin who needs Opfield's control principal for an administrative statement, such as creating a role or an extension that requires a superuser, can start the request with `RESET ROLE`. Objects that request leaves in the application database are handed to the application role right after it, so application objects never stay owned by Opfield's own principals. Opfield also repairs this ownership whenever it creates or reconciles a binding, which fixes tables that were created from the console before this behavior existed. The repair changes objects only inside the application database. It skips system schemas and extension members, and it never changes the ownership of other databases or shared objects. ClickHouse and key-value stores need no such step: binding principals there reach the whole application database through grants or key patterns, not object ownership.

Managed lifecycle actions use durable operation IDs and reconciliation, so a temporary daemon disconnect leaves the instance in a transitional state until Opfield verifies the final daemon state rather than guessing success or failure.

PostgreSQL:

- Test saved connections.
- Track connection health and history.
- Browse schemas and tables.
- Browse rows.
- Insert, update, and delete rows when permitted.
- Run SQL through a scoped console.

Key-value stores:

- Test saved connections.
- Track health and history.
- Scan keys.
- Inspect values.
- Set, delete, and expire keys when permitted.
- Run Redis commands through a scoped console.

New managed key-value stores run Valkey 9.1.2 with the JSON, Bloom and Search modules. Stores created before 2.12 keep running Redis until you run **Move to Valkey** on the store's page (`POST /api/databases/managed/{id}/move-to-valkey`, MCP `manage_managed_database` `move_to_valkey`, scope `databases:edit`). It copies every key into Valkey on the same node and switches the store to it. Writes pause while the keys are copied; reads keep working. The Redis data stays on the node until the key counts match, and the store goes back to Redis if anything fails. A store with keys that cannot be copied (Bloom or cuckoo filters, time series, vector sets, search indexes) is refused before anything changes. Stream consumer groups move with their last delivered ID, but not their pending entries: when a store has any, the dialog says how many and the move needs an explicit confirmation (API and MCP: `acceptPendingStreamLoss: true`). The dialog first checks the store (`GET` on the same path, MCP `move_to_valkey_check`) and shows the key count and the expected write pause. The store must be running, and its node must run a Docker daemon that supports Valkey; Opfield asks you to update the daemon otherwise.

A key-value backup restores only into the engine it was taken from: a Redis backup into a store that runs Redis or into a new store, a Valkey backup into a store that runs Valkey or into a new store. See [Storage and backups](storage-and-backups.md).

ClickHouse:

- Test saved connections and track health history.
- Browse databases, tables, views, dictionaries, and rows.
- Run SQL through a scoped console.
- Insert, update, or delete rows only when the selected table engine, server version, and caller permissions allow the operation; schema mutations are not exposed through the explorer.

Credential reveal and query execution are intentionally separate permissions. Users can be allowed to monitor a database without being allowed to reveal credentials or run arbitrary commands. Binding-injected application credentials are not displayed by default.

## Storage

Opfield supports external storage connections and managed SeaweedFS object storage on Storage nodes. Managed storage runs on one server unless it is made available on several (see [Databases And Storage On Several Servers](#databases-and-storage-on-several-servers)) and is private by default; workload links use the shared secure-link connector of the workload's Docker node with bucket-scoped credentials, and a public S3 listener requires explicit publication. Existing managed MinIO clusters keep running as a legacy engine; new clusters use SeaweedFS.

Supported connection types:

- S3-compatible object storage.
- Cloudflare R2.
- MinIO and other S3-compatible servers you operate.
- FTP and FTPS.
- SFTP.

Managed database backups and restores use configured Storage resources. Opfield keeps credentials and link-injected secrets masked outside their dedicated reveal flows.

## Databases And Storage On Several Servers

On Business and Enterprise, a managed PostgreSQL database, key-value store, ClickHouse database or SeaweedFS storage can run on 2 to 5 Storage nodes, each on its own host. One server is the primary and takes all reads and writes; the others are copies that follow it. Links, bindings and Opfield's own tools always reach the primary. Copies serve only failover and backups, not reads.

Turn it on when you create the database or storage (**Availability** in the create form) or later from its page (**Make available**). The preflight shows what you get before anything changes: the mode, the voters and witnesses, the measured round trip between the servers, the durability and what a failover can lose. Turning it on for an existing resource restarts it once; it keeps its data and serves from its server while the copies are filled.

- **Automatic failover** needs a majority of voters on separate hosts: the data servers plus witnesses. A witness is a relay that an administrator allowed to host witnesses (**Settings > Relay**, the relay's switch in the **Witnesses** column, `PATCH /api/system/relay/instances/{id}`), or a Docker node on another host. A protected relay hosts witnesses only after its owner allowed database witnesses in the relay's local configuration. With two servers Opfield uses one or three witnesses, so one data server, or one data server and one witness, can fail.
- **Two servers without a witness host** make a replicated pair without automatic failover. Switch to the copy by hand with **Make this copy primary**. The primary stops taking writes when it can reach neither Opfield nor its copy for 30 seconds, so two primaries never take writes.
- **Failover works without Opfield.** The servers and relays decide who is primary among themselves, for as long as the relays' signed policy is valid (the relay policy lease, 72 hours by default; the preflight offers 7 days). Events that happened meanwhile reach Opfield when it is back and keep the time they happened, in the audit log and in alerts. Backups wait for Opfield, as they are scheduled by it.

What an unplanned failover can lose ("acknowledged" means the client got a success):

| Engine and state | What a failover can lose |
|---|---|
| PostgreSQL, synchronous, healthy | Nothing acknowledged. A commit whose client gave up waiting for it can be lost if the primary dies within about 5 seconds; Opfield records it. |
| PostgreSQL, synchronous, copy fallen behind | No automatic failover. A copy that stops confirming for 10 seconds is dropped from synchronous replication and writes go on; a manual switch then loses the writes since then, and Opfield shows the time and an estimate. |
| PostgreSQL, asynchronous | Up to the lag limit (1 MiB by default) plus about 1 second of writes. A copy further behind cannot take over. |
| Key-value store (asynchronous only) | Up to the lag limit (1 MiB by default, usually under 1 second). |
| SeaweedFS objects | Nothing while both copies are writable: each write is acknowledged after both servers stored it. While a server is down for more than 10 seconds, new objects are stored once until it returns, and are lost only if the remaining server's disk is lost. |
| SeaweedFS object and bucket metadata | Up to about 1 second of changes. |
| ClickHouse, near servers (quorum inserts) | Nothing acknowledged while healthy. |
| ClickHouse, far or degraded | Inserts the copy had not fetched yet; they come back when the old server returns with its disk. |

Durability is synchronous by default when the servers are near (round trip up to 10 ms) and asynchronous when they are far; change it on the page. Synchronous on far servers makes every commit wait for the round trip. Opfield measures the round trip every 10 minutes and alerts when a synchronous set became far, without changing it.

**Make this copy primary** is a planned switch without loss when the primary serves and the copy is up to date. When the primary is gone or the copy is behind, the switch can lose recent writes: it asks you to confirm the estimate first (API and MCP: `acceptDataLoss: true`). The old primary comes back as a copy.

While a resource runs on several servers, its usual actions cover every server. Changing settings or the version and restarting go one server at a time, copies first; when the primary needs a restart, it first hands over to an updated copy without loss, so the resource keeps serving. Pausing (also an app shutdown) stops the copies first and then the primary, which keeps its role, so nothing fails over; unpausing starts the primary first. Deleting turns availability off, then deletes the resource. Turning a database's TLS on or off is refused while availability is on. Backups read from an up-to-date copy when there is one, otherwise from the primary. Before a node's daemon updates, a primary on that node hands over to a healthy copy. Turning availability off keeps the primary as the single server and removes the copies.

Alerts: the database categories and the **Managed storage** category offer failover, switch, degraded, no automatic failover, restored, server not reporting, copy no longer synchronous, servers now far apart, witness lost or moved, and rejoin and rebuild events, and the metrics replication lag (bytes, seconds) and round trip. The page lists the same events, and the Dashboard shows a notice while a set cannot fail over, a replicated pair's primary does not report, a witness is lost, a set is degraded, or for a day after a failover.

After the license grace period, everything that runs keeps running: failover, fencing, copies rejoining, **Make this copy primary**, rebuilding a copy, removing a server, turning availability off and witness moves. Turning it on, adding a server and changing settings are refused until the license is renewed.

API: `/api/databases/managed/{id}/availability` and `/api/managed-storage/{id}/availability` (preflight, turn on, settings, members, make-primary, rebuild, events, turn off); scope: the resource's edit scope (`databases:edit`, `storage:edit`), view scope for reads. MCP: the availability operations of `manage_managed_database` and `manage_managed_storage`, and `set_witness_hosting` of `manage_relay_pool`.

## Planned Host Access And CLI

The general Opfield CLI for terminal and CI/CD control is **expected in 2.13** on every plan. It is distinct from the existing Opfield Inference client CLI. The Bastion / SSH management daemon for controlled host access is **expected in 2.14** on Business and Enterprise. These are roadmap estimates, not currently available capabilities.

The future [plugin system](plugins.md) is unfinished Opfield core infrastructure, not a plan-specific feature. Its tentative timing is no earlier than 2.20 and may change.

## Opfield Configuration Transfer

An Opfield installation can move to another host on every plan. **Settings > General > Configuration export** writes one encrypted file with the database (a consistent snapshot; nothing stops), the master key, every CA and relay signing key, Opfield's files and, when chosen, the internal registry images and managed logs. A fresh installation of the same version restores it in the setup wizard (**Restore from an export**) or with `install.sh --restore <file>`, keeps the installation ID and license, and asks for the new address. When the address changes, Opfield tells enrolled nodes and relays the new one before the old host is shut down. API `/api/system/configuration-export`, MCP `manage_configuration_export`, scope `admin:system`. See [Moving Opfield to another host](configuration-transfer.md). This is separate from container archive export/import and from database backups.

## Nodes And Monitoring

Opfield exposes six node enrollment roles. Several roles intentionally reuse the same daemon binary with a restricted profile rather than granting one process every host capability:

| Type | Daemon | Purpose |
|------|--------|---------|
| nginx | `nginx-daemon` | Public ingress, routes, TLS termination, access lists, nginx configuration, logs, and stats. |
| docker | `docker-daemon` | Docker container and deployment management. |
| builder | `docker-daemon` | Restricted Build Worker profile supervising dedicated BuildKit and containerd services without a Docker Engine socket. |
| storage | `docker-daemon` | Restricted profile for Opfield-managed Postgres, key-value store, and ClickHouse instances, SeaweedFS object storage, and backup jobs. Existing `databases` nodes are shown as Storage nodes. |
| monitoring | `monitoring-daemon` | Host metrics without nginx or Docker control. |
| relay | `relay-supervisor` | Enrolls a physical host into the Secure Link Relay Pool and supervises its Relay worker. |

Node features:

- Enroll nodes with one-time tokens.
- Communicate over outbound gRPC with mTLS.
- Reconnect automatically with exponential backoff.
- Show version compatibility state.
- Stream node logs.
- Open scoped host consoles and browse or edit node files when explicitly permitted.
- Collect CPU, memory, disk, and network metrics.
- Report capability-aware physical GPU inventory and telemetry. Container monitoring shows a selected GPU's shared physical metrics, never fabricated per-container usage.
- Report local/public IP addresses and allow an explicit Docker service address for cross-node and proxy-upstream traffic.
- Remotely update daemon binaries with SHA256 verification and atomic replacement.

Managed services keep running if the Opfield app is offline. You lose central control until the app returns, but nginx, Docker, and managed database services continue using the last applied host state. With a healthy relay and PostgreSQL, private managed-database bindings continue independently of an app-only restart. A relay admits new connections only while its last signed policy is valid, that is for the relay policy lease after Opfield last reached it (72 hours by default), and Availability policies in lease mode keep failing over without Opfield; see [Offline Behavior](nodes.md#offline-behavior).

## Hosting Providers

Hosting accounts at HOSTKEY, DigitalOcean, Hetzner Cloud, CloudBlast, and Proxmox VE (one connector per physical host) let Opfield create a server as a node in one step: it orders the VM, installs the daemon of the chosen role, and waits until the node is online. Afterwards Opfield starts, shuts down, reboots, resizes, recovers, and destroys the VM, and manages snapshots and, on DigitalOcean, CloudBlast, and Proxmox, the VM firewall. Existing VMs can be adopted or get a node installed. The provider account and its charges stay yours. API: `/api/integrations/hosting` and `/api/hosting`; MCP: `manage_hosting`; scopes `integrations:hosting:*` and `hosting:*`. See [Hosting integrations](hosting-integrations.md).

## Structured Logging

Opfield can ingest external service logs into ClickHouse on Business and Enterprise.

Logging features:

- UI-managed environments.
- Per-environment schemas.
- Retention settings.
- Write-only `opfl_` ingest tokens.
- Single-event and batch ingestion APIs.
- Severity validation.
- Payload, token, environment, and global rate limits.
- Partial batch acceptance.
- Search UI with filters and event detail inspection.
- Housekeeping caps by total rows and approximate on-disk size, in addition to per-environment TTL.
- Always-on ClickHouse health and internal-log budget guard with Dashboard warnings.
- Official TypeScript SDK published as [`@opfield/logger`](https://www.npmjs.com/package/@opfield/logger), with source in `packages/logging-sdk`.

Logging is optional. When structured logging is set to **Disabled** in Opfield settings, logging routes report that logging is disabled and the frontend hides the Logging section.

## Integrations, Notifications, And Status Pages

Opfield includes connectors, notifications, alerts, and status pages:

- Cloudflare connectors for managed A/AAAA records, DNS inspection, and automated DNS-01 certificate workflows.
- GitLab connectors with project/group allowlists, scheduled project synchronization, repository and CI operations, variables, webhooks, sandbox clone support, and automatic container-registry discovery and import. GitLab integration requires Personal or higher; GitHub, generic Git, external SSH, and Cloudflare connectors are available on Community.
- GitHub connectors for repository discovery, tree/file operations, branches, commits, Actions workflows and secrets, using the built-in Device Flow or an explicitly configured token.
- Generic Git connectors for authenticated repository access outside the first-class GitLab and GitHub providers.
- External SSH connectors with encrypted credentials, host-key verification, explicit scopes, and controlled command/file operations against administrator-configured hosts. This is an external integration, not an Opfield-managed node role.
- Webhook notification targets with custom headers, templates, HMAC signing, retries, and delivery history.
- Enterprise SIEM audit export, when enabled in Opfield settings, to up to five active HTTPS collectors, with encrypted bearer, HMAC-SHA256, or validated custom-header authentication, durable batched delivery, retry history, and least-privilege `audit:siem:*` scopes.
- Threshold and event alert rules for nodes, containers, Git builds, Compose Projects, routes, Pages, Opfield itself (host CPU, memory and disk, backend memory and event-loop delay, API 5xx rate and latency, PostgreSQL and Redis latency and outages, stack containers, failing background jobs) and relay health, logging, integrations, certificates, security events, PostgreSQL, ClickHouse, and key-value stores. GPU node rules evaluate only metrics reported by each physical device and can target a selected GPU on one scoped node.
- Public status pages on Personal and higher with managed services, incidents, incident updates, proxy templates, and preview. The Nginx node keeps serving the last published page from its cache while Opfield restarts, updates, or is unreachable.

Connector credentials are encrypted at rest. GitLab access is split between connector administration and per-user credentials unless the caller has the explicit system credential scope. Git integration scopes can be limited to a connector, a GitLab group or project, or a GitHub owner or repository; see the Git Integration Restrictions section of [SCOPES.md](../SCOPES.md).

## Apps

An app groups the resources of one application into environments (production, staging, ...): containers, deployments, Compose projects, routes, domains, databases, storage, Pages, SSL certificates, and logging environments, with allowed nodes, a domain allowlist, shared variables and secrets, maintenance, shutdown, a kill switch, and promotion by image digest. Every plan. API `/api/apps`, MCP `apps` toolset, scopes `apps:*`. See [Apps](apps.md).

## Application Scaling

Opfield Availability (HA) is available and provides fixed-count multi-node placement for eligible mount-free Containers, Deployments, and whole Compose Projects on Business and Enterprise. Replicated mode maintains 2–32 serving placements; Failover maintains one serving placement and replaces it on another node. It deliberately does not create an application cluster or shared node network, and does not provide HA for Opfield itself, registry storage, or shared volumes. Nginx ingress is made redundant separately with [ingress groups](#ingress-groups).

An Availability operation that an Opfield restart or update interrupts, such as a rollout, is left resumable instead of failed and rolled back: it resumes once Opfield is back, with the image and settings that were requested.

Priority mode orders the eligible nodes: serving placements go to the first available nodes of the order, and once a higher-priority node has stayed healthy for the failback delay (`failbackDelaySeconds`, 300 seconds by default, 0 to 3600) Opfield moves the workload back to it with a `failback` operation.

Opfield watches every serving copy. Its Docker state always counts: a missing, stopped or paused container, a restart loop, or a failing Docker `HEALTHCHECK`. When the workload has an HTTP health check, that is the health check of a Route that serves it or a blue/green deployment's own health check, the copy's Docker node also runs that check against the copy at the check's interval; a deployment's startup grace and success threshold apply. A copy that fails it twice in a row is taken out of its routes only while the policy keeps serving without it: in Replicated mode while another copy serves and passes its check, in Failover mode in lease mode when a prepared standby can take over. Otherwise the copy keeps serving and the policy shows `degraded` with the reason (`AVAILABILITY_PLACEMENT_HTTP_UNHEALTHY`). In lease mode the copy's slot is then released: a standby takes over, or the copy is restarted on its node. Outside lease mode Opfield starts a replacement on a free node, and a Failover copy keeps its routes until the replacement serves. A copy that was taken out returns to its routes once its check passes twice in a row (or as often as the deployment's success threshold asks). HTTP health checks need the Docker daemon from this release and a running Opfield: while Opfield is down, and for workloads without an HTTP health check, only the Docker state counts. A copy the data plane stops for its Docker state is started again after about 20 seconds; while it keeps failing within 5 minutes of its start, the wait doubles up to 5 minutes.

The following scaling capabilities remain **In development**:

- **Metric autoscaling:** change the placement count from CPU, memory, queue, or traffic metrics.
- **Vertical workload scaling:** run multiple managed instances of one workload on the same managed machine.

### Data-Plane Failover (Lease Mode)

Without lease mode, Opfield itself drives failover: after it loses a node's control connection and the offline grace passes (`offlineReplacementGraceSeconds`, 15 seconds by default), it starts a prepared standby or creates a replacement elsewhere. That needs a running Opfield. In 2.11 a policy instead runs in lease mode, where the nodes and relays decide failover themselves and keep doing so while Opfield is down.

- **How a policy enters it.** A policy switches to lease mode by itself; there is no setting to turn it on or off. Every candidate Docker node, every Nginx node of the workload's routes, every relay that carries it, and its witness must advertise `availability_lease_v2` (the 2.11 daemons and relays), each candidate Docker node needs a running [lease watchdog](nodes.md#lease-watchdog) and a reported lease identity, and enough members that can vote must exist for a quorum. All of these must have held for 2 minutes without a restart, so a fleet in the middle of an update never switches. Until then the policy's lease reason is `participants_settling` and names the nodes and relays still settling. Lease mode never interrupts the serving copy when it starts.
- **Who decides.** Nodes and relays hold a lease per serving slot. The holder renews it every 5 seconds. In the default `strict` partition mode, a holder whose renewals have not reached a majority of the policy's voters for 15 seconds stops its own copy (the copy is dead within 24 seconds) and releases the slot. While a majority of the voters is reachable, the next candidate commits the lease within 45 seconds of the holder's loss and starts its copy, whether or not Opfield is up. Standbys are created ahead of time with the image pulled but not started.
- **Voters.** Each policy votes with its candidate nodes, one per physical host, plus witnesses so the count is odd and at least 3 (at most 7). A witness is a relay or a Docker node on another host; set one with `witness` or let Opfield choose one. The automatic witness is never Opfield's local relay while a remote relay can witness, because the local relay stops with the Opfield host. The policy shows a voter margin: how many more voters may fail before a quorum is lost, counting only voters that can vote without Opfield.
- **Partition modes.** `partitionMode: strict`, the default, never runs two copies of a slot, even during a network split, and a cut-off holder stops its copy as above. `available` never stops a holder on a timer: it keeps serving on both sides of a split and may run two copies at once until the split heals; do not use it for singletons such as queue consumers, indexers, or scheduled jobs.
- **Planned moves.** A failback, drain, or manual move in lease mode is a handoff: the serving node stops its copy and releases the lease before the next node starts its own. A `strict` policy in Failover mode, which has one slot, does not serve during that handoff; in Replicated mode the other replicas keep serving.
- **Excluded nodes.** A problem on one node never changes the policy's mode. A candidate that is `offline`, has no running lease watchdog (`watchdog_missing`), runs a daemon without `availability_lease_v2` (`daemon_outdated`), or has not reported a lease identity yet (`identity_pending`) is listed under **Excluded nodes** (`lease.excludedNodes` in the API) with that reason: it gets no new standby and takes no slot, and the next candidate takes its place. Fix the node (start the watchdog or re-run the node installer, or update the daemon) and it takes part again. A node that loses its watchdog also stops the copy it serves: its daemon stops renewing the lease and stops the copy within about 10 seconds, and the next candidate takes the slot. When every candidate has lost its watchdog, no node can hold the slot and the workload does not run: as soon as no slot is held any more, which takes about 20 seconds after the copies stopped, the policy leaves lease mode without the usual 2-minute wait, and once the voters confirmed the close, which takes about 15 seconds more, Opfield starts a copy on a candidate itself. Expect about a minute without a serving copy; start the watchdogs again and the policy returns to lease mode.
- **Leaving lease mode.** Only when lease mode becomes impossible for the policy, for example too few voters, an Nginx node or relay of the workload without `availability_lease_v2`, or no candidate that can hold a slot, and only after that has lasted 2 minutes without a break; an explicit disable, stop, start, or restart leaves it at once, and so does losing the watchdog on every candidate once no slot is held (see Excluded nodes). A license change never does. Leaving lease mode by itself never stops the serving copy: Opfield closes the lease, the holder keeps its copy running once a majority of the voters confirmed the close, and Opfield drives failover again.
- **Audit.** An autonomous takeover is recorded as `docker.availability.lease_failover`, a planned move as `docker.availability.lease_handoff`, and a slot that lapsed and was taken again by the same node as `docker.availability.lease_reacquired`, dated when the holder acquired the slot, also when that happened while Opfield was down.

Lease frames between nodes travel only through relays. Every Docker node of a lease-mode policy keeps a connection to every lease-capable relay of the Relay Pool, and the workload's member Secure Links are registered on each of those relays, so the policy's Docker nodes and the Nginx nodes of its routes must all reach every relay (see [Firewall Requirements](nodes.md#firewall-requirements)). Opfield's local relay stops with the Opfield host: to keep failover working when that host is lost, run at least one remote relay on another host.

## Vulnerability And Security Scanning

Git build vulnerability scanning and admission policy are available on Business and Enterprise. Broader workload vulnerability and security scanning remains **In development**, with no target version assigned yet.

## Opfield Inference

Opfield Inference is an optional model gateway available in every product plan. It is separate from AI Workspace and the remote MCP server.

Inference features:

- Connect multiple API-key, local, device-code, and supported subscription providers.
- Publish logical models with access rules, reasoning mappings, pricing, context limits, and one or more capability-compatible account or cross-provider fallback sources.
- Order published models and reasoning levels for data-plane catalogs, Codex manifests, and AI Workspace selectors.
- Route requests across healthy compatible sources while keeping active-turn continuation and affinity. Opfield may rebalance an idle affinity toward materially better quota/load capacity and retries another compatible source only before client output begins.
- Group multiple accounts of the same provider in the administration table and reorder them within that provider for Sequential routing.
- Enforce default and per-user five-hour, weekly, monthly, and API-spend budgets.
- Show each user a 30-day usage overview and let administrators reset one user's usage baselines without deleting immutable accounting history.
- Expose a base OpenAI-compatible API plus optional Codex- and Anthropic-specific adapters.
- Issue dedicated `opfi_` runtime tokens that are accepted only by inference data-plane routes.
- Connect any harness natively (DeepSeek harness recommended) from **Set Up an Inference Harness**: OpenAI- and Anthropic-compatible base URLs, a key created for the user and shown once, and the user's models.

Inference is disabled by default. See the [inference guide](inference.md) for provider, model, limit, token, and client setup.

## Programmatic Access

Opfield has four token families:

| Prefix | Purpose |
|--------|---------|
| `opf_` | Opfield REST API tokens. |
| `opfo_` | OAuth access tokens for Opfield API or Opfield MCP resources. |
| `opfl_` | Write-only logging ingest tokens. |
| `opfi_` | Dedicated Opfield Inference runtime tokens. |

OAuth uses public-client Authorization Code + PKCE and resource-bound access tokens:

- Opfield API resource: `https://<opfield>/api`
- Opfield MCP resource: `https://<opfield>/api/mcp`

REST API routes accept browser sessions, `opf_` API tokens, and `opfo_` OAuth tokens issued for the Opfield API resource. The MCP endpoint accepts only `opfo_` OAuth tokens issued for the Opfield MCP resource. Inference data-plane routes accept only `opfi_` tokens and never accept REST, OAuth, logging, or browser credentials.

API tokens and MCP agents can perform every resource and management operation their delegated scopes allow, including node enrollment and config, user and group administration, Opfield settings, integrations, hosting, inference administration, and personal inference keys. Only AI Workspace chat and sandbox access, impersonation, OAuth consent, API token and OAuth authorization minting, and the caller's own sign-in, MFA, and session management remain browser-only.

Callers can see what they can reach with `GET /api/auth/me/access`, and MCP agents with the always-listed `get_my_access` tool and the `opfield://access` resource. Create operations marked in the API reference accept an `Idempotency-Key` header, and MCP create tools an `idempotencyKey` argument, so a retry after a timeout does not create a second resource (see [Access Summary, Skills, And Idempotent Retries](operations.md#access-summary-skills-and-idempotent-retries)).

Opfield MCP exposes permission-filtered operator documentation through `read_opfield_documentation` and the `opfield://docs` resource tree. It also serves the agent skills of the installed release as `opfield://skills` resources and `skill-<name>` prompts. General topics are readable by any valid MCP authorization; subsystem topics require the corresponding delegated OAuth scope. Extended compatibility lists every granted tool by default, while discovery mode can be enabled for clients that correctly refresh `tools/list` after `notifications/tools/list_changed`.

For scope rules and delegation details, see [SCOPES.md](../SCOPES.md).

## Administration

Administration features:

- OIDC, local password, and email one-time-code authentication; users can add passkeys after setup.
- Built-in and custom permission groups.
- Per-user additional scope grants, bounded by the permissions of the administrator assigning them.
- Groups, user permissions, API tokens, and OAuth consent show access as lines: a role (Viewer, Deployer, Developer, Operator) everywhere, in a project folder, or on specific resources, and a Git level on repositories. Lines save ordinary scopes; the raw scope picker stays one click away (see [SCOPES.md](../SCOPES.md#access-lines)).
- Granular scopes for users, groups, API tokens, OAuth grants, and MCP access.
- Write-capable scopes imply matching read/view checks while preserving resource boundaries.
- Audit log for user, token, OAuth, and AI-initiated actions.
- SIEM destination management and privacy-reduced external audit export.
- Setup state and first-run configuration.
- Update checks and in-app Opfield updates.
- Daemon runtime version tracking and daemon updates.
- License state and edition display.

## AI Workspace

AI Workspace is the recommended intent-driven operating surface. It is opt-in and disabled by default, while the Operations Console remains a complete independent interface.

When enabled by an admin, it can:

- Start from guided operational Scenarios or a free-form desired outcome.
- Use complete task Scenarios for setup, infrastructure health, nodes, Docker, proxy publication and diagnosis, TLS, logging, notifications, databases, status pages, and access delegation.
- Enter Plan Mode manually or automatically for complex, multi-step, research-heavy, or materially risky work.
- Research with read-only planning tools, validate a structured Plan Block, and wait for explicit confirmation before any mutating action is available.
- Execute a confirmed plan in the background with step progress, pause, resume, cancel, and a separate final-verification run.
- Use a configured OpenAI-compatible provider or an accessible published Opfield Inference model.
- Call Opfield tools through permission-gated operations.
- Ask clarifying questions before acting.
- Continue backend-owned chat runs independently of an open browser panel.
- Use backend approval and question flows over WebSocket for active chat turns.
- Use a system-specific knowledge base.
- Save and restore conversations.
- Pin the selected model and reasoning effort to each conversation and warn before changing the model mid-chat.
- Attach and preview supported images and generated artifacts.
- Surface Opfield Inference quota warnings and stop new turns only when the applicable budget is exhausted.
- Respect per-user tool access and AI approval mode preferences.
- Move between AI Workspace and the Operations Console without changing the underlying resource model or permissions.

One plan can be active in each Work Session, while separate Work Sessions can run plans independently. Planning is separate from Approval Mode: planning itself is read-only, and confirmed execution follows the user's current approval settings. Scenarios do not bypass permissions, approvals, or audit logging.

OpenAI-compatible settings remain preserved while Opfield Inference is selected. If Inference is later disabled, AI Workspace returns to the previous OpenAI-compatible configuration or disables itself when none was configured. No data is sent to an AI provider until an administrator enables AI Workspace and configures a provider.
