---
{
  "id": "huz2cldt",
  "file_name": "huz2cldt_gateway_notification_fix",
  "tags": [
    "alerts",
    "bugfix",
    "notifications",
    "opfield",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1783024139300,
  "updated_at": 1791851641620
}
---
Opfield threshold notification alerts track state with composite resource IDs; render labels must be derived separately from those state IDs (`packages/backend/src/modules/notifications/notification-evaluator.service.ts`, `getThresholdResourceName`, verified 2026-10-01).

- Node disk alerts use composite IDs like `nodeId:/`; on firing, notifications must use the node hostname/name as resource.name, not the raw mount `/`, otherwise Discord templates render `Resource: node//`.
- Container metric alerts use composite IDs like `nodeId:containerName`; on resolve, notifications must keep the container name rather than switching to the node name.
- Database metric alerts must keep the database display name on resolve instead of falling back to the database ID.
- Fix pattern: pass the raw source/name into the clear handling and derive render names through getThresholdResourceName, preserving raw sources/names for final labels. (The original regression test file was removed by the 2026-09-29 light-suite cut.)
