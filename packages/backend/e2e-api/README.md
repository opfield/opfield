# Opfield API E2E Smoke Suite

This suite verifies a running Opfield deployment through real HTTP API calls with an Opfield API token. It creates a temporary permission group, user, and API token directly in the local PostgreSQL database, using all currently delegable API token scopes from `src/lib/scopes.ts`, then removes them after the run.

Run from the repository root:

```sh
DATABASE_URL=postgres://dev:dev@localhost:55432/gateway \
GATEWAY_E2E_API_URL=http://localhost:3000 \
pnpm --filter backend e2e:api
```

By default the suite is read-only except for creating and deleting its temporary API token. To run safe metadata mutations that create their own `codex-e2e-*` records and clean them up:

```sh
GATEWAY_E2E_ALLOW_MUTATIONS=1 pnpm --filter backend e2e:api
```

With mutations enabled, the suite covers core metadata CRUD, proxy and Docker folders, Nginx templates, PKI CAs/templates, status page services/incidents, notification webhooks/alert rules, logging schemas/environments/tokens, and safe Docker volume/network create-delete flows against a connected Docker node when one exists.

To run disposable runtime mutations against connected daemons, enable the runtime tier:

```sh
GATEWAY_E2E_ALLOW_MUTATIONS=1 \
GATEWAY_E2E_ALLOW_RUNTIME_MUTATIONS=1 \
pnpm --filter backend e2e:api
```

The runtime tier creates only `codex-e2e-*` resources. It covers pending node enrollment cleanup, connected PostgreSQL read-only query checks, ingress route (`proxy-host` API resource) create/update/toggle/delete when an online nginx node exists, PKI certificate issue/revoke and internal SSL linking, and Docker container create/duplicate/rename/env/secrets/live-update/recreate/start/stop/restart/kill/files/logs/stats/top lifecycle checks when a connected Docker node has a suitable local image. Set `GATEWAY_E2E_DOCKER_IMAGE=nginx:latest` or another already-available long-running image to force the container image used by the runtime Docker scenario.

Useful environment variables:

- `DATABASE_URL`: PostgreSQL database for the running Opfield installation. Defaults to the backend dev database.
- `GATEWAY_E2E_API_URL`: Opfield API base URL. Defaults to `http://localhost:3000`.
- `GATEWAY_E2E_KEEP_TOKEN=1`: Keep the seeded permission group, user, and API token after the run and print the token.
- `GATEWAY_E2E_ALLOW_UNHEALTHY=1`: Do not fail if `/health` returns `503`.
- `GATEWAY_E2E_ALLOW_MUTATIONS=1`: Enable safe create/update/delete smoke tests.
- `GATEWAY_E2E_ALLOW_RUNTIME_MUTATIONS=1`: Enable disposable runtime mutations for Docker containers and nginx ingress routes.
- `GATEWAY_E2E_DOCKER_IMAGE`: Docker image to use for the runtime container scenario. If omitted, the suite picks a suitable local image from the connected Docker node.

The suite never mutates pre-existing Docker containers, triggers Opfield/daemon updates, issues ACME certificates, or mutates connected databases. Runtime tests operate only on resources created by the suite and clean them up after the run.
