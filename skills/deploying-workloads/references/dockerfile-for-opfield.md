# Writing a Dockerfile for Opfield Git builds

A Git source builds the repository's Dockerfile on a Build Worker (BuildKit, `dockerfile.v0` frontend), pushes the image to Opfield's internal registry, and runs it by digest. These rules follow what Opfield does with the image.

## Rules

- **No `VOLUME`.** Opfield manages volumes. An image `VOLUME` makes Docker create an anonymous volume that Opfield does not manage: it is not listed, it is carried along on every recreate, and an Opfield volume mounted on the same path fails with `Duplicate mount point`. Declare persistent paths as Opfield volumes on the container (`manage_docker_volume`, then a mount) and keep the image stateless.
- **Configuration and secrets come from Opfield, never from the image.** Read them from environment variables: container env and secrets (`manage_docker_container_config`), App environment variables and secrets, or `env`/`secrets` on `manage_docker_source` `create`, which the first build already starts the container with. Never `COPY` a `.env` file or bake credentials into a layer.
- **Build-time values.** Non-secret values: `buildArgs` (`ARG` in the Dockerfile). Build-time secrets (a private package registry token): Build Secrets, named in `buildSecretNames` and read only through a secret mount, `RUN --mount=type=secret,id=<name>,target=<path>`. A build argument or `ENV` holding a secret stays in the image history.
- **Listen on `0.0.0.0` (or `::`) on one fixed port.** Routes reach the container through a Secure Link on its container port, with no host port. A process bound to `127.0.0.1` is unreachable. Opfield sets no `PORT` variable: choose the port, `EXPOSE` it (the Console offers exposed ports first; without `EXPOSE` it suggests the ports the process actually listens on), and use it as the Route's `dockerContainerPort` or the Deployment's `containerPort`. `EXPOSE` publishes nothing.
- **Health.** Give the service a cheap health endpoint. Blue/green Deployments probe it over HTTP (`health.path`, status 200-399 by default) before switching traffic. Availability copies are ready when the image `HEALTHCHECK` reports healthy, or, without one, when the port accepts a TCP connection. A `HEALTHCHECK` must use a tool the image contains.
- **Stop cleanly on `SIGTERM`.** Use the exec form of `CMD`/`ENTRYPOINT` so the process is PID 1 and receives the signal (or run it under `tini`). Docker kills it after the container's stop timeout (`stopTimeout`, 0 to 300 seconds; Docker's default is 10). After a Deployment switch the old slot drains for `drainSeconds` (default 30) before it stops.
- **Log to stdout and stderr.** Opfield shows container logs from there; files inside the container are lost on recreate.
- **Run as a non-root user** (`USER`), and keep writable data in Opfield volumes.
- **Small, pinned, patched images.** Multi-stage builds with a slim final stage; pin base images to a version tag (or digest) and rebuild when the base gets security fixes. The source `policy` blocks deployment on scanned findings: `vulnerabilityThreshold` (`critical` default) and `vulnerabilityScope` (`all`, `application`, `fixable_application`, `fixable_all`). Fewer OS packages means fewer findings; the `fixable_*` scopes count only findings with a released fix.
- **`.dockerignore`** keeps `.git`, `node_modules`, local `.env` files, and build output out of the context: smaller uploads, no leaked secrets, better cache use.
- **Fit the Build Worker.** A build gets 2 CPUs, 4 GiB of memory, and 20 GiB of disk, and is cancelled after the worker timeout (30 minutes by default, set per builder node, up to 360). Build logs are capped at 10 MiB. By default the worker reaches the internet but not private networks, cloud metadata, or Opfield, so a build cannot fetch from internal hosts; an offline worker reaches nothing.
- **Paths.** `dockerfilePath` and `contextPath` are relative to the repository root and must exist in the built commit.

## Migrations and one-off tasks

Opfield has no release or pre-deploy command. Run schema migrations at start, idempotently and under a database lock, because several copies can start at once: during a blue/green switch both slots run, and Availability starts one copy per node. Keep each migration compatible with the previous release (add first, remove in a later release), since the old slot keeps serving until the switch. Run a true one-off task with `execute_docker_container_console_command` in the running container, after the user agreed.

## Compose sources

A repository Compose file may build services with `build` as a path or as `{ context, dockerfile, args }` only; the context must stay inside the repository. Other build fields (`target`, `secrets`, `ssh`, `cache_from`, ...) are refused, as are `env_file`, `profiles`, `develop`, `deploy`, `extends`, `configs`, `secrets`, `privileged`, `devices`, `network_mode`, `pid`, `ipc`, and host bind mounts. Use named volumes and `environment`; Opfield replaces `build` with the built image digest in the revision it applies.

## Example (Node.js)

```dockerfile
FROM node:22.11-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# NPMRC is a Build Secret holding an .npmrc for a private registry; drop the mount if there is none
RUN --mount=type=secret,id=NPMRC,target=/root/.npmrc npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.11-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
# The server listens on 0.0.0.0:3000 and closes on SIGTERM
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
```

`.dockerignore`:

```text
.git
node_modules
dist
.env*
```

## Don't

- `VOLUME` anywhere in the Dockerfile or its base image chain you control.
- Secrets in `ARG`, `ENV`, `COPY`, or the repository.
- A shell-form `CMD` (`CMD npm start`) that keeps the app from receiving `SIGTERM`.
- Binding to `127.0.0.1`, or reading the port from a variable Opfield never sets.
- `latest` or unpinned base images, or a single stage that ships compilers and caches.
- Writing state into the container filesystem, or logs into files.
- Migrations that break the release still serving, or that are not safe to run twice.
