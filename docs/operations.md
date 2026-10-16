# Operations Guide

[Back to README](../README.md)

This guide covers day-two operation: updates, configuration, programmatic access, structured logging, AI Workspace, backups, and security notes.

## Updates

### Opfield Updates

From the UI:

1. Go to **Settings > General > About**.
2. Click **Check for updates** and review the available version.
3. Click **Update Opfield to `<version>`**.

A restart interrupts blue/green deploys, drains, Availability and Compose operations, build rollouts, and Docker migrations, so Opfield first waits for those that are running or queued. The update screen lists them and the latest time it waits: 15 minutes by default, longer when a running operation announces a later deadline, but never more than an hour. New operations of these kinds are refused until the update has finished. **Update now** stops waiting; Opfield then resumes or reconciles the interrupted operations after the restart, and it does the same when the wait runs out. A restart during the wait keeps the current version. This wait, and the database snapshot below, belong to the updater of the running version: they apply to updates started from 2.11 on, not to the update from 2.10 (see [Updating from 2.10](#updating-from-210)).

Opfield verifies the signed release manifest, pulls the selected image by its immutable digest, runs the target image's foundation migrator, updates `OPFIELD_IMAGE_REF`, and recreates its own container. Relay has an independent immutable `OPFIELD_RELAY_IMAGE_REF`; Compose leaves it running when the digest is unchanged and replaces it when the signed `relayImageRef` changes. Automatic Opfield updates fail closed when the signed manifest is missing, invalid, or does not match the requested version and running image repository.

The installation-wide **Update channel** is configured under **Settings > General > Features and updates**. `stable` is the default and accepts production releases only. `preview` also allows GitHub prereleases tagged as `vX.Y.Z-rc.N` for Opfield and with the required component suffix for Relay and managed node daemons, for example `vX.Y.Z-rc.N-relay` or `vX.Y.Z-rc.N-docker`. Switching back to `stable` immediately hides cached release-candidate offers. Component-aware resolution prefers a newer patch on the current minor, otherwise the baseline release of the next minor. Daemon checks stage one target per daemon type from that type's oldest compatible installed cohort. Inference Core keeps its independent stable signed release channel and is not changed by this setting.

If the new version does not become healthy within about five minutes, the update container rolls back. It restores `.env` and `docker-compose.yml` from `.opfield-foundation-backups/pre-update-<time>/` and restores the Opfield database from a snapshot taken just before the new app started, so the previous version never runs on a schema changed by the new version's migrations. Data written after the snapshot is lost. The snapshot is a `pg_dump` custom-format file, `opfield-db.dump`, in the same backup directory. It is deleted once the update or the restore succeeds, and a leftover one is deleted by a later update once it is older than 7 days. To restore it, the rollback stops every Compose service except `postgres`, drops the `opfield` database and recreates it from the dump. An update started from 2.12.0 or earlier is run by that version's updater, which uses `.gateway-foundation-backups`, `gateway-db.dump` and the database and role `gateway`.

The update needs free space for the snapshot on the filesystem holding the Opfield directory: the database size plus 10% plus 256 MiB. With less, the update stops before the app is replaced, and the update container logs say how much space is needed. If the migrated database cannot be dropped, the previous version starts on it as before and the dump is kept. If the restore fails after the drop, Opfield is left stopped and the dump is kept. Fix the cause shown in the update container logs, then restore from the Opfield directory:

```bash
docker compose exec -T postgres psql -U opfield -d postgres -c 'DROP DATABASE IF EXISTS opfield WITH (FORCE)'
docker compose exec -T postgres pg_restore --create --exit-on-error -U opfield -d postgres < .opfield-foundation-backups/pre-update-<time>/opfield-db.dump
docker compose up -d
```

App-only updates leave established managed-database binding streams on the relay running. Updating the relay itself is an explicit data-plane maintenance event and may interrupt those streams. The one-time migration from a pre-relay deployment also has an expected interruption while public `9443/tcp` ownership moves from `app` to `relay`.

Relay Pool updates start from **Settings > General** with **Update Relay Pool**, which appears once Opfield runs the minimum version the relay release requires. They are durable and one-at-a-time. With at least two ready physical fault domains, Opfield drains a remote instance, updates its signed supervisor artifact and then, through the new supervisor, its signed worker artifact, verifies both, returns the instance to service, and then continues. Before it drains the next member, and after the last one, it waits (at most 90 seconds) until the workloads are placed on the members already updated: a member's workloads move to the nearest relay that serves, not to the one left over while the previous member drained, and the local relay takes its workloads back right after its update. A placement planned while a relay drained is not applied once that relay serves again; it is planned again. A remote relay that is not connected (its host is down) does not block the update: its step is skipped with `Skipped: the relay is not connected; it is updated when it reconnects`, the run updates the other members and the local relay and completes, **Settings > Relay** shows the skipped relay, and once it reconnects the update is offered again for the members still behind. An offline relay does not count toward the two ready fault domains the update needs. The local Compose relay is updated last. When another relay of the pool is ready and connected and can serve every workload the local relay carries, Opfield drains the local relay the same way first: its workloads move to the other relays, the drain waits as described below, then Opfield recreates the relay container, verifies that it runs the target version, and returns it to service. The internal registry, which only the local relay serves, stays on it: a draining relay keeps admitting image pulls, and a pull that is cut when the container is recreated is sent again by the Docker daemon. Otherwise the local relay is recreated at once, and connections through it (database link pools, storage, cross-node links) drop once for about a second and reconnect. That happens when no other relay is ready, when the running local relay is older than 2.11.1 (its drain would refuse image pulls too, so the first Relay Pool update to 2.11.1 or later still recreates it at once), when a daemon on a workload's path has no Relay Pool support, when a workload's node reaches no relay outside the Opfield host, or when the local relay's workloads have not moved within 5 minutes of the drain; the local relay's step of the run records why. Once the local relay is being recreated, the update can no longer be abandoned (`409 RELAY_UPDATE_COMMITTED`); it finishes, or rolls the relay back, within a few minutes. Drain waits up to 30 minutes for long-lived streams (database link pools, WebSockets) to end; then Opfield disconnects the remaining ones, records that in the audit log as a forced disconnect, and continues. The explicitly confirmed **Force disconnect** action ends the wait earlier. A worker download that fails its checksum or signature leaves the previous worker running; a worker that still reports the previous version after its update is restarted, and the update is dispatched again a bounded number of times. A supervisor update is committed only after it reconnects at the expected version. Connector image references are promoted only after the whole pool succeeds. Each Docker node then starts the new Secure Link connector next to the running one, moves its links over once they are bound, and hands the previous connector's open connections (Route connections, WebSockets, event streams, database, storage and container link connections) to the new one, which carries them on without a reconnect; the previous connector is removed right after, so Routes and links keep working. Docker daemons older than 2.11 replace the connector in place instead, so update the nodes before the Relay Pool. What a previous connector cannot hand over stays on it for at most an hour: every connection of a connector from before 2.11.4, and a managed storage connection whose TLS the connector opens when that TLS session is not TLS 1.3 with AES-GCM. A third connector update within that hour closes the oldest previous connector's remaining connections at once.

Manual update:

```bash
# Edit .env first, for example:
# OPFIELD_IMAGE_REF=ghcr.io/opfield/opfield:v2.12.1
docker compose pull
docker compose up -d
```

### Updating From 2.10

The update from 2.10.x is run by the 2.10.x updater. It neither waits for running operations nor snapshots the Opfield database, so prepare it yourself:

1. In the Opfield directory (`/opt/gateway` by default), take a database backup and keep a copy of `.env`, which holds `PKI_MASTER_KEY`:

   ```bash
   docker compose exec -T postgres pg_dump -Fc -U gateway gateway > gateway-2.10.dump
   cp .env env-2.10.backup
   ```

2. Avoid deploys, backups, and Docker migrations while the update runs.
3. Update Opfield first, then the node daemons (**Nodes > Update Nodes**: Docker, Nginx, Storage, and Monitoring nodes), then the Relay Pool (**Settings > General**, **Update Relay Pool**). Do not update node daemons or relays before Opfield: the 2.11 Relay requires Opfield 2.11, and many 2.11 features and fixes need the 2.11 daemons and relays. Relays from 2.10 keep the 15-minute relay policy lease until they are updated.

If the update rolls back, 2.10.x starts again on the already migrated database. Fix the cause shown in the update container logs and update again. To return to the state before the update instead, put the saved `.env` back, stop every service except `postgres` (`docker compose stop app relay registry redis`), and restore `gateway-2.10.dump` with the `DROP DATABASE`, `pg_restore`, and `docker compose up -d` commands above.

After the update:

- Paid installations download the signed private core of the new release during the update, so the Opfield host must reach the license server; see [Commercial core](commercial-core.md). Community installations that never held a paid plan update without it.
- Docker Availability policies switch to lease mode by themselves once every node and relay of the workload has run 2.11 for 2 minutes. Each Docker node needs the [lease watchdog](nodes.md#lease-watchdog); nodes whose daemon runs without root need the node installer re-run, or they stay under **Excluded nodes**. In lease mode every node of the policy must reach every relay (see [Firewall Requirements](nodes.md#firewall-requirements)).
- After the Docker daemon update, the first apply of an unchanged Compose revision recreates its services once (see [Container Log Limits](#container-log-limits)).
- External PostgreSQL and key-value connections with TLS stay unverified until you add their CA or enable verification (see [Databases](capabilities.md#databases)).
- Storage nodes need outbound HTTPS to `ghcr.io` to pull the backup runner.
- Review permission groups, user permissions, API tokens, and OAuth grants: retired scope names were migrated, some of them to broader permissions, and custom groups do not receive the new 2.11 permissions automatically (see [SCOPES.md](../SCOPES.md)).

### Daemon Updates

From a node detail page, click **Update** when an update is available, or update several nodes together with **Nodes > Update Nodes**. Relay nodes update with the Relay Pool instead (**Settings > General**, **Update Relay Pool**). Opfield refuses daemon updates for disconnected nodes, relay nodes, and nodes that already run the release. Nodes that share a lease-mode Availability policy restart one after another: an update waits in the `waiting_for_lease_peers` phase until the policy's other voters and candidates are back and voting (see [Daemon Updates](nodes.md#daemon-updates) in the nodes guide).

Before it is sent, an update waits in the `waiting_for_tasks` phase for the long tasks running on the node (backups, image builds, Docker migrations, image pulls, storage copies, container archive transfers), at most 30 minutes; then it goes ahead and keeps a warning. **Update now** starts it at once; the running tasks may fail. An update of a Docker or nginx node whose daemon supports live handover keeps relay stream sessions, with a pause of a second or two; raw streams of older peers, PostgreSQL links where the daemon opens TLS, registry pulls and pushes, and backup runs are cut as before. The first update onto such a daemon, and a rollback below it, cut open connections once; so does the next update of a node whose launcher process started before 2.11.4, which restarts the whole service once for the new launcher.

The update flow:

1. Opfield fetches and verifies the signed daemon update manifest.
2. Opfield waits for the long tasks running on the node (at most 30 minutes) and, for lease members, for their lease peers, then dispatches the signed manifest, download URL, and verified SHA256 checksum to the daemon.
3. New daemons verify the signed manifest locally before downloading.
4. The daemon verifies the downloaded binary checksum, replaces the binary atomically, and exits for systemd restart.
5. The daemon reconnects and reports its new version.

Existing daemons from before signed-manifest support can perform one transition update. In that case Opfield verifies the signed manifest before dispatch, and the old daemon enforces the verified SHA256 checksum. After that transition, daemon-side signature verification is enforced for future updates.

### Updating To 2.11.1

2.11.1 moves managed database and storage links to one shared secure-link connector per Docker node (no per-link connector containers, no host listeners) and adds container links. Update Opfield first, then the Docker daemons. After a node's Docker daemon update:

- Each workload with a database link is recreated once to join its new link network, one at a time per node (the next once the previous runs healthy). Deployments roll blue/green without downtime; standalone containers and Compose services restart once.
- Each workload with a storage link created before 2.11.1 is recreated once right after its link switches. Links created on 2.11.1 need no recreate.
- Variable names and credentials stay the same; nothing needs to be done by hand. Do not delete old link networks or connector containers yourself.
- Rolling a Docker daemon back to 2.11.0 switches its links back automatically, with one recreate per workload. At most four workloads per node are recreated at once (the daemon's concurrent command limit), so on a node with many linked deployments the later ones reconnect a little later.
- Later connector updates keep open link connections: from 2.11.4 the previous connector hands them to the new one. A connector from before 2.11.4 keeps them for up to an hour, then closes them once; a third update within that hour closes the oldest connector's connections at once.

New link networks take a /26 each from `docker.secure_links.subnet_pool` (default `10.213.0.0/16`); see [Daemon Configuration](nodes.md#daemon-configuration). Set it before the Docker daemon update when the default range overlaps a network the nodes reach through their default route; earlier daemons ignore the key.

## Container Log Limits

Docker's default `json-file` log driver keeps container logs without a size limit, so one busy container can fill a node's disk. Opfield bounds them:

- The services of the Opfield stack (`app`, `relay`, `registry`, `postgres`, and `redis`) rotate their logs at 50 MB × 3 files. The Inference core rotates at 50 MB × 3 and the local ClickHouse at 10 MB × 3. An Inference core created before its rotation keeps its newest 10 MB once its log passes 150 MB, checked every hour, until its next update or repair recreates it with rotation.
- On Docker nodes, containers, blue/green deployments, and Compose services that Opfield creates or recreates without log options of their own get `json-file` rotation at 50 MB × 3 (`max-size: 50m`, `max-file: 3`). This applies while the node's default Docker log driver is `json-file` and `/etc/docker/daemon.json` sets no default `max-size`; a host with another default driver or a default `max-size` keeps its own policy. A Compose service's own `logging` with the `local` or `none` driver is kept; its own `json-file` logging without `max-size` gets `max-size: 50m` and keeps its other options.
- The containers Opfield runs for itself on a node (Secure Link connectors and anchor, storage connectors, backup, copy and helper containers) rotate at 10 MB × 3, as the managed database and storage engines do.
- Every hour, each Docker node bounds the logs Docker never rotates: a container whose `json-file` log has no `max-size` (created before 2.11, created outside Opfield with `docker run` or another Compose, or with log options of its own that set none) keeps its newest 10 MB once its log passes 150 MB. The container keeps running; recreate it from Opfield to give it rotation.
- When the Docker node installer installs Docker Engine itself, it writes `/etc/docker/daemon.json` with `json-file` and 50 MB × 3 as Docker's default. An existing `daemon.json` is kept: Opfield changes it only to set up [Secure Runtime](nodes.md#setup-and-compatibility), which adds `runtimes.runsc` after saving the original as `daemon.json.gateway-backup`.
- Alert rules can watch a container's **Log Size (MB)**.

After a node's Docker daemon is updated to 2.11, the first apply of an unchanged Compose revision on a node where this limit applies recreates its services once, because the added log settings change their configuration. The first apply after Opfield and the daemon run 2.11 also recreates every service once, because each service then gets a label with its own configuration digest instead of the revision digest; from then on a new revision recreates only the services it changes. Plan that apply like any restart of the project. The first apply after the daemon update to 2.12.3 recreates the services whose own `json-file` logging had no `max-size`.

## Node Log Limits

- **Route logs on nginx nodes.** nginx writes an access and an error log per route (`/var/log/nginx/proxy-<route>.access.log` and `.error.log`) and its default `access.log` and `error.log`. Every 5 minutes, whether the node is connected to Opfield or not, the nginx daemon bounds them, whatever the distribution's logrotate does (Alpine has none by default): a live log over its cap keeps its newest lines in `<name>.1` and starts again empty, all of them together stay within 5% of the disk (64 MB to 2 GB; rotated logs go first, oldest first), the logs of routes the node no longer serves are removed once nginx stopped writing them, and rotated logs older than the **Nginx Logs** retention in **Settings > Features > Housekeeping** (30 days by default) are deleted. With that category off, rotated logs are kept until the size limit needs the space. Logs other configs write to the directory (an integrate-mode host's own sites) are not touched. The Housekeeping card shows the real size of these logs on all nginx nodes, from each node's last report.
- **Daemon logs on OpenRC and manual-mode hosts.** On systemd hosts, the daemons log to journald, which bounds its own size. Under OpenRC (Alpine) the daemons and the lease watchdog log to `/var/log/<daemon>.log` and `.err`, and without a service manager to `<state>/launcher/manual.log`; nothing rotates these files. Each daemon checks its own every 5 minutes: once one passes 50 MB, its newest 5 MB stay in `<file>.1` and the file starts again empty. A failure that repeats every second (an unreachable relay, a lease watchdog that cannot read its records) is logged when it starts, every 5 minutes with a count, and when it recovers.

## What Docker Nodes Clean Up Themselves

Docker keeps a removed container's anonymous volumes (an image `VOLUME`, a bare `-v /path`). When Opfield removes a container for good, the node's daemon removes them too: a replaced or removed blue/green slot or router, an Availability placement that is replaced or removed, a container whose creation failed halfway, and the containers of a Compose project taken down or deleted. A volume stays when another container uses it, when it carries the `opfield.housekeeping.protected=true` label, when Opfield manages it, or when the container's mount list or the Compose file names it. Named volumes are never removed this way, and a recreate (an update, a mount change) keeps the container's anonymous volumes. Anonymous volumes left by earlier releases are counted by **Housekeeping > Orphaned Volumes**, which removes only those it saw attached to a container Opfield created (see [Disk Usage And Retention](#disk-usage-and-retention)).

The daemon also removes, at start and every 15 minutes:

- short-lived helper containers (volume file access, the Compose sidecar, database helpers) that a daemon restart left behind, 15 minutes after they stopped;
- the stored environment file (which may hold secrets) of a container that no longer exists, a day after it last changed; a container's file goes as soon as Opfield removes the container;
- at start only, its own temporary files older than an hour.

Migrations spool images and volumes in the daemon's state directory. A spool never takes the node's disk below the managed-instance reserve (2 GB by default, `docker.database.reserve_bytes`): an export or transfer that would is refused or stopped with a message naming the free space. The spool of a migration nothing has used for 6 hours is removed.

An upload into a container or volume that was abandoned (a closed browser, an Opfield restart) leaves a hidden `.opfield-upload-<id>.tmp` file. Opfield removes it when the upload session expires after 30 minutes without a chunk, and the next upload into the same directory removes any such file older than an hour.

## Configuration Reference

The installer writes infrastructure/bootstrap values to `.env`. Product settings are stored in Opfield: canonical public URL and internal web TLS are edited in **Settings > General**; sign-in methods, MFA, the OIDC provider, and identity provisioning in **Settings > Authentication**; SMTP, network trust, and the outbound webhook policy in **Settings > Advanced**; structured logging (ClickHouse), OAuth and MCP access, and Housekeeping in **Settings > Features**; request limits, logging ingest guardrails, sessions, rate limiting, and PKI defaults are edited in **Settings > Environment**. ACME uses the acting user's email and the provider selected in the certificate form.

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port inside the app container. |
| `DATABASE_URL` | PostgreSQL connection URL. |
| `REDIS_URL` | Redis connection URL. |
| `OPFIELD_IMAGE_REF` | Opfield image reference used by Compose. The installer writes the selected release tag; signed self-updates replace it with `image@sha256:<digest>`. |
| `OPFIELD_DEPLOYMENT_MODE` | Immutable process mode: `standard` (default) or `demo`. Demo enables the dedicated public demo OTP flow and centrally denies visitor mutations, secret access, consoles, AI/MCP/OAuth, and automation tokens. Invalid values fail startup; changing the mode requires recreating the Opfield process. |
| `OPFIELD_RELAY_IMAGE_REF` | Independently pinned immutable image reference used by relay. Only a digest change updates relay. |
| `OPFIELD_RELAY_BUILD_VERSION` | Expected build version reported by the pinned relay image. |
| `OPFIELD_RELAY_PROTOCOL_MAJOR` | Supported relay wire-protocol major. |
| `SETUP_BOOTSTRAP` | Installer-only flag that permits a fresh empty database to enter first-run setup. |
| `WEB_TLS_BOOTSTRAP_MODE` | Seeds `http` or `https` only when no persisted web-transport choice exists. |
| `WEB_TLS_AUTO_DIR` | Persistent directory for the native web TLS leaf and private key. |
| `GITHUB_OAUTH_CLIENT_ID` | Optional override for the built-in product-wide GitHub OAuth App client ID used for connector Device Flow. Opfield does not use a client secret or redirect users through the app's callback URL. |
| `PKI_MASTER_KEY` | 64-character hex key for encrypted PKI material. |
| `GRPC_PORT` | TLS-only gRPC port for daemon connections. |
| `GRPC_TLS_AUTO_DIR` | Directory for Opfield's auto-issued internal gRPC TLS certificate and key. |
| `GRPC_TLS_EXTRA_SANS` | Extra comma-separated DNS names or IP addresses for the auto-issued gRPC server certificate. Opfield also includes the persisted canonical public host and discovered host IP addresses automatically. |
| `GRPC_TLS_CERT` | Optional custom gRPC TLS certificate issued by Opfield's system CA. |
| `GRPC_TLS_KEY` | Optional custom gRPC TLS private key paired with `GRPC_TLS_CERT`. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | Proxy health check interval. |
| `ACME_RENEWAL_CRON` | ACME renewal schedule. |
| `EXPIRY_CHECK_CRON` | Certificate expiry check schedule. |

Legacy product-setting variables are imported into PostgreSQL by the target image before an update replaces the app container. The migration preserves explicit legacy values, fills missing fields from the target release defaults, and removes the migrated keys from both host `.env` and the app service's Compose environment only after the database import succeeds.

Before enabling demo mode, configure the canonical `system-admin` account for email OTP and its required MFA factors. Demo mode intentionally exposes no password, OIDC, or direct passkey primary login, including for administrators; this avoids turning the public demo OTP endpoint into an alternate login for identities governed by another authentication provider.

See [.env.example](../.env.example) for the common development values. Runtime-only and installer-managed image, registry, relay, storage, DNS, and update variables retain their schema defaults when omitted.

Redis is required infrastructure. Opfield uses it for sessions, cache, and rate limiting; if Redis is unavailable, `/health` returns `503` and Redis-backed rate-limited API/auth/public surfaces fail closed with `RATE_LIMIT_UNAVAILABLE`.

OIDC scopes should normally include `openid email profile`. The `email` scope requests `email` and `email_verified`, but providers differ in whether `email_verified` is present in the ID token and whether it is true by default. Leave **Require verified OIDC email** disabled unless your IdP emits reliable verified-email claims.

### GitHub connector OAuth

GitHub connector OAuth works out of the box with Opfield's built-in product-wide OAuth App client ID. No environment configuration, client secret, or per-instance callback is required.

Set `GITHUB_OAUTH_CLIENT_ID` only to override the built-in client with a custom organization-owned **GitHub OAuth App**, for example for a fork or white-label deployment. Do not create a separate OAuth App per Opfield instance.

1. In GitHub, open **Settings > Developer settings > OAuth apps > New OAuth App**.
2. Set an operator-facing application name such as `Opfield` and use the product's public website as the homepage URL.
3. GitHub requires an authorization callback URL when registering the app. Use a stable HTTPS page controlled by the product, such as `https://opfield.dev/`. Opfield's Device Flow does not redirect to this URL.
4. Enable **Device Flow**, then register the app.
5. Copy the app's **Client ID**. Opfield does not need a client secret; do not generate or distribute one for this integration.
6. Set the override on the installations that should use this custom app:

   ```dotenv
   GITHUB_OAUTH_CLIENT_ID=Ov23li...
   ```

7. Recreate the app container so it receives the environment variable:

   ```bash
   docker compose up -d --no-deps --force-recreate app
   ```

In Opfield, verify the setup under **Settings > Integrations > GitHub**. The user first clicks **Start GitHub authorization** so the device code is visible, then explicitly opens GitHub and approves access. The resulting user token is encrypted by Opfield and stored in the created connector.

The shared OAuth App currently requests `repo`, `workflow`, `read:org`, and `read:packages`. These scopes allow repository and CI operations, organization discovery, and package reads within the authorizing user's own GitHub access. GitHub Enterprise connectors remain token-based because the shared OAuth App is registered on `github.com`.

## Local authentication operations

Email/password and email-OTP sign-in require a verified SMTP configuration in **Settings > Advanced**. Do not enable either method until a test message succeeds. With verified SMTP, an account invitation email with a sign-in link can be sent from the user dialog, or automatically for every created account (**Settings > Authentication > Identity provisioning**, off by default). Opfield encrypts SMTP credentials using `PKI_MASTER_KEY`; losing or rotating that key without re-entering the SMTP password prevents delivery.

A managed installation sends sign-in emails through Opfield Cloud email without any SMTP setup: the Opfield account sends them from `<name>@mail.opfield.cloud` within the plan's monthly, daily and hourly limits, and email sign-in can be turned on right away. An email over a limit fails at once (no retries) and shows in the logs; an invitation or password link an administrator sends reports that failure instead of "sent". **Use my own SMTP** in the SMTP panel shows the SMTP form; saving it switches sign-in emails to your SMTP (while password or email-code sign-in is on, send a test first). Turning the switch off goes back to the cloud email.

For local accounts, group MFA policy is enforced after the primary credential. TOTP recovery codes are one-use. If an account loses all MFA factors, a system administrator must reset MFA from the user administration screen; that action also revokes its browser sessions. Users and administrators can independently view and revoke browser sessions, but session cookies themselves are never exposed.

## Update Signing Operations

Opfield and daemon automatic updates require signed release manifests. Release CI must have `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64` set to a base64-encoded Ed25519 private key PEM. The corresponding public key is compiled into Opfield and daemon binaries.

If `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64` is missing, Opfield and daemon release jobs fail instead of publishing unsigned automatic-update artifacts. To rotate the update signing key, generate a new key pair, update `config/update-trust/update-signing-public-key.pem`, deploy that release, then switch CI to the new private key.

Images are additionally signed with Sigstore keyless signing and carry SBOM attestations; see [Verifying releases](verify-releases.md) for the `cosign verify` commands and how to check a manifest by hand.

## Programmatic Access

Opfield supports browser sessions, REST API tokens, OAuth access tokens, MCP access, logging ingest tokens, and inference runtime tokens. These are intentionally separate.

| Prefix | Token family | Purpose |
|--------|--------------|---------|
| `opf_` | API token | REST API automation. |
| `opfo_` | OAuth access token | Opfield API or Opfield MCP resource. |
| `opfl_` | Logging ingest token | Write-only structured log ingestion. |
| `opfi_` | Inference runtime token | Opfield Inference data-plane requests. |

Tokens issued before 2.12.1 start with `gw_`, `gwo_`, `gwl_` or `gwi_` and keep working until they are revoked or expire.

### API Tokens

API tokens are created in Opfield settings and are scoped. They can call REST API routes according to their scopes and the owning user's current effective permissions.

Important behavior:

- Token scopes cannot exceed the owning user's permissions.
- Effective scopes are bounded by the owner at request time.
- Every action scope except creation, including delete, satisfies its family's view check with the same qualifier, so resource-scoped grants stay limited to the same resource.
- Creation scopes (`*:create*`, `docker:images:pull`, `ssl:cert:issue`, `pki:cert:issue`) imply no view.
- Sensitive reveal or export operations require explicit scopes.
- API tokens are not accepted by the MCP endpoint.
- **Limit selected scopes to folder…** in the token's scope editor (and on the OAuth consent screen) narrows the selected scopes to one folder and its subfolders. A token's folder and node grants are expanded first and then bounded by the owner's current permissions, so a token never reaches a resource its owner cannot.

API tokens and OAuth grants can do everything a user can do with Opfield resources, including node enrollment and global nginx config, raw route config, users and permission groups, Opfield and environment settings, integration and hosting connectors, hosting VMs, inference administration, relay drain/rebalance/force-disconnect, and updates. They can also manage the owner's personal `opfi_` inference keys when they hold `feat:ai:use`. They cannot carry the user-only AI Workspace, AI sandbox, and `mcp:use` scopes, `admin:users:impersonate`, or `integrations:gitlab:sandbox:clone`, and they cannot call browser/identity-bound routes: sign-in, password, MFA, passkeys, the caller's own sessions and preferences, starting impersonation, OAuth consent, API token and OAuth authorization management, per-user Git credentials, AI Workspace chat, UI bootstrap, and the post-setup onboarding checklist. See [SCOPES.md](../SCOPES.md#api-token-delegation).

### OAuth

Opfield supports OAuth 2.0 Authorization Code + PKCE for public clients.

Dynamic OAuth client registration is intended for public local clients such as CLIs and MCP clients. By default, newly registered clients may use only loopback callback URLs (`localhost`, `127.0.0.1`, or `::1`). This keeps automatic CLI login working without allowing arbitrary external callback origins.

Admins can enable OAuth extended callback compatibility in Opfield settings when a client requires an external HTTPS callback URL. When enabled, unverified OAuth clients may register HTTPS callback URLs outside loopback. The consent screen warns users whenever an authorization result will be sent to an external callback origin.

OAuth access tokens are resource-bound:

| Resource | URL | Accepted by |
|----------|-----|-------------|
| Opfield API | `https://<opfield>/api` | REST API routes. |
| Opfield MCP | `https://<opfield>/api/mcp` | Remote MCP endpoint. |

An OAuth access token for the API resource cannot call MCP. An OAuth access token for the MCP resource cannot call normal REST API routes.

Opfield intentionally treats the two OAuth resources differently:

- Opfield API OAuth keeps expiring access tokens and refresh-token renewal.
- Opfield MCP OAuth is intended for long-lived MCP and AI clients. MCP authorizations issue a long-lived access token and do not depend on refresh-token renewal during normal use.

MCP authorizations should be removed explicitly when access is no longer needed; revocation immediately stops the corresponding MCP token from being accepted.

OAuth authorizations are managed in **Profile > Authorizations > OAuth Applications**. If the same client has grants for both API and MCP resources, Opfield displays them as separate rows.

### MCP

The remote MCP endpoint is intended for AI and MCP clients.

MCP accepts only OAuth access tokens issued for the Opfield MCP resource. It rejects:

- Browser cookies.
- `opf_` API tokens.
- `opfl_` logging tokens.
- `opfi_` inference tokens.
- OAuth tokens issued for the Opfield API resource.

The `mcp:use` scope is a user-account capability gate. The owning user must have it for MCP access.

MCP tools cover every resource and management operation the OAuth grant's scopes allow, including node config and files, Docker migrations, the logging backend, Opfield settings, users and groups, inference providers, models, limits, usage and personal inference keys, hosting, and GitLab, GitHub, generic Git, Cloudflare, and external SSH connectors. Only AI Workspace internals (conversations, skills, tool-output paging, web search), AI sandbox tools and sandbox clones, API token and OAuth authorization minting, and embedded-assistant UI actions (setup dialogs, resource pins) are not exposed.

By default, Extended MCP compatibility is enabled and the first `tools/list` response includes every tool allowed by the OAuth grant. Administrators can disable it for clients that support dynamic discovery; in that mode MCP starts with a compact core toolset, clients call `discover_tools`, Opfield sends `notifications/tools/list_changed`, and the client refreshes `tools/list` so the activated tools become callable.

The `Ingress` toolset covers Domains, Routes, route folders, nginx templates, access lists, and raw route configuration. For compatibility, callable tool names, resource URIs, OAuth scopes, and REST paths still use `proxy_host`, `proxy`, or `/api/proxy-hosts`; those identifiers refer to the Routes shown in the Operations Console.

The same scoped automation surface includes managed database provisioning and container/deployment/Compose-service bindings; first-class Compose discovery, revisions, lifecycle operations, secrets, activity and Git-source builds; Page Projects, Deployments, Tags, deploy tokens, runtime configuration and Git-source builds; Build Worker-filtered job history with logs/cancel/retry; path-based Additional Routes; and independent Additional Secure Link Bindings. Remote MCP clients can also upload Pages artifact bytes with the authenticated `upload_pages_artifact` tool (a one-time curl upload link, or begin/chunk/finalize), while ordinary API clients can use the resumable deploy API.

MCP clients can read the same permission-filtered internal operator documentation used by AI Workspace through `read_opfield_documentation` or the `opfield://docs` resource tree. General topics are available to any valid MCP authorization; subsystem topics are listed and readable only when the delegated OAuth scopes grant that subsystem.

Extended compatibility can expose hundreds of schemas. Disable it only for clients that correctly handle `notifications/tools/list_changed` and need the smaller discovery-driven context.

### Access Summary, Skills, And Idempotent Retries

`GET /api/auth/me/access` summarizes what the caller can reach, grouped by product area: broad access, or the granted folders (with their paths), nodes, accounts, and single resources with their actions, and where the caller may create. API tokens and OAuth grants are reported as bounded by their owner's current access. MCP clients get the same summary from the `get_my_access` tool, which is always listed, and the `opfield://access` resource; when a connection's access is limited, a short form of it is also part of the MCP server instructions. Folder-, node-, and resource-limited access is normal: work inside the listed grants and pass `folderId` (and `nodeId`) when creating.

The MCP endpoint also serves the agent skills shipped with this Opfield release as `opfield://skills/<name>` resources and `skill-<name>` prompts, so a connected agent reads the version that matches the installation.

Create operations marked in the API reference accept an optional `Idempotency-Key` header (1 to 255 printable ASCII characters, for example a UUID). The key is bound to the token or browser session, its current scopes, the method, and the path, and results are kept encrypted for 24 hours:

- the same key and the same request replay the stored response with `Idempotency-Replayed: true`;
- the same key with a different request returns `422 IDEMPOTENCY_KEY_REUSED`;
- a retry while the first request still runs returns `409 IDEMPOTENCY_KEY_IN_PROGRESS` with `Retry-After`;
- a completed request whose response was not stored (it looked secret or was over 1 MiB) returns `409 IDEMPOTENCY_RESPONSE_WITHHELD`; look the resource up instead of retrying.

Operations that return a secret once (tokens, enrollment, keys, credentials) never take the header. MCP create tools take an `idempotencyKey` argument on the same mechanism, scoped to the MCP token and tool, except tools whose result carries a secret; their codes are `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_IN_PROGRESS`, and `IDEMPOTENCY_RESULT_WITHHELD`.

### Scope Rules

Creation scopes (`*:create*`, `docker:images:pull`, `ssl:cert:issue`, `pki:cert:issue`) imply no view. Every other action scope, including delete, implies its family's view scope with the same qualifier, so a resource-scoped grant stays bounded to the same resource (see [SCOPES.md](../SCOPES.md#scope-evaluation-behavior)).

For the complete scope list, implication behavior, delegability, and manual OAuth opt-in scopes, see [SCOPES.md](../SCOPES.md).

## Structured Logging

Logging is optional and is configured in **Settings > Features** as disabled, managed local, or external. Connection secrets are encrypted in Opfield settings. Legacy `CLICKHOUSE_*` env values are accepted only for migration and are removed by managed updates after a successful import.

### ClickHouse Image Upgrades

Opfield pins its managed local ClickHouse container to an explicit `clickhouse/clickhouse-server` release tag instead of using `latest`. Upgrade the pinned runtime intentionally and verify it against a copy of existing ClickHouse data.

An always-on guard monitors disk, structured logs, and ClickHouse internal logs. Enable **ClickHouse Internals** in **Settings > Features > Housekeeping** to allow the five-minute guard and manual Housekeeping runs to trim ClickHouse's system log tables (every `system.*_log` table, `query_log` last); enable it only when the entire ClickHouse instance is dedicated to Opfield. The guard follows the **Structured Logs** and **ClickHouse Internals** switches even while Housekeeping itself is turned off.

The managed local ClickHouse runs with Opfield's settings in `/etc/clickhouse-server/config.d/opfield-safety.xml`: it logs warnings to its container log (rotated at 10 MB × 3) instead of trace-level files inside the container, keeps no system log tables except `query_log` for one day, and so stays small. A local ClickHouse created before 2.12.3 gets the file and restarts once when Opfield starts; the rows its old system log tables held are then removed.

**Settings > Features > Housekeeping** can additionally cap the shared structured-log table by row count and approximate on-disk size. Cleanup drops only complete oldest daily partitions and preserves the current partition. Per-environment `retentionDays` TTL remains active independently. Internal cleanup is best effort and does not make ingest unavailable merely because maintenance privileges are absent.

If logging is disabled:

- Logging actions return `LOGGING_DISABLED`.
- The frontend hides the Logging section.

If ClickHouse is configured but unavailable:

- Environment metadata remains manageable.
- Ingest and search return `LOGGING_UNAVAILABLE`.

Authenticated users with `housekeeping:view` can inspect `GET /api/logging/health`. Confirmed disk or configured structured-log capacity exhaustion pauses ingest with `LOGGING_CAPACITY_EXHAUSTED` while existing log search remains available. The Dashboard shows storage pressure, degraded maintenance, exhaustion, and unavailability warnings.

### Logging Schemas

Opfield stores logs in one shared ClickHouse table. Each logging environment can define schema behavior:

| Mode | Behavior |
|------|----------|
| `reject` | Reject invalid log entries when unknown or invalid keys are present. |
| `strip` | Remove unknown custom labels/fields and accept the remaining event. |
| `loose` | Keep sanitized unknown custom labels/fields. |

### Ingest Examples

Single event:

```bash
curl -H "Authorization: Bearer opfl_xxx" \
  -H "Content-Type: application/json" \
  -X POST https://opfield.example.com/api/logging/ingest \
  -d '{"severity":"info","message":"hello from curl","service":"demo"}'
```

Batch:

```bash
curl -H "Authorization: Bearer opfl_xxx" \
  -H "Content-Type: application/json" \
  -X POST https://opfield.example.com/api/logging/ingest/batch \
  -d '{"logs":[{"severity":"info","message":"started","service":"api"},{"severity":"error","message":"failed","service":"api","fields":{"statusCode":500}}]}'
```

Search:

```bash
curl -H "Content-Type: application/json" \
  -H "Authorization: Bearer opf_xxx" \
  -X POST https://opfield.example.com/api/logging/environments/<environment-id>/search \
  -d '{"from":"2026-04-27T00:00:00.000Z","to":"2026-04-27T23:59:59.999Z","severities":["error","fatal"],"message":"failed","limit":100}'
```

### TypeScript SDK

Opfield publishes the official TypeScript logging SDK as [`@opfield/logger`](https://www.npmjs.com/package/@opfield/logger). Install it in Node services that need structured log delivery with batching, retries, fallback handling, and trace/span context:

```bash
pnpm add @opfield/logger
```

```ts
import { OpfieldLogger } from "@opfield/logger";

const logger = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  service: "billing-api",
  source: "worker-1",
  labels: { app: "billing", region: "eu" },
  fields: { version: "2.4.1" },
});

const trace = logger.createTrace({ requestId: "req_123" });
trace.info("Payment started");
trace.error("Payment capture failed", {
  labels: { provider: "stripe" },
  fields: { statusCode: 502, durationMs: 1834 },
});

await logger.flush();
await logger.close();
```

`opfl_` tokens are server-side write-only secrets. Do not expose them in browser code.

## AI Workspace

AI Workspace is the recommended intent-driven operating surface, but it is optional and disabled by default. The Operations Console remains fully usable without it.

To use it:

1. Go to **Settings > AI Workspace**.
2. Enable AI Workspace.
3. Choose **OpenAI-compatible** or, when the Inference feature is enabled, **Opfield Inference** as the provider type.
4. For OpenAI-compatible mode, configure the provider URL, endpoint family, model, and API key.
5. For Opfield Inference mode, choose a published default model and whether users may select another model they can access.
6. Review tool access and approval behavior.

AI Workspace offers two structured starting points in addition to free-form requests:

- **Scenarios** provide guided operational workflows while preserving the same permissions, approvals, and audit logging as a free-form request.
- **Plan Mode** researches and validates a multi-step change without performing mutations. Select Plan manually for any request; AI Workspace can also enter it automatically for complex, research-heavy, or materially risky work.

Plan Mode publishes a structured Plan Block for review. Choose **Implement** to begin, **Refine** to request another planning pass, or provide a custom instruction. Nothing mutates before **Implement** is explicitly confirmed. During execution, the progress block shows the active step and supports pause, resume, and cancel. A separate verification run completes the plan after implementation.

Operational notes:

- No data is sent to an AI provider until an administrator enables AI Workspace.
- Chat execution is backend-owned. Closing AI Workspace or reconnecting the browser does not make an active run depend on that WebSocket connection.
- Saved conversation history is loaded over REST, while active chat turns, approvals, questions, stops, and live snapshots use the AI WebSocket.
- Tool calls are permission-gated and scopes are checked by the backend before execution.
- Destructive operations require approval unless the user's AI approval mode allows the backend to auto-approve that class of tool.
- AI-initiated actions are flagged in audit logs.
- AI Workspace can use Opfield-specific context from its knowledge base.
- The selected model and reasoning effort are stored with each conversation. Changing a model after the conversation starts requires confirmation and adds a model-change marker to history.
- Opfield Inference mode uses the user's Inference limits instead of the AI Workspace request-limit block. The composer warns when an applicable quota window has 10% or less remaining and blocks new turns only when the budget is effectively exhausted.
- If a user's API budget is disabled, models backed only by API-provider connections are hidden from that user in both AI Workspace and Inference model catalogs.
- OpenAI-compatible provider values are preserved while Opfield Inference is selected. Disabling Inference restores the previous OpenAI-compatible configuration; if none exists, AI Workspace is disabled.
- Supported image attachments and generated artifacts are stored and previewed through Opfield-managed artifact routes.
- Each Work Session can have one active plan. Plans in separate Work Sessions can execute independently.

## Docker Image Cleanup

Old images stay on a node until something removes them, and Git-source builds add one per deploy. Opfield keeps per container or blue/green deployment the image it runs plus older ones up to its **Image Cleanup** setting (**Settings** of the container or deployment; on by default, **Keep last N versions** 2, the running one included):

- After an image change (a Git-source build deploy, an update, a recreate, a webhook deploy, a Compose apply) the node removes the older images of that repository 2 minutes later, so a rollout that has just pulled one of them again keeps it. Git-source build images, pulled by digest from the internal registry, count like tagged ones.
- When a Git-source build finishes or a Compose batch is applied, every online Docker node removes that source's older build images, so Availability replicas and Compose services on other nodes keep their running build and one to roll back to as well.
- The setting of a deployment, and of an Availability copy on another node, is that of its workload. When several containers run images of one repository, the largest setting counts, and a container with Image Cleanup turned off keeps all images of its repository.
- Images nothing on the node runs (the image of a removed container, an earlier Compose tag, a superseded database engine or tool image, the builds of a deleted Git source) and dangling images are removed once Opfield has seen them unused for 12 hours. Of Opfield's tool images (Compose sidecar, Docker CLI, volume helper, backup runner, Keeper witness) the newest stays.
- Images a container uses (running or stopped) are never removed, and neither are the builds the internal registry keeps for rollback nor images a deployment, Compose revision (the active one and the two newest), Availability policy, rollback release or pull under way names. Blue/green deployments keep both slots' images.
- **Housekeeping > Docker Images** (on by default) applies all of this on every online Docker node on each run; its card counts every old image, those still within their 12 hours included. It also removes old Opfield app and relay images on the Opfield host (the one Opfield runs and the newest other one stay) and old connector images (the current one and one more stay). Nodes that kept old images from earlier releases are cleaned within a day of the update.
- Database and storage nodes remove their own unused images: an engine or tool image no container uses and no managed instance names goes after 24 hours unused; the newest of each repository stays.
- **Prune** on a node's Images removes dangling images (no tag, no digest) at once and applies the same rules.

## Disk Usage And Retention

**Settings > Features > Housekeeping** starts with what Opfield's own data takes on the Opfield host: every disk that holds it (the Docker data root with images, container logs and named volumes, and any volume of the stack on a disk of its own) with its free space, the Postgres database with its largest tables, Redis memory and AOF size, and the size of the container logs (shown only; logs rotate by their Docker log settings). The disks are measured every 10 minutes.

Every record Opfield keeps has a bound, on by default and applied to existing installs on the first run after an update:

- **Operation History** (90 days) removes finished operations and run records, keeping each resource's 10 latest: builds, Compose, Availability and hosting operations, webhook deliveries, registry maintenance runs, relay pool update runs, deployment releases, container migrations, storage copy jobs, sandbox jobs, inference core operations, App promotions and incidents, sign-in sessions, earlier certificate placements of proxy hosts and deleted image records.
- **Build Logs** (30 days, 2 GiB in total) removes the logs of finished builds past the age, then the oldest while all build logs together are larger. The newest 3 finished builds of each source keep their log.
- **Inference Usage** (90 days, at least 35) removes settled inference requests with their attempts and usage records. Usage limits and reports read at most the last 30 days or the current month, and each user's lifetime total keeps what was removed. Old provider quota readings and unused price versions go too.
- **Orphaned Volumes** (3 days) removes an anonymous volume once it was unused that long, only when Opfield created it: a scan saw it attached to a container Opfield created. Unused volumes Opfield did not create, or cannot tell (for example left before this release), are never removed automatically; the card counts them so you can remove them yourself. Blue/green slots and Availability replicas remove their anonymous volumes when they are replaced.
- **Orphaned AI Artifacts** removes files whose conversation or user was deleted, and keeps tool and sandbox outputs within 10 GiB together (oldest first). Files users attached are not capped.
- **Opfield Host Files** removes leftovers of interrupted work on the Opfield host: temporary files, MCP archive transfer spools, configuration export snapshots and dumps. It also runs a minute after Opfield starts.
- **Dismissed Alerts** also keeps one open alert per resource and kind, and removes open alerts older than 90 days.

With the Housekeeping switch off, the scheduled run still runs the categories that bound Opfield's own data (Internal Registry, Operation History, Build Logs, Inference Usage, Expired OAuth Grants, Expired Tokens, Opfield Host Files), each with its own switch. A category that takes more than 30 minutes is stopped and reported, and the rest of the run continues. When a disk holding Opfield data reaches 90%, housekeeping runs at once instead of at night (at most once an hour).

## Notifications And Status Pages

Opfield supports operational notification workflows:

- Webhook notification targets.
- Delivery history.
- Built-in templates for common integrations.
- Alert rules.
- Status-page incident workflows.
- Certificate, domain, health, and runtime alerts.

Use status pages for externally visible service health and incidents. Use notifications for internal operational alerts.

Built-in rules watch disk space out of the box:

- **Node disk almost full** (85% or more, warning) and **Node disk full** (95% or more, critical): every data disk of every node, each disk alerting on its own and the message naming it. That is the root disk, the disk holding Docker's data root, the disk holding the managed storage root and any other attached disk (**Disk To Watch: Every Data Disk**). The disk images of managed databases, storage and volumes are left out: they have their own rules below. A relay in protected mode reports its root disk only, and that is watched too. A **Node disk almost full** rule edited before 2.12.3 keeps watching the root disk `/` only; pick **Every Data Disk** to widen it.
- **Node disk oversubscribed**: the disk for managed databases and storage on a node is promised more than it holds, so its instances fill it before they reach their sizes and new instances and disk grows there are refused.
- **Postgres disk almost full**, **Key-value store disk almost full** and **ClickHouse disk almost full**: the data disk of a database at 85% or more.
- **Opfield disk almost full** (Opfield category): the Opfield host's data disk at 85% or more.

The upgrade creates them enabled, notifying the webhooks the existing node, Opfield, database and storage rules notify; on a new install, pick their webhooks in **Notifications > Alerts**. Change the thresholds or turn them off there. In a message template, `{{details.mount}}` is the mount point of the disk a node disk rule alerts on.

Two more built-in Opfield rules come with the update: **Opfield disk full** (critical, 95% or more) and **Housekeeping not running** (no successful housekeeping run for two days, so nothing is being removed). The Opfield host disk they watch is the fullest disk that holds Opfield data: the Docker data root and every volume of the stack, not only the app's data directory.

Notification message and webhook templates use one canonical nested context. Common families are `notification.*`, `alert.*`, `resource.*`, `metric.*`, `node.*`, `health.*`, `certificate.*`, `state.*`, `event.*`, `operation.*`, `failure.*`, `details.*`, `fired.*`, `resolution.*`, and `gateway.*`. For example, use `{{notification.title}}`, `{{alert.severity.emoji}}`, `{{metric.value}}`, and `{{fired.duration}}` (how long the alert lasted, such as `3m 37s`; `{{fired.duration.seconds}}` is the number of seconds). Historical flat names such as `alert_name`, `value`, `threshold`, `fired_at`, and `fired_duration` are not aliases and render empty. The `coalesce` helper can select the first non-empty nested value.

An alert rule has a message for when its alert fires and a **Resolve Message Template** for when it resolves. A rule without a resolve message uses Opfield's text for it, such as "Proxy host example.com is back online after 13m 2s." or "CPU Usage on node-1 is back to normal at 42% after 5m 0s."; the firing message is not reused for the resolve, unless it was written for both states (it reads `alert.status`). One-off event rules never resolve and have no resolve message. A recovery event (**Node Online**, **Health Online**, **Database Online**) is sent once each time the resource comes back, not for resources that are simply up when the rule is created; when the resource goes down again the alert closes quietly, without a resolve message.

### Webhook Delivery

Each webhook sends its notifications one at a time, in the order the alerts fired and resolved. When a webhook's target cannot be reached (network or DNS error, timeout, `408`, `425` or `5xx`), the whole webhook pauses and tries the same notification again after 15 seconds, 30 seconds, 1, 2 and then every 5 minutes; nothing behind it is sent meanwhile, and the queue continues in order once the target answers. A `429` pauses the webhook for as long as the target asks (`Retry-After`, or Discord's `retry_after`). Any other `4xx`, or a target the outbound webhook policy refuses, fails that notification only. A notification still queued 24 hours later fails. The queue is kept in the database, so it continues after an Opfield restart.

A firing notification that could not go out because the webhook's target could not be reached is not sent once its alert has resolved, and neither is that resolve: the reader never saw the alert, so there is nothing to resolve. The **Delivery Log** shows both as **Not sent** with the reason. A webhook that rate-limits (`429`) is up, so it gets both the firing and the resolve, in order, once it takes deliveries again.

### One Cause, One Alert

Opfield checks its own outbound connectivity every 20 seconds by resolving and connecting to the hosts of the enabled webhooks and two public endpoints (`one.one.one.one` and `dns.google`); webhooks on private addresses are not counted. When none can be reached, the built-in rule **Opfield lost outbound connectivity** (Opfield category, event `outbound.unavailable`, after 40 seconds) fires, and it resolves once Opfield reaches them again. An Opfield that has not reached any of them since it started, such as an air-gapped install, does not report it. The upgrade creates this rule enabled, notifying the webhooks the existing proxy and node rules notify; on a new install, pick its webhooks in **Notifications > Alerts**.

A proxy host health alert (offline or degraded) is folded under another alert that explains it:

- the proxy host's node is down: a node **offline** alert fires for the node serving the proxy host (its nginx node or a member of its ingress group) or for the node running its container upstream;
- Opfield lost outbound connectivity, and the proxy host's health probe was sent by Opfield itself and got no answer (DNS, connect or timeout errors).

A container or deployment health alert (offline or degraded) is folded the same way under the **offline** alert of the node it runs on.

A folded alert is not sent to a webhook that gets the alert it is folded under; a webhook that does not get that alert still gets it. It resolves together with that alert, without a separate message. An alert that fires later still folds the proxy host alerts it explains if they have not gone out yet. For 2 minutes after that alert resolves, the proxy host alerts it explains are not raised, so proxy hosts that come back right after their node or Opfield's connectivity do not alert; a proxy host still down after that alerts on its own. While Opfield cannot reach its webhooks, their notifications wait and go out in order as soon as it can.

### SIEM Audit Export

Configure SIEM collectors in **Notifications → SIEM**. Opfield keeps delivery in the main app process: no separate Compose service or worker container is required. A scheduler claims durable outbox rows every 30 seconds with database leases, so duplicate scheduler execution is safe if more than one app process is present. This lease safety applies only to SIEM delivery; horizontal Opfield application clustering is not currently a supported deployment mode.

The feature flag is enabled by default where the Enterprise `siem-export` entitlement is available. Use **Settings > General > Features and updates > SIEM audit export** to turn it off installation-wide: this hides the SIEM screens, makes the SIEM API and AI tools unavailable, stops new outbox rows, and pauses delivery without restarting Opfield. Existing destinations, terminal history, and queued records stay in PostgreSQL; queued records resume after re-enabling the feature. Once a license grace period ends, SIEM forwarding pauses: new audit events are not queued, and the configuration, delivery history, and queued records are kept and resume on renewal. Queued records older than the Audit Log retention are removed meanwhile.

Each request sends `{ "schemaVersion": 1, "events": [...] }` to an HTTPS endpoint using either `Authorization: Bearer <token>`, one validated custom request header, or HMAC headers `X-Opfield-Timestamp` and `X-Opfield-Signature-256`. The HMAC is `sha256=<hex>` over `timestamp + "." + exact raw JSON request body`; the collector should reject stale timestamps and use constant-time comparison. A successful `2xx` completes the batch. Network errors, `408`, `429`, and `5xx` retry after 30 seconds, 2 minutes, 8 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours, with at most eight attempts. Other `4xx` responses are terminal failures.

Use **Send test event** after configuring a collector. It sends a synthetic event only and creates neither an audit-log record nor a queued delivery. The delivery log intentionally shows safe status, timing, retry information, error text, and the reduced event only; it never stores or displays collector response bodies. Delivery rows follow the Audit Log retention setting in **Settings > Features > Housekeeping**: rows older than it are removed whether they were delivered or are still waiting, except a batch being delivered at that moment.

When troubleshooting, verify the endpoint against Opfield's outbound-webhook network policy, confirm the expected bearer, custom-header, or HMAC verification at the collector, and inspect the SIEM Delivery Log. Do not paste a token, header value, or HMAC secret into tickets, audit notes, chat, or collector URLs. Disabling an individual destination pauses its outstanding rows; re-enabling within 7 days resumes them. A destination left disabled (and unchanged) for longer loses its paused rows at the next housekeeping run. Deleting a destination discards outstanding rows, while historical terminal rows remain until retention cleanup.

## Backups

Back up:

- PostgreSQL data.
- Redis data if preserving sessions and cache matters.
- ClickHouse data if structured logging is enabled.
- `.env`.
- Custom TLS certificate and key files.
- Any external volume paths you configured manually.

Critical secrets:

- `PKI_MASTER_KEY` is required to decrypt PKI private key material and encrypted provider/infrastructure credentials stored in PostgreSQL.
- Redis session data controls browser session validity; preserve Redis data only when session continuity matters.
- OIDC client secret is needed for login.
- ClickHouse and database credentials are needed for service startup.

Store backups separately from the Opfield server and test restore procedures before relying on them.

## Internal Registry Storage

The internal registry keeps build images on a Docker volume of the Opfield host by default. That volume shares the host's disk with PostgreSQL. To keep images off that disk, move the registry to an S3 bucket in **Settings > Features > Internal Registry > Storage** (or `PUT /api/docker/registries/internal/settings` with `storage`, or the MCP tool `manage_docker_registry` with `internal_update_settings`). Every plan can do this. It needs `docker:registries:edit`.

- Enter the endpoint (empty for AWS S3), region, bucket, an optional folder, path-style access (on for MinIO, SeaweedFS and most self-hosted S3) and an access key, or pick an S3 storage connection you may use (`storage:credentials:use`). The registry container must reach the endpoint.
- Opfield first writes, reads and deletes a test object in the bucket. If that fails, nothing changes and the error says why. A folder that already holds registry data Opfield did not copy is refused: use an empty folder.
- The switch then runs in the background. Builds wait (pushes are paused), pulls keep working. Opfield copies every stored image to the bucket, restarts the registry on it and checks that the images used by running workloads can be read. If any step fails, the registry goes back to its previous storage. **Last storage switch** in the panel (and `storage.lastSwitch` in the API) shows the result.
- After a successful move to S3, the images are removed from the local volume. Garbage collection and retention work as before. The panel and Housekeeping show the size of the registry's folder in the bucket, measured every few minutes.
- If Opfield restarts during a switch, it finishes the switch at the next start when the new storage was already written, and otherwise puts the registry back on its previous storage. The app log says what it repaired.
- Switching back to **Local disk** copies the images from the bucket to the volume. The bucket keeps its copy; empty that folder before you move the registry to it again.
- To move to another bucket or folder, switch to Local disk first, then to the new bucket.

The registry cleans up after itself at every maintenance run (after builds and nightly with Housekeeping):

- It keeps per container the build it runs and one to roll back to. **Roll back** in the container's **Source** tab (Delivery status; API `POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/rollback`, MCP `manage_docker_source` `rollback`) runs that build again; the container stays on it until the next new commit is built and deployed. Older builds are gone: to run older code, push a revert commit.
- The builds of a Git source that no longer exists (its container, deployment or Pages project was deleted, or the source was detached) are deleted once two maintenance runs at least 12 hours apart found no workload naming them.
- On local disk, the leftovers of pushes that failed or were cancelled are removed after a day.
- On local disk, the registry stops taking new builds and image pushes while the disk under its volume is 90% full or more. Builds then fail with a message that says so, and the registry shows **Degraded**. They resume on their own once space is freed. Pulls keep working. A registry on S3 is not limited by the host disk.

The choice is kept in `.env` (`OPFIELD_REGISTRY_STORAGE` and `OPFIELD_REGISTRY_S3_*`), and `docker-compose.yml` reads it, so updates and restarts keep it. If you rotate the S3 keys, enter the new ones in the same panel. Installations that never change this setting keep the local volume.

A configuration export carries the bucket settings and keys, like the other stored credentials, and the restored installation runs its registry on the same bucket. Do not keep the old installation running on that bucket: both registries would collect garbage in it.

## Security Notes

For the full security model, including daemon PKI, mTLS enrollment, token boundaries, and hardening guidance, see [Security model](security.md).

- Prefer OIDC with MFA enforced at the identity provider.
- Grant users only the groups and scopes they need.
- Separate read, write, reveal, export, and destructive scopes.
- Treat API tokens, OAuth access tokens, OAuth refresh tokens, logging tokens, and inference runtime tokens as secrets.
- Use OAuth resource separation for API and MCP clients.
- Review audit logs after sensitive operations.
- Keep daemon update capability limited to trusted admins.
- Protect `.env` because it contains database, OIDC, session, and PKI secrets.

## Troubleshooting Pointers

If Opfield cannot start:

- Check `docker compose ps`.
- Check app logs with `docker compose logs app`.
- Verify `.env` values.
- Verify PostgreSQL, Redis, and ClickHouse health. Redis and PostgreSQL outages make `/health` fail. Redis outages also make API/auth/public rate-limited endpoints return `503` until rate limiting is enforceable again. `/health` checks PostgreSQL over a connection of its own, so a busy connection pool does not read as an outage.

If Opfield runs but is slow or misbehaves:

- Ask the AI assistant or an MCP client to use `manage_opfield_diagnostics`. It needs `diagnostics:view`, or `diagnostics:logs` for logs; both are held by the built-in admin groups. It shows:
  - Opfield's host CPU, memory and disk;
  - the backend process and event-loop delay;
  - PostgreSQL and Redis;
  - the stack containers, background jobs, and API latency and errors;
  - 48 hours of one-minute history;
  - the logs of the app, database, cache, relay, registry and the last update run.
- Alert rules in the Opfield category can report high host CPU, memory or disk use, process memory, event-loop delay, API 5xx rate and p95 latency, PostgreSQL latency and pool waits, and Redis latency. They also fire when PostgreSQL or Redis is unavailable, when a stack container is down or unhealthy, and when a background job keeps failing. A PostgreSQL outage alert is sent directly to the webhooks of its rules; the webhooks and rules come from the last copy read before the outage.

If a node does not connect:

- Verify the node can reach `opfield.example.com:9443`.
- Confirm the enrollment token was copied before it expired or was used.
- If logs mention an Opfield certificate fingerprint mismatch, delete the pending node and create a new node in Opfield, then rerun the generated command. You may change `--opfield` to a direct `9443/tcp` endpoint, but keep the generated `--gateway-cert-sha256` value.
- Check the daemon systemd logs.
- Confirm system time is sane on both Opfield and the node.

If Dashboard shows the red **Opfield relay is unavailable** state:

- Allow the bounded automatic recovery attempts to finish or use **View details** to inspect the safe diagnostic reason.
- If recovery remains critical, verify the `relay` Compose service, its identity volume, PostgreSQL reachability, and the independently pinned relay image. Do not bypass the relay by publishing another port or moving `9443/tcp` back to `app`.
- The red state means managed-node and private managed-database tunnel traffic is unavailable. Existing database sessions survive a PostgreSQL outage after establishment, but new opens fail closed until authorization can be checked.
- Nodes and remote relays reach Opfield through this relay, so while it restarts (a crash, automatic recovery, an update, a manual restart) they show as reconnecting, not offline, and Opfield sends no offline alerts for them. **Settings > Relay** shows the pool as `local relay restarting`, then `nodes reconnecting` until they are back. A node still away 2 minutes after the relay serves again is marked offline then and alerts as usual.

If OAuth or OIDC fails:

- Verify redirect URI exact match.
- Verify the canonical public URL in **Settings > General** and the OIDC redirect URI in **Settings > Authentication**.
- Verify the provider exposes discovery metadata.
- Check Opfield app logs for callback errors.
