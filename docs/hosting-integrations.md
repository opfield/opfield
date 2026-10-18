# Hosting integrations

Hosting accounts let Opfield create a provider VM, run the existing role installer and wait for the node to enroll and become useful to Opfield. The provider account and its charges remain yours. Opfield does not resell hosting.

## Providers and UI

| Provider | Resources | Account finances |
| --- | --- | --- |
| HOSTKEY | VM orders and lifecycle management | Account balance and estimated monthly expenses |
| DigitalOcean | Droplets and lifecycle management | Account balance when available and estimated monthly expenses |
| Hetzner Cloud | Cloud servers; not Robot or bare metal | Estimated VM expenses; no account balance API |
| CloudBlast | VPS creation (installed over SSH) and lifecycle management | EUR credit balance and estimated monthly expenses |
| Proxmox VE | Create QEMU VMs; inventory and manage eligible QEMU VMs and LXC containers | None; placement shows host/storage capacity |

Connect accounts under **Settings → Integrations → Hosting**, also listed under **Nodes → Providers**. Account pages contain Overview and Virtual machines, with account settings in the action menu. Balance and monthly expenses appear as overview cards where available and permitted. There is no Finance tab, invoice browser or top-up action. Testing a connection does not order a VM or create an invoice.

**Add connector** uses the existing step-based dialog composition. HOSTKEY, DigitalOcean, Hetzner and CloudBlast use Connection → Settings. Proxmox uses Connection → Proxmox host → Infrastructure → Network → Review; inventory-only mode skips infrastructure and network. Back preserves the draft. Only the final action saves a connector; Continue/discovery never creates a VM. New connectors are enabled immediately; existing connectors retain their enabled state when edited.

Hosting extends the existing node header and Overview tab. Eligible VMs also expose Firewall and Snapshots. Docker resources are linked from Overview to the filtered Docker pages. Provider power state remains distinct from Opfield daemon availability.

## Create a node

1. Choose **Create hosted node** from Nodes or **Create VM** from an account.
2. Select the existing Opfield role, name, account, location and operating system. Choose CPU, memory and disk resources for this VM.
3. Review the configuration and available provider price. Proxmox uses your own capacity. Selecting a profile does not create a resource.
4. Confirm once. The persisted operation performs provider provisioning, installation, enrollment and role-readiness checks.

With a complete single-host Proxmox profile, Opfield applies the connector's infrastructure/network settings and allocates VMID/IP on the server. OS and VM resources are chosen during node creation, not saved as connector defaults. Relay roles still require their advertised address. The final review precedes creation; a request cannot escape the connector's host or allocation pools.

You can close the wizard and reopen the operation from the account. Closing the browser or restarting Opfield does not cancel or repeat an accepted order. A lost response reuses the saved request. Do not clear browser storage to work around an uncertain operation: reconcile the original operation first.

An operation is not ready merely because its VM is running or its installer exited successfully. For example, a Docker node must connect and report a healthy Docker runtime. A dead or disconnected daemon means **Offline**, even when the provider reports Running.

If installation fails on a known new VM, **Retry installation** keeps that VM and the pending node ID, rotates the enrollment token and does not order a replacement. An uncertain installer outcome is reconciled rather than blindly executed again. Expired installation credentials require the explicit retry path.

Installing Opfield on a visible existing server is an explicit action, distinct from adoption. It requires a proven Guest Agent channel or an existing trusted SSH connection to that server's actual interface address. Opfield does not reinstall the operating system to gain access.

## CloudBlast

CloudBlast connects with an API token from CloudBlast Account Settings → API; Opfield calls the official API v2 at `https://console.cloudblast.io`. The account's numeric ID is its identity, so a replacement token for the same account can be saved on the existing connector.

