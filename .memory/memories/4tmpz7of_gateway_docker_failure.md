---
{
  "id": "4tmpz7of",
  "file_name": "4tmpz7of_gateway_docker_failure",
  "tags": [
    "docker",
    "migration",
    "realtime",
    "rollback",
    "security",
    "snapshots"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1781721373255,
  "updated_at": 1791851249026
}
---
Opfield Docker detail mutation-settle and node-migration contract:
- When an env/settings mutation starts, DockerContainerDetail sets a local mutation lock immediately and derives one effective transition from backend _transition plus the local lock.
- Keep the page blocked until it observes backend transition state, a refreshed changed payload, or recreated-id remap; never clear the lock merely because the mutation request returned.
- A stopped-container live save may produce no daemon transition event. Clear its local lock through explicit refresh/settle logic instead of waiting indefinitely for _transition or inspect-only deltas.
- When backend recreate/update failure clears a transition, publish docker.container.changed with action=transitioning and transition=null so the detail page can unlock/refetch.
- Fail recreate promptly if a replacement appears under a new ID but reaches exited or dead rather than running.
- Migration handoff must resolve the target by the migration target container ID, not by a reused container name. Refresh the target list and detail snapshot before publishing cutover; treat realtime as an optimization and keep a bounded settling read for missed one-shot events.
- A docker.snapshot.changed handler must only read the already-refreshed snapshot. Calling a no-cache refresh from that handler creates an unbounded GET -> snapshot event -> GET feedback loop and exhausts the API rate limit.
- Persisted Docker migration execution plans can contain credentials in commands, labels, entrypoints, and health checks even after env removal. Envelope-encrypt manifests and deployment recreation payloads at rest; persist only safe routing IDs, current cutover slug, counts, progress, and verification metadata in plaintext.
- Rollback must restore the exact restart policy for every source container, deployment router, and slot before starting the source. If any policy restoration fails, do not start the deployment and leave the migration guarded for operator attention. Skip source restoration entirely before the stopping_source phase.
- Completion/progress modal ownership is tab-local; other users still receive realtime redirect but must not inherit the initiating tab's modal.
- Verification for this area: targeted transition/navigation/snapshot/rollback/encryption tests, full frontend/backend suites, daemon tests and vet, frontend/backend lint/typecheck/build, Drizzle generation plus fresh-database migration, proto generation, and git diff --check.
