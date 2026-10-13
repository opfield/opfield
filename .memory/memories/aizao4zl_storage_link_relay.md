---
{
  "id": "aizao4zl",
  "file_name": "aizao4zl_storage_link_relay",
  "tags": [
    "availability",
    "design-constraint",
    "managed-storage",
    "relay",
    "storage-link"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790896684976,
  "updated_at": 1790896684976
}
---
Managed storage link (storage binding) runtime constraints that decide how a link can run on several nodes (Availability placements):
- The docker daemon validates the storage connector: container name must be `gateway-storage-connector-<GATEWAY_CONNECTOR_BINDING_ID>`, its single network alias `storage-<first 16 hex of that id>`, and the connector socket looks up the relay connect grant by owner kind `managed_storage_binding` + that same id. So a copy of a link on another node cannot get a new id without changing the endpoint variable.
- `relay_routes` allowed one route per owner (except `proxy_host_secure_link`, one per source node for ingress groups), and `reconcileManagedStorageRelayPolicy` deletes `managed_storage_binding` routes whose owner is not a link row, so DB-style child projection ids get wiped.
- Chosen design (fx/ha-storage, 2026-10-02): keep the link's own names on every node and give storage links one relay route per source node, like ingress-group Secure Links (`relay_routes_storage_link_source_unique`, `ensureStorageBindingRoute` per source + retargets all on move, `revokeStorageBindingRoute(bindingId, node)`); `getManagedStorageBindingRouteRuntime` then sums placements automatically. Storage link networks are internal, so a placement must join them next to its own network (`attachedNetworkNames`), never as container network_mode. Node capability `managed_storage_link_v1` marks docker daemons that host storage connectors (2.10 daemons have Availability but no connector socket).
