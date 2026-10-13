---
{
  "id": "e0oqvuoo",
  "file_name": "e0oqvuoo_live_handover_sealed",
  "tags": [
    "concurrency",
    "live-handover",
    "relayresume",
    "root-cause",
    "rsv1"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791495928486,
  "updated_at": 1791495928486
}
---
Live handover (packages/daemons/shared/relayresume + shared/handover) invariant, learned fixing the v2.11.4 stress flake "resume offset outside the retained data" (branch fix/handover-resume-offset, commits c8f0f565, 8db728cf, 97d2e09b):

- Between Session.HandoverState (read-out) and the commit (keeper snapshot, TargetTable.HandOver, Detach) the old process's paths keep running. Anything it tells the peer in that window that reflects state newer than the read-out breaks the next process: a RESUME_ACK frees the peer's retained bytes up to the old process's rcv_nxt (bytes lost, caught as a reset), a RESUME from the old source makes the target free bytes (next source refused as stale until the 55 s budget), a CLOSE exchange finishes the stream behind the next process ("resume rejected (code 2)" / target waiting 60 s).
- Fix shape: Session.sealed (set by HandoverState) keeps every path read in order per path, processes it on Thaw, drops it on Detach; TargetTable.resume drops (no answer) RESUMEs for sealed/detached sessions and for a handed-over table even after Accept checked (TOCTOU, else RejectUnknown); Manager.attempts begins no move while sealed. Acks are safe: they carry `delivered`, which cannot move while frozen.
- Separate race: Bridge.quiescent counts the writer stopped while in Recv or parked; Recv answering ErrFrozen must keep it counted (Session.frozenOut), else collect sees "busy" and cuts the stream.
- Kept frames assume Stream.Recv returns a fresh frame per call (generated gRPC does); a reusing Recv would need a copy.
- Regression tests: relayresume/handover_test.go (deterministic via per-tunnel frame counters: "reader re-entered Recv after the frame" = frame handled). Plain RSv1 moves are not affected (one process per end, offsets always held).
- The stress test only reproduced under ~6 parallel processes with GOMAXPROCS 1..6 (11 of 36 runs failed on rc.6); alone it passes. Test-harness gotcha: keying per-daemon counters by *Registry in a world-level map leaked every old process (OOM); keep such state on the daemon struct.
