---
{
  "id": "a7elxcv1",
  "file_name": "a7elxcv1_nginx_proxy_lifecycle",
  "tags": [
    "deletion",
    "nginx",
    "nodes",
    "proxy-hosts",
    "relay",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786747174263,
  "updated_at": 1791851342126
}
---
Opfield offline Nginx node removal must break the node/proxy-host deletion deadlock through an explicit node-level cascade, not a raw database cascade. The backend permits cascade only when the Nginx node is actually disconnected, preflights independent blockers such as assigned Domains before deleting any hosts, and deletes each proxy host through lifecycle services. Offline-source Secure Link cleanup must first persist relay route/endpoint revocation and bump policy revision. Applying that snapshot to Relay may be deferred when Relay control is unreachable: log the deferral and rely on periodic/reconnect reconciliation, because blocking after durable revocation creates another deletion deadlock and does not improve a partitioned Relay's state. Mark link rows cleanup-pending so target snapshots exclude them, best-effort synchronize target Docker nodes, skip the unreachable source snapshot, retire certificate deployment state, and audit that stale local Nginx config may remain. Connected nodes retain confirmed daemon cleanup; Domains are never cascade-deleted because they represent external DNS state.
