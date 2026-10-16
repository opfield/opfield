import { PERMISSIONS_DOC } from './ai.docs.permissions.js';

export const FOUNDATION_DOCS: Record<string, string> = {
  discovery: `# Resource Discovery

Opfield AI starts conversations with a small base tool surface. Domain-specific tools are discovered by category and then remembered on the backend conversation.

## Base Tools
- discover_tools: inspect callable tool categories and category-specific tools.
- read_skill and activate_skill: inspect or load one system or enabled organization skill listed in the assistant's compact prompt catalog. These are AI Workspace-only and are not MCP tools. Do not reactivate a skill while its earlier activation remains in the current context; activate it again after compaction only when it is still relevant.
- get_current_context: read the current UI route/resource when the user says "this page" or "current item".
- wait: pause briefly when an operation is pending, then continue by re-checking status.
- find_resource: globally search readable resources by name, ID, domain, image, etc.
- internal_documentation: read workflow and argument docs before complex operations in AI Workspace. Remote MCP clients use read_opfield_documentation or the opfield://docs resource tree with the same subsystem scope filtering.
- ask_question: ask concise clarifying questions.
- fetch: read a direct HTTP/HTTPS URL through Opfield when sandbox runner is enabled and the user has sandbox access.
- web_search: available only when enabled by settings.

## Tool Discovery
- If the needed operation is not available, call discover_tools first.
- Use internal_documentation before Opfield-specific workflows, tool argument details, permission-sensitive operations, and recently added capabilities. Do not answer those from general intuition.
- Use discover_tools({ categories: ["Logging"], includeTools: true }) before managing logging environments/schemas/logs.
- Use discover_tools({ categories: ["Docker"], includeTools: true }) before managing Docker containers/images/volumes/networks or inspecting Compose projects.
- Use discover_tools({ categories: ["Ingress"], includeTools: true }) before managing domains, routes, route folders, nginx templates, or access lists.
- Use discover_tools({ categories: ["Inference"], includeTools: true }) before configuring inference providers, models, limits, or tokens.
- Use discover_tools({ categories: ["Hosting"], includeTools: true }) before creating a VM at a cloud provider or on a Proxmox host, or managing hosted VMs (manage_hosting; read internal_documentation({ topic: "hosting" }) first). MCP clients activate the hosting toolset.
- Use discover_tools({ query: "certificate" }) when you know the task but not the category.
- After discovery, use internal_documentation for workflow details and argument shapes.

Use find_resource whenever the user gives a name, domain, hostname, image, container name, certificate name, logging environment/schema name, database name, or other visible identifier and you need the actual ID or nodeId.
Use find_resource with an empty query and a concrete type when the user asks to list resources by type, for example Docker containers or Page Projects.

## Rule
- A request to create, order, or provision a server or VM (at HOSTKEY, DigitalOcean, Hetzner, CloudBlast, or on a Proxmox host) is the hosting workflow (topic hosting), not create_node: create_node only registers a server that already exists.
- Use get_current_context when the user refers to the page or resource they are currently viewing.
- Use wait for short pending states such as container startup, image pull completion, DNS/SSL validation, deployments, daemon reloads, or log ingestion. After wait, call the relevant read/status tool again; do not finish the conversation just because the operation is not complete yet.
- Prefer find_resource before broad list sweeps.
- For a direct URL, use fetch. Use web_search only when you need search results rather than the exact URL content.
- Do not list every node and then inspect every node for Docker resources unless find_resource failed, the user explicitly asked for per-node enumeration, or you need a complete inventory.
- If the result includes nodeId, pass that nodeId to Docker tools.
- If exactly one result is valid/applicable for the operation, use it without asking. For Docker image/container operations, ignore non-Docker nodes as choices.
- If multiple applicable results match, use ask_question to disambiguate.

## Examples
- Find a container named api: find_resource({ query: "api", types: ["docker_container"] })
- List Docker containers: find_resource({ query: "", types: ["docker_container"], limit: 50 })
- List Docker nodes: find_resource({ query: "", types: ["node"], limit: 50 })
- Find an ingress route by domain: find_resource({ query: "example.com", types: ["proxy_host"] })
- Find a logging schema: find_resource({ query: "nginx", types: ["logging_schema"] })
- Search all readable resources: find_resource({ query: "production" })`,

  pki: `# PKI (Public Key Infrastructure)

## Certificate Authorities (CAs)
- **Root CA**: Self-signed, top of the trust chain. Created with create_root_ca. Set pathLengthConstraint to limit CA chain depth (0 = can only issue end-entity certs, 1 = can create one level of intermediate CAs).
- **Intermediate CA**: Signed by a parent CA. Created with create_intermediate_ca(parentCaId, ...). Recommended for issuing end-entity certificates.
- Key algorithms: rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384.
- CAs can be revoked (permanent) or deleted (only if no certs issued).
- manage_ca: update (CRL distribution URL, CA issuers URL, max issued validity; pki:ca:edit), revoke (the CA and its subordinate CAs), export_key (passphrase-protected PKCS#12 of the CA key, audited; pki:ca:export).
- Each CA has: commonName, keyAlgorithm, validityYears, maxValidityDays (max validity for certs it issues).

## PKI Certificates
- Issued by a CA using issue_certificate.
- Types: tls-server (web/SSL), tls-client (client auth), code-signing, email (S/MIME).
- Fields: caId, commonName, keyAlgorithm, validityDays, type, sans (Subject Alternative Names).
- SANs: array of PLAIN strings — just the value, NO type prefix. Examples: "example.com", "*.example.com", "10.0.0.1", "user@example.com". The system auto-detects the type (dns/ip/email/url). NEVER use "DNS:", "IP:", or other prefixes — they will cause errors.
- Certificates can be revoked with an RFC 5280 reason: unspecified (default), keyCompromise, caCompromise, affiliationChanged, superseded, cessationOfOperation, or certificateHold.
- Private keys are generated server-side and encrypted at rest.

## System PKI Audit
- System CAs and their leaves are hidden from ordinary PKI tools.
- Use \`audit_system_pki_leaves\` only when the user explicitly asks to inspect Opfield system PKI. It requires both PKI view permission and \`admin:details:certificates\`.
- The report is read-only: \`current\` and \`retired\` reflect persisted lifecycle ownership; \`unknown\` means ownership cannot be proven and must never be mutated automatically.
- Never use generic revoke/delete operations for system certificates or CAs: server policy rejects them. This tool cannot revoke, delete, issue, export keys, or clean up certificates.

## PKI → SSL Workflow
PKI certificates live in a separate store from SSL certificates. To use a PKI cert with an ingress route:
1. issue_certificate → returns { certificate, message }
2. link_internal_cert(internalCertId: certificate.id) → creates an SSL certificate entry
3. Use the SSL certificate ID (from step 2) when creating/updating routes through the route tools.
NEVER use a PKI certificate ID directly as sslCertificateId on a route.`,

  ssl: `# SSL Certificates

SSL certificates in Opfield enable HTTPS on ingress routes. Three types exist:

## Types
1. **ACME** (Let's Encrypt): Automated free certificates via request_acme_cert. Requires domain verification. Auto-renewable.
2. **Upload**: Manually uploaded PEM certificate + private key via manage_ssl_certificate({ operation: "upload", ... }). No auto-renewal — must be re-uploaded before expiry.
3. **Internal**: Linked from PKI store via link_internal_cert(internalCertId); needs ssl:cert:issue on the destination and pki:cert:deploy (or pki:cert:export) on the PKI certificate or its CA. Uses the PKI cert's key material, which only nginx receives. When Opfield holds the key, it reissues the leaf from the same CA and template daily once two thirds of its lifetime have passed (unless the CA ends too soon for a longer replacement, or the certificate lives less than 3 days), and pushes it to every route (auto-renew shows as "Reissue"; toggle with manage_ssl_certificate set_auto_renew). manage_ssl_certificate({ operation: "renew" }) reissues it now and needs pki:cert:issue on the CA. CSR-issued links (no key in Opfield) only alert: issue a new certificate and re-link it.

## ACME Certificates (Let's Encrypt)
- request_acme_cert({ domains: ["example.com", "www.example.com"], challengeType: "http-01" })
- **http-01**: Opfield deploys each challenge to the Nginx ingress assigned to that registered domain. The assigned node must be online and publicly reachable on port 80.
- **dns-01 with Cloudflare**: For wildcard certs or when port 80 is blocked and a matching Cloudflare connector/zone is configured. Use request_acme_cert({ domains, challengeType: "dns-01", dnsProvider: "cloudflare" }). Opfield creates the TXT records, waits for propagation, verifies the ACME order, cleans up created TXT records, and returns the issued certificate.
- **manual dns-01**: If no Cloudflare connector/zone is available, omit dnsProvider. The tool returns { domain, recordName, recordValue }; user must create a DNS TXT record manually, then confirm with manage_ssl_certificate({ operation: "verify_dns", sslCertificateId }).
- Auto-renew: checked daily at 3 AM. Renews certificates 30 days before expiry.
- DNS-01 auto-renew requires Cloudflare. Enable or disable it with manage_ssl_certificate({ operation: "set_auto_renew", sslCertificateId, enabled: true, provider: "cloudflare" }) or enabled: false.
- Staging mode available for testing (certs not browser-trusted).

## Uploading Custom Certificates
- manage_ssl_certificate({ operation: "upload", certificatePem, privateKeyPem, chainPem? })
- Chain PEM is optional (intermediate CA chain).
- Expiry is parsed from the certificate — no auto-renewal.

## Using PKI Certificates as SSL
To use a PKI-issued certificate with an ingress route:
1. Issue a PKI certificate: issue_certificate(...) → returns cert with id
2. Link it: link_internal_cert(internalCertId: cert.id) → creates an SSL certificate entry with a separate ID
3. Use the SSL certificate ID (from step 2) as sslCertificateId on the route
IMPORTANT: Never use a PKI certificate ID directly as sslCertificateId — you must link it first.

## Using SSL Certs with Routes
- Set sslCertificateId on the route to the SSL certificate UUID.
- Set sslEnabled: true to enable HTTPS.
- sslForced: true redirects all HTTP traffic to HTTPS (301 redirect).
- http2Support: true enables HTTP/2 (recommended with SSL).

## Certificate Deployment
When an enabled TLS route uses an SSL certificate, Opfield:
1. Keeps the canonical encrypted certificate material in the Opfield control plane
2. Deploys a node-local replica only to the route's nginx ingress node (every member for a route on an ingress group)
3. Applies the certificate and route config atomically, tests the config (nginx -t), and reloads nginx
4. Tracks per-node deployment state and removes unused replicas after the cleanup grace period

Certificate issuance itself is not tied to a machine. HTTP-01 validation is served by the registered domain's assigned ingress node (every online member of an ingress group); DNS-01 validation does not require HTTP ingress, and names on a Cloudflare-managed ingress group domain use it automatically.`,

  proxy: `# Ingress Routes

The UI and AI/MCP tools call these resources Routes. Use list_routes, get_route, create_route, update_route, set_route_maintenance, and delete_route. manage_route reads and checks one Route: get_config (full settings), get_by_slug, health_history, secure_link_status, access_logs (newest nginx access and error lines), maintenance_access_code (needs proxy:maintenance:bypass), and validate_config (an advanced snippet or, with mode raw, a raw config, before saving it). Existing REST paths, internal resource types, and persisted identifiers retain the proxy-host name for compatibility.

## Types
- **proxy**: Forward requests to a backend server (forwardHost:forwardPort).
- **redirect**: Redirect to a URL (redirectUrl, redirectStatusCode: 301/302).
- **404**: Return 404 for all requests (used to block domains).

## Key Fields
- nodeId: the nginx ingress node this route is deployed on. Optional when creating: see Choosing the Ingress Node.
- ingressGroupId: serve the route from every member of an ingress group instead of one node (topic ingress-groups).
- domainNames: array of domains this route serves. Registered Opfield domains among them must all be assigned to the route's nginx node.
- forwardHost/forwardPort/forwardScheme: backend server details (for proxy type).
- upstreamKind: manual, docker_container, docker_deployment, or pages. Docker upstreams store a standalone container name, a Compose project/service identity, or a deployment ID plus a TCP application port; Pages stores a Page Project and mutable Tag target.
- sslEnabled: enable HTTPS. Requires sslCertificateId (SSL cert UUID, NOT PKI cert UUID).
- sslForced: redirect HTTP to HTTPS.
- http2Support: enable HTTP/2.
- websocketSupport: enable WebSocket proxying.
- accessListId: attach an access list for IP/auth restrictions.
- clientIpSource / clientIpOptions: where the client IP comes from (see Client IP Source).
- healthCheckEnabled: monitor backend availability.
- advancedConfig: raw nginx config snippet (advanced users only).
- rawConfigEnabled: bypass template rendering and use rawConfig directly.
- rawConfig: custom nginx configuration content (used when rawConfigEnabled is true).
- enabled: toggle the route on/off without deleting.
- folderId: organize into folders.
- nginxTemplateId: use a custom nginx template.

Ordinary list_routes and get_route responses omit rawConfig and rawConfigEnabled. Raw content is only available through explicit route raw-config tools with raw-read permission.

## Choosing the Ingress Node
- A registered Opfield domain pins its ingress node. Omit nodeId on create_route and the route uses the node its registered domains are assigned to; registered domains on different nodes cannot share one route.
- With no registered domain, an omitted nodeId resolves to the only nginx node the caller may create routes on. When several qualify, create_route fails with ROUTE_INGRESS_NODE_REQUIRED and lists them (id, name, hostname, status); retry with one of them as nodeId.
- A registered domain on an ingress group places the route on that group.
- list_route_ingress_nodes (REST: GET /api/proxy-hosts/ingress-nodes) lists those nodes, and in groups the ingress groups the caller may view (ingress:groups:view) whose members are all such nodes, up front. It needs any proxy:create grant and no node permission, and returns only id, displayName, hostname, and availability status. Pass folderId to see the nodes allowed for a route in that folder. Nodes locked for new services are omitted.
- The node still has to be allowed: proxy:create broadly, on the route folder (pass folderId), or on the node (proxy:create:node/<nodeId>). Folder grants may place routes on every nginx node; folders do not pin nodes.

## Maintenance Mode
- Maintenance mode is available for enabled managed routes that are not using raw config. It keeps the configured HTTP/HTTPS vhosts but returns HTTP 503 and pauses managed health checks until maintenance ends.
- Maintenance state is audited and can feed notification rules and status pages.
- Use \`set_route_maintenance({ routeId, enabled })\`. Do not emulate maintenance by disabling the route or rewriting its config.

## Docker Upstreams
- The UI, REST API, AI Workspace, and remote MCP Ingress toolset can bind a route to a standalone Docker container, a Compose service, or a blue/green deployment. Compose targets persist project/service identity and automatically re-resolve the current container after Compose recreates it.
- For a standalone \`docker_container\`, pass \`dockerNodeId\`, \`dockerContainerName\`, and \`dockerContainerPort\`. For a Compose service, still use \`upstreamKind: "docker_container"\`, but pass \`dockerNodeId\`, \`dockerComposeProjectId\`, \`dockerComposeServiceName\`, and \`dockerContainerPort\` without \`dockerContainerName\`. For \`docker_deployment\`, pass \`dockerNodeId\`, \`dockerDeploymentId\`, and \`dockerContainerPort\`. The caller must hold the matching container, Compose-project, or deployment view scope enforced by the REST API. Container lists report \`listeningPorts\` (TCP ports the running container actually listens on, detected by the node) next to the declared \`ports\`; when an image declares no port, take \`dockerContainerPort\` from \`listeningPorts\`.

## Pages Upstreams
- Use \`upstreamKind: "pages"\` with \`pageProjectId\` and \`pageTagId\`. Routes target a mutable ready Tag, never an immutable Deployment.
- Pages route creation and retargeting require the Pages feature and profile plus view access to the selected Project.

## Additional Routes And Secure Links
- Use \`manage_additional_route\` for managed literal path-prefix locations inside a Route. Pass the parent \`routeId\`; use \`additionalRouteId\` for get/update/retry/delete. Targets may be manual, standalone Docker containers, Compose services, Docker deployments, or a ready Pages Tag. Compose targets use \`dockerComposeProjectId\` plus \`dockerComposeServiceName\` and are re-resolved after container recreation. Docker targets automatically create a route-owned Secure Link binding; edit or delete that binding through the Additional Route.
- Custom proxy templates support Additional Routes when the template includes \`{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}\` inside the intended \`server\` block.
- Use \`manage_additional_secure_link\` for independent bindings referenced by a Route advanced nginx configuration and pass the parent \`routeId\`. Docker bindings use \`upstreamKind: "docker_container"\` or \`"docker_deployment"\`; a managed S3 destination uses \`upstreamKind: "managed_storage"\` plus the stable \`managedStorageId\`. The managed-storage destination reaches S3 through the private relay and does not use a shared Docker network, a published storage port, or the cluster root key. The main Route upstream picker is a separate contract and does not select this destination.
- Do not confuse ingress Route Secure Links with private database or storage workload links. Ingress Secure Links connect nginx Route traffic to a selected destination and are managed through the Route/Additional Secure Link tools. Database and managed-storage links provision private workload connectivity and scoped injected credentials; managed-storage link creation/deletion requires \`storage:bind\` (included in \`storage:iam\`) plus the target workload scopes, and database links \`databases:bind\` (included in \`databases:edit\`). Its list also reports route-owned bindings for visibility, but those cannot be deleted independently.
- A database or storage workload link is saved into the workload whatever it is doing and never waits for it to become healthy. A ready link reports \`observedState\` \`target_applied\` while the workload has not run it yet (never started, stopped, its rollout pending or failed) and \`active\` once its runtime carries it. A Git-source container that its first build has not created yet is linked by its name (permissions are checked on its reserved identity) and its first build starts it with the link. A Compose service can be linked before the project's first revision, or while a build rollout or another operation holds the project, by a service name the next revision defines (the Git source lists the services of its Compose file as \`composeServiceNames\`); when that revision lacks the service the link fails with that reason. Deployment rollback, a switch to an older slot, and applying an older Compose revision keep the current links, and applying any revision leaves out links deleted since it was built. Link rollouts keep the workload's image and mounts, so they need no \`docker:containers:mounts\` even with host bind mounts. In a Compose service each linked value is the Compose variable \`\${OPFIELD_DB_<link>_<value>}\` under the variable name the link chose, backed by a managed project secret of that name; links created before 2.12.1 keep \`GATEWAY_DB_<link>_<value>\`. Keep these references when editing the Compose file.

## Client IP Source
nginx sees the address of the peer that connected. Behind Cloudflare or a load balancer that is the proxy, so access list IP rules, rate limits, access logs and the X-Real-IP / X-Forwarded-For sent to the upstream would all see the proxy. clientIpSource tells nginx where the client address is instead (nginx realip: set_real_ip_from, real_ip_header, real_ip_recursive on):
- auto (default): cloudflare when a name of the route is a registered domain proxied by Cloudflare (Cloudflare DNS with proxied: true, including a covering wildcard domain), else direct. Proxying or unproxying the domain re-renders its auto routes.
- direct: the connecting peer.
- cloudflare: CF-Connecting-IP, believed only from Cloudflare's edge ranges. Use it when the route is proxied by Cloudflare outside Opfield's DNS integration.
- reverse_proxy: X-Forwarded-For (clientIpOptions.header x_forwarded_for, default; the right-most address not in the list) or X-Real-IP (x_real_ip), believed only from clientIpOptions.trustedProxyCidrs (addresses or CIDRs, at least one).
A client that connects directly keeps its own address whatever headers it sends. Opfield refreshes Cloudflare's ranges every 6 hours (the built-in list holds until the first check; a failed check keeps the last good list, and the background job cloudflare-ip-ranges fails only when the list is 14 days stale while a route uses it) and re-renders the affected routes when they change. A custom template or advanced config that sets real_ip_header in the server block keeps its own setting. Raw configs get the directives only where they contain the line \`# opfield:client-ip\` (place it in the server block). Pages preview links have no setting of their own: they trust Cloudflare's edge when the Pages domain is proxied by Cloudflare (nginx daemons with nginx_pages_preview_client_ip_v1), and follow range or proxy changes at the next Pages reconcile (about a minute). The Opfield console's own API resolves client IPs with its own network setting (Settings > Advanced): with Reverse proxy and the ingress node as trusted proxy it reads X-Real-IP, which is now the client behind Cloudflare too.

## Nginx Config
Each route generates an nginx server block on its selected ingress node. Changes are applied by reloading nginx.
Config templates can customize the generated config (see templates topic).

## Raw Config Mode
When rawConfigEnabled is true and rawConfig is saved, template rendering is bypassed and rawConfig is used directly as the nginx server block. With rawConfigEnabled but no rawConfig yet, Opfield keeps rendering the managed config. A Route to a Docker container or deployment keeps its Secure Link in raw mode: keep its upstream (\`opfield_secure_link_<route id with - replaced by _>\`, as get_route_rendered_config shows it) in the raw config, or the Route loses its target. Use get_route_rendered_config to view the current config, toggle_route_raw_mode to enable/disable (disabling also returns a Route of type raw to proxy), and update_route_raw_config to write raw config.`,

  domains: `# Domains

Domains are registered public hostnames with an explicit nginx ingress assignment. DNS may be operator-managed externally or managed through a configured Cloudflare connector.

## Purpose
- Track the A/AAAA target expected from the assigned nginx ingress node public service address
- With external DNS, validate the operator-managed records without mutating the DNS provider
- With Cloudflare, create and reconcile managed A/AAAA records
- Adopt existing matching Cloudflare A/AAAA records without changing their target
- Detect target mismatches before creating routes
- Required for ACME HTTP-01 challenges (domain must resolve to its assigned Nginx ingress)

## Lifecycle
1. Register a domain with an eligible nginx node: create_domain({ domain: "example.com", nginxNodeId: "..." }). manage_domain({ operation: "list_nginx_nodes" }) lists the eligible nodes with any domains:create grant and no node permission
2. Opfield resolves the node's effective public ingress address
3. Without Cloudflare, the operator points external DNS to that address and Opfield validates the resolved records
4. With Cloudflare, Opfield resolves the matching zone; it creates missing records or adopts existing matching A/AAAA records as matched_existing
5. If Cloudflare has different A/AAAA records, create_domain returns conflict metadata; overwrite or adopt only after explicit user approval
6. Use manage_domain({ operation: "check_dns", domainId }) to manually re-check resolved DNS and repair drift; pass repair: false for a read-only check that never rewrites a Cloudflare record
7. Moving ingress is an explicit migration: the domain and its routes move together. Cloudflare-managed DNS is updated during cutover; external DNS must be changed by the operator before completion.

## DNS Records Tracked
- **A**: assigned Nginx node public IPv4 address
- **AAAA**: assigned Nginx node public IPv6 address
- Other record types are not created or overwritten by Opfield domain tools in v1

## Rules
- Domains used by routes cannot be deleted (remove them from routes first)
- isSystem domains (management domains) cannot be deleted
- Wildcard domains (*.example.com) can be registered
- nginxNodeId is optional only when exactly one Nginx node with a detected public address is open to the caller's domains:create grant at the destination; otherwise create_domain fails with DOMAIN_NGINX_NODE_REQUIRED and lists the eligible nodes
- Registered domains and their routes must use the same nginx node or ingress group. create_route may omit nodeId for a registered domain: the route uses the domain's ingress node or group
- ingressGroupId on create_domain (or manage_domain update) serves the domain and its routes from every member of an ingress group; Cloudflare DNS then lists every active member address (topic ingress-groups)
- create_domain requires domains:create, and delete_domain requires domains:delete. Those domain permissions include the managed DNS records for the domain
- For matched_existing domains, pass deleteDns=false to keep DNS and remove only the Opfield mapping, or deleteDns=true to remove the adopted Cloudflare records`,

  'access-lists': `# Access Lists

Access lists provide IP-based access control and HTTP basic authentication for ingress routes.

## How It Works
1. Create an access list with IP rules and/or basic auth users
2. Attach it to one or more routes via accessListId
3. Nginx enforces the rules on every request to those routes

## IP Rules
- Ordered array of rules: { type: "allow"|"deny", value: "IP, CIDR or all" }
- Examples: { type: "allow", value: "10.0.0.0/8" }, { type: "deny", value: "192.0.2.7" }, { type: "deny", value: "all" }
- nginx checks the rules in order and the first match wins; when a list has rules, every address that matches none is denied (Opfield renders deny all; after the last rule)
- Common pattern: allow specific IPs/ranges; nothing else gets in. To block a few addresses and let everyone else in, put the deny rules first and end with { type: "allow", value: "all" }
- Order matters: deny all before allow 203.0.113.7 blocks 203.0.113.7 too
- ipRuleWarnings in every access list response lists the rules that cannot change the outcome: kind "shadowed" (an earlier rule, coveredByIndex, matches every address the rule matches, so it never matches) and kind "no_effect" (a deny rule no later rule allows, so those addresses are denied anyway). Indexes are 0-based; the console numbers rules from 1. Only single-rule coverage is detected

## Basic Authentication
- basicAuthEnabled: true to enable HTTP basic auth
- basicAuthUsers: array of { username, password }
- Passwords are hashed with bcrypt before storage in htpasswd format
- Htpasswd files are deployed to nginx nodes via daemon

## Tool Argument Shapes
- create_access_list accepts allowIps and denyIps as string arrays plus basicAuthUsers.
- manage_access_list({ operation: "update", accessListId, ... }) accepts ipRules as ordered { type, value } objects (the whole list, in order) and basicAuthUsers as { username, password } objects.
- manage_access_list({ operation: "move_rule", accessListId, fromIndex, toIndex }) moves one IP rule (0-based positions; the rules between shift by one) against the stored list, so it cannot overwrite a concurrent edit of the other rules. REST: POST /api/access-lists/:id/ip-rules/move.
- Use basicAuthEnabled to turn HTTP basic auth on or off. If it is enabled, provide at least one basic auth user.

## Usage
- One access list can be shared across multiple routes
- Changing an access list automatically updates all routes using it
- An access list cannot be deleted while a route or a Pages project uses it; detach it first`,

  templates: `# Certificate Templates

Templates define preset configurations for issuing PKI certificates. They save time and enforce consistency.

## How Templates Work
1. Admin creates a template with desired settings (cert type, key algorithm, validity, key usage, etc.)
2. When issuing a certificate, select the template — its settings become defaults
3. Settings can still be overridden per-certificate at issue time

## Template Fields
- **certType**: tls-server, tls-client, code-signing, email
- **keyAlgorithm**: rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384
- **validityDays**: default validity period (1-3650 days)
- **keyUsage**: digitalSignature, keyEncipherment, dataEncipherment, keyAgreement, nonRepudiation
- **extKeyUsage**: serverAuth, clientAuth, codeSigning, emailProtection, timeStamping, ocspSigning (plus custom OIDs)
- **requireSans**: whether SANs are mandatory when issuing
- **sanTypes**: allowed SAN types (dns, ip, email, uri)
- **subjectDnFields**: default Organization, OU, Locality, State, Country for the certificate subject
- **crlDistributionPoints**: URLs for CRL download
- **authorityInfoAccess**: OCSP responder URL and CA Issuers URL
- **certificatePolicies**: policy OIDs with optional CPS qualifier URLs
- **customExtensions**: arbitrary X.509 extensions by OID (hex-encoded DER values)

## Tools
- list_templates, create_template, delete_template; manage_template get and update (the same fields as create_template).

## Built-in Templates
- isBuiltin: true — provided by default, cannot be edited or deleted
- Common presets: TLS Server, TLS Client, Code Signing, Email

## Nginx Config Templates
Separate from certificate templates — these define nginx server block templates for routes.
- Each template has a type: proxy, redirect, or 404.
- Templates use variable syntax ({{variableName}}) for dynamic values
- Can be cloned and customized
- Assigned to routes via nginxTemplateId`,

  acme: `# ACME (Automated Certificate Management)

Let's Encrypt integration for free, automated SSL certificates.

## Issuing an ACME Certificate
1. request_acme_cert({ domains: ["example.com", "www.example.com"], challengeType: "http-01" })
2. Opfield contacts Let's Encrypt, receives a challenge
3. For http-01: Opfield deploys each challenge to the registered domain's assigned Nginx ingress, then Let's Encrypt verifies it
4. For Cloudflare dns-01: use request_acme_cert({ domains, challengeType: "dns-01", dnsProvider: "cloudflare" }); Opfield creates TXT records, verifies, cleans up, and can enable Cloudflare auto-renew.
5. For manual dns-01: Opfield returns { domain, recordName, recordValue } — user creates DNS TXT record, then confirms
6. Certificate is issued and stored as an SSL certificate

## Challenge Types
- **http-01**: Automatic for registered domains with an assigned, online Nginx ingress. Opfield deploys the challenge to that node at \`/.well-known/acme-challenge/\`; the domain must resolve to the node and port 80 must be publicly accessible.
- **dns-01 with Cloudflare**: Automatic when a matching Cloudflare connector/zone is configured. Use dnsProvider: "cloudflare".
- **manual dns-01**: For wildcard certificates (*.example.com) or when port 80 is blocked. Manual step: add a TXT record at \`_acme-challenge.example.com\`. Supports wildcard issuance.

## Auto-Renewal
- Checked daily at 3 AM (configurable via ACME_RENEWAL_CRON setting)
- Renews certificates 30 days before expiry
- Uses the same challenge type as the original issuance
- DNS-01 auto-renew requires Cloudflare and is controlled with manage_ssl_certificate({ operation: "set_auto_renew", sslCertificateId, enabled, provider: "cloudflare" })
- Renewal failures are logged and alerted

## Staging Mode
- Choose the Let's Encrypt staging provider in the certificate form when testing issuance
- Certificates are NOT trusted by browsers (for testing only)
- Useful for testing ACME flow without hitting rate limits
- Rate limits: 50 certs per registered domain per week (production)

## Troubleshooting
- **Challenge fails**: Verify domain resolves to your nginx node IP (check Routes > Domains). Ensure port 80 is open and not blocked by firewall.
- **DNS-01 fails**: Verify TXT record is propagated (use dig or nslookup). TTL must be low enough for timely propagation.
- **Rate limited**: Switch to staging for testing. Production limit: 5 duplicate certs per week, 50 per domain per week.
- **Renewal fails**: For HTTP-01, check the assigned ingress node and daemon logs. For Cloudflare DNS-01, check the connector, zone access, and TXT propagation.`,

  users: `# User Management

## Authentication
Opfield can enable OIDC, password, and email one-time-code sign-in independently. Email-based sign-in requires verified SMTP. Users can add passkeys after they sign in; passkeys are not a first-run primary method.
- The browser setup wizard creates exactly one deliberate first administrator in the built-in system-admin group. It does not promote an arbitrary first OIDC login.
- OIDC is configured under Settings > Authentication with an issuer URL, client ID, client secret, auto-provisioning policy, default group, and optional verified-email requirement.
- When OIDC auto-provisioning is enabled, later valid OIDC logins can create users in the configured default group. Existing OIDC users are bound to the provider subject; Opfield may refresh their name and avatar from the provider.
- Password and email-code configuration, recovery flows, passkeys, and first-run choices are described in the authentication topic. Do not claim that OIDC is the only sign-in method.

## Permission Groups
- Every user belongs to exactly one permission group
- Groups define which scopes (permissions) the user has
- **Built-in groups** (cannot be modified): system-admin, admin, operator, viewer, guest
- **Custom groups**: created by admins with any combination of scopes
- **Group nesting**: a group can inherit from one parent group (single level only). Inherited scopes are automatically added to the user's effective scopes.
- Nesting limit: only top-level groups can be parents — a nested group cannot itself have children

## Managing Users
- View all users: list_users
- manage_user administers another account: set_auth_method, rename, reset_avatar, send_password_link, send_invitation, list_sessions, revoke_session, revoke_all_sessions, reset_mfa, list_deleted and restore (the last three need admin:system). The caller's own password, MFA, passkeys, and sessions stay in the browser.
- Change a user's group: update_user_role(userId, groupId) — changes their permissions immediately
- Replace a user's exact additional per-user scopes: set_user_additional_permissions(userId, additionalScopes). Pass [] to reset all additional permissions without changing the user's group. Only grant scopes the acting administrator already has.
- Block or unblock users from the Administration UI, API, or AI Workspace.
- Deleting a user is a soft-delete: their access and tokens are revoked, they are hidden from operational user lists, and historical audit/usage data remains intact. Only a system administrator can restore a deleted user, and restore leaves them blocked until explicitly unblocked.

## User Fields
- id, email, name, avatarUrl, groupId, groupName, groupScopes, additionalScopes, scopes, isBlocked, blockedBy (while blocked: \`admin\`, or \`opfield_account\` when the Opfield account removed the access; lifted by the user's next sign-in with it), isDeleted
- lastLoginAt, loginCount, createdAt`,

  audit: `# Audit Log

All significant actions are logged.
- Fields: userId, action, resourceType, resourceId, details (JSON), ipAddress, userAgent, createdAt.
- Actions follow pattern: "resource.action" (e.g., "ca.create", "cert.revoke", "proxy.update").
- AI-initiated actions have details.ai_initiated: true.
- Query with get_audit_log: filter by action, resourceType, pagination.
- Housekeeping can auto-delete old entries (configurable retention).
- SIEM audit export is a separate privacy-reduced delivery stream. Its receiver never receives full audit details, user agents, resource names, secrets, or collector response bodies. See the siem topic for its lifecycle and tools.`,

  siem: `# SIEM Audit Export

## Purpose
When enabled in Opfield general settings, Opfield can export privacy-reduced audit events to up to five active HTTPS SIEM collectors. This is an outbound push integration: Opfield sends batches to the collector; it does not expose a webhook for the collector to call.

## Safe Event Contract
Each event contains an id, a stable Opfield installation source identifier, type \`dev.opfield.audit.v1\`, ISO timestamp, action, optional actor id/email, resource type/id, and source IP. Never claim that full audit \`details\`, resource display names, user agents, secrets, credentials, raw request payloads, or collector response bodies are exported.

## Destination Security
- Endpoint URLs must be HTTPS and must not include userinfo, query parameters, or fragments.
- The existing outbound-webhook network policy validates and pins DNS addresses to protect against SSRF and rebinding. Redirects are not followed.
- Every destination uses a bearer token, HMAC-SHA256, or one validated custom HTTP header. The secret or custom header value is encrypted at rest and is never returned by API, UI, tools, logs, audit entries, or assistant responses.
- Custom headers cannot replace Opfield transport headers such as \`Host\`, \`Content-Type\`, or the \`X-Opfield-*\` headers. A custom Authorization header is allowed when a collector requires a non-Bearer scheme.
- HMAC sends \`X-Opfield-Timestamp\` and \`X-Opfield-Signature-256\` for \`timestamp + "." + rawBody\`; bearer uses the standard Authorization header.

## Delivery Lifecycle
- Audit writes and queued SIEM records are created in one database transaction; the request path never sends HTTP.
- The in-process scheduler claims rows with database leases and sends a JSON body \`{ schemaVersion: 1, events: [...] }\`.
- 2xx completes delivery. Network errors, 408, 429, and 5xx retry at 30s, 2m, 8m, 30m, 2h, 6h, and 12h, for at most eight attempts. Other 4xx responses fail terminally.
- Disabling SIEM in Opfield general settings prevents new outbox rows and pauses delivery; destinations, history, and queued records stay intact until SIEM is enabled again.
- Disabling a destination pauses outstanding work; enabling within 7 days resumes it, after 7 days disabled and unchanged the paused rows are removed. Deleting a destination soft-deletes configuration and discards outstanding work. Only failed deliveries can be manually requeued.
- A test sends a synthetic \`dev.opfield.audit.test.v1\` event only: it creates no audit row and no queued delivery.
- Every delivery row, delivered or still waiting, is removed once older than Audit Log retention (a batch being delivered finishes first). Do not use notification-webhook delivery semantics for SIEM.

## AI Tools
- SIEM tools are unavailable while \`generalSettings.features.siemEnabled\` is false.
- Read: \`list_siem_destinations\`, \`get_siem_destination\`, \`list_siem_deliveries\`, \`get_siem_delivery\` require \`audit:siem:view\`.
- Change: \`create_siem_destination\`, \`update_siem_destination\`, \`delete_siem_destination\`, \`test_siem_destination\`, and \`requeue_siem_delivery\` require \`audit:siem:manage\` and go through normal tool approval.
- Request a secret only when the caller explicitly wants to create or replace a destination. Treat it as one-time input and never echo it.`,

  nginx: `# Nginx Ingress Management

Opfield manages public ingress through nginx daemon nodes running on remote servers. The Opfield relay on port 9443 is the daemon control-plane transport; it is not an HTTP/TLS ingress for published applications.

## Architecture
- Each nginx node runs a Go daemon (\`nginx-daemon\`) alongside the host's native nginx installation
- A dedicated Opfield relay communicates with daemons over gRPC (port 9443) with mutual TLS; the application uses an internal service-mTLS control-plane hop
- Domains and routes are assigned to specific nginx nodes. A registered domain and every route using it must share the same node.
- Each route config is generated by Opfield and pushed to its selected ingress daemon
- The daemon writes the config files, tests with \`nginx -t\`, and reloads nginx gracefully

## Config Management
- Route configs are generated from templates and written to the nginx \`conf.d/sites/\` directory
- Each route becomes one nginx server block file
- Changes are atomic: write → test → reload (rollback on test failure)
- Global nginx.conf can be viewed and edited from the node detail page (Configuration tab)

## Config Templates
- Nginx templates define the server block structure for routes
- Built-in templates for common patterns (reverse proxy, redirect, etc.)
- Custom templates support variables: \`{{variableName}}\` replaced at render time
- Assigned to routes via nginxTemplateId — default template used if none specified

## Raw Config Mode
- When rawConfigEnabled is true on a route, the template rendering is bypassed entirely
- The rawConfig field is used directly as the nginx server block content
- Useful for complex configurations that templates can't express
- Ordinary route list/detail responses omit rawConfig and rawConfigEnabled
- Raw content can only be read through explicit raw config read/render paths with raw-read permission
- Enabling or disabling raw mode and writing raw config both require proxy:raw:write
- proxy:unrestricted skips the dangerous raw and advanced directive validation for the same route
- Use get_route_rendered_config to see the current generated config before switching to raw mode

## Monitoring
- **Stub status**: nginx stub_status module provides active connections, accepts, handled, requests, reading, writing, waiting
- **Access log parsing**: traffic stats by status code, response times, bandwidth
- **Health checks**: per-route backend health monitoring (configurable URL, interval, expected status)
- **Nginx logs**: access and error logs streamed via daemon, viewable per route or per node

## SSL/TLS
- SSL certificates are stored canonically by Opfield and deployed as node-local replicas only to ingress nodes with enabled TLS routes using them
- Config includes ssl_certificate and ssl_certificate_key directives
- HTTP/2 support togglable per route
- OCSP stapling enabled by default when CA chain is available`,

  nodes: `# Nodes (Daemon Management)

Nodes are remote servers running Opfield daemons. Each daemon type manages different infrastructure.

## Node Types
- **nginx**: Ingress node — runs nginx and manages route configs, TLS replicas, access lists, public traffic, logs, and stats. Requires nginx installed on the server.
- **monitoring**: Lightweight system monitoring agent — reports CPU, memory, disk, load, network. No nginx required. Useful for any server you want to monitor.
- **docker**: Container runtime node — manages Docker containers, deployments, images, volumes, and networks. Requires Docker Engine. Provides console, files, logs, environment, and secret management.
- **builder**: Restricted Build Worker profile of the existing \`docker-daemon\`. It has no Docker Engine socket and accepts only Git build, cancellation, and registry-binding commands. It supervises dedicated BuildKit and containerd services on a separate worker host or outer unprivileged container and must advertise execution, dedicated-runtime, and enforced-resource-profile capabilities before Repository mode is admitted.
- **storage**: Unified restricted docker-daemon profile for Opfield-managed Postgres, key-value stores, ClickHouse, SeaweedFS object storage (plus legacy MinIO clusters), and bounded backup jobs. It runs as root, validates ext4 image storage before enrollment, advertises both managed-database and managed-storage capabilities, and rejects generic Docker workloads.
- **databases**: Legacy restricted docker-daemon profile for Opfield-managed Postgres, key-value stores, and ClickHouse. It remains database-only; new unified stateful capacity belongs on a Storage node.
- **relay**: Secure Link Relay Pool node — runs the signed relay supervisor and worker on a separate physical host. It uses the standard node enrollment lifecycle, requires an advertised address reachable by participating managed hosts on its service port (TCP 9443 unless created with another \`servicePort\`; daemons dial the port the relay worker reports), and appears in the Relay Pool only after enrollment succeeds.

## Which Tools Take Which Node
A node's \`type\` decides which tools accept it; \`list_nodes\` and \`get_node\` return it with a one-line \`usedFor\`.
- \`docker\`: every Docker tool (containers, deployments, Compose, images, volumes, networks, Git sources).
- \`nginx\`: routes, Pages and ingress groups.
- \`storage\` and legacy \`databases\`: managed databases and managed storage.
- \`builder\`: Git builds only (\`manage_docker_build\`); Docker tools refuse it.
- \`relay\`: the Relay Pool (\`manage_relay_pool\`).
- Every type: \`get_node\`, console and files.
\`capabilities.daemonType\` is the daemon build, not the role: storage, databases and builder nodes report \`docker\` there and Docker tools still refuse them. A call on a node of the wrong type is refused with the node's type and the nodes of the right type you can use.

## How to Enroll a New Node (Step by Step)

These steps enroll a server that already exists. To create a new server as a node in one step, a VM at a hosting account (HOSTKEY, DigitalOcean, Hetzner Cloud, CloudBlast) or on a Proxmox host, use manage_hosting provision (topic hosting): Opfield orders the VM, installs the daemon of the chosen role, and enrolls it; there is no command to run by hand.

### Step 1: Create the node in Opfield UI
Go to **Nodes** page → click **Add Node** → select the node type (nginx, docker, builder, storage, databases, monitoring, or relay) → set a display name → click **Create Node**. Relay nodes also require the address advertised to participating hosts. This generates a **one-time enrollment token**, the Opfield gRPC certificate fingerprint, and setup commands. **Settings → Relay → Add relay node** opens the same flow with Relay preselected.

### Step 2: Run the setup script on the target server
The UI shows ready-to-copy commands, one per enrollment target, with curl or wget; create_node and manage_node regenerate_enrollment_token return the same commands as installCommands. Give the user the command for the target the host can reach, unchanged, and run it on the target server. On a release build the command downloads the installer of that Opfield release from get.opfield.dev, runs it only when it matches the release's \`opfield-node-installers.sha256\`, and pins with \`--version\` the daemon release of Opfield's own minor line (a relay gets the release its pool runs). An unreleased build (version \`dev\`) runs the installer from the main branch instead. For an Opfield release \`<opfield-version>\` (the version of the connected Opfield, written \`vX.Y.Z\`; never copy a version from an example) the nginx command looks like this:

\`\`\`bash
cd "$(mktemp -d)" && \\
curl -fsSL -o setup-node.sh https://get.opfield.dev/gateway/releases/download/<opfield-version>/setup-node.sh && \\
curl -fsSL -o opfield-node-installers.sha256 https://get.opfield.dev/gateway/releases/download/<opfield-version>/opfield-node-installers.sha256 && \\
grep ' setup-node.sh$' opfield-node-installers.sha256 | sha256sum -c - && \\
sudo bash setup-node.sh \\
  --opfield <opfield-host>:9443 --token <enrollment-token> --opfield-cert-sha256 sha256:<opfield-cert-fingerprint> --version <opfield-version>
\`\`\`

The installers by node type: **nginx** setup-node.sh, **docker** and **builder** setup-docker-node.sh, **storage** setup-storage-node.sh, legacy **databases** setup-database-node.sh, **monitoring** setup-monitoring-node.sh, **relay** setup-relay-node.sh (with \`--advertise-address\`).

For **builder** nodes, use the same installer with \`--mode builder\`. The host must use systemd. The installer downloads pinned upstream releases of \`containerd\`, \`buildkitd\`, \`buildctl\`, \`runc\`, CNI plugins, \`syft\`, and \`grype\`, verifies their embedded SHA-256 checksums, and installs required system packages such as \`git\` and \`iptables\`. It fails closed when the runtime is incomplete; do not add a Docker socket or convert it to a generic Docker profile as a workaround.

For **storage** nodes, run setup-storage-node.sh with the generated Opfield address, enrollment token, and certificate fingerprint. It uses the same fixed-size ext4 storage preflight as the database installer, but enrolls the unified Storage profile with managed-database and managed-storage capabilities. For legacy **database** nodes, run setup-database-node.sh; they remain database-only. In either case, the interactive installer selects an eligible local storage root before enrollment. For automation, pass --storage-root <path> and --yes; stateful nodes always run the restricted docker-daemon profile as root. Before enrollment, the installer verifies the local Docker Engine and the complete fixed-size ext4 image lifecycle, including loop attach, mount/write, growth, resize, unmount, and detach. An LXC host must receive loop-control, a loop-device pool, and mount permission from its outer host; there is no unbounded-volume fallback.

The setup script:
1. Downloads the daemon binary to \`/usr/local/bin/<type>-daemon\`
2. On a fresh generic Docker node, preflights and attempts to install the optional Secure Runtime before enrollment, and installs the lease watchdog (\`opfield-lease-watchdog\` service; \`gateway-lease-watchdog\` on nodes installed before 2.12.1 until it updates itself) that stops an Availability lease-mode copy past its lease deadline. Storage and legacy database nodes skip both. A Docker daemon running as root with systemd or OpenRC installs a missing watchdog itself; otherwise re-run the installer, or Availability lists the node under excludedNodes.
3. Creates config at \`/etc/<type>-daemon/config.yaml\` with the Opfield address, token, and certificate fingerprint
4. Creates a systemd service and enables it
5. Starts the daemon — it connects to Opfield and completes mTLS enrollment automatically

### Step 3: Verify connection
The node status changes from **pending** to **online** in the Nodes list once the daemon connects. The enrollment token is invalidated after first use.

## Assistant Tools
- list_nodes: list daemon nodes visible to the current user.
- get_node: inspect one node.
- execute_node_console_command: run one argv-style command on a node console. Use { nodeId, command: ["sh","-lc","..."] }. This is destructive, requires nodes:console, is available to MCP only when that OAuth scope is explicitly granted, and catastrophic patterns such as rm -rf / are blocked. MCP callers cannot change Opfield-managed Docker objects with it (see Console below).
- create_node, rename_node, delete_node: manage node records.
- manage_node_config: read/update/test nginx node config. Use { operation: "read"|"update"|"test", nodeId, content? }. read requires nodes:config:view:<nodeId>; update/test require nodes:manage:<nodeId>. Available to MCP tokens that hold these scopes.
- manage_node_file: manage node filesystem paths. Requires nodes:files:read, plus nodes:files:write for changes; available to MCP tokens that hold them.
- manage_node: update (display name, color, service addresses, builder settings), regenerate_enrollment_token (a node that never enrolled), health_history, monitoring_history, daemon_logs, and nginx_logs.
- manage_hosting: the VM behind a hosted node (node_get shows its account, power state and available actions; topic hosting).
- manage_docker_runtime: preflight or install the gVisor Secure Runtime on a Docker node (install restarts Docker on that node; nodes:manage on the node).
- create_node takes type nginx, docker, builder, storage, databases (legacy), monitoring, or relay. Bastion nodes are not available yet (expected in 2.14) and are refused.

### Alternative: Manual installation
If you cannot use the setup script, you can install manually. Storage and database nodes are the stateful exceptions: they use the restricted docker-daemon profiles and require the verified storage preflight.
1. Download the daemon binary and place it at \`/usr/local/bin/<type>-daemon\`
2. Run: \`<type>-daemon install --opfield <host>:9443 --token <token> --opfield-cert-sha256 sha256:<opfield-cert-fingerprint>\`
   This creates the config file and systemd service automatically.
3. Enable and start: \`systemctl enable --now <type>-daemon\`

## Connection & Communication
- Daemons connect to Opfield via **gRPC on port 9443** with mutual TLS (mTLS).
- Opfield pushes commands to daemons: apply config, deploy certs, health check, log streaming, exec, etc.
- The daemon sends back: health reports (every 30s), command results, log entries, exec output.
- Daemons auto-reconnect on disconnect with exponential backoff (1s → 60s).
- mTLS certificates auto-renew once a third of their lifetime remains (about four months for a one-year certificate); a failed renewal is retried with backoff up to hourly. Opfield alerts when a node certificate has less than 30 days left.

## Console (Interactive Shell)
All node types support an interactive console — a PTY shell session on the host OS.
- Accessed via the **Console** tab on the node detail page.
- Requires \`nodes:console\` scope.
- Supports popout window, reconnection with output replay, and terminal resize.
- Shell auto-detected from \`/etc/shells\` (prefers bash > zsh > ash > sh).
- Can be configured to run as a specific OS user via \`console.user\` in daemon config; that needs a daemon running as root. A non-root daemon with another \`console.user\` refuses every console session: the node shows \`capabilities.nodeConsoleUserUnavailable\` and console commands fail with NODE_CONSOLE_USER_UNAVAILABLE. Do not retry.
- The node operator can turn the host console and host file access off in the daemon config file on the node (\`console.enabled: false\`, \`files.enabled: false\`). The node then shows \`capabilities.nodeConsoleDisabled\` / \`capabilities.nodeFilesDisabled\`, and console commands and node file operations fail with NODE_CONSOLE_DISABLED / NODE_FILES_DISABLED. Opfield cannot re-enable them; do not retry. Docker container consoles and files are not affected.
- The assistant has a separate one-shot \`execute_node_console_command\` tool for command execution when regular Opfield read/manage tools cannot answer the request. Prefer argv commands such as \`["sh","-lc","systemctl status nginx"]\`.
- Treat every console command as destructive: risky commands require explicit approval and obviously host-breaking commands are blocked before reaching the daemon.
- Use console tools for host-level inspection or repair only after identifying the exact node with get_current_context or find_resource. Do not guess node IDs from chat text.
- Managed Docker objects stay with Opfield: agents (remote MCP with OAuth grants or API tokens, and the assistant) cannot change them through \`execute_node_console_command\` or \`ssh_execute_command\`. A command that removes, recreates, stops, starts, restarts, kills, pauses, renames or updates a container Opfield manages, runs a container under its name or on its host ports or volumes, connects or disconnects its networks, removes or prunes managed volumes, networks or containers, runs \`docker compose\` up/down/rm/restart/stop/pull on a managed project, or edits the daemon state under \`/var/lib/docker-daemon\`, \`/etc/docker-daemon\` or \`/var/lib/docker\` is refused with MANAGED_RESOURCE_CONSOLE_FORBIDDEN and audited. The error names the object and the tool to use instead (manage_docker_container recreate/live_update, remove/stop/start/restart/kill/rename_docker_container, manage_docker_deployment and the deployment tools, manage_docker_compose, manage_docker_volume, manage_docker_network). A container recreated by hand is a different container to Opfield: it loses its access identity and grants, and its Git-source builds and rollouts stop recognising it. Read-only commands (docker ps, inspect, logs, stats, images, compose ps) stay allowed; people in the browser console are not restricted. Do not work around the refusal with another shell form, a script file or a different tool.

## System Information
Daemons report hardware/OS info on registration:
- CPU model, core count, architecture (amd64, arm64)
- Kernel version, hostname, OS info
- Uptime, file descriptor usage
- Disk mounts with usage percentages
- Network interfaces with RX/TX stats

## Monitoring & Health
- **Health reports** (every 30s): CPU%, memory, disk, load average, swap, network I/O, open FDs.
- Daemons report localIpAddresses and publicIpAddresses. Docker nodes may set serviceAddress explicitly; otherwise Opfield uses the first reported local address and then a public address for cross-node/proxy-upstream traffic.
- **Nginx nodes** additionally report: nginx status, uptime, worker count, error rates (4xx/5xx), stub status stats.
- **Docker nodes** additionally report: container count (running/stopped/total), per-container CPU/memory/network stats, Docker version.
- Generic Docker nodes report Secure Runtime state, version, setup progress, and compatibility. Existing nodes expose manual Setup in Node Details to users with \`nodes:manage\` for that node (broad \`admin:update\` is still accepted for one release); do not attempt remote installation through a console unless the user explicitly asks for host-level repair.
- **Traffic stats** (nginx only): parsed from access logs — status code distribution, response times.
- Background polling at 10s intervals; 5s when a user is actively viewing the node detail page.

## Node Management
- **Rename**: change display name (does not affect hostname).
- **Delete**: removes the node from Opfield. The daemon will fail to reconnect (mTLS cert becomes invalid).
- **Pin to sidebar**: quick-access link in the sidebar navigation.
- **Service creation lock**: \`set_node_service_creation_lock\` (\`nodes:lock\`) stops new routes and containers from being placed on a node. On a Build Worker it stops new builds: builds it runs finish, queued builds go to other Build Workers, and while every online Build Worker is locked new builds are refused (503) and queued builds wait.
- **Nginx service problem**: \`lastHealthReport.nginxServiceProblem\` on an nginx node names a problem of the host's nginx service that only root can fix (nginx stopped with its pid directory gone, a pid file left to root, an Alpine nginx service that leaves the pid file to root), ending with the command to run as root. Relay it as it is; Opfield cannot run it.

## Key Fields
- id, hostname, displayName, type, status (pending/online/offline/error)
- serviceAddress (optional Docker reachability override)
- lastSeenAt, capabilities (daemon version, features, system info)
- certificateSerial (mTLS cert); node reads never include enrollment token material
- metadata (extensible metadata object)`,

  housekeeping: `# Housekeeping

Automated cleanup tasks, configurable in Settings.
- Schedule: cron expression (default: "0 2 * * *" — 2 AM daily).
- Tasks:
  - Nginx Logs: rotate/compress/delete old log files. Retention in days.
  - Audit Log: delete entries older than retention days.
  - Dismissed Alerts: remove old dismissed alerts.
  - Delivery Log: delete old notification delivery attempts.
  - Structured Logs: cap ClickHouse application logs by total rows and approximate disk size while preserving the newest daily partition.
  - ClickHouse Internals: monitor high-volume system logs and, when enabled, trim supported internal tables during manual Housekeeping runs and the five-minute health guard. Enable it only for a ClickHouse instance dedicated to Opfield.
  - Orphaned AI Artifacts: delete files no longer attached to a chat, or whose conversation (or user) was deleted, after an hour. Tool and sandbox outputs together are capped at 10 GiB, oldest first; files users attached are never capped.
  - Orphaned Certs: remove unreferenced certificate files.
  - ACME Challenges: clean up old validation tokens.
  - Docker Prune (dockerPrune, on by default): old Opfield app and relay images on the Opfield host (the running one and one to roll back to stay), obsolete connector images, and on every online Docker node the image cleanup rules: each workload's older images beyond its image cleanup setting, unused images nothing runs or names once unused for 12 hours, and dangling images. Database and storage nodes remove their own unused engine images after 24 hours unused (the newest of each stays). Existing installs are cleaned within a day of the update; the card counts every old image, those still waiting included. get_stats dockerImages breaks the count down: opfieldHost, connectors, and per Docker node removableNow (what the next run removes) and waiting (with nextRemovableAt); prune_docker_images with dryRun:true lists one node's images with their reason before anything is removed.
  - Operation History (operationHistory, default 90 days): finished Docker container tasks after a day; finished builds with their logs, compose, availability and hosting operations and source webhook deliveries after the retention. Each resource keeps its 10 latest runs, and rows still referenced (a live build artifact, a hosted node's origin, a snapshot) stay.
  - Expired OAuth Grants (oauthCleanup): expired OAuth codes and tokens (refresh tokens once expired), and OAuth client registrations that never completed an authorization, after 30 days. A client that was ever granted is never removed.
  - Expired Tokens (expiredTokens, default 7 days, 0 removes at once): API and inference tokens whose expiry passed that many days ago. Until then they are listed as Expired and refused like revoked ones; the audit log keeps their history and records each removal.
  - Operation History also removes finished registry maintenance runs, relay pool update runs, deployment releases, container migrations, storage copy jobs, sandbox jobs, inference core operations, App promotions and incidents, expired GitHub sign-in sessions, earlier proxy host certificate placements and deleted image records, keeping each owner's 10 latest.
  - Build Logs (buildLogs, default 30 days and 2 GiB): logs of finished builds past the age, then the oldest while all build logs together exceed the size. The newest 3 finished builds of each source keep their log; build records stay with Operation History.
  - Inference Usage (inferenceUsage, default 90 days, 35 at least): settled inference requests with their attempts and usage records; each user's lifetime totals keep what was removed. Also old provider quota readings and price versions nothing uses.
  - Orphaned Volumes (default 3 days): only anonymous volumes Opfield created (seen attached to a container Opfield created) are removed once unused that long. Unused volumes Opfield did not create, or cannot tell, are never removed; the card reports them.
  - Opfield Host Files (hostFiles): leftovers of interrupted work on the Opfield host: temp files, MCP archive transfer spools, configuration export snapshots and dumps. Also runs a minute after start.
  - Dismissed Alerts also keeps one open alert per resource and kind and removes open alerts older than 90 days.
- With the Housekeeping switch off, the scheduled run still runs Internal Registry, Operation History, Build Logs, Inference Usage, Expired OAuth Grants, Expired Tokens and Opfield Host Files (each with its own switch). Each category has 30 minutes.
- When a disk holding Opfield data on the Opfield host is 90% full, housekeeping runs at once (at most hourly). Built-in alerts: "Opfield disk almost full" (85%), "Opfield disk full" (95%, critical) and "Housekeeping not running" (no successful run for two days).
- get_stats includes diskUsage: every Opfield host disk (Docker data root, stack volumes) with free space, Postgres database size and largest tables, Redis memory and AOF size, container log sizes (read only). File sizes (container logs, nginx logs, the registry on local disk) are apparent file sizes, comparable with a log max-size, not the blocks a compressing filesystem allocates.
- Can be triggered manually from Settings page.
- Tool: manage_housekeeping get_config, get_stats, get_history, update_config (config, validated like PUT /housekeeping/config), and run.
- Run history tracked (last N runs with per-category results).

## Permissions
- \`housekeeping:view\` — read config, stats, and run history.
- \`housekeeping:run\` — trigger a manual run.
- \`housekeeping:configure\` — edit config and schedule.`,

  permissions: PERMISSIONS_DOC,
};
