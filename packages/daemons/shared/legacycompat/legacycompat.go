// Package legacycompat holds the literals of the product names before Opfield that nodes, relays, installations and
// clients released earlier still read or send. Every other place uses the Opfield names; code that must recognise or
// send one of these values takes it from here. Each constant names what reads it. Do not change a value: it is a
// contract with something already running.
package legacycompat

import _ "embed"

const (
	// AppImageManifestKind: kind of the signed app image manifest the updater of every installed release verifies.
	AppImageManifestKind = "gateway-image"
	// MinVersionField: relay and core manifest field with the minimum app version, read by installed releases.
	MinVersionField = "minGatewayVersion"
	// MaxVersionField: core manifest field with the maximum app version, read by installed releases.
	MaxVersionField = "maxGatewayVersion"
	// UpdateKeyID: key id of update manifests and the license endpoints document, checked by installed releases.
	UpdateKeyID = "wiolett-update-v1"
	// UpdateFeedBase: release feed base installs up to 2.12.2 are pinned to and signed downloadUrls name.
	UpdateFeedBase = "https://get.opfield.dev/gateway"
	// GRPCPackage: protobuf package of released daemons and relays: state schemas, service paths 2.12.0 daemons call and 2.12.0 relays forward.
	GRPCPackage = "gateway.v1"
	// StateFormat: format id of daemon state files, read by daemons of every release.
	StateFormat = "gateway-daemon-state/v1"
	// NextAddressCapability: registration capability the app of every release reads from daemons.
	NextAddressCapability = "gateway_next_address_v1"
	// LauncherProbe: probe answer launcher copies of different releases compare.
	LauncherProbe = "gateway-daemon-launcher"
	// LauncherWorkDirPrefix: launcher work directory of daemons before 2.12.1.
	LauncherWorkDirPrefix = ".gateway-launcher"
	// LauncherNamePrefix: launcher process and lock names of daemons before 2.12.1.
	LauncherNamePrefix = "gateway-daemon"
	// ControlSessionFile: control session record the setup-*.sh installers of releases before 2.12.1 read.
	ControlSessionFile = "gateway-session.json"
	// ConfigSection: top-level section of daemon config.yaml files written before 2.12.1.
	ConfigSection = "gateway"
	// GrantAudience: relay grant audience relays before 2.12.1 accept.
	GrantAudience = "wiolett-relay"
	// GrantSubjectKind: relay grant subject kind and route source kind relays of every version in a pool compare.
	GrantSubjectKind = "gateway"
	// RelayMetadataPrefix: identity metadata prefix relays before 2.12.1 forward.
	RelayMetadataPrefix = "x-wiolett-relay-"
	// InternalRegistryServiceID: local-service id of the internal registry in relay policy and grants, accepted by relays of every version.
	InternalRegistryServiceID = "gateway-internal-registry"
	// ManagedStorageRouteOwnerKind: relay route owner kind of managed storage the app of every release sends.
	ManagedStorageRouteOwnerKind = "managed_storage_gateway"
	// AvailabilityLeaseDomain: signature domain prefix of lease frames, manifests, accepts, clock origins and key rotations.
	AvailabilityLeaseDomain = "gateway-availability-lease"
	// AvailabilityHolderDomain: signature domain prefix of holder statements and witness activations.
	AvailabilityHolderDomain = "gateway-availability-holder"
	// AvailabilityMemberDomain: signature domain prefix of member primary assignments.
	AvailabilityMemberDomain = "gateway-availability-member"
	// AvailabilityFilePrefix: file names inside ClickHouse availability members (config, users, role, keeper, recovery, internal secret).
	AvailabilityFilePrefix = "gateway-availability"
	// KeeperFilePrefix: keeper joining marker and role file inside ClickHouse availability members.
	KeeperFilePrefix = "gateway-keeper"
	// ClickHouseClientProfile: settings profile of every client user in ClickHouse availability members.
	ClickHouseClientProfile = "gateway_client"
	// ClickHouseInternalUser: internal user ClickHouse availability members talk to each other with.
	ClickHouseInternalUser = "gateway_member"
	// HeartbeatPath: heartbeat path between availability members of different releases.
	HeartbeatPath = "/.gateway/hb/"
	// ListenerHandoverPrefix: names of database listeners handed between daemon processes across an update.
	ListenerHandoverPrefix = "gateway-db-listener/"
	// RegistryProxyHandoverPrefix: names of registry proxy listeners handed between daemon processes across an update.
	RegistryProxyHandoverPrefix = "gateway-registry-proxy/"
	// RunDirPrefix: runtime directories inside managed containers (tls, config, storage, master, minio-certs, minio-sftp, backup, clean) and on nodes before 2.12.1.
	RunDirPrefix = "/run/gateway-"
	// ConnectorRunDir: runtime mount of secure link and storage connectors created before 2.12.1.
	ConnectorRunDir = "/run/gateway"
	// RedisConfigPrefix: Redis configuration files of managed key-value containers.
	RedisConfigPrefix = "gateway-redis-"
	// ClickHouseManagedConfigFile: user configuration file of managed ClickHouse containers.
	ClickHouseManagedConfigFile = "gateway-managed.xml"
	// ClickHouseRuntimeConfigFile: runtime profile file of managed ClickHouse containers.
	ClickHouseRuntimeConfigFile = "00-gateway-runtime.xml"
	// ClickHouseTLSConfigFile: TLS configuration file of managed ClickHouse containers.
	ClickHouseTLSConfigFile = "gateway-tls.xml"
	// ClickHouseOwnerOverrideFile: owner override file of managed ClickHouse containers.
	ClickHouseOwnerOverrideFile = "zz-gateway-owner.xml"
	// PostgresHBAFile: pg_hba.conf of managed PostgreSQL containers.
	PostgresHBAFile = "gateway-pg_hba.conf"
	// PostgresMemberDir: member data directory of managed PostgreSQL availability sets.
	PostgresMemberDir = "gateway-ha"
	// RedisMoveGroup: consumer group of a key-value move between daemons of different releases.
	RedisMoveGroup = "gateway-move"
	// StorageCAFile: CA file name inside managed storage containers.
	StorageCAFile = "gateway-ca.crt"
	// StorageRootFilesystem: root filesystem name of managed storage containers.
	StorageRootFilesystem = "gateway-managed-storage-root"
	// SeaweedFSRootIdentity: root identity of managed SeaweedFS clusters.
	SeaweedFSRootIdentity = "gateway-root"
	// SeaweedFSPolicyName: inline IAM policy name of managed SeaweedFS clusters.
	SeaweedFSPolicyName = "gateway"
	// SeaweedFSImageRepository: repository of the patched SeaweedFS build storage containers run, pinned by digest.
	SeaweedFSImageRepository = "seaweedfs-gateway"
	// ImageRepository: image repository of releases before 2.12: references of running containers, pinned connector tags and mirrors.
	ImageRepository = "ghcr.io/the-square-labs/gateway"
	// VolumePlaceholderSource: placeholder source of loop volume images created before 2.12.1.
	VolumePlaceholderSource = "gateway-volume-placeholder"
	// VolumeImageFstabMark: fstab mark of volume images mounted before 2.12.1.
	VolumeImageFstabMark = "# gateway-volume-image "
	// DockerConfigBackupSuffix: backup of /etc/docker/daemon.json nodes set up before 2.12.1 keep.
	DockerConfigBackupSuffix = ".gateway-backup"
	// BuildSecretsGlob: build secret files workers before 2.12.1 left in workspaces.
	BuildSecretsGlob = ".gateway-build-secrets-*"
	// LabelPrefix: label prefix of containers, networks and volumes created before 2.12.1.
	LabelPrefix = "wiolett.gateway."
	// NetLabelPrefix: label prefix of local ClickHouse containers created before 2.12.1.
	NetLabelPrefix = "net.wiolett.gateway."
	// ComLabelPrefix: label prefix of managed services and volumes created before 2.12.1.
	ComLabelPrefix = "com.wiolett.gateway."
	// SandboxLabel: marker label of sandbox containers created before 2.12.1.
	SandboxLabel = "gateway.sandbox"
	// HousekeepingProtectedLabel: cleanup protection label of volumes protected before 2.12.1.
	HousekeepingProtectedLabel = "gateway.housekeeping.protected"
	// EnvPrefix: environment prefix of services, connectors and launchers before 2.12.1.
	EnvPrefix = "GATEWAY_"
	// DeploymentRouterHeader: header of deployment routers rendered before 2.12.1.
	DeploymentRouterHeader = "X-Gateway-Deployment-Router"
	// ObjectNameFamily: bare product word in names of objects created before 2.12.1 (Docker networks, compose keys and containers; nginx files).
	ObjectNameFamily = "gateway"
	// DatabaseLinkNetworkPrefix: link networks of database links created before 2.12.1.
	DatabaseLinkNetworkPrefix = "gateway-db-"
	// StorageLinkNetworkPrefix: storage networks, containers and links created before 2.12.1.
	StorageLinkNetworkPrefix = "gateway-storage-"
	// ContainerLinkNetworkPrefix: container link networks created before 2.12.1.
	ContainerLinkNetworkPrefix = "gateway-link-"
	// StorageConnectorPrefix: storage connector containers created before 2.12.1.
	StorageConnectorPrefix = "gateway-storage-connector-"
	// AddressFlag: address flag of daemon install commands customer automation and installers before 2.12.1 pass.
	AddressFlag = "--gateway"
	// CertFlag: certificate fingerprint flag of the same install commands.
	CertFlag = "--gateway-cert-sha256"
	// SetNetworkPrefix: availability set networks created before 2.12.1.
	SetNetworkPrefix = "gateway-set-"
	// SecureLinkConnectorName: secure link connector containers created before 2.12.1.
	SecureLinkConnectorName = "gateway-secure-link-connector"
	// SecureLinkAnchorName: secure link anchor containers created before 2.12.1.
	SecureLinkAnchorName = "gateway-secure-link-anchor"
	// SecureLinkNetworkName: secure link networks created before 2.12.1.
	SecureLinkNetworkName = "gateway-secure-links"
	// VolumeImageBootService: volume image boot unit of nodes set up before 2.12.1.
	VolumeImageBootService = "gateway-volume-images"
	// LinkListenerBootService: link listener boot unit of nodes set up before 2.12.1.
	LinkListenerBootService = "gateway-link-listeners"
	// DeploymentRouterMarker: configuration marker inside deployment router containers.
	DeploymentRouterMarker = "/etc/nginx/conf.d/.wiolett-gateway-router-config"
	// DeploymentRouterVersion: configuration version line inside deployment router containers.
	DeploymentRouterVersion = "# wiolett-gateway deployment router config v4"
	// DeploymentRouterTagPrefix: resolve, fallback and slot-address tags inside deployment router configurations.
	DeploymentRouterTagPrefix = "# gateway:"
	// DeploymentRouterUnavailable: named location inside deployment router configurations.
	DeploymentRouterUnavailable = "@gateway_router_unavailable"
	// DeploymentRouterUpstreamPrefix: upstream names inside deployment router configurations.
	DeploymentRouterUpstreamPrefix = "gateway_deployment_"
	// BuilderNamespace: containerd namespace and cgroup of the builder, where the build cache is filed.
	BuilderNamespace = "gateway-builds"
	// BuilderBridge: bridge of Build Workers set up before 2.12.1.
	BuilderBridge = "gateway-builds0"
	// BuilderNamePrefix: directories, services and networks of Build Workers set up before 2.12.1.
	BuilderNamePrefix = "gateway-builder"
	// BuilderChainPrefix: firewall chains of Build Workers set up before 2.12.1.
	BuilderChainPrefix = "GATEWAY_BUILDER_"
	// StateRoot: shared host state directory of daemons before 2.12.1.
	StateRoot = "/var/lib/gateway"
	// LeaseWatchdogName: lease watchdog service and binary name before 2.12.1.
	LeaseWatchdogName = "gateway-lease-watchdog"
	// RelaySupervisorName: relay supervisor service and directories before 2.12.1.
	RelaySupervisorName = "gateway-relay-supervisor"
	// RelayProgramName: relay program directory and binary before 2.12.1.
	RelayProgramName = "gateway-relay"
	// RelayWitnessName: relay witness data directory before 2.12.1.
	RelayWitnessName = "gateway-relay-witness"
	// WitnessUser: witness user of relays installed before 2.12.1.
	WitnessUser = "gateway-witness"
	// ListenerKeepDropInHeader: systemd drop-in header daemons before 2.12.1 wrote.
	ListenerKeepDropInHeader = "# Written by the Gateway daemon: keep its listening sockets across restarts.\n"
	// EtcPrefix: configuration directory prefix of relays and Build Workers before 2.12.1.
	EtcPrefix = "/etc/gateway"
	// UsrLocalLibPrefix: program directory prefix of relays and Build Workers before 2.12.1.
	UsrLocalLibPrefix = "/usr/local/lib/gateway"
	// OptPrefix: runtime bundle prefix of Build Workers before 2.12.1.
	OptPrefix = "/opt/gateway"
	// UsrLocalBinPrefix: binary prefix of the lease watchdog before 2.12.1.
	UsrLocalBinPrefix = "/usr/local/bin/gateway"
	// NginxDir: nginx tree of ingress nodes installed before 2.12.1.
	NginxDir = "/etc/nginx/gateway"
	// IngressHealthName: health path, socket directory and certificate name customer monitors and earlier nodes use.
	IngressHealthName = "gateway-ingress-health"
	// ReservedPathPrefix: reserved path prefix nginx still answers (Pages config script, maintenance access).
	ReservedPathPrefix = "/_gateway"
	// NginxVariablePrefix: nginx variables, zones and log format of ingress nodes installed before 2.12.1.
	NginxVariablePrefix = "gateway_"
	// NginxManagedMarkPrefix: managed markers and file names in configurations of ingress nodes installed before 2.12.1.
	NginxManagedMarkPrefix = "gateway-"
	// SecureLinkUpstreamMarker: secure link upstream marker in route configs rendered for ingress nodes before 2.12.1.
	SecureLinkUpstreamMarker = "gateway-managed-secure-link-upstream"
	// NginxPagesMark: Pages marker in configurations of ingress nodes installed before 2.12.1.
	NginxPagesMark = "# gateway-pages "
	// IngressHealthHost: certificate name of the ingress health endpoint before 2.12.1.
	IngressHealthHost = "ingress-health.gateway.invalid"
	// MaintenanceHeaderPrefix: maintenance headers of route configs rendered before 2.12.1.
	MaintenanceHeaderPrefix = "X-Gateway-Maintenance-"
	// IngressGenerationHeader: ingress generation header of configs rendered before 2.12.1.
	IngressGenerationHeader = "X-Gateway-Ingress-Generation"
	// NginxLogFormatComment: comment in nginx.conf of ingress nodes installed before 2.12.1.
	NginxLogFormatComment = "# Gateway daemon log format (auto-injected)"
	// NginxPagesHostnamesComment: comment in nginx.conf of ingress nodes installed before 2.12.1.
	NginxPagesHostnamesComment = "# Gateway Pages generated hostnames (auto-injected)"
	// NginxPagesBucketComment: comment in nginx.conf of ingress nodes installed before 2.12.1.
	NginxPagesBucketComment = "# Gateway Pages generated hostnames are longer than the default bucket fits."
)

// StateSchemaV2100 is the compiled nginx-daemon.proto of v2.10.0 (package GRPCPackage), the oldest release a node may
// be rolled back to; statecompat writes the copies of state that release reads through it.
//
//go:embed state-schema-v2.10.0.binpb
var StateSchemaV2100 []byte

// InstanceClaim carries the app instance id of relay grant claims under the key relays of every version verify.
type InstanceClaim struct {
	OpfieldInstanceID string `json:"gatewayInstanceId"`
}

// ConfigSectionField reads the daemon config.yaml section written before 2.12.1 (ConfigSection) into Control.
// Embed it with yaml:",inline".
type ConfigSectionField[T any] struct {
	Control T `yaml:"gateway"`
}
