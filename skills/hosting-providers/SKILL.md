---
name: hosting-providers
description: Create servers as Opfield Nodes through hosting accounts, and manage the VMs behind them. Covers HOSTKEY, DigitalOcean, Hetzner Cloud, CloudBlast, and Proxmox VE (one connector per physical host), including ordering a VM with the node role installed, following the operation until the Node is online, retrying a failed installation, adopting or installing on existing VMs, and power, resize, delete, snapshots, and firewall. Use when asked to create, order, or provision a server, VM, or Node at a cloud provider or on a Proxmox host, or to start, stop, resize, snapshot, or destroy a hosted VM. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Hosting Providers

A hosting account (connector) lets Opfield order a VM, install the daemon of the chosen Node role on it, and manage the VM afterwards. Paid cloud providers bill the provider account; Proxmox uses your own hypervisor, one connector per physical host (`settings.proxmoxHost`). Everything goes through `manage_hosting` (toolset `hosting`). `create_node` does not create servers: it only registers one that already runs (see `managing-nodes`).

Read `read_opfield_documentation({ topic: "hosting" })` before the first call: it has every field, phase, and error code this skill summarizes.

## Access

Ordering needs `integrations:hosting:view` and `hosting:resources:create` on the account (`hosting:resources:create:<connectorId>`) plus `nodes:create` (broad, or on the node folder you pass). The built-in admin group has no hosting scopes. On `HOSTING_ACCESS_DENIED`, report the scope named in `details.requiredScope`; do not look for a way around it.

## Provision a Node

1. `manage_hosting({ operation: "connector_list" })`: pick the enabled account. For Proxmox, match the host the user named with `settings.proxmoxHost`.
2. `manage_hosting({ operation: "catalog", connectorId })`. On `503 HOSTING_CATALOG_NOT_READY` run `connector_sync` (`integrations:hosting:manage`) or wait for the background sync, then read it again.
3. Choose `location`, `size`, `image` from the catalog. The image's `supportedRoles` must include the role. Cloud price: `sizes[].locationPrices[location]` or `sizes[].price`. Proxmox: `location` = the connector host, `size: "custom"`, plus `cpu`, `memoryMb`, `diskGb` within the host `capacity`.
4. Confirm role, name, placement, resources, image, and (cloud) the exact price with the user. The order is billable.
5. Order with `connectorId` inside `input`:

   ```json
   {
     "operation": "provision",
     "input": {
       "connectorId": "<account id>",
       "idempotencyKey": "<new random UUID>",
       "name": "docker-02",
       "role": "docker",
       "location": "<catalog location id>",
       "size": "<catalog size id>",
       "image": "<catalog image id>",
       "confirmedPrice": { "amount": "<catalog amount>", "currency": "<catalog currency>" }
     }
   }
   ```

   Relays also need `relayAddress`. Proxmox drops `confirmedPrice` and adds `cpu`, `memoryMb`, `diskGb`. After a timeout repeat the identical call with the same `idempotencyKey`: it returns the same operation and never orders twice.
6. Poll `manage_hosting({ operation: "operation_get", operationId })` until `phase` is `ready` or `failed` (`pending`, `dispatching`, `provisioning`, `configuring`, `installing`, `enrolling`; `awaiting_payment` for a HOSTKEY invoice; `reconciling` or `unknown` while Opfield confirms an uncertain answer). It takes minutes.
7. `get_node({ nodeId })` must report `online` before you place anything on the Node.

## When it fails

- Never order a second VM to fix the first one.
- `failed` with `resourceId` (the VM exists, installation failed): `operation_retry_install` with a new `idempotencyKey`. It keeps the VM and the pending Node. The VM must be running.
- `unknown` or a phase that does not move: `operation_reconcile`; it never repeats the provider call.
- `failed` without `resourceId`: no VM was created. Tell the user before ordering again.
- `HOSTING_PRICE_CHANGED`: read the catalog again and confirm the new price.

## Existing VMs

- A VM that already runs an Opfield Node: `adoption_candidates`, then `adopt` with `input: { resourceId, nodeId }`.
- A VM without a daemon: `provision` with `input.existingResourceId`, the VM's `location`, `size: "existing"`, `image: "existing"`. It installs through Guest Agent, or through `sshConnectorId` (a trusted external SSH connector) when the VM has none.

## Operate the VM

- `node_get({ nodeId })` gives `resourceId`, `incarnation`, `powerState`, and which actions are available.
- `resource_action` with `input: { action, idempotencyKey, expectedIncarnation, confirmed: true }`: `start`, `shutdown`, `reboot`, `resize` (cloud: `size` + `confirmedPrice`; Proxmox: `cpu`, `memoryMb`, `diskGb` on a stopped VM, disks only grow), `recover` (restart the daemon), `delete` (destroys the VM and removes its Nodes; irreversible). Confirm each with the user.
- Snapshots: `snapshots_list`, then `snapshot_action` with `snapshot_create`, `snapshot_delete`, or `snapshot_restore` (restore replaces disk data).
- Firewall: `node_firewall_get`, then `node_firewall_update` with the whole `config`, `expectedRevision`, `expectedFingerprint`, and `acknowledgeConnectivityRisk: true`. Keep the Node's path to Opfield open.

## Verify

- Provisioning: operation `ready` and `get_node` `online` with a fresh capability report.
- Lifecycle actions: the returned operation reached `ready`, and `node_get` shows the new power state or resources.

## Pitfalls

- A running VM is not an online Node: wait for `ready` and `online`.
- `HOSTING_RESOURCE_IDENTITY_CONFLICT`: the VM behind the id changed. Read it again and confirm again; never force.
- Removing a hosting account does not destroy its VMs, and deleting a Node record does not destroy its VM.

Further reading: [Hosting providers](https://docs.opfield.dev/en/integrations/hosting-providers/).
