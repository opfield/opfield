---
{
  "id": "z36pcfh4",
  "file_name": "z36pcfh4_inference_failover_routes",
  "tags": [
    "discovery",
    "failover",
    "gateway-inference",
    "routing",
    "v2.9.8"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787837324629,
  "updated_at": 1791852003012
}
---
Opfield Inference runtime candidate-selection contract:

- The model administration UI account count represents persisted enabled source bindings; it does not prove every binding survives the data-plane eligibility query.
- A configured, enabled, non-deleted, core-backed source remains a routing candidate across transient discovery omissions.
- Discovery availability is catalog freshness, not authoritative request-time reachability.
- Keep capability compatibility, source/connection enablement, deletion state, and core-link validity as hard filters.
- If the core or upstream rejects a model, response-level failover owns excluding that connection and trying the next eligible candidate.
- Regression coverage must include transient discovery omission with healthy alternate bindings, reserve thresholds, upstream rejection, and multi-candidate failover.
