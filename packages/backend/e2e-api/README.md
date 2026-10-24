# Opfield API E2E Smoke Suite

This suite verifies a running Opfield deployment through real HTTP API calls with an Opfield API token. It creates a temporary permission group, user, and API token directly in the local PostgreSQL database, using all currently delegable API token scopes from `src/lib/scopes.ts`, then removes them after the run.

Run from the repository root:

```sh
DATABASE_URL=postgres://dev:dev@localhost:55432/opfield \
OPFIELD_E2E_API_URL=http://localhost:3000 \
pnpm --filter backend e2e:api
```

By default the suite is read-only except for creating and deleting its temporary API token. To run safe metadata mutations that create their own `codex-e2e-*` records and clean them up:

```sh
OPFIELD_E2E_ALLOW_MUTATIONS=1 pnpm --filter backend e2e:api
```

With mutations enabled, the suite covers core metadata CRUD, proxy and Docker folders, Nginx templates, PKI CAs/templates, status page services/incidents, notification webhooks/alert rules, logging schemas/environments/tokens, and safe Docker volume/network create-delete flows against a connected Docker node when one exists.

To run disposable runtime mutations against connected daemons, enable the runtime tier:

```sh
OPFIELD_E2E_ALLOW_MUTATIONS=1 \
OPFIELD_E2E_ALLOW_RUNTIME_MUTATIONS=1 \
pnpm --filter backend e2e:api
```

The runtime tier creates only `codex-e2e-*` resources. It covers pending node enrollment cleanup, connected PostgreSQL read-only query checks, ingress route (`proxy-host` API resource) create/update/toggle/delete when an online nginx node exists, PKI certificate issue/revoke and internal SSL linking, and Docker container create/duplicate/rename/env/secrets/live-update/recreate/start/stop/restart/kill/files/logs/stats/top lifecycle checks when a connected Docker node has a suitable local image. Set `OPFIELD_E2E_DOCKER_IMAGE=nginx:latest` or another already-available long-running image to force the container image used by the runtime Docker scenario.

Useful environment variables:

- `DATABASE_URL`: PostgreSQL database for the running Opfield installation. Defaults to the backend dev database.
- `OPFIELD_E2E_API_URL`: Opfield API base URL. Defaults to `http://localhost:3000`.
- `OPFIELD_E2E_KEEP_TOKEN=1`: Keep the seeded permission group, user, and API token after the run and print the token.
- `OPFIELD_E2E_ALLOW_UNHEALTHY=1`: Do not fail if `/health` returns `503`.
- `OPFIELD_E2E_ALLOW_MUTATIONS=1`: Enable safe create/update/delete smoke tests.
- `OPFIELD_E2E_ALLOW_RUNTIME_MUTATIONS=1`: Enable disposable runtime mutations for Docker containers and nginx ingress routes.
- `OPFIELD_E2E_DOCKER_IMAGE`: Docker image to use for the runtime container scenario. If omitted, the suite picks a suitable local image from the connected Docker node.

The suite never mutates pre-existing Docker containers, triggers Opfield/daemon updates, issues ACME certificates, or mutates connected databases. Runtime tests operate only on resources created by the suite and clean them up after the run.

## Surface matrix (`e2e:matrix`)

The matrix derives what to test from the product surface instead of a hand-written scenario list. It orders a thin, throwaway fleet through a hosting connector (one small VM per role: nginx, docker, storage, builder, monitoring, relay; images rotate by seed), crawls every operation in the OpenAPI document (every GET must answer without a 5xx; every CRUD family gets a schema-generated create → read back → listed → update → delete → 404 → unlisted cycle; every POST/PUT/PATCH gets wrong-type, missing-required and broken-JSON probes), runs real lifecycles on the fleet (containers, deployments, Compose, ingress routes with HTTP probes, managed PostgreSQL and S3 with data round-trips, bindings, backups, Pages, Apps, PKI, relay pool), reboots a random fleet VM mid-run, and checks generic invariants throughout (no 5xx, async work terminal within deadlines, no new system alerts, nodes healthy, no `mx-<seed>-` leftovers). Teardown always removes the fleet VMs and node records.

```sh
OPFIELD_URL=https://opfield.example:3000 \
OPFIELD_TOKEN=<api token with the delegable scopes> \
HOSTING_CONNECTOR_ID=<proxmox connector in a dedicated test pool> \
SEED=4711 PHASES=fleet,crawl,runtime,chaos \
pnpm --filter backend e2e:matrix
```

- `SEED`: 1-12 lowercase letters or digits; names (`mx-<seed>-…`), images, chaos victim and timing derive from it, so a finding repeats with the same seed.
- `PHASES`: any of `fleet,crawl,runtime,chaos` (default all). Without `fleet`, nodes named `mx-<seed>-<role>` from an earlier run are reused.
- `MATRIX_INSECURE_TLS=1`: accept a self-signed Opfield certificate. `MATRIX_KEEP_FLEET=1` keeps the VMs; `MATRIX_REUSE_FLEET=1` reuses them.
- Deadlines (minutes): `MATRIX_HOSTING_DEADLINE_MIN` (15), `MATRIX_WORKLOAD_DEADLINE_MIN` (8), `MATRIX_TASK_DEADLINE_MIN` (5), `MATRIX_CHAOS_DEADLINE_MIN` (8). Poll interval `MATRIX_POLL_MS` (4000).

The report lands in `e2e-api/out/matrix-<seed>.json` and `.md` (gitignored): findings with severity, invariant, request, redacted response excerpt and repro command; coverage per operation (exercised, failed or skipped with the reason); duration per phase. The exit code is 1 when a critical or high finding exists.
