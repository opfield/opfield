---
{
  "id": "lct3cijz",
  "file_name": "lct3cijz_gateway_availability_decision",
  "tags": [
    "availability",
    "compose",
    "docker",
    "ha",
    "internal-registry",
    "opfield",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1788310918318,
  "updated_at": 1791851722115
}
---
Opfield Multi-node Availability is intentionally not based on Docker Swarm because Swarm's manager/gossip/VXLAN and node-to-node connectivity conflict with Opfield's outbound-only isolated-node security positioning.

Accepted product contract (decision 2026-09-02, plan `.workflow/plans/09-02-26-multi-node-workload-availability`): one Availability feature for existing Containers, managed Deployments, and whole Compose Projects. Modes are fixed-count replicated and one-serving failover over an eligible node allowlist/all-compatible set, with at most one placement per node, no metric autoscaling, and all mounts forbidden. Opfield owns durable policies, placements, operations, generation fencing, healing, and stale reconnect cleanup through existing authenticated daemon channels. Images use immutable internal-registry digests with active and deterministic standby pre-pull/pins. Existing managed database bindings are logical and project placement-local connector/Secure Link state before readiness. One user-visible Route/Proxy Host/Secure Link projects hidden healthy placement endpoints over the existing Relay Pool. Workload HA is in scope; Nginx, Opfield control-plane, registry-storage HA, shared storage, and node-to-node networking are not.

Status (verified in main on 2026-10-01): implemented. Backend `packages/backend/src/modules/docker/availability/*`, schemas `docker-availability.ts` and `docker-availability-lease.ts` (lease mode with a lease watchdog component released under the `-watchdog` tag), scope `docker:availability:manage`, licence feature `multi-node-availability` (Business). The owner treats lease mode as the core of the feature: never ship it disabled behind a flag.
