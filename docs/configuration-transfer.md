# Moving Opfield To Another Host

[Back to README](../README.md)

A configuration export packs an Opfield installation into one encrypted file. Restoring it on another host brings back the same installation: users, settings, nodes, routes, certificates, secrets and the license. Export and restore are available on every plan.

## What Moves

The export holds:

- the Opfield database, as a consistent snapshot taken while Opfield keeps running;
- `PKI_MASTER_KEY`, which decrypts every stored secret: OIDC, SMTP, ClickHouse, registry and integration credentials;
- every CA private key, including the System CA that enrolled nodes trust, and the relay policy signing keys that remote relays trust (both are stored in the database and encrypted with the master key);
- Opfield's files: Pages artifacts, avatars, AI artifacts, listener certificates, the local relay identity and the internal registry's token signing material;
- the commercial core of a paid installation, so it runs on the new host without a new download;
- the installation ID, so the license stays with the installation;
- optional tunables set in `.env`: `GITHUB_OAUTH_CLIENT_ID`, `HEALTH_CHECK_INTERVAL_SECONDS`, `ACME_RENEWAL_CRON`, `EXPIRY_CHECK_CRON`, `DNS_RESOLVERS`, `DNS_CHECK_INTERVAL_SECONDS`, `UPDATE_CHECK_INTERVAL_HOURS`, `SECURE_LINK_LOOPBACK_PORT`.

Two parts are optional, because they can be large; the export dialog shows their sizes:

- **Internal registry images.** Without them, images built from Git sources are rebuilt on the next deploy.
- **Logs** of the Opfield-managed ClickHouse. ClickHouse pauses for a few seconds while its files are linked into a snapshot; ingest continues after that. Logs in an external ClickHouse stay where they are.

## What You Enter Again

The new host keeps its own values for:

- the public URL and the gRPC address nodes connect to: the restore asks for them;
- database and registry passwords: the new installation makes its own;
- `PUBLIC_IPV4`, `PUBLIC_IPV6`, `OPFIELD_LOCAL_HOSTS` and `GRPC_TLS_*` overrides in `.env`;
- the sandbox workspace directory and Docker logging of the new host;
- reverse proxy, firewall and DNS records in front of Opfield.

Sign-in sessions do not move: everyone signs in again. The local relay starts with empty state and takes the restored policy key on its first start.

## Export

**Settings > General > Configuration export** (scope `admin:system`, which only the built-in administrators group has). Choose a passphrase of at least 12 characters, choose whether to include registry images and logs, and select **Export**. The browser downloads `<host>-<date>.opfield-export` while Opfield writes it; the dialog shows the progress. Nothing stops while the export runs.

The file is encrypted with AES-256-GCM under a key derived from the passphrase with scrypt. Opfield does not store the passphrase and cannot recover it. The file and the passphrase together open every secret of the installation: keep them apart.

API: `GET /api/system/configuration-export` (sizes), `POST /api/system/configuration-export` with `{ passphrase, includeRegistry, includeLogs }` returns a one-time download link valid for 15 minutes, `GET /api/system/configuration-export/{id}` reports progress. MCP: `manage_configuration_export` (`estimate`, `export`, `progress`). Exports are audited as `system.configuration_export` (or `system.configuration_export_failed`), with the options and the size; the passphrase never reaches a log. Impersonated sessions cannot export.

## Restore

An export restores into a fresh installation of **the same Opfield version** that made it. A different version is refused before anything changes; install that version, restore, then update. The whole file is decrypted and checked before anything changes: a wrong passphrase, a changed or truncated file, or a missing part stops the restore with nothing touched. If a step fails later, the restore puts the previous database, volumes and files back.

### In the setup wizard

Install Opfield on the new host as usual (the installer picks the latest release; to restore an older export, use the installer option below). Open the setup wizard, enter the setup code and choose **Restore from an export**. Upload the file, enter the passphrase and check the export. The wizard shows when and where it was made and what it contains, and asks for this host's public URL and gRPC address, filled in with the exported ones. Restoring stops Opfield for a few minutes; the wizard then sends you to the sign-in page at the restored address.

### With the installer

```bash
curl -fsSL https://get.opfield.dev | bash -s -- --restore /path/to/opfield.opfield-export
```

The installer reads the version from the file, installs exactly that version into a fresh directory, asks for the passphrase and for this host's address, restores and starts Opfield. For a run without a terminal, set `OPFIELD_RESTORE_PASSPHRASE` and pass `--public-url` and `--grpc-target`; without them the exported address is kept. `--install-dir` works as for a normal install. The directory must not hold an installation already.

The first start after a restore applies the new address, reissues the gRPC and web certificates for it, and records `system.configuration_restored` in the audit log.

The restored copy is not linked to an Opfield account: the cloud link of the exported installation is dropped, with the Opfield account sign-in client Opfield Cloud gave it. An export of an Opfield Cloud installation also comes back without its Opfield account sign-in, which works only on the cloud's address: OIDC sign-in is turned off, password sign-in on, and the owner moves to password sign-in. The installer prints a one-time link (valid 24 hours) that sets the owner's password; a restore in the setup wizard shows the same link on its last screen. For a new link, run `docker compose exec app node dist/cli/owner-password-link.js` in the installation directory. Other users and roles stay as they were; accounts that signed in with the Opfield account need another sign-in method. The licence stays with the cloud installation: the copy starts on Community under a new installation ID, and its owner activates their own key in Settings > License. A self-hosted export keeps its licence.

## Nodes And Relays

Enrolled nodes and remote relays keep their identities: the restored installation has the same System CA, so their certificates stay valid. They reconnect to the address in their daemon configuration (`opfield.address`; nodes set up before 2.12.1 may still have it under `gateway.address`).

- **Same address.** Point the address (DNS name or IP) at the new host. Daemons reconnect on their own.
- **New address.** Before you shut the old installation down, open **Settings > General > Move nodes to a new address** on it and enter the new gRPC address (`host:port`, port 9443 by default). Every connected node and relay keeps it next to its current address. A daemon switches only after its current address stayed unreachable for 10 minutes and the new address presents a certificate of the same System CA, that is, once the old installation is down and the restored one answers. It then writes the new address into its configuration. Nodes that connect while the address is announced are told within a minute. The panel lists which nodes were told, which are offline and which run a daemon too old for it; update those daemons first. **Withdraw** takes the address back.
- **Old installation gone.** Nodes that were not told keep trying the old address. Point that address at the new host, or set `opfield.address` (or `gateway.address` on a node that still has that section) in the daemon configuration on the node (`/etc/docker-daemon/config.yaml`, `/etc/nginx-daemon/config.yaml`, `/etc/monitoring-daemon/config.yaml` or `/etc/gateway-relay-supervisor/config.yaml`) and restart the daemon. The node keeps its identity; no new enrollment is needed.

Keep the old installation stopped once nodes have moved: two installations with the same identity must not run at the same time.

API: `GET` and `PUT /api/system/configuration-export/move` with `{ "address": "host:port" }` or `{ "address": null }`. MCP: `manage_configuration_export` `move_status`, `announce_move`, `withdraw_move`. Audited as `system.opfield_move_announced` and `system.opfield_move_withdrawn`.
