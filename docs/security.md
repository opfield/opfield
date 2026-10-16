# Security Model

[Back to README](../README.md)

Opfield is a privileged infrastructure control plane, so its security model is built around strong identity, narrow network exposure, encrypted secrets, auditable actions, and explicit permissions. Opfield makes the dangerous parts visible, authenticated, scoped, and recoverable.

## Secure-By-Default Principles

Opfield defaults to security controls that reduce the most common privately operated control-plane risks:

- First-run access is protected by a one-time, 24-hour setup code. Opfield stores only its identifier, expiry, and SHA-256 hash.
- OIDC, password, and email one-time-code sign-in are explicit administrator choices. Password hashes use the local credential store; SMTP and OIDC secrets are envelope-encrypted with `PKI_MASTER_KEY`.
- No inbound management ports on managed nodes. Daemons initiate outbound connections to Opfield.
- No long-lived daemon shared secret. First enrollment uses a one-time token plus a pinned Opfield gRPC TLS leaf fingerprint, then replaces the token with an mTLS client certificate.
- No global trust for programmatic tokens. API/OAuth scopes are bounded by the owning user's current effective permissions.
- Programmatic tokens can be limited in time and place. API tokens, inference tokens and OAuth grants take an optional expiry and an IP allowlist (up to 20 addresses or CIDR ranges), checked on every request against the client address resolved through the trusted proxies; expired tokens are refused like revoked ones and removed by housekeeping after a configurable period (7 days by default).
- No silent secret reveal. Certificate exports, database credential reveal, Docker secret access, and dangerous OAuth scopes require explicit permissions.
- New Opfield-created Docker workloads are non-privileged, add no Linux capabilities, and run with `no-new-privileges`. The optional Secure profile uses gVisor `runsc` for a stronger host-isolation boundary; it is not presented as a full virtual machine or universal syscall compatibility layer. Secure Runtime rejects Docker `NetworkMode=host` and `NetworkMode=container:*`. Its gVisor host-network backend still operates inside the Docker-created network namespace so ordinary bridge networks, published ports, and Docker service discovery continue to work; it does not place the workload in the node's host network namespace.
- New and changed container mounts can reference only Opfield-managed local Docker volumes. Opfield rejects new host bind mounts; unchanged legacy mounts can remain attached until an operator removes or migrates them.
- Git-source builds run only on nodes enrolled as Build Workers. The same `docker-daemon` binary runs in a command-restricted `builder` mode with no Docker Engine socket; it supervises dedicated BuildKit and containerd services using the standard runc runtime. Build admission fails closed unless the worker advertises execution, dedicated-runtime, and enforced-resource-profile capabilities. The separate worker host or outer unprivileged container is the security boundary and must not contain unrelated workloads or credentials.
- Repository-backed Compose projects are committed as one parent batch with one isolated child build per service. Opfield does not create or activate the immutable Compose revision until every expected child artifact passes vulnerability policy. The revision pins every service digest before apply, and active/rollback retention rotates only after the Compose operation succeeds.
- The builder accepts one untrusted job at a time, disables BuildKit's OCI worker, insecure entitlements, and CDI, and uses a dedicated containerd namespace. Its systemd units apply CPU, memory, PID, and OOM limits; the daemon monitors the combined checkout/BuildKit/containerd storage budget, destroys the workspace, and prunes shared cache before and after every job. The installer defaults to public-internet egress for ordinary package downloads while firewalling metadata, private/control-plane ranges, host-control endpoints, and the node's Opfield gRPC endpoint; an offline profile is available for regulated environments.
- Build Secrets are encrypted separately from runtime secrets, scoped to one source binding, sent only to the assigned Build Worker over the existing mTLS control channel, written as mode `0600` ephemeral files, and exposed through BuildKit secret mounts. Secret values are write-only in the API/UI, removed with the job workspace, and redacted from builder logs. Scanner SBOM data is ephemeral and is not published to the registry; build provenance is not generated.
- The internal Docker registry is private by default, available independently of paid Git build admission, and has no host-published port. Builder push and runtime pull traffic uses daemon-managed loopback proxies and short-lived repository/action-scoped Relay grants. Optional Business+ public registry access is a separate nginx ingress binding with an explicit domain and certificate; disabling it clears the external-access draft and does not change internal image references. Opfield checks the current plan, including its license grace periods, before every public registry JWT issuance, so external Docker clients lose access once the grace period ends even though the ingress binding and its settings stay in place; renewal restores access without reconfiguration.
- Multi-node workload Availability keeps Docker hosts independent and outbound-only. A repository-scoped mirror grant lets only the workload origin node copy an image into its dedicated internal repository; placement nodes receive pull-only grants. Opfield does not enable Docker Swarm, open manager/worker, gossip, VXLAN, application, database, or management listeners between Docker nodes, and does not establish node-to-node trust. Ingress and managed-database connectivity continue to use placement-owned Secure Links through the existing Relay Pool. Lease-mode failover adds no listener either: nodes exchange lease traffic only through the relays. Docker nodes run the [lease watchdog](nodes.md#lease-watchdog) as a separate root service without a network listener; it only kills the processes of a lease-mode container whose deadline record, written by the Docker daemon on tmpfs, has expired.
- Managed databases are private by default. Application bindings use Opfield-authenticated tunnels and per-binding engine identities. A published database TCP endpoint is an explicit opt-in; direct TLS is enabled by default and may be deliberately disabled per database.
- Opfield creates a dedicated Database CA at startup, separate from daemon mTLS. Each managed database receives a server certificate containing its database node's reported service IPs. Direct clients receive only the CA certificate and fingerprint; the server private key remains on the database node. Rotate the certificate after changing a node's published IPs.
- Managed database links, managed storage links, and container links run through one shared secure-link connector per Docker node. Each link has its own internal network that only its consumer joins, a stable link ID, and the daemon's existing authenticated Relay session; there is no per-link connector container and no host listener. A database workload receives only its binding-specific engine identity rather than the database owner credential.
- A container link opens exactly one port of the target, in one direction, to one consumer; the target needs no published port and cannot reach the consumer through the link. Creating one needs `docker:containers:link` on the target (`docker:compose:manage` for a Compose service), so a target owner can allow incoming links without granting any other access.
- The public daemon endpoint on `9443/tcp` is owned by a separate relay container, not the web application process. The app reaches relay control RPCs over service mTLS, and relay reaches the app's internal gRPC endpoint with its own service identity. The relay accepts forwarded node identity only from that authenticated app/relay boundary and rechecks current authorization in PostgreSQL.
- Relay database access uses a dedicated PostgreSQL role restricted to versioned security-barrier views. It cannot read encrypted credentials or mutate Opfield state. Every new binding open fails closed when the required view contract or PostgreSQL authorization check is unavailable; established streams are not closed merely because PostgreSQL is temporarily unavailable.
- Remote Relay Pool workers receive instance-bound signed policy envelopes over an independently enrolled supervisor identity. Policy revisions are replay-protected and expire after a disconnected lease configurable up to 7 days (`relayPolicyLeaseHours`, default 72 hours), so a worker keeps serving on its last known policy through an extended Opfield outage; a worker that has not yet advertised long-lease support still gets the legacy fixed 15-minute lease. Worker and supervisor updates use separately scoped signed manifests; a worker is replaced only after local readiness/version verification, and the supervisor update remains rollback-pending until Opfield verifies its reconnect.
- Binding identities are least-privilege: Key-value store bindings receive ordinary data, connection, transaction, and pub/sub commands plus explicit script execution/load commands; they cannot administer ACLs, flush/kill scripts, or manage functions. The target daemon, Relay, database daemon, and Opfield enforce per-binding/session admission caps and close idle tunnel sessions.
- Managed database lifecycle commands carry durable operation IDs. A lost command response is reconciled against daemon state before Opfield reports a terminal result, so a delayed create, resize, or delete cannot be mistaken for a different operation.
- No anonymous control plane. Administrative and automation actions are permission-gated and audited.

Opfield still needs to be treated as sensitive infrastructure. Run it in an isolated VM or dedicated host, protect `.env`, back up secrets carefully, and limit Docker socket access to trusted operators.

## Opfield Host Docker Socket Trust Boundary

The production Opfield app intentionally mounts `/var/run/docker.sock`. This is required for signed self-update orchestration, foundation migration and recovery, image pruning and registry maintenance, and Opfield-managed local services. It is not an accidental convenience mount and it is not expected to provide a security boundary between the app container and its Docker host.

Docker Engine authorization is carried by access to the socket itself. A read-only bind mount does not make Docker API operations read-only, and a process with Docker API access can generally obtain host-level control. Opfield therefore treats the app container and its dedicated Docker host as one trusted computing base. An application-level compromise must be handled as a potential compromise of that host.

The supported production control is host isolation: install Opfield in its own VM or dedicated machine, do not run customer workloads or unrelated control planes on the same Docker host, restrict host login and Docker-group membership, and keep the signed update chain enabled. Removing the socket mount is not a supported hardening mode because it breaks self-update, recovery, and managed-service lifecycle paths. An organization that requires the control-plane process to have no host Docker authority must place Opfield in a dedicated VM whose only purpose is running Opfield; the VM boundary is the isolation boundary.

## Identity And Login

Opfield can enable OIDC, password, and email one-time-code sign-in independently. Email-based methods require a verified SMTP configuration. Users may add passkeys after setup; passkeys are not a first-run primary method.

The browser wizard creates exactly one deliberate first administrator in the built-in `system-admin` group. No arbitrary first OIDC login is promoted. Later OIDC users follow the configured auto-provisioning and default-group policy.

The installer prints a random one-time setup code and never writes its plaintext to `.env` or the database. A successful code exchange creates an HTTP-only setup session bounded by the same 24-hour expiry. Product APIs stay locked until the wizard has an explicit public URL, at least one sign-in method, and the first administrator. Completing setup removes the code and setup sessions. The printed reset command reopens setup, invalidates browser/setup sessions, and issues a new code.

Opfield binds OIDC users by the provider subject (`sub`) after first login. Manually pre-created users are initially claimed by matching the email asserted by the configured OIDC provider, so this flow assumes the provider is enterprise-controlled and authoritative for email assignment. Administrators can enable **Require verified OIDC email** to require `email_verified=true` for future auto-created users and pre-created user claims. Existing subject-bound users continue to authenticate by `sub`; when verified-email mode is enabled, Opfield does not replace a stored email with a changed unverified email claim.

## Node Trust Uses PKI And mTLS

Managed hosts run small daemons for nginx, Docker, or monitoring. Those daemons do not expose a management API to the network. Instead, they connect outbound to Opfield's dedicated relay on the gRPC control-plane port, normally `9443/tcp`. Opfield daemon gRPC is always TLS; there is no plaintext development or production mode. The daemon keeps one control connection and one independent long-lived tunnel connection so an app-only restart does not tear down binding traffic.

Relay nodes are the deliberate exception to the no-inbound-service-port rule: their management channel is still outbound-only, but their advertised mTLS data endpoint must accept traffic from participating managed hosts. Opfield neither changes firewall rules nor claims that a public/NATed endpoint is reachable; staged assignments activate only after target registration and source-side probes succeed.

Long-term daemon trust is based on Opfield's internal node PKI:

1. An operator creates a node in Opfield.
2. Opfield creates a one-time enrollment token, stores only a hash, and returns the current Opfield gRPC TLS leaf certificate fingerprint as `opfieldCertSha256`.
3. The setup command writes the token and fingerprint to daemon config as `opfield.token` and `opfield.cert_sha256`.
4. The unenrolled daemon connects to Opfield and verifies the presented TLS leaf certificate matches `opfield.cert_sha256`.
5. Only after that fingerprint check passes, the daemon sends the enrollment token.
6. Opfield validates the token and issues a node client certificate from the internal Opfield Node CA.
7. The daemon writes the CA certificate, client certificate, and private key to its local config path.
8. The daemon clears the enrollment token and reconnects using mTLS.
9. Opfield identifies the node from the verified mTLS client certificate.

After enrollment, the token is not the node's identity. The certificate is.

Opfield normally auto-issues its gRPC server certificate from the internal system CA and stores it under `GRPC_TLS_AUTO_DIR` (`/var/lib/gateway/tls` by default). The auto-issued certificate includes localhost, the Opfield host name, the persisted canonical public host, discovered host IP addresses, and `GRPC_TLS_EXTRA_SANS`. The optional native HTTPS listener receives a separate `gateway-web` leaf from this same CA. Custom `GRPC_TLS_CERT` and `GRPC_TLS_KEY` paths are advanced configuration and must point to a server certificate issued by the Opfield system CA, because enrolled daemons trust that CA for ongoing mTLS connections.

## Why This Prevents Node Hijacking

A reusable shared secret is easy to copy, leak, or leave behind. Opfield avoids that pattern:

- Enrollment tokens are one-time setup material and are removed from daemon config after use.
- Enrollment tokens are sent only after the daemon verifies the pinned Opfield gRPC TLS leaf fingerprint, so a DNS/proxy/path mistake cannot silently disclose the token to a different TLS endpoint.
- Each daemon gets a unique client certificate.
- The client certificate common name is the Opfield node ID.
- Opfield verifies that the certificate identity matches the node claiming the stream.
- Control streams and log streams require a verified client certificate.
- Certificate renewal requires the existing certificate and is checked against the connected node identity.
- Deleting a node revokes its mTLS certificate so the old daemon cannot reconnect as that node.

This gives every node a cryptographic identity anchored in Opfield's internal CA. A random host cannot join the fleet without a valid enrollment token and the matching Opfield certificate endpoint, and an enrolled daemon cannot impersonate a different node without that node's private key.

For best enrollment assurance, run the setup command against a direct Opfield `9443/tcp` endpoint that you control. If the web UI is behind Cloudflare or another proxy, you may replace `--opfield <host>:9443` with the direct Opfield host/IP for daemon enrollment, but keep the generated `--opfield-cert-sha256` value. Replacing the fingerprint defeats the pin and should only happen after creating a new node command from the Opfield UI/API.

## PKI Responsibilities

Opfield maintains separate certificate domains:

- System node CA for daemon mTLS identity.
- Internal PKI for user-managed roots, intermediates, templates, and issued certificates.
- SSL certificate store for ACME, uploaded, or linked certificates used by ingress routes. Opfield keeps canonical encrypted material and distributes node-local replicas only to nginx nodes with active TLS routes.

Private key material is encrypted at rest with `PKI_MASTER_KEY`. That key is critical: without it, Opfield cannot decrypt stored PKI material or private keys. Protect it like a root secret and include it in secure backups.

Opfield also supports certificate lifecycle operations:

- CA and certificate creation.
- Certificate issuance from templates.
- Revocation.
- Expiry tracking and alerts.
- ACME certificate issuance and renewal.
- Daemon mTLS certificate renewal before expiry.

## Authorization And Scopes

Opfield separates authentication from authorization.

Authentication answers who the user or daemon is. Authorization answers what that identity can do.

Authorization uses granular scopes:

- Users receive scopes through permission groups.
- API tokens and OAuth grants cannot exceed the owning user's current effective scopes.
- MCP access requires the owning user to have the `mcp:use` capability.
- Resource-scoped grants can limit access to a specific node, Docker container or deployment, ingress route (`proxy_host` in API identifiers), database, logging environment, schema, or similar resource.
- Folder grants (`<scope>:folder/<folderId>`) cover a folder, its subfolders, and every resource inside them, and nothing outside; node-bound families and every creation scope also accept `<scope>:node/<nodeId>`. API tokens and OAuth/MCP grants expand their own folder and node grants first and are then bounded by the owner's current permissions, so a token never reaches a resource its owner cannot (see [Scope Evaluation Behavior](../SCOPES.md#scope-evaluation-behavior)).
- Git integration scopes can be limited to one connected account and, below it, to GitLab groups and projects or GitHub owners and repositories (see [Git Integration Restrictions](../SCOPES.md#git-integration-restrictions)).
- External Docker clients use an Opfield API token with internal registry access, a property of the token chosen when it is created: pull (the owner can view a Docker workload or image) or pull and push (the owner can edit or manage a workload), each for every repository or for listed repository names. Every registry login rechecks the owner's current permissions. Older tokens with `docker:registries:internal:pull`/`:push` scopes keep that access.
- Creation scopes (`*:create*`, `docker:images:pull`, `ssl:cert:issue`, `pki:cert:issue`) imply no view. Every other action scope, including delete, implies its family's view scope with the same qualifier, so resource-scoped grants stay bounded to the same resource (see [SCOPES.md](../SCOPES.md#scope-evaluation-behavior)).

Sensitive operations have dedicated scopes. Examples include Docker mount editing, Docker secret reveal, database credential reveal, certificate export, node console access, container file access, raw nginx validation bypass, and audit log access. Managed databases reuse the database create, edit, delete, and credential-reveal scopes, and linking a workload to a managed database or storage cluster needs `databases:bind` or `storage:bind` on it plus the workload's environment and secrets scopes; generated binding secrets are not displayed by default.

Attaching an Opfield-managed volume needs `docker:volumes:view` on that volume as well as the workload's own create or edit, so a workload cannot mount another team's volume. Changing legacy host bind mounts is guarded by `docker:containers:mounts`, but the scope does not bypass the managed-storage policy. New or changed mounts must reference Opfield-managed local volumes, and new host bind mounts are rejected. Existing legacy mounts are preserved by ordinary updates; a legacy local volume can be adopted only when it uses the local driver, local scope, and no driver options.

For the complete scope list and implication rules, see [SCOPES.md](../SCOPES.md).

## Programmatic Access

Opfield intentionally separates token families:

| Token | Purpose |
|-------|---------|
| `opf_` | REST API automation token. |
| `opfo_` | OAuth access token for one resource, either Opfield API or Opfield MCP. |
| `opfl_` | Write-only structured logging ingest token. |
| `opfi_` | Dedicated Opfield Inference runtime token. |

Tokens issued before 2.12.1 start with `gw_`, `gwo_`, `gwl_` or `gwi_` and keep working until they are revoked or expire.

REST API tokens are not accepted by the MCP endpoint. MCP accepts only OAuth access tokens issued for the Opfield MCP resource. Logging ingest tokens can write logs only to their logging environment. Inference data-plane routes accept only `opfi_` tokens and reject browser sessions plus `opf_`, `opfo_`, and `opfl_` credentials.

API tokens and OAuth/MCP grants may carry every scope except the user-only AI Workspace, AI sandbox, and `mcp:use` scopes, `admin:users:impersonate`, and `integrations:gitlab:sandbox:clone`. Delegated scopes are always bounded by the owner's live permissions, and a token can never create API tokens or OAuth authorizations. Identity-bound routes (sign-in, MFA, passkeys, own sessions, impersonation start, OAuth consent, token management, AI Workspace chat) require a browser session.

OAuth consent also treats dangerous scopes differently: high-risk scopes, including user/group administration, `admin:system`, Opfield settings edits, raw nginx and node config writes, paid or destructive hosting actions, and system connector credentials, are visible but unchecked by default and must be explicitly selected.

Opfield keeps dynamic OAuth registration enabled for local public-client UX, but defaults registration and authorization to loopback callbacks only. External HTTPS callbacks require the explicit OAuth extended callback compatibility setting, and the consent screen marks those requests with an additional high-risk warning.

## Secret Handling

Opfield stores several kinds of sensitive data:

- PKI private keys.
- SSL private keys.
- Database connection credentials.
- Docker/deployment secrets.
- API, OAuth, and logging token hashes or encrypted values.
- License key material.

Sensitive values are encrypted where the product needs to recover them, and hashed where Opfield only needs to verify them. UI and API responses avoid returning raw secrets unless the caller has the explicit reveal/export scope for that operation.

External PostgreSQL and key-value connections over TLS verify the server certificate chain and host name, optionally against a private CA stored with the connection. Connections saved before 2.11 never verified it and stay explicitly unverified, with a warning, until an operator adds the CA or enables verification; see [Databases](capabilities.md#databases).

Docker registry credentials are sent to a Bearer token service only when the challenge realm is on the same HTTPS registry host or matches the registry's explicitly configured trusted HTTPS token-service origin.

## Network Exposure

Network exposure is narrow:

- Public users reach Opfield UI/API over HTTPS.
- Daemons connect outbound to Opfield gRPC on `9443/tcp`.
- Managed nodes do not need inbound SSH or daemon management ports for Opfield.
- Nginx nodes still expose normal service traffic ports, typically `80/tcp` and `443/tcp`.

For webhook delivery, Opfield has outbound network policy controls. Loopback, link-local, multicast, reserved outbound ranges, and Opfield self addresses are always blocked. Private destinations are allowed only when private-network delivery is enabled and every resolved address matches an administrator-configured CIDR; the default allowlist is `10.0.0.0/8` and `172.16.0.0/12`. This policy is not gated by the product license tier.

## Auditability

Opfield records administrative and automation actions in the audit log. When something goes wrong, the audit log shows who changed what.

Examples of audited areas include:

- User and group changes.
- Node enrollment and management.
- API token and OAuth authorization actions.
- Proxy, certificate, Docker, database, notification, logging, and AI-assisted operations.

Use audit log export when you need external retention or compliance workflows.

## SIEM Audit Export

SIEM export is outbound HTTPS push from Opfield to an authenticated collector; it is not an inbound webhook that lets a collector call Opfield. Each exported record is deliberately narrower than an audit-log record: it includes an event id, Opfield installation source, timestamp, action, optional actor id/email, resource type/id, and source IP. Full audit `details`, resource display names, user agents, request payloads, credentials, secrets, and collector response bodies are never exported.

The SIEM feature flag is enabled by default where the Enterprise `siem-export` entitlement is available. In **Settings > General > Features and updates**, disabling **SIEM audit export** hides the SIEM screens, blocks the SIEM API and AI tools, prevents new audit events from entering the SIEM outbox, and pauses the delivery scheduler. Destination configuration, delivery history, and already queued records are retained; queued records resume when SIEM is enabled again. SIEM forwarding also runs through every license grace period and pauses once it ends: new audit events are not queued and the scheduler sends nothing, while the feature flag, destinations, history, and queued records stay unchanged and resume on renewal. Existing destinations and deliveries stay viewable and deletable after the grace period; creating, changing, testing, and replaying need the current plan.

Destinations require HTTPS without URL credentials, query strings, or fragments. They reuse the outbound-webhook policy: unsafe address ranges are blocked unless explicitly permitted, DNS addresses are pinned for each request, and redirects are not followed. Each destination uses bearer-token, HMAC-SHA256, or validated custom-header authentication; its secret or custom-header value is envelope-encrypted at rest and is never returned through the UI, API, audit log, AI tools, or application logs. Custom header names must be valid HTTP field names and cannot override Opfield transport headers such as `Host`, `Content-Type`, or `X-Opfield-*`; `Authorization` remains available for collectors with a non-Bearer scheme.

For HMAC-SHA256, Opfield sends `X-Opfield-Timestamp` and `X-Opfield-Signature-256: sha256=<hex>`, where the signature is calculated over `timestamp + "." + raw JSON request body`. A collector must verify the exact raw body, compare the HMAC in constant time, and reject stale timestamps to limit replay.

`audit:siem:view` allows destination and delivery-history visibility. `audit:siem:manage` controls configuration, tests, deletion, and replay of failed records; it is an explicit OAuth consent scope. Disabling an individual destination pauses its outstanding work (kept for 7 days), deletion discards outstanding work, and only terminal failed records may be replayed. Every delivery record, sent or not, is removed once it is older than the Audit Log retention.

## Operational Hardening Checklist

Use this baseline for production:

- Run Opfield on an isolated VM or dedicated host.
- Do not run unrelated workloads on the same Docker host.
- Use HTTPS for the UI/API.
- Use an OIDC provider with MFA.
- Protect `.env`, `PKI_MASTER_KEY`, database credentials, and OIDC client secret.
- Keep Redis healthy and monitored. Opfield treats Redis as required security infrastructure for sessions and rate limiting; Redis-backed limiter failures fail closed with `503` instead of allowing unchecked traffic.
- Back up PostgreSQL, Redis data if needed, ClickHouse data if logging is enabled, custom TLS files, and `PKI_MASTER_KEY`.
- Limit `admin:system`, update, secret reveal, certificate export, console, and file-access scopes to trusted operators.
- On nodes where nobody should reach the host through Opfield, set `console.enabled: false` and `files.enabled: false` in the daemon config (or install with `--disable-console --disable-files`). Opfield cannot turn these back on remotely. To remove host access, disable both: with only the console off, writing files as the daemon user (root by default) can still run code on the host through systemd units, cron jobs, or `authorized_keys`, and can rewrite the daemon config to turn the console back on. See [Host Console And File Access](nodes.md#host-console-and-file-access).
- For a relay on a machine that belongs to someone else, install it with `--protected` (or run `relay-supervisor protected on` there and restart the relay supervisor). The relay then refuses console, file access, command execution and host diagnostics from Opfield, and accepts only official signed updates to the same or a newer release. Only the machine owner can turn it off. See [Protected Relays](nodes.md#protected-relays).
- Keep daemon setup tokens and generated fingerprints short-lived operationally: copy once, enroll, and do not store setup commands in tickets or chat.
- Enroll daemons against a direct trusted `9443/tcp` Opfield endpoint, and keep the generated `--opfield-cert-sha256` value when changing only the endpoint host.
- Keep Opfield and daemons updated through signed release manifests. Automatic updates fail closed when the manifest is missing, invalid, or does not match the exact Opfield image digest or daemon binary checksum.
- Review audit logs after sensitive changes.

## Threat Model Notes

Opfield reduces the risk of node hijacking by pinning first enrollment to the generated Opfield gRPC TLS leaf fingerprint, replacing setup tokens with per-node mTLS certificates, verifying certificate identity on daemon streams, and revoking node certificates on deletion. This is the security property operators should care about most: initial token submission depends on reaching the expected Opfield certificate, and ongoing control of a managed node depends on possession of that node's private key and a certificate that Opfield issued for that exact node identity.

Opfield and daemon self-updates use a compiled Ed25519 public key to verify signed release manifests. The private update signing key must live only in CI as `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64`; it must not be stored in the repository, `.env`, tickets, or chat. Opfield image updates are installed by signed digest, and daemon binary updates are installed only after signed-manifest and SHA256 verification.

License states are signed separately. Each Opfield release pins the license server's Ed25519 public keys by key ID in `modules/license/license-attestation.ts` and applies a license state only when it is signed by a pinned key for this installation, for the request that asked for it (purpose and a random per-request nonce), and within 15 minutes of the local clock. Redirecting the license server hostname, replaying a captured response, or copying another installation's state therefore cannot unlock a plan; Opfield rejects such a response and keeps its last valid signed state, with the ordinary 100-day offline grace counted from that state's signed issue time. Stored license states are verified again on every read, so editing the cached license in the database does not raise the plan. The license server's private signing keys live only in its `LICENSE_SIGNING_KEYS` secret. This protects official, unmodified releases; an operator who modifies Opfield's source to skip these checks is outside what signatures can prevent and violates the Paid Key Terms.

Host security stays with you:

- A root compromise of the Opfield host can compromise the control plane.
- A root compromise of a managed host can access that daemon's local certificate and whatever the host itself can access.
- Losing `PKI_MASTER_KEY` means encrypted PKI and private key material cannot be decrypted.
- The production Docker socket mount is an intentional product requirement, not an accidental exposure. It makes the Opfield app and Docker host one trust domain, so Opfield must run on isolated infrastructure.

Every infrastructure control plane has these boundaries. Opfield makes them explicit and keeps access narrow, observable, and PKI-backed.
