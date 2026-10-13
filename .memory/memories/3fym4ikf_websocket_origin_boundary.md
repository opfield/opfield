---
{
  "id": "3fym4ikf",
  "file_name": "3fym4ikf_websocket_origin_boundary",
  "tags": [
    "authentication",
    "origin",
    "security",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786190863596,
  "updated_at": 1791851165368
}
---
Opfield WebSocket cookie authentication must not trust localhost or local-interface hosts as a broad Origin class. In production, accept the canonical public `APP_URL` origin, or for direct domainless Opfield access only the exact origin of the WebSocket target resolved from the upgrade request, including scheme, host, and port. A page served from another local port must not be able to open the authenticated Opfield WebSocket merely because both endpoints are local. Bearer Authorization credentials remain independent of this cookie-Origin predicate. The enforcement helper and regression coverage live in `packages/backend/src/app.ts` and `packages/backend/src/app.host-guard.test.ts`.
