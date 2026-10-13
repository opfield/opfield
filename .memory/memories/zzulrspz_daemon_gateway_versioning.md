---
{
  "id": "zzulrspz",
  "file_name": "zzulrspz_daemon_gateway_versioning",
  "tags": [
    "compatibility",
    "daemon",
    "opfield",
    "updates",
    "versioning"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1776726813806,
  "updated_at": 1791852026606
}
---
Opfield marks a daemon as incompatible during gRPC registration (`packages/backend/src/grpc/services/control.ts`) by comparing the running Opfield APP_VERSION with msg.register.daemonVersion using isMinorCompatible() from `packages/backend/src/lib/semver.ts`. Compatibility requires the same major.minor; patch differences are allowed. If either version is 'dev' or unparsable, it is treated as compatible. DaemonUpdateService (`packages/backend/src/services/daemon-update.service.ts`) reads the release feed configured by `RELEASES_API_URL` only to compute updateAvailable/latestVersion; it does not control incompatibility. (Verified 2026-10-01; earlier notes called this feed "GitLab", which predates the GitHub migration.)
