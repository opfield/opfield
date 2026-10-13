---
{
  "id": "pzorr3qy",
  "file_name": "pzorr3qy_internal_containers_safety",
  "tags": [
    "docker",
    "internal-containers",
    "read-model",
    "safety",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.92,
  "created_at": 1786557839910,
  "updated_at": 1791851850957
}
---
Opfield-owned implementation containers are identified by explicit labels and filtered only at the public Docker presentation boundary. Current internal markers include wiolett.gateway.managed=secure-link-connector, wiolett.gateway.managed-database.connector=true, net.wiolett.gateway.managed=clickhouse plus net.wiolett.gateway.owner=gateway, com.wiolett.gateway.managed-service, and gateway.sandbox=true. Public container lists, aggregate snapshots, dashboard pins, GPU usage, compose/webhook consumers, and AI list tools use the filtered inventory. Internal safety-sensitive operations such as image cleanup and Docker migration preflight must use DockerManagementService.listAllContainers so service containers still count as running/in-use and are not damaged. Do not filter the persisted daemon snapshot or daemon reconciliation itself.
