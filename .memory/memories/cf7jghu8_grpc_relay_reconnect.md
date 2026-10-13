---
{
  "id": "cf7jghu8",
  "file_name": "cf7jghu8_grpc_relay_reconnect",
  "tags": [
    "grpc-js",
    "local-relay-outage",
    "relay",
    "root-cause"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1791475480435,
  "updated_at": 1791851471234
}
---
Root cause seen in the v2.11.4-rc.5 stand run (F-2, O-2): after the local relay container restarts, Docker may give it another address, and Opfield's grpc-js channels to `relay:9443` (RelayControlClient admin + tunnel broker) keep the old resolved address (grpc-js re-resolves DNS at most every 30 s) and fail fast during reconnect backoff with a stale `14 UNAVAILABLE ... Last error: connect ECONNREFUSED/EHOSTUNREACH <old ip>:9443`. Symptoms: supervisor `servingAgainAt` 9-18 s late with auto-recovery off, binding/link/policy calls refused for up to 24 s after nodes were back.

Fix pattern (branch fix/rc5-findings, commit da0f9a2a): channels use `grpc.use_local_subchannel_pool` (otherwise a new channel reuses the failed shared subchannel and its backoff); `RelayControlClient.reconnectIfDown()` replaces channels in TRANSIENT_FAILURE or used-then-IDLE (never READY/CONNECTING, never a never-used idle one); the supervisor calls it every second while an outage is open (`watchReturn`) and when the relay serves again. Commercial core: gRPC code 14 / `No connection established` counts as transient in `isTransientReconcileError`, and `retryTransientErrors` retries bindings left in error.

Related evaluator rule: stateful mappings of edge-triggered sources (relay supervisor publishes on change only) need `stateful.holdsUntilNextEvent`, or resolve/fire windows stay uncovered until the next event.
