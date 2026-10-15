# Installation Guide

[Back to README](../README.md)

Opfield installs as a small Docker Compose stack containing the application, a long-lived daemon relay, PostgreSQL, and Redis. Product configuration belongs to Opfield itself and is completed in the browser.

## Requirements

| Profile | CPU | Memory | Free SSD capacity |
|---------|-----|--------|-------------------|
| Minimum | 2 vCPU | 4 GB RAM | 32 GB |
| Recommended | 4 vCPU | 8 GB RAM | 64 GB |

The disk figures are free capacity after the operating system is installed. When Opfield-managed local ClickHouse logging is enabled, reserve an additional 32 GB minimum or 128 GB recommended. Actual logging storage depends on ingest volume and retention. External ClickHouse requires no additional local logging storage on the Opfield host.

- Linux with Docker Engine and Docker Compose v2.
- OpenSSL and curl.
- Access to the Opfield update service and image registry. The update service resolves signed artifacts from GitHub Releases.
- Inbound `3000/tcp` for the UI/API and `9443/tcp` for managed daemon gRPC connections.
- A trusted reverse proxy is optional. Opfield can serve port 3000 directly over HTTP or over a certificate issued by its existing System CA.

Opfield intentionally mounts the host Docker socket. It is required for signed in-place self-updates, foundation migration and recovery, image housekeeping, and optional Opfield-managed local services such as ClickHouse and Inference Core. This is a deliberate host trust boundary, not container isolation: Docker socket access is equivalent to administrative control of the Docker host, even if the socket bind is marked read-only. Treat the Opfield app container as part of the host trusted computing base, run it in an isolated VM or dedicated trusted host, and never place unrelated workloads or credentials on that Docker host. Removing the mount is not a supported hardening option because it disables product lifecycle and recovery paths; deployments that require a control plane without host Docker access must isolate Opfield in its own VM.

The control-plane stack also includes an Opfield-managed Docker Distribution registry with a persistent volume and no host-published port. Reserve registry capacity in addition to the base figures above when Git-source builds are enabled; retention keeps three successful artifacts per source plus active, rollback, in-progress, and manual pins.

## Build Worker Requirements

Git-source builds are available on Business and Enterprise and require at least one separate Linux node enrolled with `setup-docker-node.sh --mode builder`. A Build Worker uses the existing `docker-daemon` binary but does not install or connect to Docker Engine. The installer downloads pinned official releases of containerd, BuildKit, runc, Syft, Grype, and the required CNI plugins directly from their upstream projects, verifies embedded SHA-256 checksums, and installs them before enrollment. System packages such as Git and iptables are installed through the host package manager. Builder mode is supported on Linux amd64 and arm64 and fails closed when an upstream component, checksum, or required binary is unavailable.

Each Build Worker executes one isolated build at a time. A Compose project with multiple `build` services therefore queues one child build per service and may take several worker slots sequentially when only one worker is enrolled. Opfield applies the Compose project only after the complete batch is approved; adding workers increases throughput without changing rollout semantics.

The builder profile writes and starts dedicated egress-policy, containerd, and BuildKit units, private Unix sockets, a dedicated containerd namespace, the standard containerd runc runtime, and a Git askpass helper. `--builder-egress internet` is the default and permits public dependency downloads while blocking metadata, private/control-plane ranges, host-control endpoints, and the configured Opfield gRPC endpoint; `--builder-egress offline` disables build-step egress. In both profiles build steps cannot reach any service of the Build Worker host itself, on any of its addresses, and get no IPv6. Repository mode remains unavailable when the internal registry is not writable or no online worker reports the full execution, dedicated-runtime, and resource-enforcement capabilities. Treat the separate Build Worker host or outer unprivileged container as the security boundary: do not colocate unrelated workloads, credentials, or control-plane services on it.

## Install

```bash
curl -fsSL https://get.opfield.dev | bash
```

The installer downloads the latest release and asks one question on a fresh interactive install: whether port 3000 should start with native HTTPS. HTTPS is the default, including non-interactive installs. Choose HTTP only when you deliberately want plaintext on the internal hop or will terminate TLS elsewhere.

Explicit non-interactive examples:

```bash
# Native HTTPS (also the default)
curl -fsSL https://get.opfield.dev | bash -s -- --https

# Plain HTTP on port 3000
curl -fsSL https://get.opfield.dev | bash -s -- --http
```

To install an exact release instead of the newest stable one, for example to test a release candidate, pass `--version` on a fresh host. It installs that release with the relay of the same release, or the newest relay of its line; the installation then updates through Opfield as usual:

```bash
curl -fsSL https://get.opfield.dev | bash -s -- --version v2.12.1-rc.5
```

