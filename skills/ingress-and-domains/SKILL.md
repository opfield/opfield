---
name: ingress-and-domains
description: Expose and troubleshoot services through Opfield ingress, including Domains and DNS, Routes (proxy hosts) to Docker, Pages, or manual upstreams, SSL certificates from ACME, upload, or internal PKI, Access Lists, Additional Routes, Secure Links, nginx templates, and maintenance mode. Use when asked to put a service on a hostname, add HTTPS, restrict access by IP or basic auth, put a Route into maintenance, or find out why a Route, Domain, or certificate is not working. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Ingress and Domains

The Console and tools call these resources **Routes**; REST paths and the resource type keep the legacy name `proxy-hosts` / `proxy_host`. Each Route is one nginx server block on its assigned ingress (`nginx`) Node, or on every member of an **ingress group** (nginx Nodes, normally one per site, that serve the same Routes and Domains; see below).

Start with `using-opfield` for connection, discovery, and safety rules. Use this skill after the target workload or Pages Tag exists, or when the request is about ingress itself. Read `read_opfield_documentation({ topic: "proxy" })` (also `domains`, `ssl`, `acme`, `access-lists`) before an unfamiliar workflow.

## Publish a hostname

1. **Domain.** Find the registered Domain with `list_domains` or `find_resource({ types: ["domain"] })`, or create it with `create_domain({ domain, nginxNodeId })` on the Ingress Node that will serve the Route (`manage_domain({ operation: "list_nginx_nodes" })` lists the Nodes you may use). A Domain and every Route using it stay on the same Node. Inspect existing DNS before any managed DNS write.
2. **DNS.** For external DNS, return the exact record change and wait for the user or provider: `create_domain` with `dnsProvider: "external"` registers the domain only after its A/AAAA records point at the ingress (`DOMAIN_DNS_NOT_READY` with `details.targetIps` until then), so add the record first and register after. With a Cloudflare connector, Opfield creates or reconciles A/AAAA records; when it reports conflicting records, overwrite or adopt only after explicit approval. Re-check with `manage_domain({ operation: "check_dns", domainId, repair: false })`, which only reads; without `repair: false` the check also repairs drifted provider records, so use that form only when the user asked Opfield to fix the records.
3. **TLS.** Reuse a compatible ready SSL certificate, or issue one: HTTP-01 needs the Domain resolving to the assigned online Ingress Node with public port 80 reachable; DNS-01 through a matching Cloudflare connector is automatic; manual DNS-01 returns a TXT record the user must create before verification. The certificate is usable only when Opfield reports it ready. Details: [TLS and Access Lists](references/tls-and-access-lists.md).
4. **Route.** `create_route` or `update_route` with a stable target and the SSL certificate ID (never a PKI certificate ID). Omit `nodeId` for a registered Domain: the Route uses the Domain's Ingress Node or group. Without one, `list_route_ingress_nodes` lists the Nodes (and, in `groups`, the ingress groups) you may create Routes on; no Node permission is needed. Target shapes, Additional Routes, Secure Links, and templates: [Routes and upstreams](references/routes-and-upstreams.md).
5. **Verify** in layers (below) before returning a URL.

Enable WebSockets, redirects, Access Lists, headers, caching, rate limits, maintenance, health checks, or advanced nginx configuration only when the application needs them. Never convert or replace an unrelated live Route because its hostname looks similar.

## Stable Route targets

- Standalone Container: Docker Node, stable Container name, application port.
- Compose service: Docker Node, Compose Project, service name, application port; re-resolves after Compose recreates the Container.
- Blue/green Deployment: Docker Node, Deployment ID, application port.
- Pages: Page Project and a ready mutable Tag, never an immutable Deployment (`publishing-html-pages`).
- Manual upstream: explicit host, port, and scheme.

## Access Lists and maintenance

