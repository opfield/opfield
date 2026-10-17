# Development Guide

[Back to README](../README.md)

Opfield is an Nx and pnpm monorepo with TypeScript app packages and Go daemon packages.

## Requirements

- Node.js `>=24`
- pnpm `>=9`
- Go `>=1.24.4`
- Docker
- protoc

## Local Setup

Install dependencies:

```bash
pnpm install
```

Start local infrastructure:

```bash
pnpm dev:infra
```

This starts Postgres, Redis, ClickHouse, and the development internal registry from [docker-compose.dev.yml](../docker-compose.dev.yml). PostgreSQL is published on host port `55432` to avoid collisions with another local server.

Run migrations:

```bash
pnpm db:migrate
```

Start development servers:

```bash
pnpm dev:all
```

This starts backend, frontend, and status-page dev servers through Nx.

## Environment

Use [.env.example](../.env.example) as the local development reference.

Important local defaults:

```env
DATABASE_URL=postgres://dev:dev@localhost:55432/opfield
REDIS_URL=redis://localhost:6379
SETUP_BOOTSTRAP=false
WEB_TLS_BOOTSTRAP_MODE=http
```

Configure the canonical URL, authentication, and structured logging through the first-run wizard. For `pnpm dev:infra`, the bundled development ClickHouse can be selected as an external connection at `http://localhost:8123`; leaving structured logging disabled hides its product surfaces.

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm dev:all` | Start backend, frontend, and status page in parallel. |
| `pnpm dev:infra` | Build the connector images and start local Postgres, Redis, ClickHouse, and the internal registry. |
| `pnpm dev:infra:down` | Stop local infrastructure. |
| `pnpm build` | Build backend, frontend, status page, logging SDK, and update service. |
| `pnpm build:all` | Build app packages and daemon binaries. |
| `pnpm build:daemon` | Build all Go daemon binaries. |
| `pnpm test` | Run the light suite: the backend, frontend, update service, daemon, and Relay tests that guard authorization, authentication, update trust, data integrity, untrusted input, and lease safety. Behaviour is covered by the end-to-end run on a stand before a stable release. |
| `pnpm test:backend` | Run backend tests. |
| `pnpm test:daemon` | Run the Go daemon tests of the light suite. |
| `pnpm test:relay` | Run local Relay tests. |
| `pnpm test:release-upgrade -- --candidate vX.Y.Z --ssh root@host` | Prove a release candidate before a stable tag on a disposable Docker-capable Debian/Ubuntu host: install the last stable release, update through the product, update daemons and relay, force the old updater's rollback, update again, then install the candidate fresh. Prints PASS/FAIL per check and removes everything it created; `--help` lists the options. |
| `pnpm lint` | Run frontend/backend/package lint (the frontend also runs its UI rules, `pnpm --filter frontend lint:ui-rules`) and Go vet for daemons and Relay. |
| `pnpm lint:daemon` | Run Go vet for daemons. |
| `pnpm typecheck` | Type-check backend, frontend, status page, logging SDK, and update service. |
| `pnpm proto` | Regenerate protobuf stubs. |
| `pnpm db:generate` | Generate a Drizzle ORM migration. |
| `pnpm db:migrate` | Run database migrations. |
| `pnpm db:studio` | Open Drizzle Studio. |
| `pnpm graph` | Open the Nx dependency graph. |

## Repository Layout

```text
opfield/
+-- packages/
|   +-- backend/          # Hono backend, REST API, OAuth, MCP, gRPC, jobs
|   +-- frontend/         # React + Vite Opfield UI
|   +-- status-page/      # Public status page frontend
|   +-- logging-sdk/      # TypeScript structured logging client
|   +-- update-service/    # Cloudflare Worker for GitHub release discovery and signed assets
|   +-- relay/            # Local long-lived Opfield relay worker
|   +-- daemons/
|       +-- nginx/        # nginx management daemon
|       +-- docker/       # Docker management daemon
|       +-- monitoring/   # host metrics daemon
|       +-- relay/        # remote Relay Pool supervisor
|       +-- lease-watchdog/ # Availability lease fence on Docker nodes
|       +-- backup-runner/ # database backup and storage copy runner image
|       +-- secure-link-connector/ # Docker-to-nginx Secure Link sidecar
|       +-- shared/       # shared Go packages and generated protobuf
+-- proto/                # protobuf service definitions
+-- scripts/              # Opfield and daemon installers
+-- skills/               # agent skills served as opfield://skills (synced from opfield-skills)
+-- docker-compose.yml    # production compose stack
+-- docker-compose.dev.yml
```

## Backend

The backend lives in `packages/backend`.

Main responsibilities:

- Hono HTTP API.
- OpenAPI documentation.
- OIDC authentication.
- Session handling.
- Permissions and scopes.
- OAuth and MCP.
- PostgreSQL persistence through Drizzle ORM.
- Redis-backed cache/session/rate-limit behavior.
- gRPC server for daemon control.
- Background jobs.
- WebSocket streams.

Useful paths:

| Path | Purpose |
|------|---------|
| `packages/backend/src/modules` | Feature modules and routes. |
| `packages/backend/src/db/schema` | Drizzle schema definitions. |
| `packages/backend/src/db/migrations` | SQL migrations. |
| `packages/backend/src/grpc` | gRPC server and generated TypeScript types. |
| `packages/backend/src/lib/scopes.ts` | Permission scope definitions and helpers. |

## Frontend

The frontend lives in `packages/frontend`.

Main stack:

- React 19.
- Vite.
- Tailwind CSS 4.
- shadcn-style UI components.
- Zustand stores.
- Vitest tests.

Useful paths:

| Path | Purpose |
|------|---------|
| `packages/frontend/src/pages` | Route-level pages. |
| `packages/frontend/src/components` | Shared and feature components. |
| `packages/frontend/src/stores` | Zustand stores. |
| `packages/frontend/src/services` | API and event-stream clients. |
| `packages/frontend/src/lib/scope-utils.ts` | Frontend scope editor helpers. |

## Daemons

Go daemons live under `packages/daemons`.

| Path | Purpose |
|------|---------|
| `packages/daemons/nginx` | nginx management daemon. |
| `packages/daemons/docker` | Docker management daemon. |
| `packages/daemons/monitoring` | metrics daemon. |
| `packages/daemons/relay` | remote Relay Pool supervisor. |
| `packages/daemons/secure-link-connector` | Docker-to-nginx Secure Link connector sidecar. |
| `packages/daemons/shared` | shared Go packages. |
| `packages/daemons/go.work` | Go workspace. |

The local public relay worker is a separate Go module under `packages/relay`; it is built, tested, vetted, versioned, and released independently from the node daemons.

Run daemon tests:

```bash
cd packages/daemons
go test ./docker/... ./monitoring/... ./nginx/... ./relay/... ./shared/... ./secure-link-connector/...
```

## Protobuf

Protobuf definitions live in `proto/`.

Regenerate stubs:

```bash
pnpm proto
```

Generated Go stubs are committed under `packages/daemons/shared/opfieldv1` and `packages/daemons/shared/relayv1`.

## Database Migrations

Generate a migration after schema changes:

```bash
pnpm db:generate
```

Apply migrations locally:

```bash
pnpm db:migrate
```

Open Drizzle Studio:

```bash
pnpm db:studio
```

## Verification

Common verification before submitting changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For daemon-only changes:

```bash
pnpm proto
pnpm test:daemon
pnpm lint:daemon
```

Run `pnpm proto` whenever the Opfield daemon or Relay protobuf contracts change. The daemon update command schema is part of the signed update trust boundary, so keep generated Go stubs and backend TypeScript command types aligned.

For full release confidence:

```bash
pnpm build:all
```

## Release Images

Workflows `Image` and `Release` publish every image (`…/relay`, `…/secure-link-connector`, `…/backup-runner`,
the patched SeaweedFS build, the managed PostgreSQL images `…/postgres` and extension bundles `…/postgres-ext/<id>` of
`packages/daemons/postgres-image`, the third-party mirrors) under one repository, resolved by
`scripts/release/image-repositories.sh`:

| Setting | Kind | Effect |
| --- | --- | --- |
| `OPFIELD_SIGNED_IMAGE` | repository variable | The repository signed release manifests name, which installs then pull from. Defaults to the image repository. |
| `OPFIELD_IMAGE` | repository variable | Overrides the image repository (forks). Defaults to `ghcr.io/opfield/opfield`. |
| `GHCR_PUSH_TOKEN` | repository secret | A token that can write packages in the image repository's organization (a classic token with `write:packages`). Needed while the repository and the image repository live in different organizations. Without it the workflow token is used. |
| `COMMERCIAL_REPOSITORY` | repository variable | The private commercial core repository CI and releases dispatch to. Defaults to `opfield/opfield-commercial` in the opfield organization, `<owner>/opfield-commercial` elsewhere. |
| `SIGN_IMAGES` | repository variable | `true` signs every published image keyless with cosign (GitHub OIDC, `id-token: write`, no secret), attaches SPDX SBOM attestations made with syft, and adds the SBOMs to the release assets (`scripts/release/supply-chain.sh`). Turn it on once the repository publishes from the opfield organization, so the signing identity is the one [Verifying releases](verify-releases.md) documents; the first Image run then also signs the builds that already exist. The Ed25519 update manifests do not depend on it. |

Docker nodes and the installer pull the third-party mirrors and the patched SeaweedFS from `ghcr.io/opfield/opfield`.