`get.opfield.dev` serves the installer of the newest stable release, which takes `--version` from 2.12.1 on. To install a release candidate before that, run the installer of the release itself: `curl -fsSL https://get.opfield.dev/gateway/releases/download/v2.12.1-rc.5/install.sh | bash -s -- --version v2.12.1-rc.5`.

The installer puts Opfield in `/opt/opfield` (Compose project `opfield`). Supported options are `--install-dir`, `--image`, `--source-dir`, `--http`, `--https`, `--dry-run`, `--version`, and `--restore` (with `--public-url` and `--grpc-target`). `--source-dir` builds a fresh test installation from a local Opfield checkout instead of discovering and pulling a release; it cannot update an existing installation. A source build needs 8 GB RAM, or swap on a 4 GB host. `--dry-run` verifies the selected signed release and renders the planned flow without creating files, building or pulling images, or starting services. Run with `--help` for syntax. The installer has no domain, nginx, Cloudflare, OIDC, SMTP, or ClickHouse prompts. Its settings can also come from the environment (`OPFIELD_INSTALL_DIR`, `OPFIELD_IMAGE`, `OPFIELD_WEB_TRANSPORT`, `OPFIELD_INSTALL_VERSION`, `OPFIELD_RESTORE_PASSPHRASE`); the `GATEWAY_*` names of earlier releases still work.

## Browser Setup Wizard

After the stack is healthy, the installer prints:

- the URL to open;
- the System CA SHA-256 fingerprint;
- a one-time setup code valid for 24 hours;
- the command that resets setup and issues a new code.

The setup code is shown only in installer output. Opfield stores its identifier, expiry, and SHA-256 hash, never the plaintext code. Until setup completes, normal product and authentication APIs return `423 SETUP_REQUIRED`; health, static wizard assets, and the setup API remain available.

Open Opfield and enter the code. The wizard then configures:

1. An explicit canonical public URL. Opfield never uses the browser origin as its default.
2. Opfield network endpoints: the public gRPC target embedded in node enrollment commands and an optional local gRPC IP for private-network nodes. Detected addresses are suggestions and can be replaced.
3. One or more sign-in methods: OIDC, password, and email one-time code.
4. OIDC when selected, and verified SMTP when an email-based method is selected.
5. Exactly one first administrator and exactly one primary sign-in method for that account.
6. Structured logging as disabled, Opfield-managed local ClickHouse, or external ClickHouse.
7. Optional AI Workspace setup. AI Workspace is the recommended intent-driven interface, while the Operations Console remains complete without it. Opfield Inference configuration is nested inside this step.

When the UI/API is behind Cloudflare or another web proxy, choose a direct host or IP as the public gRPC target. Generated enrollment commands contain the selected endpoint, so normal node setup does not require editing `--opfield` by hand.

Finish the wizard before using Opfield. The setup session and one-time code are invalidated at completion.

## Managed Cloud Installations

A managed installation bought in the Opfield account comes up ready, without the wizard. Its provisioning leaves `/var/lib/gateway/cloud-enroll.json` in the app container; on first start Opfield connects to the cloud account, activates the license key and, when the file names the account's sign-in client and owner:

- sets the public URL (and, when unset, the public gRPC target to its host);
- adds an OIDC provider named "Opfield account" with `https://account.opfield.dev` as issuer and the client created for this installation (redirect URI `<public URL>/auth/callback`);
- creates the owner of the account as system administrator, bound to that account;
- marks setup complete.

These steps happen together or not at all: if one fails, nothing is kept and the installation stays on the setup code flow. The client secret is stored encrypted and removed from the file; the whole file is removed once every step finished. Each step is in the audit log as `cloud.managed_sso`, without secrets.

Open the installation and choose **Sign in with Opfield account**. Add other users later from Users, with your own SSO, password, or email code. Sign-in on a managed installation follows the same rules as on a self-hosted one: in Settings > Authentication you can rename, edit or remove the "Opfield account" provider, replace it with your own SSO, turn OIDC sign-in off, use password or email-code sign-in, and move the owner to another sign-in method. Opfield refuses only a change after which no administrator could sign in, so give another administrator (or the owner) a method that stays first.

The client Opfield Cloud created for the installation is kept apart from the provider. **Use Opfield account** in the OIDC provider panel (API and MCP: `oidcProviderAction: "opfield_account"` in the auth settings update) brings the "Opfield account" provider back with that client at any time and turns OIDC sign-in on. While the installation does not use the Opfield account client, the cloud's secret rotation is refused and changes nothing; a reinstall that brings a new client keeps it for **Use Opfield account** and leaves your provider in place. A managed installation whose file has no sign-in client or owner uses the setup code flow above.

### Custom domain

