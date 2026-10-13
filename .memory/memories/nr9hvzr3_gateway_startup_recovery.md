---
{
  "id": "nr9hvzr3",
  "file_name": "nr9hvzr3_gateway_startup_recovery",
  "tags": [
    "daemons",
    "dev-env",
    "docker",
    "frontend",
    "local-setup",
    "opfield",
    "postgres"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1782911201956,
  "updated_at": 1791851791152
}
---
Opfield local development stack gotchas (merged 2026-10-01 from four notes written April–August 2026).

Status first: since 2026-09-28/29 the repository owner does not want tests, tsc or image builds on the development Mac (they run on a build server), and the local Docker stacks described in older notes were not running on 2026-10-01. Container and Compose project names below are historical (seen: `gateway_app_local`, `gateway-upgrade-e2e`, `gateway-local`, `daemon-docker`, `gateway-dind`, `gateway-docker-daemon`, `gateway-monitoring-daemon`, `gateway-nginx-daemon`). Run `docker ps -a` before assuming any of them exists. The Docker socket is blocked by the agent sandbox, so docker commands need the sandbox disabled.

Still-valid repository facts (verified 2026-10-01)
- `docker-compose.dev.yml` maps local Postgres to host port 55432 to avoid conflicts.
- The Vite dev proxy target comes from `GATEWAY_DEV_PROXY_TARGET` (default http://localhost:3000) in `packages/frontend/vite.config.ts`. When another project owns port 3000, run the backend with PORT=3001 (gRPC stays on GRPC_PORT=9443) and set `GATEWAY_DEV_PROXY_TARGET=http://localhost:3001` in `packages/frontend/.env`. Smoke check: `curl -i http://localhost:5173/auth/me` must match `http://localhost:3001/auth/me` (usually 401), not a 404 from another project.

Recreating containers
- `docker compose ... up -d --build app` recreates the app and re-reads `.env`. A recreated app with a missing or different DB password crashes in migrations. Before recreating only the app, compare the running container's effective `DATABASE_URL`/Compose environment with the env file and pass the existing effective database configuration (never record its secret); require `/health` to report lifecycleState running afterwards. Replacing only the app while PostgreSQL, Redis and Opfield volumes stay intact preserves browser sessions.
- To ship a frontend change to a running app without recreating it: `pnpm --filter frontend build`, then `docker cp packages/frontend/dist/. <app-container>:/app/public/` and hard-refresh (asset names are hashed).

Local daemons
- Reuse existing local daemon containers instead of creating replacements: they carry enrollment tokens, state volumes and node identities.
- Daemon binaries for an arm64 Linux container are cross-built, e.g. `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags '-s -w -X main.Version=dev' -o bin/docker-daemon-linux-arm64 ./cmd/docker-daemon` in `packages/daemons/docker`; a host-platform build fails there with `Exec format error`. After `docker cp` into the container, restart the in-container process and check its log for `docker engine connected` and `connected to gateway`.
- If a daemon container exits with code 127, check whether Docker created directories at file bind-mount paths for its binaries and replace them with executable Linux binaries.
- If a Docker-in-Docker container exits with `failed to save daemon pid to disk: process with PID N is still running`, start it again and quickly clear stale runtime paths inside it (/run/docker, /run/containerd, /run/docker.sock, /var/run/docker, /var/run/containerd, /var/run/docker.sock), then retry.