- An Access List combines ordered IP allow/deny rules (first match wins; addresses that match no rule are denied) with optional HTTP basic auth. Reorder rules with `manage_access_list` `move_rule` and check `ipRuleWarnings` for rules an earlier rule shadows. It attaches to Routes through `accessListId` and to Pages previews through the Page Project; editing a shared list updates everything that uses it.
- Never invent, request, or relay basic-auth passwords in chat. Prefer IP rules for lists you create; for basic auth, let the user add users in the Opfield Console, then attach the list by ID.
- `set_route_maintenance({ routeId, enabled })` serves HTTP 503 while keeping the vhosts listening and pausing managed health checks. Use it instead of disabling the Route or editing its config, so the change stays audited and reaches notification rules and status pages. It works on enabled, non-raw Routes only.

## Ingress groups (several sites)

- `manage_ingress_group` (read `read_opfield_documentation({ topic: "ingress-groups" })` first) lists, creates and changes groups, adds, removes and reorders members, and places existing Routes and Domains on a group. It needs the multi-node availability license feature for anything that grows a group; removing members and deleting groups never do. Reading groups needs `ingress:groups:view`, changing them `ingress:groups:manage` (broad or on a node folder); placing a Route or Domain on a group needs neither, only the create permission on every member.
- A Route or Domain on a group is served by every member, each with its own config and certificate replicas, so it keeps serving while a site or Opfield is down. Create them with `ingressGroupId` instead of `nodeId`; move existing ones with `convert_route` / `convert_domain` (new members first, DNS last) and back with `update_route` / `manage_domain update` `ingressGroupId: null` plus the member Node (DNS first).
- A new member receives every Route before its address is published; a removed member leaves DNS first and keeps serving until no public name resolves to it (at most 24 hours; `force` skips the wait).
- DNS failover mode `none`: Cloudflare-managed records list every active member (round robin). Plain records are not health-checked, so an unreachable member keeps receiving its share until it is removed. Tell the user this when they rely on a group for failover, and recommend a health-checking load balancer in front of the members (for example Cloudflare Load Balancing) that probes `/.well-known/opfield-ingress-health` on each member: 200 when its nginx runs the current configuration (and, with Secure Links, a relay transport is usable), 503 otherwise, 502 when its nginx daemon is not running.
- `get` shows per member whether each Route's config and certificate reached it and why not; Route health is `degraded` when some member fails it. Certificates for names on a Cloudflare-managed group Domain renew with DNS-01 automatically.

## Verify in layers

1. The target resource is ready and healthy.
2. The Route is enabled and applied on the expected Ingress Node (every member for a group: `manage_ingress_group` `get`).
3. The Domain resolves to that Node.
4. TLS is valid for the hostname, with the expected chain and `notAfter`.
5. An external HTTPS request returns the expected status and, when practical, recognizable content or a health response; with `sslForced`, plain HTTP redirects to HTTPS.

Return a verified URL only after the relevant layers pass. Certificate issuance and delivery are separate steps: Opfield stores the certificate, pushes a replica to the Route's Ingress Node, and applies config atomically (`nginx -t`, then reload). If external verification is unavailable, name the layers that passed and say public reachability was not tested.

## Pitfalls

- Moving a Domain to another Ingress Node is an explicit migration: the Domain and all its Routes move together, and external DNS must be repointed first.
- Domains used by a Route, and system Domains, cannot be deleted.
- Raw config (`proxy:raw:write`), `proxy:unrestricted`, and `proxy:templates:manage` are OAuth manual-approval scopes; expect them to be missing unless explicitly granted, and treat raw mode as high risk.
- ACME production limits are 5 duplicate certificates per week and 50 certificates per registered domain per week. Use staging while testing.
- Ingress Secure Links (nginx to a destination) differ from database and storage workload links; use `databases` or `storage` for those.

Further reading: [Ingress overview](https://docs.opfield.dev/en/ingress/overview/), [Ingress troubleshooting](https://docs.opfield.dev/en/ingress/troubleshooting/).
