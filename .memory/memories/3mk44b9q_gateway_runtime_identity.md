---
{
  "id": "3mk44b9q",
  "file_name": "3mk44b9q_gateway_runtime_identity",
  "tags": [
    "containers",
    "docker",
    "monitoring",
    "opfield",
    "recreate",
    "restart",
    "snapshots"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787594299433,
  "updated_at": 1791851170436
}
---
# Opfield container monitoring runtime identity contract

- Container monitoring state belongs to one runtime generation, identified by Docker runtime container ID plus inspect `State.StartedAt`. Recreate changes the ID; restart can keep the ID but changes `StartedAt`.
- Filter stats history to samples whose timestamp is at or after the current runtime `StartedAt`. Ignore late history, process-list, or SSE responses from a previous identity.
- When a recreate event adopts a replacement runtime ID, `DockerContainerDetail` immediately fetches replacement inspect data even if route resolution still holds the old object.
- `StatsTab` resets cards, histories, counter baselines, GPU samples, and process state when identity changes. Repeated process polling keeps the shared panel mounted and renders loading, temporary-error, or empty states.
- `DockerSnapshotReconciler` tracks active transitions. During restart/recreate, transient old-runtime exit events refresh inventory without replacing the durable detail snapshot; completion urgently refreshes the replacement runtime.
- Cached detail decoration reconciles status/running state from the latest daemon health report, including by stable name when runtime ID changed, without substituting stale cached configuration.
- Regression coverage must exercise restart versus recreate identity, late-response rejection, transition snapshots, replacement inspect fetch, process polling states, and cache reconciliation.
