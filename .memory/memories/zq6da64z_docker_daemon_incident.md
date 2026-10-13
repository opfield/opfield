---
{
  "id": "zq6da64z",
  "file_name": "zq6da64z_docker_daemon_incident",
  "tags": [
    "daemon",
    "docker",
    "incident",
    "production",
    "snap",
    "systemd"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1777288607698,
  "updated_at": 1791852019807
}
---
Opfield Docker daemon service dependency lesson:

- A Docker package or Snap refresh can restart the Docker engine. If `docker-daemon.service` has a hard systemd `Requires=` dependency on the engine unit, systemd stops the Opfield daemon during that refresh and the node temporarily disconnects.
- The Opfield daemon should use ordering/soft dependency semantics such as `Wants=` and `After=`, not a hard `Requires=` on the Docker engine service.
- The installer and daemon unit generator must preserve this contract across package variants.
- Verification should inspect the generated systemd dependency graph, simulate or observe an engine restart, confirm the Opfield daemon reconnects without manual repair, and keep a regression test around unit generation.
