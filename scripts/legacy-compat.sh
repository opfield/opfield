# shellcheck shell=bash
# Literals of the product names before Opfield that installed releases, nodes and released clients still read. Every
# other place uses the Opfield names; scripts that must recognise or write one of these values take it from here.
# Sourced by the release scripts and the Dockerfiles; scripts/stage-installers.sh inlines it into every published
# installer in place of the line that sources it. Each line says what reads it. Do not change a value.

# Release assets and the update feed
LEGACY_APP_IMAGE_MANIFEST_ASSET=gateway-image.update.json # app manifest name of releases before 2.12.6, published next to opfield-image.update.json; remove after every install runs v2.12.6
LEGACY_APP_IMAGE_MANIFEST_KIND=gateway-image # kind inside that manifest, verified by installed releases and install.sh
LEGACY_UPDATE_KEY_ID=wiolett-update-v1 # key id of signed update manifests, checked by setup-relay-node.sh and installed releases
LEGACY_MIN_VERSION_FIELD=minGatewayVersion # relay manifest field with the minimum app version (install.sh, installed releases)

# Images
LEGACY_RELAY_BINARY=/gateway-relay # relay entrypoint that compose files of 2.12.0 and pre-generic app images start
LEGACY_SEAWEEDFS_REPOSITORY=seaweedfs-gateway # repository of the patched SeaweedFS build that docker daemons pin by digest
LEGACY_SECURE_LINK_ANCHOR_LABEL=wiolett.gateway.secure-link-connector.anchor # connector image label docker-daemon 2.12.0 looks for
LEGACY_APP_DATA_DIR=/var/lib/gateway # app data mount of installations made before 2.12.3; the app image links it to /var/lib/opfield
LEGACY_RELAY_IDENTITY_DIR=/var/lib/gateway-relay # relay identity mount (app and relay containers) of installations made before 2.12.3
LEGACY_REGISTRY_AUTH_DIR=/var/lib/gateway-registry-auth # registry token mount (app and registry containers) of installations made before 2.12.3
LEGACY_IMAGE_REPOSITORY=ghcr.io/the-square-labs/gateway # app image repository signed manifests of releases before 2.12 name (install.sh --restore)

# Installations made before 2.12.1
LEGACY_INSTALL_DIR=/opt/gateway # install directory install.sh finds them in until their host move
LEGACY_INSTALL_PENDING_MARKER=.gateway-install-pending # marker of a fresh install of such a release that stopped early
LEGACY_ENV_PREFIX=GATEWAY_ # prefix of their .env settings and of installer variables customer automation still sets
LEGACY_DATABASE=gateway # their Compose project, PostgreSQL database and role until the host move
LEGACY_COMMERCIAL_DIR_NAME=.gateway-commercial # commercial core directory in their install directory until the host move
LEGACY_FOUNDATION_BACKUP_DIR=.gateway-foundation-backups # backup directory the updaters of 2.12.0 and earlier write
LEGACY_DB_DUMP=gateway-db.dump # database snapshot file those updaters write
LEGACY_MANAGED_SERVICE_LABEL=com.wiolett.gateway.managed-service # service label of their docker-compose.yml
LEGACY_ADDRESS_FLAG=--gateway # address flag of node installers before 2.12.1 and of customer automation
LEGACY_CERT_FLAG=--gateway-cert-sha256 # certificate fingerprint flag of the same installers and automation
LEGACY_EXPORT_VERSION_FIELD=gatewayVersion # version field in the header of configuration exports they made

