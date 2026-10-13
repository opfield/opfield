---
{
  "id": "9vk5wac1",
  "file_name": "9vk5wac1_relay_resume",
  "tags": [
    "gateway-backend",
    "placement",
    "relay",
    "relay-resume"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791616049649,
  "updated_at": 1791616049649
}
---
Opfield backend: Opfield's own resumable relay streams (packages/backend/src/grpc/relay-resume.ts, ResumableRelayDuplex) must mirror the Go relayresume source semantics. Two rules learned in the 2.11.4 rc.9 fix round:
1. Every planned move is bound to the relay it was asked to leave: `migrate(trigger, fromRelayId)`. If the stream is no longer on that relay when the move runs, nothing happens (Go `plannedMove.stale()`). Paced drain moves (`drainRelay` spreads them over up to a minute), GOAWAY/lane-lost moves, target MIGRATE_REQ hints, and the returner's delayed `return` all pass a relay. Without this, a drain move that fired after a target hint had already moved the stream off the draining relay avoided the new relay, and the stream went to a farther one (stand: UK to NL at 300 ms).
2. `return` and `lane` moves dial with no avoided relay. A `return` whose best path is the current relay cancels the new path and counts no move (Go `ErrStay`). Lane moves record no stall into migrationStall percentiles (Go `recordStall` skips TriggerLane).
Each move is logged at info as "Gateway relay stream moved" (route, trigger, from, to). That log is the evidence to check in e2e runs.
