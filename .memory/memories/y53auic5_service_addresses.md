---
{
  "id": "y53auic5",
  "file_name": "y53auic5_service_addresses",
  "tags": [
    "dns",
    "migration",
    "nginx",
    "nodes",
    "service-addresses",
    "ui-contract"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787215910208,
  "updated_at": 1791851975317
}
---
# Opfield Node Service Address Contract

- The canonical node address field is `serviceAddresses: string[]`, persisted as PostgreSQL `text[]`.
- The list is ordered, trimmed, unique, and limited to 10 entries.
- An empty list means automatic address selection from the daemon health report.
- Legacy `serviceAddress` and `secondaryServiceAddress` columns remain during the compatibility transition and are synchronized from the first two canonical values.
- Existing legacy primary/secondary values are migrated into the canonical list in the same order.
- Consumers requiring one endpoint use the first configured address, then their established automatic fallback.
- Nginx ingress and Domain DNS reconciliation consume the full effective list.
- Every explicitly configured Nginx address must be a publicly routable IP.
- Replacing an address still used by assigned Domains remains confirmation-gated and atomically writes the node change with `pendingDnsTargetIp`; adding addresses while retaining every tracked target does not retarget Domains.
- Node Settings presents one plural Service Addresses section using the shared free-text Combobox with grouped detected options, shared AnimatedHeight, and joined plus/minus row controls. There is no separate Secondary Address UI.
- The Node update route applies the existing node-type-specific config permission checks to the canonical list.
