---
{
  "id": "gz01c8d5",
  "file_name": "gz01c8d5_inference_core_docker",
  "tags": [
    "docker-compose",
    "inference-core",
    "local-development",
    "model-discovery",
    "troubleshooting"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790155283819,
  "updated_at": 1791851580597
}
---
Managed inference core in local development (verified 2026-09-28/29 with core `2.60.0-thesqlabs.3`):

- Install the managed inference core from a Compose-managed Opfield container. A bare `tsx` backend can show a stale seeded `ready` row with no container or sealed credentials; provider authorization then fails with `CORE_CREDENTIALS_MISSING`. For manual testing run Opfield in a Compose container with the Docker socket, stable Compose labels and an internal service-network alias; it can reuse the dev Postgres and Redis services.
- After installation the UI shows live discovered provider models and auto-fills metadata (display name, context window, input/output limits, auto-compaction, modalities, capabilities).
- To test a local core build, set `INFERENCE_CORE_DISTRIBUTION_IMAGE` (read in `modules/inference/core/inference-core-runtime.service.ts`) to a local tag, e.g. `inference-core:local-dev`, via a Compose override. Build the core with `docker build --build-arg VERSION=local-dev -t inference-core:local-dev .`; the default `VERSION=dev` fails readiness with `core readiness version mismatch: expected local-dev, received dev`.
- Opfield recreates a missing core only through the Repair operation (startup reconciliation just marks it degraded), and Repair merely restarts a still-running container. So remove the core container first (its state and secrets volumes survive), then press Repair in Settings > Inference.
- The Compose files used on 2026-09-29 lived in /tmp and were lost on a later reboot; recreate an override instead of looking for them. Heavy builds no longer run on the development Mac (owner's rule since 2026-09-29).
