import { OPFIELD_ABOUT_MARKDOWN } from './opfield-about.js';

export const GUIDE_DOCS: Record<string, string> = {
  overview: `# Opfield Overview

${OPFIELD_ABOUT_MARKDOWN}

## Main Capabilities
- **Access and administration**: groups, scopes, resource-scoped permissions, audit logs, OIDC/password/email-code sign-in, passkeys, API tokens, OAuth, and MCP.
- **Traffic, Pages, and certificates**: nginx ingress nodes, proxy/redirect/404 routes, Pages Projects/Deployments/Tags, access lists, PKI, uploaded/internal/ACME certificates, and external or Cloudflare-managed domains.
- **Compute**: Docker nodes, containers, Compose projects, images, volumes, networks, private registries, webhooks, blue/green deployments, exports/imports, and migrations.
- **Storage, databases, and logging**: external and managed S3-compatible storage plus FTP/FTPS/SFTP connections; unified Storage nodes for managed object storage and databases; saved PostgreSQL, key-value (Redis protocol), and ClickHouse connections; optional structured logging in managed or external ClickHouse.
- **Operations**: daemon and Relay Pool health, notifications, housekeeping, status pages, updates, licensing, GitLab/GitHub/generic Git/external SSH/Cloudflare integrations, and a separate Opfield Inference service.
- **Hosting**: hosting accounts at HOSTKEY, DigitalOcean, Hetzner Cloud, CloudBlast, and Proxmox VE (one connector per physical host). Opfield orders the VM, installs the node of the chosen role, and manages power, resize, snapshots, and firewall afterwards (manage_hosting, topic hosting).

## Availability Boundaries
Single-node first-class Compose Projects provide read-only discovery, monitoring, and logs on Community and every paid plan; deployment and lifecycle management require Personal or higher. Workload Availability (HA) is available on Business and Enterprise for mount-free Containers, Deployments, and whole Compose Projects: 2–32 replicas or one serving placement with failover across independent Docker nodes, without Swarm or an overlay. It does not provide HA for Opfield itself, nginx, registry storage, or shared volumes. Metric autoscaling and multiple instances on the same node remain in development.

Storage connections, managed object storage, managed-database backup/restore, and their private workload links are implemented operations. They remain subject to the configured license, feature entitlement, and the current user storage or database scopes. Moving Opfield itself to another host is the configuration export (manage_configuration_export, Settings > General) restored in the setup wizard or with install.sh --restore; it is separate from these backups.

The general Opfield CLI (distinct from the existing Opfield Inference CLI) is expected in 2.13 on every plan. Broader workload vulnerability and security scanning is expected in 2.14 on Business and Enterprise. The plugin system is unimplemented core infrastructure, not a plan feature; its tentative timing is no earlier than 2.20 and is uncertain.

## How To Guide A User
Start with the user goal, then read the focused topic before explaining a workflow or calling tools. Use installation for a new deployment, authentication for access/sign-in questions, opfield-settings for control-plane settings and MCP, nodes for adding an existing server, hosting for creating a new server (a VM at a cloud provider or on Proxmox) as a node, relays for the Relay Pool, integrations for GitHub, generic Git, and external SSH, apps for applications and environments, and troubleshooting for failures. A feature being described here does not grant permission to view or change it; always respect the user's scopes and confirm destructive changes.

## Dashboard Attention And Pins
- The Dashboard sidebar item can show a **12px square attention badge**. Blue means the Dashboard has only informational cards, such as an unfinished setup checklist. Yellow means at least one warning card is visible; this includes red/unhealthy resource states, certificate expiry, low node capacity, MFA reminders, update/logging/inference warnings, and unhealthy pinned database or Docker resources. No badge means there are no visible information or warning cards for the current user.
- The Dashboard is one user-scoped bootstrap snapshot. Do not describe the badge as an unread notification count or as a system-wide state: it reflects only cards visible to the signed-in user and their permissions.
- Nodes, routes, databases, Docker containers, and Docker deployments can each be pinned independently to the **Dashboard**, the **Sidebar**, or both. A Dashboard pin adds a compact card; a Sidebar pin adds a quick-access link. Removing one placement must not remove the other.
- When a user asks where to pin something, explain this distinction and recommend Dashboard for operational status and Sidebar for frequent navigation.
- In the embedded Opfield Assistant, resolve the resource with \`find_resource\` first, then use \`set_resource_pin\` with an explicit \`target\` and \`pinned\` value. Docker pins also need \`nodeId\`, \`nodeSlug\`, and the resource \`name\`. This tool changes only the current browser session's saved layout preference and is intentionally unavailable through MCP.`,

  installation: `# Installing And First-Time Setup

## Install
Use the release installer. It installs Opfield and starts it with native HTTPS by default. Supported installer options are --install-dir, --image, --source-dir, --http, --https, and --dry-run. The installer does not collect a domain, nginx, Cloudflare, OIDC, SMTP, or ClickHouse configuration.

## Browser Setup Wizard
After the stack becomes healthy, the installer prints the Opfield URL, System CA SHA-256 fingerprint, a one-time setup code valid for 24 hours, and a reset command. The plaintext code appears only in installer output. Until the wizard completes, normal product and auth APIs return SETUP_REQUIRED.

The wizard requires:
1. An explicit canonical public URL.
2. One sign-in option: Opfield account (Connect with Opfield account at the account portal, or a CLD code from account.opfield.dev > Installations > Add; the person who connects it becomes the first administrator and the installation needs outbound HTTPS to the portal), your own OIDC provider (provider settings plus the administrator's name and email), or a password with an authenticator app (the administrator is created with the password and enrols the app before setup can finish; the system-admin group then requires a second factor; an email code may be added next to it, which needs verified SMTP). A password without a second factor is not offered in setup.
3. Structured logging mode: disabled, Opfield-managed local ClickHouse, or external ClickHouse.

## HTTPS And Reverse Proxy
Native HTTP and HTTPS both listen on port 3000. Native HTTPS uses an Opfield System CA leaf certificate. A reverse proxy may connect over either protocol; when it verifies the HTTPS upstream, configure it to trust the Opfield System CA. Public certificates, DNS, Cloudflare, and ACME are configured after setup, not by the installer or wizard.

## Safe Advice
Never ask a user to paste a setup code, password, API token, private key, or SMTP/OIDC secret into chat. Explain where it is entered in the UI instead. For a failed install or wizard, use the troubleshooting topic before suggesting recovery steps.`,

  authentication: `# Authentication And User Access

## Sign-In Methods
Opfield can enable OIDC, password, and email one-time-code sign-in independently. Email-code sign-in requires verified SMTP; setup offers a password only with an authenticator app. Passkeys can be added by an already signed-in user and are not a first-run primary method.

## First Administrator
The browser setup wizard creates exactly one explicit first administrator in the built-in system-admin group. Opfield does not promote an arbitrary first OIDC user; with the Opfield account option it is the portal user who connected the installation, bound on their first Opfield account sign-in with that email. The setup code is one-time and expires after 24 hours; it must not be shared or stored in chat.

## Admin Recovery
A system administrator locked out of their sign-in runs \`docker compose exec app node dist/cli/admin-recovery-link.js [--email <admin email>]\` on the Opfield host (default: the owner). It prints one JSON line with a one-time link (30 minutes, single use) that signs them in without their provider or second factor and opens Profile > Account security; the sign-in is audited as auth.recovery_sign_in. Never ask for the link in chat.

## OIDC
Configure issuer URL, client ID, client secret, requested scopes, optional automatic user creation, default group, and optional verified-email enforcement in Opfield settings. OIDC users are bound to their provider subject after the first login. When verified-email enforcement is enabled, Opfield requires the provider's verified-email assertion for future auto-provisioning and matching flows. The OIDC provider panel can also remove the provider (OIDC sign-in turns off) and, on an installation connected to Opfield Cloud (managed or self-hosted), set up the "Opfield account" provider with **Use Opfield account**: at once when the cloud already gave a client, otherwise after the Opfield account answers the request (the panel shows Waiting for your Opfield account and a Cancel request button). Managed installations follow the same sign-in rules as self-hosted ones; any change after which no administrator could sign in is refused.

## Accounts And Permissions
Each user belongs to one permission group and may have permitted per-user scope overrides. Groups, scopes, resource restrictions, API tokens, OAuth authorizations, and MCP access determine what a user can do. Do not imply that a successful sign-in grants administration access.

## Support Rules
Use the Login/Profile UI for password, email-code, passkey, and token flows. Do not reveal, request, or copy secrets. If authentication is unavailable, check SMTP/OIDC configuration, the canonical URL, and the relevant audit or application logs; use troubleshooting for the ordered diagnostic path.`,

  cloudflare: `# Cloudflare Integration

Opfield Cloudflare connectors securely store an encrypted API token, synchronize available DNS zones, and support Opfield domain management plus automated DNS-01 ACME flows.

## Setup
Create a connector in the Cloudflare integration UI or through the authenticated Opfield API, provide a token with only the required zone and DNS permissions, then test and synchronize it. Do not ask users to paste the token into chat and do not expose its value after creation.

## What It Enables
- Opfield domains can create, adopt, inspect, and—when authorized—delete Cloudflare A/AAAA records.
- DNS-01 certificates can create and clean up TXT records automatically when one enabled connector has an unambiguous matching zone.
- A wildcard certificate or a deployment where port 80 is unavailable usually needs DNS-01.

## Constraints And Diagnostics
If no enabled connector has a matching zone, DNS-01 cannot be automated. If several connectors match, resolve the ambiguity rather than choosing one silently. Existing DNS records with a different target require explicit approval before overwrite. Use connector test/sync, zone status, and DNS propagation checks before retrying certificate issuance. If the API token is already present in the user's current request, create_cloudflare_connector can create the connector under approval; otherwise open the concrete Cloudflare setup flow and keep the secret out of chat history.`,

  'docker-registries': `# Docker Registries

Opfield stores private Docker registry credentials encrypted at rest. A registry may be global or restricted to a specific Docker node; use only a registry available to the selected node when pulling, recreating, or deploying an image.

The Opfield-managed internal Distribution registry is separate from user-saved registry credentials. It has no host-published port by default, keeps three successful artifacts plus live pins, and is configured under Settings > Features. Do not ask for a domain unless the user explicitly wants external Docker-client access; internal builder/runtime traffic uses scoped daemon-managed Relay bindings.

Public Docker Hub images such as \`nginx:alpine\` do not require a saved registry. Pull them directly with \`registryId\` omitted. Never create a manual Docker Hub registry merely to pull a public image, and never pass an empty string as \`registryId\`.

## Configuration
Use manage_docker_registry (or the Docker registry UI and REST API) to list, get, create, update, delete, or test a saved registry (test_direct checks a registry before saving it). Viewing requires docker:registries:view; create, edit, and delete operations require the corresponding docker:registries scope. Integration-managed registry records, such as GitLab-provided credentials, cannot be edited as ordinary registries. The internal registry uses internal_get, internal_repositories, internal_update_settings (storage on the local volume or an S3 bucket, external access hostname, nginx node, certificate), internal_gc (garbage collection, optionally dryRun), and internal_resume_maintenance; reads need broad docker:registries:view and changes broad docker:registries:edit.

## Safe Use
Credentials are never returned after storage and must not be pasted into chat, logs, templates, or container environment variables. For Bearer token authentication, Opfield sends credentials only to a token service on the same HTTPS registry host or an explicitly configured trusted HTTPS token-service origin. Do not weaken this protection merely to make a pull succeed.

## Troubleshooting
First confirm the registry is enabled, available for the selected node, and passes its connection test. Then verify the image reference and node connectivity. A missing-credential failure may mean a GitLab integration exists but has no usable registry credentials; configure it in the integration rather than replacing it with an unrelated secret.`,

  clickhouse: `# ClickHouse In Opfield

Opfield supports ClickHouse as a saved external database connection, an Opfield-managed database instance on a dedicated Storage node, or the optional structured-logging backend.

## Access And Connectivity
External ClickHouse connections require an HTTP(S) URL or host plus database and username. Managed instances are private by default. Application bindings use the private connector and authenticated Opfield tunnel; do not present a binding as direct TCP access or disclose its injected credentials.

Published managed ClickHouse uses TLS and exposes HTTPS plus a native TLS endpoint. Opfield provides the Database CA certificate/fingerprint with direct credentials and supports certificate rotation after a node IP change. Publishing is an explicit infrastructure choice, not a default.

## Data Operations
Opfield provides schema/table browsing, a SQL console, monitoring, and conditional row operations when the selected table supports them. Do not promise arbitrary inline updates or deletes: ClickHouse mutations can be unsupported for a table and must fail closed. Do not use database tools to claim that Opfield can deploy, bind, publish, or reveal managed-instance credentials unless a matching guarded operation is available.

## Structured Logging
Structured logging can be disabled, use Opfield-managed local ClickHouse, or use an external ClickHouse connection. It is configured separately from ordinary saved database connections in Opfield settings.`,

  troubleshooting: `# Opfield Troubleshooting

## Start With Evidence
Identify the failing surface, read its focused internal topic, and inspect the current Opfield state before proposing a change. Do not ask for or expose secrets, raw credentials, private keys, setup codes, full daemon errors, or unredacted logs. Prefer health/status tools, audit records, and sanitized operational logs.

## First Setup Or Sign-In
- Setup blocked: confirm the one-time setup code is within its 24-hour lifetime and use the installer-provided reset command when it has expired. Normal APIs remain locked until the wizard completes.
- Sign-in failure: distinguish OIDC, password, and email-code methods. Check OIDC issuer/client settings and verified-email policy, or verified SMTP for email-based sign-in. Do not claim OIDC is mandatory.
- Browser URL problem: confirm the explicit canonical URL and whether the browser reaches Opfield directly or through a reverse proxy. Native HTTP/HTTPS use port 3000.

## Opfield Itself
- Slow UI or API, a failing background job, database or cache trouble, or a failed update: read manage_opfield_diagnostics snapshot first, then history for the time window (48 hours of one-minute samples) and requests for the routes involved.
- Read Opfield's own logs with manage_opfield_diagnostics logs (scope diagnostics:logs): source app for the backend, update for the last update run, or postgres, redis, relay, registry. Filter by level, text, context or requestId and a since/until window rather than reading everything.

## Nodes, Ingress, And Certificates
- Offline node: inspect node health and reconnect status before retrying a mutation.
- Route failure: verify its nginx ingress node, domain affinity, upstream reachability, published Docker port where applicable, and rendered configuration. Do not disable a route to imitate maintenance mode.
- ACME failure: for HTTP-01 verify public port 80 and DNS; for DNS-01 verify the matching Cloudflare connector/zone and TXT propagation. Use staging for safe certificate-flow tests.

## Docker, Databases, And Integrations
- Docker pull failure: validate the node, image reference, registry availability, and registry credentials before changing a registry trust policy.
- Database failure: distinguish a saved external connection from a private managed instance. Check health and TLS/connection settings; do not copy binding credentials or publish an endpoint as a workaround.
- Cloudflare failure: test and synchronize the connector, then resolve missing or ambiguous zones explicitly.

## Escalation
If evidence is insufficient, state what could be verified and direct an administrator with the needed scope to the relevant UI or logs. Never invent a successful recovery, current version, or available tool.`,
};
