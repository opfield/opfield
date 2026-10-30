import { LEGACY_INGRESS_HEALTH_PATH } from '@/lib/legacy-compat.js';
export const INGRESS_GROUP_DOCS: Record<string, string> = {
  'ingress-groups': `# Ingress Groups

An ingress group is a set of nginx ingress nodes, normally one per site, that serve the same routes and domains. Each member renders every route of the group itself and keeps its own replica of every certificate, so a member keeps serving while the Opfield control plane or another member is down. Use manage_ingress_group (REST: /api/ingress-groups).

## Model
- A group has a name, slug, optional description, a node folder (folderId; groups use node folders, with their own ingress:groups permissions) and dnsFailoverMode.
- Members are nginx nodes in site-preference order (reorder changes it). A node may belong to several groups. Only nodes whose nginx daemon reports the ingress_group_v1 capability can be members.
- Member state: joining (being prepared, not in DNS), active (serving and published in DNS), draining (still serving, withdrawn from DNS, removed once DNS stopped pointing at it).
- Routes (create_route or update_route ingressGroupId) and domains (create_domain ingressGroupId, manage_domain update) target either one node or one group. A route on a group is served by every member; route nodeId then shows the first active member.
- A domain name must be unique across every member of every group and node it is served on.

## Permissions And License
- Ingress groups have their own permissions, granted broadly or on a node folder (\`<scope>:folder/<nodeFolderId>\`, covering its subfolders); node permissions do not reveal them. list and get need ingress:groups:view; create, update, delete, add_member, remove_member and reorder need ingress:groups:manage (which implies view) on the group folder; putting a node into a group also needs nodes:manage on that node.
- Placing a route or domain on a group needs ingress:groups:view on the group (broadly or on its folder) and proxy:create or domains:create covering every member (broad, the destination folder, or a node grant on each member). Route and domain node lists (list_route_ingress_nodes, manage_domain list_nginx_nodes) offer only groups the caller may view. Saving a route or domain that stays on its group needs no ingress scope; the built-in operator group has ingress:groups:view.
- Creating a group or growing its runtime (create, update, add_member, reorder, placing routes or domains on it) needs the multi-node availability license feature. Existing groups keep serving without it; delete and remove_member are always allowed.

## Zero-Downtime Operations
- convert_route and convert_domain (or update_route / manage_domain update with ingressGroupId) place an existing route or domain on a group: config and certificates reach every new member first, DNS changes last. Moving back to one node: ingressGroupId null plus the member node (nodeId for routes, nginxNodeId for domains); DNS changes first, the other members are cleaned up afterwards.
- add_member: the node gets every route config, certificate and Secure Link source of the group while joining; only then is it active and published in DNS. An offline node stays joining and joins when it reconnects.
- remove_member: DNS first. The member keeps serving until no public name of the group resolves to it and the DNS TTL passed (at most 24 hours), then its configs, certificates and Secure Link sources are removed. force removes at once, while cached DNS may still send clients to it. The last active member of a group that still serves routes or domains cannot be removed.
- delete: only a group without routes and domains.

## DNS
- dnsFailoverMode none: a Cloudflare-managed group domain lists the address of every active member (round robin). Plain DNS records are not health-checked, so an unreachable member keeps receiving its share of clients until it is removed from the group. External DNS is the operator's; Opfield validates that it points at members.
- Members without a detected public ingress address are not published.

## Certificates
- Every member holds a replica of every certificate its routes use; renewals and TLS resyncs reach every member, and the convergence reconciler repairs missing or stale replicas and configs (every minute and when a member reconnects).
- ACME HTTP-01 challenges are placed on every online member. Certificates for names on a Cloudflare-managed group domain are issued and renewed with DNS-01 automatically, which does not depend on any ingress node.

## Status
- get shows each member with state, connection and ingress health, and each route and domain with per-member delivery: the config and certificate version each member confirmed, or pending or failed with the reason. get_route shows servingNodeIds, ingressGroup and ingressDelivery for a route on a group.
- Route health is checked through every member: a route is degraded when some member fails it and offline when none serves it.
- Every Opfield-rendered server block and the default server answer /.well-known/opfield-ingress-health (and the earlier ${LEGACY_INGRESS_HEALTH_PATH}, for monitors set up before): 200 when nginx runs the current config generation (and, with Secure Links, at least one relay transport is usable), 503 otherwise, 502 when the nginx daemon is not running. The body is only {"status":"serving"} or {"status":"unavailable"}; the details (generations, relay transports, reasons) are in the ingress group member health in Opfield, never on the public path. An nginx daemon before 2.12.1 answers the new path only on route hosts: monitors that probe a node IP or the default server use ${LEGACY_INGRESS_HEALTH_PATH} until the daemon updates.`,
};
