<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/opfield-banner-dark.svg">
    <img src=".github/assets/opfield-banner-light.svg" alt="Opfield: run your fleet from one field." width="880">
  </picture>
</p>

English | [Русский](README.ru.md) | [中文](README.cn.md)

**Documentation:** [docs.opfield.dev](https://docs.opfield.dev)

## Why Opfield

Opfield replaces your self-hosted infrastructure stack. Ingress, TLS, containers, deployments, failover, databases, object storage, backups, monitoring, logs, alerts, status pages, private networking, and access control: one product, one install, one permission model, one audit log.

AI Workspace turns a goal or a ready Scenario into a plan you review, and runs it only after you confirm. The Operations Console is a complete interface on its own: installing, operating, automating, and recovering Opfield never depends on AI.

With Opfield you:

- Run proxy, Docker, storage, and monitoring nodes with no inbound management ports on them.
- Give operators a UI and API for production work instead of root shell access.
- Get TLS, internal PKI, ACME certificates, domains, status pages, notifications, and audit history in one place.
- Manage Docker containers, Compose projects, deployments, `.ofca` archives, logs, files, consoles, secrets, and registries across every node.
- Automate through API tokens, OAuth, CI/CD webhooks, and MCP clients under the same scoped permissions.
- Plan a multi-step change in AI Workspace and run it after explicit confirmation.

## What Opfield Replaces

| Instead of | You get in Opfield |
|------------|--------------------|
| nginx or Traefik, certbot, cert-manager | Routes and Domains with automatic ACME certificates, internal PKI, access lists, and maintenance pages |
| Portainer and other Docker panels | Containers, Compose projects, images, volumes, networks, logs, files, and consoles on every node |
| Coolify, Dokku, Heroku-style PaaS | Git builds, deployments with slot switching and rollback, Apps with environments, Pages for static sites |
| Kubernetes for failover | Docker Availability: workloads move to another node when one fails, with no cluster to run |
| Database operators and hosted databases | Managed PostgreSQL, key-value stores, ClickHouse, and S3 object storage with availability and private links |
| Backup scripts and backup services | Scheduled database backups to S3, FTP, FTPS, or SFTP, restore that never overwrites the source, and an encrypted export that restores the whole installation |
| VPN, bastion hosts, open management ports | Secure Links and relays: nodes connect outbound, workloads and databases need no open ports |
| Prometheus, Grafana, Loki, Alertmanager | Node and container metrics, centralized logs, alert rules, and notifications |
| Statuspage, Uptime Kuma | Status pages with components and incidents |

Why each one is simpler and better: [Why Opfield](https://docs.opfield.dev/en/getting-started/why-opfield/). The host operating system and the network perimeter stay with you, and the unit of work is a container or a Compose project.

## Early Integrators

Opfield runs in product, enterprise, trading, and fintech environments at:

- [Remedy Trade](https://docs.opfield.dev/en/success-stories/remedy-trade/) — systematic trading operations.
- [Just Working](https://docs.opfield.dev/en/success-stories/just-working/) — enterprise platforms and cloud integration.
- [DFK Algotrade](https://docs.opfield.dev/en/success-stories/dfk-algotrade/) — fintech engineering and portfolio infrastructure.

## Fastest Install

Install Opfield on a Linux server with Docker:

```bash
curl -fsSL https://get.opfield.dev | bash
```

> [!IMPORTANT]
> **Production deployment note:** Opfield is a privileged infrastructure control plane. The host Docker socket mount is intentional and required for signed self-updates, recovery, housekeeping, and Opfield-managed local services. The app container is therefore part of the Docker host's trusted computing base: compromise of the app must be treated as potential host compromise. Run Opfield in an isolated VM or dedicated host, never colocate unrelated workloads or credentials on that Docker host, and do not remove or replace the socket mount with a read-only mount (the Docker API remains privileged and required operations would break).

The installer starts Opfield and prints a one-time setup code. The browser wizard then configures the canonical URL, selectable public and local node-network endpoints, one or more sign-in methods (OIDC, password, or email code), the first system administrator, optional structured logging, and optional AI Workspace. Opfield Inference is configured inside the AI Workspace flow rather than as a separate onboarding product.

Expose the ports that match your deployment:

| Port | Purpose |
|------|---------|
| `3000/tcp` | Opfield app UI/API port. For behind-NAT installs, expose this on the local network and point your external reverse proxy to it. |
| `443/tcp` | Optional public HTTPS endpoint supplied by your own reverse proxy. Opfield itself listens on `3000/tcp`. |
| `80/tcp` | HTTP and ACME HTTP-01 challenge, only if that challenge mode is used. |
| `9443/tcp` | Public relay-backed gRPC endpoint for managed daemon control and tunnel connections. The Opfield app's gRPC listener is internal. |

Behind NAT or an existing external reverse proxy, publish `3000/tcp` only on the local network and configure the external proxy to forward the public Opfield domain to the selected native HTTP or HTTPS transport on `<opfield-lan-ip>:3000`. Managed nodes still connect outbound to Opfield on `9443/tcp`; they do not need inbound management ports.

On a fresh interactive install, the only shell prompt selects native HTTPS or HTTP for port `3000`. All product configuration happens in the browser wizard; updates are non-interactive and preserve persisted settings.

For flags, non-interactive installs, custom SSL, OIDC details, updates, and node setup, read the [installation guide](docs/installation.md).

## Start Here

| Goal | Read |
|------|------|
| Understand what Opfield can manage | [Capabilities](docs/capabilities.md) |
| Install Opfield | [Installation guide](docs/installation.md) |
| Move Opfield to another host | [Configuration export and restore](docs/configuration-transfer.md) |
| Add Ingress, Docker, Build Worker, Storage, Monitoring, or Relay nodes | [Nodes and daemons](docs/nodes.md) |
| Run Storage nodes, storage connections, and database backups | [Storage and backups](docs/storage-and-backups.md) |
| Export or import Docker containers with or without an embedded image | [OFCA container archives](docs/docker-container-archives.md) |
| Configure tokens, OAuth, MCP, logging, updates, and AI | [Operations guide](docs/operations.md) |
| Configure the multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| Review the security model | [Security model](docs/security.md) |
| Verify release images, SBOMs, and signed manifests | [Verifying releases](docs/verify-releases.md) |
| Understand license tiers and activation | [Licensing](docs/licensing.md) |
| Run the project locally or contribute | [Development guide](docs/development.md) |
| Review permission scopes | [SCOPES.md](SCOPES.md) |

## Product Tour

<table>
<tr>
<td align="center"><strong>Fleet overview</strong></td>
<td align="center"><strong>AI Workspace planning</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/dashboard-overview.png" width="100%" alt="Opfield dashboard with routes, databases, nodes, health, and resource utilization"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/ai-workspace.png" width="100%" alt="AI Workspace presenting a reviewed infrastructure deployment plan"></td>
</tr>
<tr>
<td align="center"><strong>Workload and Secure Link runtime</strong></td>
<td align="center"><strong>Managed database observability</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/container-secure-link.png" width="100%" alt="Docker workload overview with Secure Link runtime metrics"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/managed-database.png" width="100%" alt="Managed PostgreSQL database health and performance overview"></td>
</tr>
<tr>
<td align="center"><strong>Ingress route and health</strong></td>
<td align="center"><strong>Distributed node inventory</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/ingress-route.png" width="100%" alt="Healthy ingress route backed by a Docker Secure Link"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/nodes.png" width="100%" alt="Opfield node inventory with ingress, Docker, database, monitoring, build, and relay roles"></td>
</tr>
</table>

## What Opfield Covers

| Area | Summary |
|------|---------|
| Ingress | Domains select a public nginx ingress node, or on Business+ an ingress group of several nginx nodes that serve the same routes and keep serving while Opfield or another member is down; routes forward traffic to addresses, Docker containers, deployments, or Pages Tags. Managed Additional Routes add path-prefix targets inside one route, while Additional Secure Link Bindings expose Docker upstreams to advanced nginx config. Includes maintenance mode, redirects, WebSockets, access lists, health checks, route folders, templates, logs, and stats. The REST API keeps `proxy-host` identifiers for compatibility. |
| Pages | Project-based static-site hosting with immutable Deployments, mutable Tags (including system-managed `latest`), custom Routes that target Tags, optional wildcard previews, no-store runtime configuration, per-project node placement, and migration. Available on Personal and higher; Business+ adds Git source builds on isolated Build Workers. Project/source metadata, build control, and publication are available through AI Workspace and MCP, while remote MCP clients can also upload artifacts through an authenticated resumable tool without passing credentials as arguments. |
| Docker | Container lifecycle, first-class single-node Compose Projects, Business+ direct Git repository/branch push-to-deploy for containers, blue/green deployments, and Compose projects, isolated Build Workers, a private-by-default Opfield-managed registry in every plan with optional Business+ external access, the Default (`runc`) runtime profile in every plan and the Secure (`runsc`/gVisor) profile in Business and Enterprise, Opfield-managed volumes, rollout/rollback, shared physical NVIDIA/AMD/Intel GPU attachment, eligible cross-node container and volume migrations, offline inventory snapshots, registries, images, networks, tasks, webhooks, logs, console, file browser, secrets, env vars, ports, and cleanup. Business+ multi-node Availability fails a workload over between Docker nodes, also while Opfield is down. Secure workloads cannot use GPU, migration, or export; GPU-attached workloads cannot migrate or export in v1. |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports, and route binding. |
| Domains | Central hostname registry, nginx ingress placement on one node or an ingress group, external or Cloudflare-managed DNS, validation, usage tracking, and explicit ingress migration. |
| Databases | Saved PostgreSQL, key-value, and ClickHouse connections with encrypted credentials, health history, browsing, scoped query consoles, and capability-aware write operations; private-by-default managed Postgres, key-value store (works with Redis clients), and ClickHouse instances can bind securely to Docker workloads through the Console, AI Workspace, or MCP. Scheduled native backups and restores run on a selected Storage node. Available on Personal and higher; since 2.11 this includes saved external connections. |
| Storage | Storage connections to AWS S3, Cloudflare R2, MinIO and other S3-compatible endpoints, FTP, FTPS, and SFTP, plus private-by-default managed SeaweedFS object storage on Storage nodes with bucket-scoped application bindings. Available on Personal and higher. |
| Monitoring | Node CPU, memory, disk, network, service status, capability-aware physical GPU telemetry, daemon runtime details, log streaming, and update checks. |
| Logging | Optional ClickHouse-backed structured log ingestion with schemas, retention, ingest tokens, rate limits, search, storage caps, and health safeguards. |
| Automation | API tokens, OAuth 2.0 PKCE, remote MCP endpoint with scoped Ingress, Pages, Databases, Docker/Compose, source-build, and Build Worker operations, readable internal Opfield documentation, CI/CD webhooks, webhook notifications, and status pages. |
| Integrations | GitLab project, repository, CI/CD, variable, webhook, registry, and sandbox workflows; GitHub repository and Actions workflows; generic Git connectors; external SSH connectors; and Cloudflare DNS/ACME automation. Connector credentials are encrypted and access is scope-gated. GitLab integration requires Personal or higher. |
| Relay | A long-lived local relay owns public `9443/tcp` for daemon control and managed tunnel traffic. Relay Pool can add remote supervisor/worker pairs, explicit placement and rebalancing, draining, and rolling signed updates while preserving one logical Secure Link. Opfield, local relay, and remote relay certificates renew while running. |
| AI Workspace | Opt-in intent-driven operations with guided Scenarios, Plan Mode, permission-aware tools, approvals, sandboxed execution, progress tracking, and final verification. Planning never performs mutations before explicit confirmation. Scenarios, Plan Mode, and sandboxed execution require Personal or higher. |
| Inference | Optional multi-provider model gateway with dedicated tokens, usage controls, capability-compatible cross-provider fallback before output begins, and OpenAI- and Anthropic-compatible APIs for Codex, Claude Code, and other harnesses. |
| Administration | OIDC, password, email-code and passkey login, group-based and per-user additional permissions, scoped programmatic access, audit logs, setup state, updates, and license controls. |

## How It Works

Opfield runs as a Docker stack on the control-plane server. Managed hosts run small Go daemons that connect outbound to Opfield over gRPC with mTLS.

```text
                Opfield server
        +-----------------------------+
        | app + relay + registry      |
        | redis                       |
        | postgres local or remote    |
        | clickhouse local/remote/off |
        | relay gRPC :9443            |
        +-------------+---------------+
                      |
                outbound mTLS
                      |
        +-------------+-------------------+
        |             |                   |
 nginx-daemon   docker-daemon     storage profile      monitoring-daemon
 ingress route  container host    databases, S3 store  metrics-only host
```

The relay is a separate long-lived container and is the only public owner of `9443/tcp`. Ordinary app-only updates keep the relay container and established managed-database binding streams running; a relay update remains an explicit data-plane maintenance event. Each Relay release names the minimum Opfield version it needs, and Opfield offers or applies a standalone relay update only once it runs that version.

Opfield checks its gRPC, web, and local relay certificates hourly and renews each one within 30 days of expiry without a restart: existing daemon and relay connections keep their current certificate, and new handshakes receive the renewed one. While node enrollment tokens are outstanding, the gRPC certificate their setup commands pin is renewed only in its last week.

Opfield can extend that local relay into one logical Relay Pool from **Settings > Relay**. Additional relay nodes are enrolled with a dedicated supervisor, keep management outbound-only to Opfield, and expose only their configured relay data endpoint (TCP `9443` by default) to participating managed hosts. Opfield does not open firewalls, provide NAT traversal, or create an overlay network. Opfield rebalances placements onto a new relay by itself once the pool is stable (or when an administrator starts **Rebalance**) and switches a workload only after its hosts reached the new relay; new connections then spread across the workload's pre-verified active relay set while the UI continues to show one logical Secure Link. Remote relay certificates renew automatically before they expire; a remote relay that cannot recover can be re-enrolled from the same page, while Opfield repairs the local relay's policy trust on its own.

In production, run at least two relays on hosts other than the Opfield host, in different failure domains. When a relay fails, its streams resume on another relay without the sockets on either end noticing; with only the local relay, Secure Links and database links depend on the Opfield host. See [How many Relays](https://docs.opfield.dev/en/nodes/relay-pool/#how-many-relays).

Nodes do not need inbound management ports. Public traffic ports, such as `80` and `443` on nginx nodes, are still required for the services you expose.

## Security Model

Opfield is secure by default:

- User login supports OIDC, password, email codes, and passkeys. Local authentication requires verified SMTP delivery, and group MFA policy is enforced after the primary credential.
- Managed nodes connect outbound to Opfield over gRPC with mTLS. First enrollment requires a one-time token plus the generated Opfield gRPC certificate fingerprint, and the daemon verifies the Opfield TLS leaf before sending the token. After enrollment, daemon commands require a client certificate issued by Opfield's internal node CA.
- Each node certificate is bound to a node identity. Opfield checks the mTLS certificate identity before accepting control streams, log streams, and certificate renewal requests.
- Nodes do not need inbound management ports. Losing Opfield access does not stop existing nginx configs or Docker containers; it only pauses centralized control.
- API tokens, OAuth grants, MCP access, database credentials, certificate exports, and secret reveal operations are scope-gated, bounded by the owning user's current permissions, and audited.
- Private key material and stored infrastructure credentials are encrypted at rest with the configured `PKI_MASTER_KEY`.

The result is a PKI-backed trust model: short-lived enrollment tokens get a node into the system only after the daemon confirms it is talking to the pinned Opfield certificate, and long-term trust is based on certificate identity rather than reusable shared secrets. The daemon never hands its setup token to an impostor, and an enrolled node is identified by its certificate, not by a reusable secret. Read the [security model](docs/security.md) for the full explanation and deployment hardening checklist.

## Verifying Releases

Every release can be checked independently:

- Opfield and its daemons install an update only after verifying its Ed25519-signed manifest against the public key compiled into them. The manifests are release assets (`*.update.json`).
- From Opfield 2.12, every published image (Opfield, relay, Secure Link connector, backup runner, patched SeaweedFS, the mirrored third-party images, and the inference core) is signed with Sigstore keyless signing by the GitHub Actions workflow that published it and recorded in the Rekor transparency log.
- Each release lists SPDX SBOMs of its images and binaries, which are also attached to the images as signed attestations.

```bash
cosign verify ghcr.io/opfield/opfield:v2.12.0 \
  --certificate-identity https://github.com/opfield/opfield/.github/workflows/release.yml@refs/tags/v2.12.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

See [Verifying releases](docs/verify-releases.md) for every image, SBOM checks, and manual manifest verification. Release notes are published with each GitHub release ([CHANGELOG.md](CHANGELOG.md)). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## FAQ

<details>
<summary><strong>Do I need Kubernetes for failover?</strong></summary>

No. Docker Availability runs a workload on a set of nodes and moves it to another node when one fails, without etcd, CNI, an ingress controller, operators, or YAML. Managed databases and object storage run on several servers and fail over to a copy automatically once a witness votes (a Relay or a third server). The unit of work is a container or a Compose project; Opfield does not run Kubernetes manifests or Helm charts.
</details>

<details>
<summary><strong>Do nodes need inbound management ports?</strong></summary>

No. Daemons connect outbound to Opfield over gRPC with mTLS. Nginx nodes still need normal public traffic ports such as `80` and `443` if they serve public sites.
</details>

<details>
<summary><strong>Can Opfield manage an existing nginx host?</strong></summary>

Yes. Install the nginx daemon in `integrate` mode. Opfield keeps your existing `nginx.conf` and injects managed includes plus a local stats endpoint. See [nginx node modes](docs/nodes.md#nginx-node-modes).
</details>

<details>
<summary><strong>Can Opfield run without ClickHouse?</strong></summary>

Yes. Choose **Disabled** for structured logging in the first-run wizard or **Settings > Features**. The rest of Opfield continues to work. Managed local ClickHouse can be disabled without deleting its data volume.
</details>

<details>
<summary><strong>Can API or OAuth tokens expose secrets?</strong></summary>

Only when the owning user already has the required scopes. Sensitive OAuth scopes require explicit opt-in during consent, API/OAuth tokens cannot exceed the user's current effective permissions, and resource-scoped write-capable scopes stay bounded to the same resource when they imply read/view checks. See [SCOPES.md](SCOPES.md).
</details>

<details>
<summary><strong>How does Opfield prevent managed nodes from being hijacked?</strong></summary>

Opfield uses its own internal PKI for daemon identity. A node setup command includes a one-time enrollment token and the Opfield gRPC certificate fingerprint. The daemon verifies the presented Opfield TLS leaf certificate before it sends the token, receives an mTLS client certificate from Opfield's node CA, deletes the token from local config, and reconnects with the certificate. Opfield then verifies the certificate identity on control streams, log streams, and renewal requests. See the [security model](docs/security.md).
</details>

<details>
<summary><strong>What happens if Opfield is offline?</strong></summary>

Managed services keep running. Existing nginx configs continue serving traffic, Docker containers continue running, and daemons reconnect when Opfield returns. Centralized UI/API control is unavailable until the app is back. Relays keep working on their last signed policy for the relay policy lease, 72 hours by default (**Settings > Relay**), and then admit no new connections until Opfield is back. Docker Availability policies in lease mode keep failing over without Opfield: in the default strict mode a copy on a node cut off from most of its policy's voters stops by design, and the next candidate takes over. See [offline behavior](docs/nodes.md#offline-behavior).
</details>

<details>
<summary><strong>Is AI Workspace required?</strong></summary>

No. AI Workspace is optional. The Operations Console, REST API, OAuth, and MCP remain independently usable, and Opfield does not send data to an AI provider until an administrator enables AI Workspace and configures a provider. Operators can start from guided Scenarios or select Plan Mode for a validated, readable plan; no mutating action runs until the user explicitly confirms implementation.
</details>

## Plans And Licensing

Opfield has four product plans. Paid plans apply to one Opfield installation and do not add per-node, per-user, or per-permission-group charges.

Opfield source is available under the [PolyForm Perimeter License 1.0.1](LICENSE.md). It permits use, modification, and redistribution for noncompeting purposes, including ordinary internal business use. A Personal, Business, or Enterprise key unlocks the corresponding paid-plan features and limits under the [Paid Key Terms](COMMERCIAL-LICENSE.md); it does not waive Perimeter's restriction on providing a product marketed as a substitute for Opfield. Competing hosted/SaaS, OEM, white-label, and resale offerings require a separate written agreement with the Licensor.

This repository is the open core: the frontend, the backend, the node daemons, the relay, and the installers. Paid-plan backend features ship as the commercial core, a separately signed package that is not in this repository. Activating a paid key installs the core that matches the running Opfield version through the signed update mechanism; Community builds and runs from this repository alone. See [Community and the commercial core](docs/commercial-core.md).

Every official release also carries the [Product Continuity Grant](CONTINUITY-GRANT.md): if Opfield stops being provided (12 consecutive months with no new release while the license service is unavailable, or an end-of-life notice) or the Licensor can no longer act, the source code of the last release, including the commercial core, becomes available to everyone under the MIT License, and holders of a valid key keep a perpetual, royalty-free right to use and self-host that release and to run it without the license service.

> [!NOTE]
> Pricing is preliminary, does not constitute an offer, and is subject to change. Confirm current pricing and terms before purchase.

| Plan | Monthly | Annual | Scale and focus |
|------|---------|--------|-----------------|
| ![Community](docs/assets/license/opfield-community-24.png)<br>Community | $0 | $0 | Core platform, AI Workspace, and Opfield Inference for internal and other noncompeting use; up to 25 managed nodes, 3 users, and 1 custom permission group; read-only Compose discovery, inventory, monitoring, and logs. Pages, databases, storage, GitLab integration, and AI Workspace Scenarios, Plan Mode, and sandboxes unavailable. |
| ![Personal](docs/assets/license/opfield-personal-24.png)<br>Personal | $29 | $290 | Unlimited managed-node/user/group plan quotas, Compose deployment and lifecycle management, container archive import/export, blue/green deployments, cross-node migration, managed databases and external database connections with backups, storage connections and managed SeaweedFS object storage, GitLab integration, AI Workspace Scenarios, Plan Mode, and sandboxes, public status pages, Pages static-site hosting, and registry discovery. Multi-node Workload Availability requires Business or Enterprise. |
| ![Business](docs/assets/license/opfield-business-24.png)<br>Business | $189 | $1,890 | Personal (including Compose management and Pages) plus Git push-to-deploy for containers, blue/green deployments, Compose Projects, and Pages with isolated Build Workers and build vulnerability policy, optional external access to the private internal registry, Docker Secure Runtime, structured logging, audit export, guided onboarding, and multi-node Workload Availability (HA). |
| ![Enterprise](docs/assets/license/opfield-enterprise-24.png)<br>Enterprise | On request | On request | Business (including Pages) plus Internal PKI, SIEM export, a dedicated technical contact, and assisted deployment and migration. |

Plans list only what ships today. Planned work, where a version is a target and not a promise:

| Planned | Target | Plans |
|---------|--------|-------|
| General Opfield CLI | 2.13 | All plans |
| Bastion / SSH management daemon | 2.14 | Business, Enterprise |
| Broader workload vulnerability and security scanning | Not set | Business, Enterprise |
| Metric autoscaling and same-node replicas | Not set | Business, Enterprise |

These Community limits, and the features above that now need Personal or higher, apply from 2.11; 2.10 Community allowed 100 managed nodes, 10 users, and 5 custom permission groups. Plan limits are checked only when something is created, so an installation already above them keeps its existing nodes, users, and groups but cannot add more while it stays at or above a limit.

See [Plans and licensing](docs/licensing.md) for the complete feature matrix, availability states, license verification, and source-license boundary.

After a paid key expires, full technical entitlements remain active for 24 hours on Personal, 3 days on Business, or 7 days on Enterprise. After that grace period, Opfield blocks creation of new paid-plan resources and other paid-only operations, but does not stop, delete, or disable already configured infrastructure. Existing services continue under the Paid Key Terms' continuity provisions. Revoked, replaced, invalid, or explicitly deactivated keys are handled separately and may disable protected entry points.

Copyright (c) 2021-2026 Alexandr Slavinschii, Republic of Moldova