- **VM creation installs over SSH.** CloudBlast's create API accepts no user data, so Opfield generates a one-time ed25519 key pair per creation. The private key is held only in the operation's encrypted bootstrap data and is discarded when the operation ends. Opfield registers the public key with CloudBlast under the operation marker, then creates the server with it; the server hostname ends with the same marker. Once the server is running and out of `installing`, Opfield trusts the SSH host key on the first connection to the server's public address and pins it for the rest of the operation. A different key or address later stops the installation without sending anything. The installer then runs as root with a freshly rotated, single-use enrollment token that expires after 30 minutes.
- After the installer finishes, successfully or not, Opfield deletes the key from the CloudBlast account. It also removes the key from `/root/.ssh/authorized_keys` when installation succeeded; after a failure the key stays so the failure can be diagnosed. Both cleanups are recorded on the operation. A failed provider-key deletion keeps the operation reconcilable, retries it (up to 20 attempts) and reports its outcome before the operation completes.
- Admitted images are plain Ubuntu and Debian templates, such as "Ubuntu 24.04 LTS" and "Debian 12", within the installer-supported versions. Application templates, Fedora, other Linux distributions and Windows are listed but never offered for automatic installation. Plan changes (resize) and daemon recovery are unavailable through CloudBlast's API.
- Inventory reads each server's plan, addresses and real-time hypervisor state. Start, graceful shutdown, reboot and destroy are polled through that state and never re-sent. Destroying a server keeps only addresses that were already reserved IPs.
- **Snapshots** are CloudBlast backups taken in snapshot mode (the server stays online). Names are limited to 40 characters. Restore requires a stopped server. Storage cost uses the plan's backup price per GB-month.
- **Firewall** uses one Opfield-owned security group per server, with explicit catch-all rules for the inbound and outbound policy. Opfield refuses to apply while the server is attached to other security groups, or when its group is shared or contains rules Opfield cannot represent. After confirmed server deletion, the unused owned group is removed.
- Balance is the account credit in EUR. Top-ups, user SSH keys, reverse DNS, extra or reserved IPs, reinstall and rename remain CloudBlast console actions.

## Proxmox prerequisites

Neither inventory nor new VM creation requires a manually prepared template. Template-free provisioning uses the Proxmox API's `import` download/upload support and asynchronous `import-from` configuration (verified against Proxmox VE 9.1). Opfield's runtime needs `xorriso` to generate a small NoCloud ISO; it is included in the Opfield Docker image. To enable VM creation, configure:

- The HTTPS API endpoint and one selected physical Proxmox host per connector. Opfield discovers cluster identity instead of requiring a user-invented identifier; VMIDs remain cluster-wide even with multiple host connectors.
- An API token with narrowly scoped permissions for the intended host, VMIDs and storage. Opfield inspects effective per-resource permissions; a reachable Guest Agent is not automatically permission to execute commands.
- A trusted CA or independently verified SHA-256 certificate pin when using a private certificate. Do not disable TLS validation.
- Existing disk storage supporting `images`, image storage supporting `import`, and bootstrap storage supporting `iso`. One file-based storage may serve both image and bootstrap media; block storage such as ZFS may remain the VM disk target. Discovery lists actual content capabilities. Opfield never changes the hypervisor's storage configuration.
- A bounded VMID pool, for example `250-260,271,273-280` (20 unique IDs). Ranges are inclusive and overlaps are deduplicated; a pool supports at most 1000 IDs. The optional inventory Resource scope is distinct from this creation pool.
- DHCP, or a static IPv4 pool with subnet/gateway, for example `192.0.2.100-192.0.2.119,192.0.2.150`. Reserve it exclusively for Opfield, outside DHCP/manual assignment. The usable IP count must be at least the VMID count. Network/broadcast/gateway and out-of-subnet addresses are rejected.
- An existing bridge, optional resource pool, VLAN (blank means untagged), DNS servers and optional search domain, MTU and interface firewall flag.
- Optional aggregate CPU, memory and disk budgets for the connector. These include allocated VMs and in-flight creation/resize reservations; they are not per-VM defaults. Unknown inventory values prevent allocation against an enabled limit.

