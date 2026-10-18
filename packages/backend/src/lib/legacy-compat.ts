/**
 * Literals of the product names before Opfield that installations, nodes, relays and clients released earlier still
 * read or send. Every other place uses the Opfield names; code that must recognise or send one of these values imports
 * it from here. Each constant names what reads it. Do not change a value: it is a contract with something already
 * running. Pure constants only (no imports): the update Worker, the frontend bundle and node scripts load this file too.
 */

/** Feed namespace of releases before 2.12.6 (feed, signed downloadUrls); remove after every install runs v2.12.6. */
export const LEGACY_UPDATE_NAMESPACE = 'gateway';
/** Artifact base of daemon manifests signed before 2.12.6; remove after every install runs v2.12.6. */
export const LEGACY_UPDATES_BASE_URL = 'https://get.opfield.dev/gateway';
/** Artifact base of manifests signed before the get.opfield.dev move; remove after every install runs v2.12.6. */
export const LEGACY_THESQLABS_UPDATES_BASE_URL = 'https://updates.thesqlabs.com/gateway';
/** App manifest name of releases before 2.12.6, also published from 2.12.6; remove after every install runs v2.12.6. */
export const LEGACY_APP_IMAGE_MANIFEST_ASSET = 'gateway-image.update.json';
/** Kind of the signed app image manifest, verified by the updater of every installed release. */
export const LEGACY_APP_IMAGE_MANIFEST_KIND = 'gateway-image';
/** Manifest field with the minimum app version (relay and core manifests), read by installed releases. */
export const LEGACY_MIN_VERSION_FIELD = 'minGatewayVersion';
/** Manifest field with the maximum app version (core manifests), read by installed releases. */
export const LEGACY_MAX_VERSION_FIELD = 'maxGatewayVersion';
/** Only installer checksum list of releases before 2.12.1; read from such a release for a relay pool still on it. */
export const LEGACY_INSTALLER_CHECKSUMS_ASSET = 'gateway-daemon-installers.sha256';
/** First release line of inference core builds (vX.Y.Z-<line>.N), still served and ordered. */
export const LEGACY_CORE_RELEASE_LINE = 'wiolett';
/** Key id of signed update manifests and of the license endpoints document, checked by every installed release. */
export const LEGACY_UPDATE_KEY_ID = 'wiolett-update-v1';
/** Settings key the updater of the running release writes before the restart and the target release reads. */
export const LEGACY_UPDATE_ATTEMPT_KEY = 'update:gateway:attempt';
/** Settings key with the minimum app version of the staged relay release, read by releases up to 2.12.2. */
export const LEGACY_RELAY_MIN_VERSION_KEY = 'update:relay:min_gateway_version';
/** Update sidecar containers releases before 2.12.1 started; only cleaned up. */
export const LEGACY_UPDATE_SIDECAR_NAME = 'gateway-update-sidecar';
/** Image repository of releases before 2.12: references of running containers, pinned images and mirrors. */
export const LEGACY_IMAGE_REPOSITORY = 'ghcr.io/the-square-labs/gateway';
/** Inference core repository earlier core releases were published to. */
export const LEGACY_CORE_IMAGE_REPOSITORY = 'ghcr.io/the-square-labs/inference-core';
/** Commercial core manifest kind; 2.12.0 prepare-update and the license server read it. */
export const LEGACY_COMMERCIAL_MANIFEST_KIND = 'gateway-commercial';
/** Install directory name, Compose project, database and role of installations made before 2.12.1. */
export const LEGACY_INSTALL_DIR_NAME = 'gateway';
/** Commercial core directory of installations not yet moved. */
export const LEGACY_COMMERCIAL_DIR_NAME = '.gateway-commercial';
/** App data mount of installations made before 2.12.3 (the app image links it to /var/lib/opfield). */
export const LEGACY_APP_DATA_DIR = '/var/lib/gateway';
/** Relay identity mount of installations made before 2.12.3. */
export const LEGACY_RELAY_IDENTITY_DIR = '/var/lib/gateway-relay';
/** Registry token mount of installations made before 2.12.3. */
export const LEGACY_REGISTRY_AUTH_DIR = '/var/lib/gateway-registry-auth';
/** Backup directory the updaters of 2.12.0 and earlier write; only pruned. */
export const LEGACY_FOUNDATION_BACKUP_DIR = '.gateway-foundation-backups';
/** Database snapshot file those updaters write; only pruned. */
export const LEGACY_DB_DUMP = 'gateway-db.dump';
/** Managed-block markers of docker-compose.yml files written before 2.12.1. */
export const LEGACY_COMPOSE_MARKER = '# gateway-managed:';
/** ClickHouse database of the local logging of installations not yet moved. */
export const LEGACY_LOGS_DATABASE = 'gateway_logs';
/** Local ClickHouse container of installations not yet moved. */
export const LEGACY_CLICKHOUSE_CONTAINER = 'gateway-clickhouse';
/** Registry token realm placeholder in docker-compose.yml written before 2.12.1. */
export const LEGACY_REGISTRY_TOKEN_REALM = 'https://gateway.invalid/api/docker/registry/token';
/** Registry image reference docker-compose.yml files written before 2.12 pin. */
export const LEGACY_REGISTRY_IMAGE =
  'ghcr.io/the-square-labs/gateway/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8';