A managed installation can have one custom domain, set in the Opfield account (point a CNAME at `<name>.opfield.cloud` first). The account sends it over the link (`public-alias`); Opfield gets a Let's Encrypt certificate for it on its port-80 listener, serves it next to its own address and renews both. Once the certificate is issued, the public URL is `https://<custom domain>`; `<name>.opfield.cloud` keeps working in the browser, and node setup commands keep using it. A failed issuance waits for **Retry** in the account (at most once every 10 minutes). Turning the domain off moves the public URL back. After a switch, passkeys registered on the old address stop working and MCP clients sign in again; links in emails already sent point to the old address. Settings > General shows the domain read-only.

## Sign-In With The Opfield Account On A Self-Hosted Installation

A self-hosted installation connected to Opfield Cloud (Settings > Cloud) can use the Opfield account for sign-in too. Set the public URL, then choose **Use Opfield account** in Settings > Authentication > OIDC provider. Opfield asks your Opfield account for a sign-in client for `<public URL>/auth/callback`; the panel shows *Waiting for your Opfield account…* until the account answers, then sets up the "Opfield account" provider and turns OIDC sign-in on. **Cancel request** withdraws the request. API and MCP: `oidcProviderAction: "opfield_account"` and `"cancel_opfield_account"`; `opfieldAccountSignIn` in the settings shows whether it is available, whether a client was issued and the pending request.

People who sign in with the Opfield account are matched like with any OIDC provider of the installation: automatic user creation, the default group and the verified-email rule in Identity provisioning apply. The provider can be edited or removed like any other. The account can replace the client's secret over the link; while you use another provider, that is refused and changes nothing.

When someone loses access in the Opfield account (removed from the team, their access to the installation removed, the installation moved to another account, or the account suspended), the account tells the installation over the link. Their user here is blocked by the Opfield account, whichever sign-in provider is active now: their browser sessions end, open consoles and live views close as on any block, and their API tokens and OAuth/MCP access stop working (the tokens are kept). Users shows *Blocked by the Opfield account*. When the account gives the access back, their next sign-in with the Opfield account unblocks them. An administrator's block is never lifted by a sign-in; **Unblock user** lifts either block, and **Block user** on such a user makes it an administrator's block. This needs no remote management. The last active system administrator is never blocked this way. The audit log records `cloud.sso_revoke` with the reason and the users, and `user.opfield_account_unblock` for each sign-in that lifted a block.

When you disconnect the installation from Opfield Cloud, the account disconnects it, or you connect it to another account (**Switch account**), Opfield forgets the client and removes the "Opfield account" provider (OIDC sign-in turns off). If no other administrator could sign in then, the provider stays and keeps signing in, but no longer as the cloud's client; the audit log entry `cloud.managed_sso` (provider_kept) and the OIDC provider panel say so. Give an administrator another sign-in method, then remove the provider, or choose **Use Opfield account** to ask the new account for a client. A request still waiting is dropped on Switch account. Connecting again to the same account keeps the sign-in.

## Native HTTPS And Reverse Proxies

Native HTTPS and HTTP use the same port, `3000`. Native HTTPS uses a dedicated `opfield-web` leaf certificate issued by the existing Opfield System CA; it does not create a second root CA.

A reverse proxy can connect to either internal protocol. Configure the proxy to trust the Opfield System CA when it verifies the native HTTPS upstream. The wizard records the Opfield addresses used by node enrollment; ingress addresses, public certificates, Cloudflare connectors, DNS records, and ACME workflows remain product configuration after the base stack is installed.

Administrators can enable or disable internal HTTPS later in **Settings > General > Features and updates**. Opfield restarts after the change. When the browser directly addresses an IP, the UI changes `http`/`https` to follow the listener. With a domain or reverse proxy, the browser keeps its external URL and only reloads.

## Structured Logging

The wizard offers three modes:

- **Disabled**: logging ingest and UI are unavailable.
- **Managed local**: Opfield uses the mounted Docker socket to create a pinned ClickHouse container on its current Docker network.
- **External**: Opfield stores the supplied ClickHouse connection configuration.

Disabling managed local logging stops the ClickHouse container and preserves its named volume. Re-enabling adopts the same managed container and credentials. OIDC, SMTP, and ClickHouse secrets are encrypted with `PKI_MASTER_KEY` in Opfield settings.

## Updating And Legacy Migration

Running the installer again updates an existing installer-managed deployment to the latest release without repeating product configuration.

The relay is the sole public owner of the existing `9443/tcp`; the application keeps only an internal gRPC listener for relay-to-app control-plane proxying. Opfield and relay use independent immutable image references. A normal Opfield update does not recreate relay when the signed manifest keeps the same `relayImageRef` digest.

