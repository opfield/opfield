---
{
  "id": "ifp3c48s",
  "file_name": "ifp3c48s_opencodex_inference_migration",
  "tags": [
    "accounting",
    "inference",
    "opencodex",
    "review-lessons",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787137855135,
  "updated_at": 1791851654769
}
---
# Managed inference-core integration contract

- Opfield owns the control plane: `gwi_` authentication, model/provider configuration, limits, pricing, and accounting.
- The managed inference core is a private runtime dependency reachable only over the internal service network; it must not publish a public port.
- The data plane is the stable transparent `/api/inference/v1/*` proxy with signed `wiolett-core/v1` context.
- Create the request/accounting row before signing context, and keep `rootRequestId` equal to that durable request ID.
- WebSocket proxying is per turn. Because the core socket may be multi-turn, Opfield closes the upstream socket after a terminal event so the client turn cannot hang.
- Hold the concurrency lease for the entire turn and release it only in finalization.
- Database mocks can hide missing persistence fields. Accounting regression tests must assert durable pricing snapshot linkage rather than only successful responses.
- Idempotent redelivery replays persisted admission decisions, including admitted output limits.
- Oversized responses that cannot be delivered to the client settle as failed rather than billing an undelivered success.
- Legacy harness-specific Codex, Anthropic, setup, and toggle routes are removed. Clients use discovery and the single stable inference prefix.
