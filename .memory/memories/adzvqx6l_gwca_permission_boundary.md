---
{
  "id": "adzvqx6l",
  "file_name": "adzvqx6l_gwca_permission_boundary",
  "tags": [
    "authorization",
    "docker",
    "opfield",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785532665862,
  "updated_at": 1791851052721
}
---
# Opfield Docker authorization and state contract

## Container archive export

- Container archive export requires resource-scoped `docker:containers:export` in addition to protected-data access.
- Source-container export also requires `docker:containers:files` and `docker:containers:environment`.
- `docker:containers:secrets` controls visibility of the Include secrets option and whether secret values can be exported.
- Export scope defaults to system administrators and administrators, is excluded from operators, and requires manual OAuth approval.

## Volume archive export

- Volume archive download requires separate resource-scopable `docker:volumes:export`; view and file-read permissions do not imply export.
- The action is visible only with broad permission or a matching node-scoped export grant.
- Existing custom roles and delegated tokens require an explicit grant.

## Private registry selection

- Multiple saved registry records may share a host while carrying different credentials or scopes. Inferred single-host lookup can select credentials without access to the target image.
- Every image-pull surface supports explicit registry selection.
- AI/MCP create and pull tools expose optional `registryId`, pass it through validation/services, resolve auth for the selected registry, and preserve the resolved registry identity.
- Recreate/deployment flows continue trying authorized registry candidates when no explicit registry is supplied.

## Environment persistence and rollback

- Container environment variables live in `docker_env_vars`, separate from `docker_secrets`, using the same `CryptoService` envelope encryption pattern.
- Management reads database-backed values first, seeds existing runtime values on first read, persists updates only after daemon acceptance, and merges stored environment/secrets into recreate/update flows.
- Daemon recreate (`packages/daemons/docker/internal/docker/client.go`) accepts `env` and `removeEnv`.
- If replacement creation or startup fails after removing the old container, the daemon attempts rollback from the original container snapshot.

Cross-cutting secret-retention, installation-hardening, and MCP-token policy remains canonical in the dedicated security-boundary memory rather than duplicated here.
