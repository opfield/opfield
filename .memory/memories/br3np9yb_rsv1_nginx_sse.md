---
{
  "id": "br3np9yb",
  "file_name": "br3np9yb_rsv1_nginx_sse",
  "tags": [
    "e2e-harness",
    "nginx",
    "relay-paths",
    "relayresume",
    "rsv1",
    "sse"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1791491795270,
  "updated_at": 1791851437418
}
---
Lessons from the v2.11.4-rc.6 stand findings (fixed on fix/rc6-a):
- RSv1: a target that resets sends its RST on its current (old) path; during a planned move the RESUME_REJ(3) on a faster new path can overtake it. Treat the refusal as "hear out the old path" (RST there = peer reset, not a cut) and finish a stream whose both directions are complete on any refusal. A given-up target path must be read until the source ends the tunnel before cancel: cancelling right after the last send lets gRPC drop the RST/CLOSE echo/RESUME_REJ, and the source then counts a cut. In-memory test relays must drop undelivered frames on cancel to model this.
- nginx + Secure Link (unix socket upstream): on upstream EOF of a close-delimited response (no length, no chunked) nginx ends the client response normally (terminating chunk) and keeps the client connection alive; over AF_UNIX it cannot tell a cut from a clean end. WebSockets close (1006). A harness SSE client must de-chunk (http.client r.readline(), not r.fp.readline()), or it "hangs" until its read timeout.
- Opfield's own relay paths must measure every pool relay continuously (as daemons do via relay_latency_targets) and keep the last RTT as the ordering key; measuring only around new paths left long-lived tunnels with unknown distances after quiet periods, so they fell back to assignment order (far relay first).
- Route health: relayed (Secure Link) probes are slow/failing while the local relay restarts and within its 2-min reconnect grace; defer them like node reconnects.
