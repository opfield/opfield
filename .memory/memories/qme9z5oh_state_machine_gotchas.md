---
{
  "id": "qme9z5oh",
  "file_name": "qme9z5oh_state_machine_gotchas",
  "tags": [
    "ai-chat",
    "opfield",
    "production-readiness",
    "providers",
    "recovery",
    "snapshots",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1783631313911,
  "updated_at": 1791851858395
}
---
Opfield AI chat state-machine verification contract:

- Snapshot ordering must be monotonic per conversation. Assemble snapshots consistently, serialize or coalesce publication, and reject non-newer revisions client-side so late responses cannot regress messages, tools, waits, runs, thinking state, or grouping.
- Active execution and drafts require restart-safe ownership, reconciliation, and cancellation semantics; do not assume process-local state survives backend restart.
- Approval and final-answer persistence must be transactionally consistent with continuation scheduling. Idempotent retries must replay or resume the persisted decision without duplicating execution.
- Provider adapters require explicit successful terminal states. Failed, incomplete, error, length-limited, or otherwise non-success terminal events must not normalize as successful completion.
- Revalidate the current implementation before treating any historical defect as still present.
- Verification must cover concurrent snapshot ordering, restart/fault injection, cancellation and compaction, mixed question-plus-approval tool rounds, each provider protocol, and authenticated browser parity across Default and Lite UI surfaces.
