---
{
  "id": "ehwd5n85",
  "file_name": "ehwd5n85_secure_link_connector",
  "tags": [
    "connector",
    "docker",
    "gotcha",
    "migration",
    "secure-links"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.94,
  "created_at": 1791140412841,
  "updated_at": 1791851515403
}
---
Opfield 2.11.1 moved DB, storage and container links onto one shared per-node secure-link connector: an anchor container owns the link-network endpoints, IPs and aliases, and the connector runs in its netns with SO_REUSEPORT plus a 30-min drain on replacement. Rules proven on the stand (rc.4–rc.18):
- Docker refuses a static IP (IPAMConfig) on networks created from Docker's default address pool ("user specified IP address is supported only when connecting to networks with user configured subnets"). Only Opfield pool networks (explicit /26 from docker.secure_links.subnet_pool, default 10.213.0.0/16) may pin the connector at base+2. Legacy link networks (pre-2.11.1 sidecar/DB networks) cannot take over an old IP.
- Clients that pin DNS (nginx static proxy_pass, envoy) break whenever the address behind a link alias changes. The only reliable move is: switch the transport (overlap aliases), remove the old endpoint, then recreate that consumer immediately, one consumer at a time, in BOTH directions (forward migration and rollback revert). Never leave queued consumers for the next periodic pass.
- DB and storage link orchestrators must share a per-workload lock and a per-node slot limit of 4 (the docker daemon refuses a 5th concurrent long command as busy), so a workload with both kinds of links is recreated once.
- A daemon must not run SyncRelayGrants inline in the session receive loop. Opfield re-sends bundles while egress is not ready, and inline syncs chain into minutes of unserved commands. Grant syncs run on one daemon-wide serialized worker that collapses to the newest bundle and sends no ACK to a dead session.
- An egress state must never enter the proxy secure-link state files: an older daemon rejects the whole persisted state on a non-target binding.
- After a rollback to a daemon without secure_link_egress_v1, Opfield removes the orphan anchor by name (gateway-secure-link-anchor) before the full proxy sync, then re-provisions sidecars/listeners and recreates consumers.