/** Compose volume key of the app data in installations made before 2.12.1 and its part name in configuration exports. */
export const LEGACY_VOLUME_APP_DATA = 'gateway_data';
/** Compose volume key and export part name of the relay identity. */
export const LEGACY_VOLUME_RELAY_IDENTITY = 'gateway_relay_identity';
/** Compose volume key and export part name of the relay state. */
export const LEGACY_VOLUME_RELAY_STATE = 'gateway_relay_state';
/** Compose volume key and export part name of the registry token material. */
export const LEGACY_VOLUME_REGISTRY_AUTH = 'gateway_registry_auth';
/** Compose volume key and export part name of the registry data. */
export const LEGACY_VOLUME_REGISTRY_DATA = 'gateway_registry_data';
/** Label of configuration transfer helper containers releases before 2.12.1 started. */
export const LEGACY_CONFIGURATION_TRANSFER_LABEL = 'com.wiolett.gateway.configuration-transfer';
/** Version field in the header of configuration exports made before 2.12.1. */
export const LEGACY_EXPORT_VERSION_FIELD = 'gatewayVersion';
/** Relay entrypoint compose files of 2.12.0 and app images of pre-generic releases start. */
export const LEGACY_RELAY_BINARY = '/gateway-relay';
/** Service label of containers created before 2.12.1. */
export const LEGACY_MANAGED_SERVICE_LABEL = 'com.wiolett.gateway.managed-service';
/** Managed label of a local ClickHouse created before 2.12.1. */
export const LEGACY_LOCAL_CLICKHOUSE_MANAGED_LABEL = 'net.wiolett.gateway.managed';
/** Owner label of a local ClickHouse created before 2.12.1. */
export const LEGACY_LOCAL_CLICKHOUSE_OWNER_LABEL = 'net.wiolett.gateway.owner';
/** Prefix of .env settings, docker-compose.yml variables and installer variables written before 2.12.1. */
export const LEGACY_ENV_PREFIX = 'GATEWAY_';
/** Id of the internal registry: relay local-service id, registry token service and issuer of existing installations. */
export const LEGACY_INTERNAL_REGISTRY_ID = 'gateway-internal-registry';
/** Registration capability the app of every release reads from daemons. */
export const LEGACY_HOST_MOVE_CAPABILITY = 'gateway_next_address_v1';
/** Label prefix of containers, networks and volumes created before 2.12.1. */
export const LEGACY_LABEL_PREFIX = 'wiolett.gateway.';
/** Label prefix of local ClickHouse containers created before 2.12.1. */
export const LEGACY_NET_LABEL_PREFIX = 'net.wiolett.gateway.';
/** Label prefix of managed services and volumes created before 2.12.1. */
export const LEGACY_COM_LABEL_PREFIX = 'com.wiolett.gateway.';
/** Marker label of sandbox containers created before 2.12.1. */
export const LEGACY_SANDBOX_LABEL = 'gateway.sandbox';
/** Cleanup protection label of volumes protected before 2.12.1. */
export const LEGACY_HOUSEKEEPING_PROTECTED_LABEL = 'gateway.housekeeping.protected';
/** Sandbox containers, images and workspaces of releases before 2.12.1. */
export const LEGACY_SANDBOX_NAME_PREFIX = 'gateway-sandbox-';
/** Link networks of database links created before 2.12.1. */
export const LEGACY_DATABASE_LINK_NETWORK_PREFIX = 'gateway-db-';
/** Storage networks of links created before 2.12.1. */
export const LEGACY_STORAGE_LINK_NETWORK_PREFIX = 'gateway-storage-';
/** Container link networks created before 2.12.1. */
export const LEGACY_CONTAINER_LINK_NETWORK_PREFIX = 'gateway-link-';
/** Secure link network created before 2.12.1. */
export const LEGACY_SECURE_LINK_NETWORK = 'gateway-secure-links';
/** Registry garbage collection containers an update from a release before 2.12.1 may leave. */
export const LEGACY_REGISTRY_GC_PREFIX = 'gateway-registry-gc-';
/** Prefix of connector image repositories published before the Opfield names (database, secure link). */
export const LEGACY_CONNECTOR_IMAGE_PREFIX = 'gateway-';
/** Repository namespace of the internal registry (builds, availability, promotion) in stored image references. */
export const LEGACY_REGISTRY_NAMESPACE = 'gateway';
/** Placeholder registry host of pending source builds stored before 2.12.1. */
export const LEGACY_PLACEHOLDER_REGISTRY_HOST = 'gateway.invalid';
/** App and relay image path of installs from before Opfield (host image cleanup). */
export const LEGACY_IMAGE_PATH = '/wiolett/gateway';
/** Relay grant audience relays before 2.12.1 accept. */
export const LEGACY_GRANT_AUDIENCE = 'wiolett-relay';
/** App instance id key of relay grant claims, verified by relays of every version. */
export const LEGACY_GRANT_INSTANCE_ID_KEY = 'gatewayInstanceId';
/** Relay route source and grant subject kind relays of every version in a pool compare. */
export const LEGACY_RELAY_SOURCE_KIND = 'gateway';
/** Relay route owner kind of managed storage, read by docker daemons of every release. */
export const LEGACY_MANAGED_STORAGE_OWNER_KIND = 'managed_storage_gateway';
/** Relay route owner kind of managed databases, read by docker daemons of every release. */
export const LEGACY_MANAGED_DATABASE_OWNER_KIND = 'managed_database_gateway';
/** Identity metadata relays before 2.12.1 forward. */
export const LEGACY_RELAY_METADATA_PREFIX = 'x-wiolett-relay-';
/** Error relays before 2.12.1 return for a snapshot of another app instance. */
export const LEGACY_RELAY_INSTANCE_CHANGED_ERROR = 'snapshot gateway instance changed';
/** Bare product word in names of Docker networks, containers and compose keys created before 2.12.1. */
export const LEGACY_OBJECT_NAME_FAMILY = 'gateway';
/** Prefix of browser storage keys and channels of 2.12.0 bundles, moved once. */
export const LEGACY_STORAGE_KEY_PREFIX = 'gateway';
/** Audit actions of address moves stored before 2.12.1. */
export const LEGACY_AUDIT_MOVE_PREFIX = 'system.gateway_move_';
/** GRPC package 2.12.0 daemons call and 2.12.0 relays forward. */
export const LEGACY_GRPC_PACKAGE = 'gateway.v1';
/** Signature domain prefix of availability lease manifests and key rotations, verified by nodes and relays of every release. */
export const LEGACY_AVAILABILITY_LEASE_DOMAIN = 'gateway-availability-lease';
/** Signature domain prefix of member primary assignments. */
export const LEGACY_AVAILABILITY_MEMBER_DOMAIN = 'gateway-availability-member';
/** Maintenance host header nginx daemons before 2.12.1 send. */
export const LEGACY_MAINTENANCE_HOST_HEADER = 'x-gateway-maintenance-host';
/** Health probe header of route health checks rendered before 2.12.1. */
export const LEGACY_HEALTH_PROBE_HEADER = 'x-gateway-health-probe';
/** Advisory lock the app processes of two releases take around migrations. */
export const LEGACY_LOCK_MIGRATIONS = 'gateway-migrations';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_POLICY_BOOTSTRAP = 'gateway-relay-policy-bootstrap';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_POLICY_SIGNING_BOOTSTRAP = 'gateway-relay-policy-signing-bootstrap';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION = 'gateway-relay-policy-key-rotation';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_SIGNING_KEY_ROTATION = 'gateway-relay-signing-key-rotation';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_POLICY_RECONCILIATION = 'gateway-relay-policy-reconciliation';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_POOL_REBALANCE = 'gateway-relay-pool-rebalance';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_RECOVERY = 'gateway-relay-recovery';
/** Advisory lock shared by the app processes of two releases during an update. */
export const LEGACY_LOCK_RELAY_REMOTE_POLICY_REVISION = 'gateway-relay-remote-policy-revision';
/** Setting the domain conflict trigger of earlier migrations reads. */
export const LEGACY_GUC_PROXY_DOMAIN_CONFLICTS = 'gateway.proxy_domain_conflicts';
/** Setting the host port conflict trigger of earlier migrations reads. */
export const LEGACY_GUC_HOST_PORT_CONFLICTS = 'gateway.host_port_conflicts';
/** Setting the storage copy trigger of earlier migrations reads. */
export const LEGACY_GUC_STORAGE_COPY_JOBS = 'gateway.storage_copy_jobs';
/** Setting the backup restore trigger of earlier migrations reads. */
export const LEGACY_GUC_BACKUP_RESTORE_ADMISSION = 'gateway.backup_restore_admission';
/** Maintenance lock and container name of the internal registry shared across an update. */
export const LEGACY_INTERNAL_REGISTRY_MAINTENANCE = 'gateway-internal-registry-maintenance';
/** Relay endpoint id of the internal registry in relay policy. */
export const LEGACY_INTERNAL_REGISTRY_RELAY_ENDPOINT = 'gateway-internal-registry-relay-endpoint';
/** Docker snapshot cache key earlier releases wrote; moved once. */
export const LEGACY_DOCKER_SNAPSHOT_CACHE = 'gateway:docker:snapshot:v1';
/** Read model cache key earlier releases wrote; moved once. */
export const LEGACY_READ_MODEL_CACHE = 'gateway:read-model:v1';
/** Nginx tree of ingress nodes installed before 2.12.1. */
export const LEGACY_NGINX_DIR = '/etc/nginx/gateway';
/** Nginx-daemon runtime directories of ingress nodes installed before 2.12.1. */
export const LEGACY_NGINX_RUN_PREFIX = '/run/gateway-';
/** Health path external monitors were set up with. */
export const LEGACY_INGRESS_HEALTH_PATH = '/.well-known/gateway-ingress-health';
/** Name of the ingress health path, socket directory and certificate on nodes installed before 2.12.1. */
export const LEGACY_INGRESS_HEALTH_NAME = 'gateway-ingress-health';
/** Reserved path prefix nginx still answers (Pages config script, maintenance access). */
export const LEGACY_RESERVED_PATH_PREFIX = '/_gateway';
/** Nginx variables, zones and the log format of ingress nodes installed before 2.12.1. */
export const LEGACY_NGINX_VARIABLE_PREFIX = 'gateway_';
/** Managed markers in configurations of ingress nodes installed before 2.12.1. */
export const LEGACY_NGINX_MARK_PREFIX = 'gateway-';
/** Certificate name of the ingress health endpoint before 2.12.1. */
export const LEGACY_INGRESS_HEALTH_HOST = 'ingress-health.gateway.invalid';
/** Maintenance headers of route configs rendered before 2.12.1. */
export const LEGACY_MAINTENANCE_HEADER_PREFIX = 'X-Gateway-Maintenance-';
/** Ingress generation header of configs rendered before 2.12.1. */
export const LEGACY_INGRESS_GENERATION_HEADER = 'X-Gateway-Ingress-Generation';
/** Nginx cache zone and named location of rendered status page configs. */
export const LEGACY_STATUS_PAGE_ZONE_PREFIX = 'gateway_status_page_';
/** Restart page script path in error pages rendered into node configs before 2.12.1. */
export const LEGACY_RESTART_SCRIPT_PATH = '/gateway-restarting.js';
/** Shared host state directory of daemons before 2.12.1 (host identity, markers). */
export const LEGACY_STATE_ROOT = '/var/lib/gateway';
/** Address flag of daemon installers and install commands before 2.12.1. */
export const LEGACY_ADDRESS_FLAG = '--gateway';
/** Certificate fingerprint flag of the same installers and commands. */
export const LEGACY_CERT_FLAG = '--gateway-cert-sha256';
/** Relay supervisor unit and directories of relays installed before 2.12.1. */
export const LEGACY_RELAY_SUPERVISOR = 'gateway-relay-supervisor';
/** Lease watchdog service of Docker nodes installed before 2.12.1. */
export const LEGACY_LEASE_WATCHDOG = 'gateway-lease-watchdog';
/** Root filesystem name of managed storage containers. */
export const LEGACY_MANAGED_STORAGE_ROOT = 'gateway-managed-storage-root';
/** Bootstrap file of Proxmox guests seeded before 2.12.1. */
export const LEGACY_HOSTING_BOOTSTRAP_FILE = '/var/lib/gateway-hosting-bootstrap.sh';
/** Product word in hosting descriptions and firewall comments, system CA common names and compose comments written before 2.12.1. */
export const LEGACY_PRODUCT_TITLE = 'Gateway';
/** DigitalOcean firewall names written before 2.12.1. */
export const LEGACY_HOSTING_FIREWALL_PREFIX = 'gateway-fw-';
/** Hetzner server label written before 2.12.1. */
export const LEGACY_HOSTING_MARKER_LABEL = 'gateway-marker';
/** Seed images written to Proxmox storage before 2.12.1. */
export const LEGACY_HOSTING_SEED_PREFIX = 'gateway-seed-';
/** Image files cached on customers' Proxmox storage, looked up by name. */
export const LEGACY_HOSTING_IMAGE_PREFIX = 'gateway-';
/** Session cookies of browsers signed in before 2.12.1. */
export const LEGACY_SESSION_COOKIE_PREFIX = 'gateway_session_';
/** Built-in group id stored by earlier migrations. */
export const LEGACY_SYSTEM_ADMINS_GROUP = 'gateway-system-admins';
/** Skill ids stored conversations load. */
export const LEGACY_SKILL_PREFIX = 'system:gateway-';
/** Cloudflare record comment of records created before 2.12.1. */
export const LEGACY_DNS_RECORD_COMMENT_PREFIX = 'wiolett-gateway:domain:';
/** Key in pages.override_compared_hosts (jsonb) and the API field built from it. */
export const LEGACY_PAGES_HOST_KEY = 'gatewayHost';
/** Key in pages.override_compared_hosts (jsonb) and the API field built from it. */
export const LEGACY_PAGES_DOMAIN_KEY = 'gatewayRegistrableDomain';
/** Field the license server requires in activation and refresh requests. */
export const LEGACY_LICENSE_VERSION_FIELD = 'gatewayVersion';
/** Signature domain of license states the license server signs. */
export const LEGACY_LICENSE_STATE_DOMAIN = 'wiolett-gateway-license-state/v1';
/** Earlier signature domain of license states. */
export const LEGACY_LICENSE_STATE_DOMAIN_SHORT = 'gateway-license-state';
/** License feature key the license server signs in place of inference. */
export const LEGACY_INFERENCE_FEATURE = 'gateway-inference';
/** Contract id of the managed inference core. */
export const LEGACY_CORE_CONTRACT = 'wiolett-core/v1';
/** Contract headers cores released before the Opfield names send and read. */
export const LEGACY_CORE_HEADER_PREFIX = 'x-wiolett-';
/** Control endpoints of the managed inference core. */
export const LEGACY_CORE_API_PREFIX = '/api/wiolett/';
/** Labels of managed inference core containers. */
export const LEGACY_CORE_LABEL_PREFIX = 'com.wiolett.inference-core.';
/** Environment the managed inference core reads. */
export const LEGACY_CORE_ENV_PREFIX = 'OPENCODEX_WIOLETT_';
/** Secrets mount the managed inference core reads. */
export const LEGACY_CORE_SECRETS_DIR = '/run/wiolett-secrets';
/** Field of credentials.json the managed inference core reads. */
export const LEGACY_CORE_INTERNAL_URL_KEY = 'gatewayInternalUrl';
/** Client identifier upstream model providers registered (User-Agent, x-grok-client-identifier). */
export const LEGACY_PROVIDER_CLIENT_ID = 'gateway';
/** Error type of the OpenAI-compatible inference API that clients match. */
export const LEGACY_INFERENCE_ERROR_TYPE = 'gateway_error';
/** Host names of installations set up before 2.12.1 that must never be an external SSH target. */
export const LEGACY_INSTALLATION_HOSTNAMES = [
  'gateway',
  'gateway-backend',
  'gateway-frontend',
  'gateway-daemon',
  'gateway-agent',
  'gateway-proxy',
] as const;
