---
{
  "id": "l2g94u2b",
  "file_name": "l2g94u2b_relay_lock_latency",
  "tags": [
    "docker-daemon",
    "latency",
    "locking",
    "managed-database",
    "relay"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1790522295535,
  "updated_at": 1791851707441
}
---
Root cause of ~2 s new-connection latency to managed databases through the relay (docker daemon up to v2.11.0-rc.16): `managedDatabaseManager.handle()` held `m.mu` for the whole command, and the `stats` action called Docker `ContainerStats` with `Stream: false, IncludePreviousSample: true`, which Docker answers only after a second CPU sample (~2 s; `one-shot=true` answers in ~1 ms but has no precpu, so CPU % cannot be computed). Relay link dials (`dialRecord`) took the same `m.mu` just to read the record, so every new tunnel to any database on that node waited for the in-flight stats call; with Opfield polling stats continuously, tunnels were released on a ~2 s grid. Managed storage `dial` had the same shape behind lifecycle commands.

Fix (commit c50c9ce1, first shipped in v2.11.0-rc.17-docker): relay dials read records without the manager lock (records are replaced atomically via temp file + rename, and the dial verifies the live container), and `stats` runs outside the lock like `probe_tls`. Its regression test (`managed_relay_dial_lock_test.go`, which held the lock or blocked a stats sample in the fake engine and asserted dials still proceed) was removed by the 2026-09-29 light-suite cut.

Rule: never hold a manager lock across Docker API calls that can block (stats, waits, lifecycle), and never make a relay dial take a lock that commands hold.

Diagnosis technique that worked: probe new connections from the app container with a PostgreSQL SSLRequest and wall-clock timestamps; replies aligned on a fixed ~2.005 s grid regardless of connect time → a shared lock or periodic release, not a timeout. Then compare the same source against databases on a different target node to localise the side; `strace` of the relay showed policy applies take ~1 ms, disproving a broker-lock theory. Run daemon Go tests with `CGO_ENABLED=0` on macOS (go-m1cpu cgo init segfaults).