# Nodes and relays installed before 2.12.1 (read by the node installers until every node reports the Opfield names)
LEGACY_STATE_ROOT=/var/lib/gateway # shared host state directory of their daemons (host identity, markers)
LEGACY_CONFIG_SECTION=gateway # top-level section of their daemon config.yaml
LEGACY_SESSION_FILE_NAME=gateway-session.json # control session record their daemons write
LEGACY_DAEMON_WRAPPER_LINE="# gateway-daemon-wrapper: runs the service user's binary, never as root" # mark of their daemon wrappers
LEGACY_LEASE_WATCHDOG=gateway-lease-watchdog # lease watchdog service and binary name on their Docker nodes
LEGACY_BUILDER_DIR_NAME=gateway-builder # name of their Build Worker directories under /etc, /usr/local/lib and /run
LEGACY_BUILDER_RUNTIME_DIR=/opt/gateway-builder # Build Worker runtime bundle directory
LEGACY_DATABASE_STORAGE_DIR=gateway-databases # database storage directory under a data mount offered to them
LEGACY_RELAY_SUPERVISOR=gateway-relay-supervisor # service, /etc and /var/lib directory name of their relay supervisor
LEGACY_RELAY_PROGRAM_PATH=/usr/local/lib/gateway-relay # program directory of their relay supervisor
LEGACY_NGINX_DIR=/etc/nginx/gateway # nginx tree of their ingress nodes (kept as a link after the move)
LEGACY_RUNTIME_DIR_PREFIX=gateway- # prefix of their nginx-daemon runtime directories under /run
LEGACY_NGINX_LINK_PREFIX=.gateway-link. # temporary link name an interrupted nginx tree move of an earlier installer leaves
LEGACY_NGINX_DEFAULT_SERVER_CONF=00-gateway-default-server.conf # default server file their nginx-daemon and installer wrote
LEGACY_ERROR_PAGES_CONF=00-gateway-error-pages.conf # error pages file their nginx-daemon wrote
LEGACY_NGINX_RUNTIME_DROPIN=zz-gateway-runtime-directory.conf # nginx systemd drop-in their installer wrote
LEGACY_NGINX_LIMITS_DROPIN=gateway-limits.conf # nginx systemd limits drop-in their installer wrote
LEGACY_NGINX_LIMITS_MARKER="# Managed by Gateway: nginx file-descriptor limit" # OpenRC nginx limit marker their installer wrote
LEGACY_NGINX_MANAGED_CONF=gateway-managed.conf # conf.d file of early installers
LEGACY_EARLY_SITES_DIR=/etc/nginx/http.d/gateway # sites directory of early installers