The built-in catalog pins official Ubuntu LTS, Debian generic and Fedora Cloud images to a specific build and SHA-256/SHA-512 checksum. Opfield downloads the selected image on demand to an operation-owned file in the chosen Proxmox storage. It does not trust an existing shared file solely because its filename contains a checksum. Successful task receipts are persisted before the next step; lost responses are reconciled against exact provider task evidence without reissuing ambiguous imports. No OS image binaries are bundled in Opfield. Arch is excluded; Alpine is not advertised until a specific image/role combination passes installation and readiness checks, and is excluded from Build Worker roles. Creating an image entry is not proof of live role compatibility.

Opfield creates a uniquely marked VM, imports the cloud disk, and supplies instance identity, network configuration and the role installer through an operation-specific NoCloud ISO. Cloud-init installs prerequisites and QEMU Guest Agent, then runs the installer. Opfield removes its bootstrap ISO and temporary source image after verified enrollment. The ISO contains short-lived enrollment material: restrict storage read access to trusted administrators. Failed or uncertain operations retain the VM for diagnosis and never silently order a replacement. Existing accepted template-based operations retain their legacy execution path; new connectors do not expose a template picker.

Provider power-on can finish before cloud-init or Guest Agent starts. For canonical images, cloud-init owns initial installation; Opfield does not also dispatch the installer through Guest Agent. Existing-resource and legacy-template installation waits for cloud-init before touching its package manager. Pool reservations survive uncertain requests and retries. Confirmed deletion permits VMID/IP reuse for a new resource incarnation; old node identities, bindings and permissions never transfer to the replacement machine. A missing inventory entry alone does not free a reservation.

Relevant Proxmox permissions include `VM.Audit`, `VM.PowerMgmt`, `VM.Allocate`, required `VM.Config.*` privileges, disk `Datastore.AllocateSpace`, image/ISO `Datastore.AllocateTemplate`, and bridge/pool access. Image download also needs `Sys.AccessNetwork` on the selected physical host in current PVE; do not substitute global administrator access. Storage inspection needs `Datastore.Audit`. Automatic temporary-file deletion requires `Datastore.Allocate` on **image and bootstrap storage**; prefer dedicated storage so this token cannot delete unrelated media. Guest identity reads and command execution are distinct: newer PVE versions use `VM.GuestAgent.FileRead` and `VM.GuestAgent.Unrestricted`; older versions use corresponding `VM.Monitor` checks. Existing VMID-only tokens must be extended explicitly before using image download/upload. Preflight rejects missing permissions before creating a VM.

## OS admission policy

New hosted VMs use a shared, fail-closed OS/version/architecture/role policy across all providers. The installer/package compatibility matrix is independent of the pinned images Opfield downloads for Proxmox: Ubuntu 22.04/24.04/26.04, Debian 11/12/13, and Fedora 43/44 on x64 (reviewed 2026-09-05 against the existing installers and upstream Docker/Nginx package support). Proxmox still offers its three pinned canonical builds; cloud providers expose compatible images from their own catalogs. Opfield never invents an image absent from the provider. Ubuntu 20.04 is not currently admitted for new automatic hosting installation and is absent from DO's distribution catalog. This does not declare existing Ubuntu 20.04 daemons incompatible. This is admission policy, **not** a claim that each provider/image/role combination has completed live E2E verification. Unknown OS versions, unknown architectures and missing compatibility metadata are not implicitly supported.

DigitalOcean plain distributions must have a recognized public slug and matching distribution metadata. Its documented Ubuntu 24.04 NVIDIA/AMD AI/ML images are also admitted by pinned public image ID, with compatible GPU vendor/count size restrictions; a changed mutable GPU alias requires a new review rather than silently upgrading the base OS. Hetzner requires a non-deprecated system image with the exact OS name and architecture. HOSTKEY requires an exact plain OS label including explicit x64 architecture; uncertain labels remain unavailable until their metadata is verified. Proxmox uses the canonical image identities, not arbitrary existing templates.

The policy applies when catalog snapshots are built, when cached catalogs are served (including older Redis data), at request admission before node/intent creation, and again before provider order dispatch. The wizard requires explicit role support and honors image location, architecture and size restrictions. These filters do not hide provider inventory from automatic adoption or alter existing Opfield nodes.

