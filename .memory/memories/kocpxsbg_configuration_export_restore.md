---
{
  "id": "kocpxsbg",
  "file_name": "kocpxsbg_configuration_export_restore",
  "tags": [
    "configuration-export",
    "daemons",
    "installer",
    "restore"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791760449242,
  "updated_at": 1791760449242
}
---
Configuration export/restore (2.12, branch feat/config-export): backend in packages/backend/src/modules/configuration-transfer (transfer-archive.ts = .opfield-export format: plaintext header line with version, scrypt + AES-256-GCM frames bound to header digest/index/final flag; transfer-docker.ts = pg_dump/pg_restore inside the Compose postgres container and volumes via never-started helper containers + Docker archive API; configuration-restore.ts = restore engine used by dist/cli/configuration-restore.js). Restore runs in a one-off container of the same image (installer `install.sh --restore`, or the setup wizard launching it); it verifies the whole file first, requires same APP_VERSION and same last migration tag, keeps rollback copies, empties gateway_relay_state so the local relay re-pins the restored policy key, writes gateway_data/configuration-restore/restored.json which the app applies at the next start (address before listener certs are checked). Address change: proto GatewayCommand field 82 SetGatewayNextAddress (capability gateway_next_address_v1); daemons switch after 10 min unreachable to a server of the same System CA.
Gotchas: the restore runner must NOT carry the helper label com.wiolett.gateway.configuration-transfer (removeLeftoverHelpers would delete it) and must be created with a name (runDetached takes no name). Source-built installs get VERSION local-<timestamp>, so a wizard restore into a fresh source build fails the version check by design; for stand tests rebuild the image with --build-arg APP_VERSION=<export version>. Stand test scripts kept in gw-export .workflow/impl/cfgexp-tools.