# docker-compose.yml of the releases before 2.12.1, written by install.sh for --restore of an export one of them made.
write_legacy_compose() {
  cat >docker-compose.yml <<'COMPOSE'
services:
  app:
    image: ${GATEWAY_IMAGE_REF}
    restart: unless-stopped
    stop_grace_period: 60s
    labels:
      com.wiolett.gateway.managed-service: app
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway
      REDIS_URL: redis://redis:6379
      PKI_MASTER_KEY: ${PKI_MASTER_KEY}
      WEB_TLS_AUTO_DIR: /var/lib/gateway/tls
      GRPC_TLS_AUTO_DIR: /var/lib/gateway/tls
      GATEWAY_RELAY_REQUIRED: "true"
      GATEWAY_RELAY_MANAGED: "${GATEWAY_RELAY_MANAGED:-true}"
      GATEWAY_RELAY_TARGET: relay:9443
      GATEWAY_RELAY_IDENTITY_DIR: /var/lib/gateway-relay
      GATEWAY_RELAY_IMAGE_REF: ${GATEWAY_RELAY_IMAGE_REF}
      GATEWAY_RELAY_SERVICE_NAME: relay
      GATEWAY_RELAY_BUILD_VERSION: ${GATEWAY_RELAY_BUILD_VERSION}
      GATEWAY_RELAY_PROTOCOL_MAJOR: ${GATEWAY_RELAY_PROTOCOL_MAJOR}
      GATEWAY_REGISTRY_AUTH_DIR: /var/lib/gateway-registry-auth
      SANDBOX_RUNNER_WORKSPACE_DIR: ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
    ports:
      - "3000:3000"
    expose:
      - "9443"
    volumes:
      - gateway_data:/var/lib/gateway
      - gateway_relay_identity:/var/lib/gateway-relay
      - gateway_registry_auth:/var/lib/gateway-registry-auth
      - ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
      # Intentional host trust boundary: required for signed self-update,
      # recovery, housekeeping, and Gateway-managed local services.
      # Run Gateway on a dedicated host/VM; a read-only bind is not safer.
      - /var/run/docker.sock:/var/run/docker.sock
      # The host's memory, CPUs, load and uptime for diagnostics. In an LXC the memory use comes from the
      # LXC's cgroup and the uptime from its init, since LXCFS answers /proc for the app container.
      - /proc/meminfo:/host/proc/meminfo:ro
      - /proc/loadavg:/host/proc/loadavg:ro
      - /proc/stat:/host/proc/stat:ro
      - /proc/1/stat:/host/proc/1/stat:ro
      - /sys/fs/cgroup:/host/cgroup:ro
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      # Inherit the image's bounded, child-process-free health probe.
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  relay:
    image: ${GATEWAY_RELAY_IMAGE_REF}
    entrypoint: ["/gateway-relay"]
    restart: unless-stopped
    labels:
      com.wiolett.gateway.managed-service: relay
    environment:
      RELAY_IDENTITY_DIR: /var/lib/gateway-relay/identity
      RELAY_STATE_DIR: /var/lib/gateway-relay/state
      RELAY_APP_GRPC_TARGET: app:9443
      RELAY_POOL_ID: system
      RELAY_INSTANCE_ID: 00000000-0000-4000-8000-000000000001
    ports:
      - "9443:9443"
    volumes:
      - gateway_relay_identity:/var/lib/gateway-relay/identity:ro
      - gateway_relay_state:/var/lib/gateway-relay/state
    healthcheck:
      test: ["CMD", "/gateway-relay", "healthcheck"]
      interval: 5s
      timeout: 3s
      retries: 2
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  registry:
    image: ${GATEWAY_REGISTRY_IMAGE_REF}
    restart: unless-stopped
    labels:
      com.wiolett.gateway.managed-service: registry
    environment:
      REGISTRY_HTTP_ADDR: 0.0.0.0:5000
      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001
      REGISTRY_LOG_LEVEL: info
      REGISTRY_HTTP_SECRET: ${GATEWAY_REGISTRY_HTTP_SECRET}
      REGISTRY_AUTH: token
      REGISTRY_AUTH_TOKEN_REALM: ${GATEWAY_REGISTRY_TOKEN_REALM:-https://gateway.invalid/api/docker/registry/token}
      REGISTRY_AUTH_TOKEN_SERVICE: gateway-internal-registry
      REGISTRY_AUTH_TOKEN_ISSUER: gateway-internal-registry
      REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE: /var/lib/gateway-registry-auth/token-cert.pem
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_INTERVAL: 10s
      REGISTRY_HEALTH_STORAGEDRIVER_THRESHOLD: "3"
    expose:
      - "5000"
    volumes:
      - gateway_registry_data:/var/lib/registry
      - gateway_registry_auth:/var/lib/gateway-registry-auth:ro
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:5001/debug/health >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  postgres:
    image: ${GATEWAY_POSTGRES_IMAGE_REF}
    restart: unless-stopped
    # A host shutdown stops every container at once. Smart shutdown (SIGTERM) lets the app finish its shutdown drain
    # on its open connections before postgres exits; the image's default (SIGINT) cuts them at once.
    stop_signal: SIGTERM
    stop_grace_period: 75s
    environment:
      POSTGRES_DB: gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d gateway"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  redis:
    image: ${GATEWAY_REDIS_IMAGE_REF}
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

volumes:
  gateway_data:
  gateway_relay_identity:
  gateway_relay_state:
  gateway_registry_data:
  gateway_registry_auth:
  postgres_data:
  redis_data:
COMPOSE
}