Relay uses the same admitted image policy as the other roles. A relay VM takes its advertised address and its **Relay Port** (`relayServicePort`, TCP 9443 by default); the review step shows the resulting relay endpoint. Opfield does not open that port in the provider: allow it in the provider firewall, in the managed VM firewall when it is on, and in any port forward in front of the VM. The operation finishes once the relay answers on that port. Released installers prepare their own command-line prerequisites. Existing-resource installation and previously dispatched operations retain their own lifecycle and are not treated as new VM orders.

## Automatic adoption

An already registered Opfield node is linked automatically when complete, fresh and unambiguous provider evidence identifies the same host. Supported evidence includes a unique directly assigned public IP, scoped private IP plus matching interface/MAC evidence, or an independently read guest host identity. A private IP alone or a shared NAT egress IP is insufficient.

Adoption preserves node ID, host identity, PKI, configuration and workloads. Multiple roles on the same proven host may share the provider resource. Ambiguous/stale/incomplete matches stay unbound with a diagnostic reason and are evaluated again on a later sync.

**Adopt nodes** on the account page links one unbound VM to one unbound node by hand (`POST /api/integrations/hosting/{id}/adopt` with `{ resourceId, nodeId }`, MCP `manage_hosting` `adopt`; candidates from `adoption-candidates`). It needs `integrations:hosting:manage` on the account and `nodes:manage` plus `nodes:details` on the node, and still links them only when the same evidence proves they are one host.

Resource and node scopes constrain discovery; they are not manual matching choices. Newly provisioned VMs are admitted into a restricted resource scope by their exact returned provider ID. Reused provider IDs with a different incarnation do not inherit management authority from the old VM.

## Ownership markers

Every VM Opfield creates carries an opaque operation marker `gw-<uuid>`: in the Proxmox VM description (`Opfield hosting gw-…`) and SMBIOS UUID, a Hetzner `marker` label, a DigitalOcean tag, or the CloudBlast and HOSTKEY hostname suffix. Owned firewall objects carry deterministic names or comments: DigitalOcean `opfield-fw-…`, CloudBlast `gw-fw-…` (described `Managed by Opfield`), Proxmox `gwfw…` security groups with `Opfield firewall …` comments. Do not edit or remove these markers; Opfield uses them to recognize its resources after a lost response.

Releases before 2.12.1 wrote descriptions, the Hetzner marker label, DigitalOcean firewall names and firewall comments under the earlier product name. They are still recognized. On sync and firewall reconciliation Opfield rewrites them in place on VMs it created (description, label, firewall name or comment only; nothing is recreated). This needs the same write permissions as normal management; without them the old names simply stay. CloudBlast security group descriptions and rule comments are not edited in place: rules get the new comment when they next change, an older group keeps its earlier description. CloudBlast ownership is decided by the group name only.

## Management and destructive operations

- Start, graceful shutdown, reboot and resize are exposed according to resource support and permissions. Proxmox resize/destruction requires a stopped guest; disk shrinking is not supported.
- **Restart daemon** requires a verified independent channel and explicit confirmation. It does not hide a VM reboot or OS reinstall. Recovery completes only after fresh node health confirms readiness.
- **Remove node**, **Destroy provider resource** and HOSTKEY rental cancellation are separate operations. VM destruction affects all roles/workloads on that host and does not silently remove Opfield node records.
- Removing an integration disconnects provider management; it does not destroy VMs, cancel rentals or stop daemons.
- An unavailable/partial provider inventory does not authorize mass deletion. A deleted resource's old IP is not released for reuse without confirmed deletion of that same incarnation.

## Finances and permissions

Billing permissions are separate from node visibility and VM management. Account totals are never presented as an individual node's bill. Amounts retain their currency, timestamp and actual/estimated meaning; unavailable values are not zero.

For a confirmed HOSTKEY VM order, Opfield can apply available account credit to its associated invoice. The payment has a separate persisted dispatch boundary; an uncertain payment is reconciled, never blindly repeated. Opfield does not collect card details or provide a general-purpose top-up/payment page.

## Firewall, snapshots and alerts