The installed Compose relay is the default local member of the Relay Pool. Additional relay nodes are optional and are enrolled later from **Settings > Relay**. Their supervisor control connection is outbound to Opfield, but each remote relay worker also needs a routable inbound data endpoint from every managed host that can use it (TCP `9443` by default). The installer does not modify host or network firewalls and does not provide NAT traversal.

The first update from a pre-relay installer-managed foundation runs the target image's foundation migrator before the new app starts. It backs up `.env` and `docker-compose.yml`, adds the relay service and identity volume, moves the existing public `9443/tcp` mapping from `app` to `relay`, and preserves the existing data volumes and daemon identity. This ownership cutover causes one expected interruption to daemon connections. If migration fails, the updater restores the foundation backup instead of starting a partial topology.

On the first compatible update, legacy `OIDC_*`, `CLICKHOUSE_*`, and `APP_URL` values are imported into Opfield settings. OIDC and ClickHouse secrets are encrypted before the managed installer or in-app updater atomically removes those exact legacy keys from `.env` and recreates the application container. An incomplete legacy OIDC configuration aborts cleanup instead of deleting recoverable values.

The migration removes the old Compose ClickHouse service definition but does not delete its container or volume. When migrated settings select local mode, Opfield adopts the legacy container. Manual Compose deployments may retain legacy env keys until the operator runs an installer-managed or in-app update.

### Moving To /opt/opfield

Installations made before 2.12.1 live in `/opt/gateway` under the Compose project `gateway`, with the database and role `gateway`. After the update to 2.12.1 has settled (about ten minutes after the new version became healthy), Opfield moves itself to the current layout once:

- the directory becomes `/opt/opfield`; `/opt/gateway` stays as a link to it;
- the Compose project, containers (`opfield-app-1`, …) and network (`opfield_default`) get the new name;
- the database and its role are renamed to `opfield`; settings in `.env` are named `OPFIELD_*`;
- the managed local ClickHouse becomes `opfield-clickhouse` with the database `opfield_logs`;
- the Docker volumes keep their names (`gateway_gateway_data`, `gateway_postgres_data`, …): `docker-compose.yml` binds them by name, so no data is copied.

During the move Opfield is unavailable for about a minute, and Secure Links through the relay on this host stop once for a few tens of seconds while the stack is recreated. Running orchestration operations finish first. Updating with the installer does the move right after the update and prints the new directory.

The move runs in the `opfield-host-move` container and records each step in `.opfield-host-move/state.json` of the install directory. After a crash or a reboot Docker starts it again and it continues where it stopped. If a step keeps failing, it undoes the steps it made and Opfield runs from `/opt/gateway` as before; it tries again later, at most three times. `docker logs opfield-host-move` shows what happened. To try again by hand:

```bash
docker rm opfield-host-move
cd /opt/gateway && curl -fsSL https://get.opfield.dev | bash
```

Rolling back to 2.12.0 after the move is not supported. System CAs show their new names (*Opfield Node CA*, *Opfield Database CA*, *Opfield Storage CA*); their certificates are not replaced, so nodes, relays and applications that trust them keep working.

## Restoring An Export

`install.sh --restore <file>` installs the Opfield version that made a [configuration export](configuration-transfer.md) into a fresh directory and restores it. An export of a release before 2.12.1 is installed in the layout that release expects; updating it to 2.12.1 or later then moves it as described above. It asks for the passphrase (or reads `OPFIELD_RESTORE_PASSPHRASE`) and for this host's public URL and gRPC address. The setup wizard of a fresh installation can restore an export too.

## Backups

A [configuration export](configuration-transfer.md) is the supported way to move an installation. For your own backups, back up together:

- PostgreSQL;
- Redis if active browser/setup sessions matter;
- the `app_data` volume containing auto-issued TLS material;
- the `relay_identity` volume containing relay service identity material;
- the `relay_state` volume containing the durable relay policy and signing-key keyring;
- the `registry_data` and `registry_auth` volumes containing the internal registry's images and its token signing material;
- the managed ClickHouse volume when local structured logging is enabled;
- `.env`, especially `PKI_MASTER_KEY` and database credentials.

The volume keys are those of `docker-compose.yml`. A fresh installation names the volumes `opfield_app_data` and so on; an installation moved from `/opt/gateway` keeps the names it had (`gateway_gateway_data`, …), which `docker-compose.yml` lists under `name:`.

Losing `PKI_MASTER_KEY` makes encrypted OIDC, SMTP, ClickHouse, PKI, and other stored secrets unrecoverable.

## After Installation

Create managed nodes from the authenticated Opfield UI after the first-run wizard is complete. Node enrollment and proxy/domain configuration are intentionally separate from installing the Opfield control plane.
