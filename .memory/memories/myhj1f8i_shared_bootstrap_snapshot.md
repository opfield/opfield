---
{
  "id": "myhj1f8i",
  "file_name": "myhj1f8i_shared_bootstrap_snapshot",
  "tags": [
    "bootstrap",
    "dashboard",
    "rate-limit",
    "realtime",
    "sidebar"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.93,
  "created_at": 1785949175721,
  "updated_at": 1791851758586
}
---
# Opfield Dashboard Bootstrap, Sidebar and Assistant Pins Contract

## Bootstrap, realtime, authorization, and invalidation

- Dashboard data loads through `POST /api/monitoring/dashboard/bootstrap`; Dashboard and Sidebar share a Zustand snapshot key and deduplicate requests.
- Bootstrap responses include attention notices and independent Dashboard/Sidebar pins for nodes, proxies, databases, Docker containers, and deployments.
- Realtime events invalidate the shared snapshot; clients do not open per-node `EventSource` streams. After reconnecting an established WebSocket, EventStream revalidates bootstrap to recover missed events.
- Update availability, group MFA policy, audit activity, and Assistant pin actions publish authorized dashboard-consumable events that invalidate the shared snapshot.
- Bootstrap is a read-only POST and must be excluded from fallback audit logging. Auditing it emits `audit.changed`, invalidates bootstrap, and creates an unbounded request loop.
- Initial failures retain request identity, retry with bounded backoff while no snapshot exists, and end in a visible retryable error rather than a permanent spinner; the snapshot stays invalidatable afterwards.
- Preserve an existing snapshot only while refreshing for the same user, scope, and pin key. Auth-context changes call `resetClientSessionState`, clearing bootstrap and pin stores before publishing new user state.
- For Docker child-scoped pins, browser-supplied scope/resource IDs are display metadata only. Resolve the deployment/container server-side and authorize its stable identity before returning data.
- Logging-health visibility and its realtime channel require `housekeeping:view`, not `logs:read`.

## Sidebar and Lite mode

- The Dashboard badge is an 8px square (`h-2 w-2`): blue when every visible notice is informational and yellow when any warning exists, including unhealthy state.
- Lite mode keeps a separate Dashboard link at the top of the sidebar, displays Sidebar-placement resources, then conversations.
- Default and Lite sidebars share `SidebarPinnedResources` for consistent routes, scope filtering, and status colors.

## Assistant pins

- The embedded Opfield Assistant supports `find_resource` and `set_resource_pin` for Dashboard or Sidebar. Pins are browser-local and excluded from MCP.
- Tool results emit a one-time `client.action` WebSocket event that updates the current browser's pin stores and invalidates bootstrap.
- Pin actions apply only to the active conversation; if an active run exists it must match the message run. Historic or delayed actions must not overwrite later manual choices.
- Docker pin actions require `nodeId`, `nodeSlug`, and `name` so local metadata remains resolvable.