Firewall management is opt-in for DigitalOcean, CloudBlast and Proxmox. Rules share inbound/outbound direction, Allow/Deny, protocol, ports and source/destination addresses. CloudBlast and Proxmox check the rules of one direction in order and the first match wins: move a rule with the arrows on the node's Firewall tab. DigitalOcean applies every deny rule before the allow rules, so the order does not matter there. Provider prerequisites and current token permissions are checked before applying. Opfield does not enable the Proxmox cluster firewall or overwrite unrelated provider policies.

After confirmed DigitalOcean VM deletion, Opfield also removes its unused owned firewall. Cleanup checks the exact provider ID and deterministic ownership name, then refuses to delete policies still attached to droplets or tags. Shared or renamed policies are preserved and recorded in the operation result. Firewall cleanup requires provider read/delete permissions; unresolved cleanup keeps the operation pending reconciliation. A lost DELETE response is checked by ID and never blindly replayed. Merely disabling the firewall still retains its rules and policy for later reuse.

Snapshots use durable pending, ready, failed and deleting entities. Creation can run while the VM is online; application consistency still requires application-level coordination. Proxmox optionally includes RAM and can restore a running VM; other integrations require a stopped VM for restore. Storage prices are estimates where available; an unknown size or price is a dash, not zero. Snapshot folders use stable Opfield entity IDs independently of provider snapshot IDs.

Creation, deletion and restore are mutually exclusive with other VM mutations. An uncertain delete is reconciled using complete inventory of the unchanged VM. An uncertain disk-resize dispatch is not repeated; Proxmox resize checkpoints allow safe continuation between CPU/RAM configuration and disk growth.

Hosting alerts support VM power state, operation outcomes, firewall failures, account synchronization and monetary thresholds. Monetary rules require an explicit currency and separate billing access. Persisted provider observations and Redis read models feed the notification bus; stale or unavailable account data does not become a zero balance.

Hosting connectors, VM lifecycle, snapshots, firewalls and account finances are available to API tokens and OAuth/MCP grants that hold the matching `integrations:hosting:*` and `hosting:*` scopes, bounded by the token owner's live permissions. OAuth consent leaves paid, destructive and credential-bearing hosting scopes unchecked by default. See [SCOPES.md](../SCOPES.md) for the canonical scopes.

## Automating through MCP or the API

Every step above is available to API tokens and MCP agents with the same checks: MCP `manage_hosting` (toolset `hosting`), REST `/api/integrations/hosting` for accounts and `/api/hosting` for operations, nodes and VMs. An agent reads `read_opfield_documentation({ topic: "hosting" })` for the full recipe; the `provision-hosted-node` prompt and the `hosting-providers` skill summarize it. In short:

1. `connector_list`, then `catalog` for the account (`503 HOSTING_CATALOG_NOT_READY`: `connector_sync`, or wait for the background sync).
2. Confirm role, name, location, size or Proxmox resources, image and price with the user.
3. `provision` with `input: { connectorId, idempotencyKey, name, role, location, size, image, confirmedPrice }` (`POST /api/hosting/operations`). Proxmox uses the connector's host as `location`, `size: "custom"` and `cpu`, `memoryMb`, `diskGb`. Repeating a request with the same `idempotencyKey` returns the same operation.
4. Poll `operation_get` (`GET /api/hosting/operations/{id}`) until `ready` or `failed`, then check that the node is online.
5. A failed installation on a created VM: `operation_retry_install` with a new `idempotencyKey`; an uncertain outcome: `operation_reconcile`. Never order a second VM instead.

Ordering needs `integrations:hosting:view` and `hosting:resources:create` on the account plus `nodes:create`; the built-in admin group has none of the hosting scopes.

## Verification boundary

Provider fixture/contract tests are not live provider acceptance. HOSTKEY, DigitalOcean, Hetzner and CloudBlast require separately supplied test credentials and explicit spending/financial authority before real orders or invoices can be tested. Proxmox E2E should run only in a positively identified test pool with exact guest IDs, a resource limit and a cleanup/restore inventory. Never use a production VM as an implicitly disposable fixture.
