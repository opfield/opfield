package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/logepisode"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	builderruntime "github.com/opfield/opfield/docker-daemon/internal/builder"
	"github.com/opfield/opfield/docker-daemon/internal/config"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	runtimemanager "github.com/opfield/opfield/docker-daemon/internal/runtime"
)

// DockerPlugin implements lifecycle.DaemonPlugin for the docker daemon.
type DockerPlugin struct {
	// legacyNames counts the node's objects still under pre-Opfield names.
	legacyNames legacyNameScan
	cfg         *config.Config
	logger      *slog.Logger
	client      *Client
	version     string // Docker engine version

	allowlist       *AllowlistChecker
	envStore        *EnvStore
	taskMgr         *TaskManager
	imagePulls      imagePullTracker // pulls of this process, for Opfield's pull_status (image_pull_tracker.go)
	deploymentOpMu  sync.Mutex
	deploymentOps   map[string]map[uint64]deploymentOperation
	deploymentLocks map[string]*deploymentLock
	deploymentOpSeq uint64

	// routerRepairsWaiting are the deployments whose router repair waits for a running operation (deploymentOpMu).
	routerRepairsWaiting map[string]bool

	registryMu      sync.RWMutex
	registryCreds   map[string]string // registry URL -> base64-encoded auth
	statsCollector  *StatsCollector
	execMgr         *ExecManager
	migrationStore  *migrationArtifactStore
	archiveStreams  *archiveLiveStore
	databaseManager *managedDatabaseManager
	storageManager  *managedStorageManager
	backupHandler   backupCommandHandler
	composeExecutor *composeExecutor
	volumeImages    *volumeImageManager
	relayGrants     *relayGrantStore
	relayTunnelMu   sync.Mutex
	relayTunnels    map[string]*relayTunnelRouter
	// setGates: relay lease gate views and the member runtime of availability
	// sets (relay_lease_groups.go); setMembers runs the members on a
	// storage-profile daemon (set_member_runtime.go).
	setGates   setLeaseGates
	setMembers *memberha.Manager
	// keeperWitnesses runs ClickHouse Keeper witness containers of sets whose
	// witness is this node (keeper_witness_node.go).
	keeperWitnesses *nodeKeeperWitnesses
	// restartAnnounced freezes relay registrations once the daemon told its
	// relays it restarts (B-13); proxyTunnels are the Secure Link tunnels it
	// serves, drained before it exits.
	restartAnnounced         atomic.Bool
	proxyTunnels             proxyTunnelSet
	relaySelection           uint64
	storageConnectorListener net.Listener
	storageConnectorSocket   string
	databaseListeners        *managedDatabaseHostListenerManager
	registryProxy            *dockerRegistryProxyManager
	builderManager           *builderruntime.Manager
	builderRuntime           *builderruntime.RuntimeSupervisor
	secureLinks              *dockerSecureLinkManager
	secureLinkState          *securelink.StateStore
	runtimeManager           *runtimemanager.Manager
	runtimeStatusMu          sync.RWMutex
	runtimeStatus            runtimemanager.Status
	runtimeStatusGen         uint64
	availability             *availabilityManager
	lease                    *leaseIntegration
	registrationChanged      chan struct{}
	// healthRefresh asks the session for a health report now (container_state_events.go).
	healthRefresh chan struct{}
	// relayPenalties orders relays that failed a route's tunnel recently after the others.
	relayPenalties relaybridge.RelayPenalties
	// relayStability is since when each relay's transport has been up without a break: resumable streams return
	// to a nearer relay only once it was stable for a while (relayresume.Returner).
	relayStability relaybridge.RelayStability
	// relayPathWake wakes resumable streams waiting to retry a move when a
	// relay path may have become available (relayresume.SourceConfig.Wake).
	relayPathWake relayresume.Signal
	// relayRTT replaces relaybridge.Latency.RTT in tests.
	relayRTT func(string) (time.Duration, bool)
	// memberReadiness gates availability member endpoints on their workload
	// (D6); memberProbe replaces its probe in tests.
	memberReadiness *memberReadiness
	memberProbe     func(ctx context.Context, links []string, cheap bool) memberProbeResult
	// availabilityHealth probes the HTTP health checks Opfield hands over for
	// the Availability copies on this node and holds a copy Opfield took out.
	availabilityHealth *availabilityHealth
	// relayTunnelOutcomes logs failing incoming relay tunnels per endpoint owner and state change (L-1).
	relayTunnelOutcomes logepisode.Tracker
	// linkRejections logs and counts the connections of database bindings and storage links the node or the relays
	// refused; linkConnections holds the links without a host listener at their limit; linkTraffic counts the sessions
	// and bytes each link carried.
	linkRejections  linkRejectionLog
	linkConnections linkConnectionCounts
	linkTraffic     linkTraffic

	// The link sockets' copies in the listener keeper, handed to the next process on a restart
	// (link_listener_handover.go); linkFlows are the link connections it lets finish.
	storageConnectorKept keptUnixListener
	secureLinkEgressKept keptUnixListener
	// The previous mode's link sockets after a switch of the daemon's user, served until their connectors are
	// retired (link_socket_mode_handover.go).
	secureLinkEgressPrevious previousUnixListeners
	storageConnectorPrevious previousUnixListeners
	linkFlows                linkFlowSet
	// egressDatabaseSlots holds the database link sessions of the egress socket at their node limit.
	egressDatabaseSlots chan struct{}

	// resumable holds the resumable relay streams (RSv1) of both sides.
	resumableMu sync.Mutex
	resumable   *relayStreamSides
	// handover carries the connections an update hands to the next process (live_handover.go); handoverTracker
	// settles what the last update did to them; liveCuts counts the connections an update cuts in any case.
	handover        *handover.Registry
	handoverTracker *handover.Tracker
	liveCuts        liveCuts
	// restoredHost are the database binding connections the previous process handed over, until their host
	// listener adopted them (live_handover.go).
	restoredHostMu sync.Mutex
	restoredHost   map[*restoredHostConnection]struct{}
	// endpointDialer replaces the backends of incoming relay tunnels in tests.
	endpointDialer func(context.Context, *pb.RelayGrantAssignment) (dialedEndpoint, error)

	// startedAt is when Init began: link connections accepted before the relay lanes are up wait for them
	// (relayLaneStartupWait).
	startedAt time.Time
	// logHandler sends the plugin's lines, those of the managers built at Init included, to the current session.
	logHandler *sessionLogHandler

	// Log stream follow support
	writer           *stream.Writer
	buildEventMu     sync.RWMutex
	buildEventWriter *stream.Writer
	sessionCtx       context.Context
	// sessionLive: an Opfield control session is up (a manual pair's primary self-fences without it and its peer).
	sessionLive atomic.Bool
	// opfieldContactAt: when Opfield's last command arrived (leasefence clock, ns; 0: none yet).
	opfieldContactAt atomic.Int64
	logStreamMu      sync.Mutex
	logStreamCancel  map[string]context.CancelFunc // containerId -> cancel
}

var _ lifecycle.ProxySecureLinkPlugin = (*DockerPlugin)(nil)

const dockerLogsCommandTimeout = 15 * time.Second
const emergencyKillCancellationTimeout = 30 * time.Second

func dockerTimeoutProvided(configJSON string) bool {
	if configJSON == "" {
		return false
	}
	var payload struct {
		TimeoutProvided bool `json:"timeoutProvided"`
	}
	if err := json.Unmarshal([]byte(configJSON), &payload); err != nil {
		return false
	}
	return payload.TimeoutProvided
}

// NewDockerPlugin creates a new DockerPlugin with the given configuration.
func NewDockerPlugin(cfg *config.Config) *DockerPlugin {
	return &DockerPlugin{
		cfg:                 cfg,
		registrationChanged: make(chan struct{}, 1),
		healthRefresh:       make(chan struct{}, 1),
		memberReadiness:     newMemberReadiness(),
		handover:            handover.NewRegistry(),
	}
}

// backupCommandHandler is deliberately narrow: backup runtime files can
// register the typed runner without giving the storage profile generic Docker
// execution. A missing handler is an explicit command error, never success.
type backupCommandHandler interface {
	handleBackupCommand(*pb.DockerBackupCommand, *pb.CommandResult)
}

func (p *DockerPlugin) RegisterBackupCommandHandler(handler backupCommandHandler) {
	p.backupHandler = handler
}

// registerCompiledBackupHandler makes the DockerPlugin itself the handler
// when backup_commands.go is linked into this package. Keeping the assertion
// dynamic preserves a runnable storage daemon before that optional worker is
// merged, while a linked worker receives p as its only command entrypoint.
func (p *DockerPlugin) registerCompiledBackupHandler() {
	if handler, ok := any(p).(backupCommandHandler); ok {
		p.backupHandler = handler
	}
}

// Type returns the daemon type identifier.
func (p *DockerPlugin) Type() string {
	return "docker"
}

// SetLogger points the plugin's logger at a new session's: its lines reach Opfield's node logs. The logger the
// plugin handed out at Init (the host listeners, the database and storage managers, Compose, the Docker client)
// follows, so a component's WARN is not left in the node's journal.
func (p *DockerPlugin) SetLogger(logger *slog.Logger) {
	if p.logHandler == nil {
		p.logger = logger
		return
	}
	p.logHandler.follow(logger.Handler())
}

// useLogger makes logger the plugin's until a session's replaces it (SetLogger).
func (p *DockerPlugin) useLogger(logger *slog.Logger) {
	p.logHandler = newSessionLogHandler(logger.Handler())
	p.logger = slog.New(p.logHandler)
}

// Init initializes the Docker client, pings the engine, and stores its version.
func (p *DockerPlugin) Init(cfg *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.useLogger(logger)
	p.availability = nil
	p.startedAt = time.Now()
	ctx := context.Background()

	if p.cfg.Docker.Mode == "builder" {
		var err error
		p.relayGrants, err = newRelayGrantStore(p.cfg.StateDir)
		if err != nil {
			return fmt.Errorf("initialize relay grant store: %w", err)
		}
		p.registryProxy, err = newDockerRegistryProxyManager(p)
		if err != nil {
			return fmt.Errorf("initialize builder registry proxy: %w", err)
		}
		// A worker set up before Opfield keeps its runtime names until this
		// start is confirmed (builder_rename.go).
		naming := builderruntime.SelectNaming()
		runtimeConfig := builderruntime.DefaultRuntimeConfigFor(naming, 0)
		runtimeConfig.EgressProfile = p.cfg.Docker.Builder.EgressProfile
		runtimeConfig.ControlPlaneAddress = p.cfg.Control.Address
		runtimeSupervisor := builderruntime.NewRuntimeSupervisor(runtimeConfig)
		if !naming.Legacy {
			if err := runtimeSupervisor.RemoveLegacyLeftovers(); err != nil {
				p.logger.Warn("pre-Opfield builder runtime leftovers not removed", "error", err)
			}
		}
		if err := runtimeSupervisor.InstallConfiguration(); err != nil {
			return fmt.Errorf("install isolated builder runtime configuration: %w", err)
		}
		if err := runtimeSupervisor.Start(); err != nil {
			return fmt.Errorf("start isolated builder runtime: %w", err)
		}
		p.builderRuntime = runtimeSupervisor
		lifecycle.OnControlAddressChanged(p.reapplyBuilderEgressFence)
		p.registryCreds = make(map[string]string)
		p.builderManager = builderruntime.NewManager(
			runtimeConfig,
			filepath.Join(p.cfg.StateDir, "builder", "jobs"),
			naming.GitAskpassPath(),
			p.emitBuildEvent,
		)
		if naming.Legacy {
			lifecycle.OnStartConfirmed(p.switchBuilderToOpfieldNaming)
		}
		p.logger.Info("builder profile initialized without Docker Engine access")
		return nil
	}

	var availability *availabilityManager
	if p.cfg.Docker.Mode == "" {
		var availabilityErr error
		availability, availabilityErr = newAvailabilityManager(p.cfg.StateDir)
		if availabilityErr != nil {
			return fmt.Errorf("initialize docker availability state: %w", availabilityErr)
		}
	}

	c, err := NewClient(p.cfg.Docker.Socket, p.cfg.StateDir, p.logger)
	if err != nil {
		return fmt.Errorf("init docker client: %w", err)
	}
	p.client = c
	p.registerOpfieldNamesOnConfirmedStart()

	if err := c.Ping(ctx); err != nil {
		// dockerd being down is no fault of this daemon (a launcher trial does not count it).
		return fmt.Errorf("docker ping failed: %w: %w", lifecycle.ErrEnvironmentUnavailable, err)
	}

	ver, err := c.GetVersion(ctx)
	if err != nil {
		return fmt.Errorf("get docker version: %w", err)
	}
	p.version = ver
	p.logger.Info("docker engine connected", "version", ver, "socket", p.cfg.Docker.Socket)
	// User workloads get json-file log rotation only when json-file is the
	// host's default driver; detect it once.
	p.logger.Info("docker default logging driver", "driver", c.DetectDefaultLoggingDriver(ctx))

	// Initialize allowlist from config
	p.allowlist = NewAllowlistChecker(p.cfg.Docker.Allowlist)

	// Initialize envstore
	envDir := filepath.Join(p.cfg.StateDir, "envstore")
	p.envStore = NewEnvStore(envDir)

	// Initialize task manager
	p.taskMgr = NewTaskManager()
	p.deploymentOps = make(map[string]map[uint64]deploymentOperation)
	p.migrationStore, err = newMigrationArtifactStore(p.cfg.StateDir)
	if err != nil {
		return err
	}
	if err := p.migrationStore.cleanupStale(time.Now()); err != nil {
		p.logger.Warn("stale migration artifact cleanup failed", "error", err)
	}
	p.archiveStreams = newArchiveLiveStore()
	p.relayGrants, err = newRelayGrantStore(p.cfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize relay grant store: %w", err)
	}
	// The connections the previous process handed over, before anything here takes time: their peers resume
	// within relayresume.UnplannedBudget of the update (live_handover.go).
	p.restoreHandover()
	// Units installed before the template carried it get a file descriptor store, so the link sockets also survive
	// a restart of the whole unit (link_listener_handover.go).
	if installed, storeErr := listenerkeep.EnsureSystemdStore(); storeErr != nil {
		p.logger.Warn("could not give the daemon unit a file descriptor store; a unit restart refuses link connections briefly", "error", storeErr)
	} else if installed {
		p.logger.Info("gave the daemon unit a file descriptor store for link sockets", "drop_in", listenerkeep.SystemdDropInName)
	}
	if p.cfg.Docker.Mode != "databases" && p.cfg.Docker.Mode != "storage" {
		removeLegacyDatabaseTunnelSocket(p.cfg.StateDir)
		p.databaseListeners = newManagedDatabaseHostListenerManager(p)
		// Runs for the life of the process: it keeps the listeners' address book (listenerPeers).
		go p.databaseListeners.watchPeers(context.Background())
		p.restoreDatabaseListeners(ctx)
	}
	if p.cfg.Docker.Mode != "databases" && p.cfg.Docker.Mode != "storage" {
		p.registryProxy, err = newDockerRegistryProxyManager(p)
		if err != nil {
			return fmt.Errorf("initialize docker registry proxy: %w", err)
		}
	}
	if err := p.startStorageConnectorRelay(); err != nil {
		return err
	}
	// ClickHouse Keeper witness containers run on any docker node a set picks.
	p.startNodeKeeperWitnesses()
	// Storage connectors created while the daemon ran as another user (root or not) cannot reach this socket.
	go p.reconcileStorageConnectorGroups(context.Background())
	if p.cfg.Docker.IsStorageProfile() {
		p.databaseManager, err = newManagedDatabaseManager(p.cfg, p.client, p.logger)
		if err != nil {
			return fmt.Errorf("initialize managed database storage for storage profile: %w", err)
		}
		p.wirePGSetHooks()
		p.wireKVSetHooks()
		p.databaseManager.plugin = p
		p.storageManager, err = newManagedStorageManager(p.cfg, p.client, p.logger)
		if err != nil {
			return fmt.Errorf("initialize managed storage runtime: %w", err)
		}
		p.storageManager.plugin = p
		// Release what interrupted deletes and older releases left behind
		// before remounting: on a fixed loop-device pool, leaked devices would
		// keep live instances down.
		p.repairLoopImages(ctx)
		if err := p.databaseManager.reconcile(ctx); err != nil {
			return fmt.Errorf("reconcile managed database storage for storage profile: %w", err)
		}
		if err := p.storageManager.reconcile(ctx); err != nil {
			return fmt.Errorf("reconcile managed storage runtime: %w", err)
		}
		p.registerCompiledBackupHandler()
		// Copy jobs do not survive a daemon restart; remove their credentials now.
		p.recoverStorageCopyJobs()
		go p.runLoopImageRepair(context.Background())
		go p.runManagedEngineSupervisor(context.Background())
	}
	if p.cfg.Docker.Mode != "databases" && p.cfg.Docker.Mode != "storage" {
		composeExecutor, composeErr := newComposeExecutor(p.cfg, p.client, p.logger)
		if composeErr != nil {
			p.logger.Warn("docker compose executor unavailable", "reason", composeErr.Error())
		} else {
			p.composeExecutor = composeExecutor
		}
		p.volumeImages, err = newVolumeImageManager(p.cfg.StateDir, p.client, p.logger)
		if err != nil {
			return fmt.Errorf("initialize disk-image volume storage: %w", err)
		}
		go p.runLoopImageRepair(context.Background())
		// Before the secure-link restore, which binds links to the routers.
		p.repairDeploymentRouters("", deploymentRouterRepairStartupTimeout)
		go p.deploymentRouterRepairLoop(context.Background(), deploymentRouterRepairInterval)
		if err := p.initProxySecureLinks(); err != nil {
			return err
		}
		if p.memberReadiness == nil {
			p.memberReadiness = newMemberReadiness()
		}
		// Runs for the life of the process, like the lease runtime.
		go p.runMemberReadiness(context.Background())
		go p.runDeploymentRouterAddresses(context.Background())
	}

	// Initialize registry credentials map
	p.registryCreds = make(map[string]string)
	p.runtimeManager = runtimemanager.NewManager()
	p.runtimeManager.DockerHost = p.cfg.Docker.Socket
	p.runtimeManager.ProgressReporter = func(status runtimemanager.Status) { p.setRuntimeStatus(status) }
	preflightCtx, cancelPreflight := context.WithTimeout(ctx, 90*time.Second)
	if migrated, migrateErr := p.runtimeManager.ReconcileInstalledConfig(preflightCtx); migrateErr != nil {
		p.logger.Warn("runsc Docker configuration migration failed", "error", migrateErr)
	} else if migrated {
		p.logger.Info("runsc Docker configuration migrated")
	}
	p.startRuntimeVerification(preflightCtx, p.runtimeManager)
	cancelPreflight()
	p.availability = availability
	if (availability != nil || p.cfg.Docker.IsStorageProfile()) && p.lease == nil {
		// Storage-profile daemons run the lease for their availability set members.
		p.initAvailabilityLease()
	}
	if availability != nil && p.availabilityHealth == nil {
		p.initAvailabilityHealth()
	}
	if p.lease == nil {
		go alignInstalledWatchdogChannel(p.logger, p.cfg.Docker.LeaseWatchdogReleasesURL, p.cfg.Docker.LeaseWatchdogArtifactBaseURL)
	}
	p.scheduleLeaseWatchdogRefresh()
	if p.databaseListeners != nil {
		// The host listeners the restore brought back adopt the database connections the previous process handed over.
		p.databaseListeners.mu.Lock()
		p.databaseListeners.adoptRestoredLocked()
		p.databaseListeners.mu.Unlock()
	}

	return nil
}

// setRuntimeStatus records and reports the Secure Runtime status and returns
// its generation.
func (p *DockerPlugin) setRuntimeStatus(status runtimemanager.Status) uint64 {
	p.runtimeStatusMu.Lock()
	gen := p.storeRuntimeStatusLocked(status)
	p.runtimeStatusMu.Unlock()
	p.sendRuntimeStatus(status)
	return gen
}

// replaceRuntimeStatus records status only while gen is still the current
// status: a background verification never overwrites what an install or a
// preflight command reported meanwhile.
func (p *DockerPlugin) replaceRuntimeStatus(gen uint64, status runtimemanager.Status) bool {
	p.runtimeStatusMu.Lock()
	if p.runtimeStatusGen != gen {
		p.runtimeStatusMu.Unlock()
		return false
	}
	p.storeRuntimeStatusLocked(status)
	p.runtimeStatusMu.Unlock()
	p.sendRuntimeStatus(status)
	return true
}

func (p *DockerPlugin) storeRuntimeStatusLocked(status runtimemanager.Status) uint64 {
	p.runtimeStatusGen++
	p.runtimeStatus = status
	if p.client != nil {
		p.client.SetRunscHealthy(status.State == runtimemanager.StateHealthy)
	}
	p.persistVerifiedRuntimeStatus(status)
	return p.runtimeStatusGen
}

func (p *DockerPlugin) sendRuntimeStatus(status runtimemanager.Status) {
	if p.writer != nil {
		if err := p.writer.Send(&pb.DaemonMessage{
			Payload: &pb.DaemonMessage_DockerRuntimeStatus{
				DockerRuntimeStatus: protobufRuntimeStatus(status),
			},
		}); err != nil && p.logger != nil {
			p.logger.Warn("failed to report Docker runtime status", "error", err)
		}
	}
}

func (p *DockerPlugin) getRuntimeStatus() runtimemanager.Status {
	p.runtimeStatusMu.RLock()
	defer p.runtimeStatusMu.RUnlock()
	return p.runtimeStatus
}

func protobufRuntimeStatus(status runtimemanager.Status) *pb.DockerRuntimeStatus {
	result := &pb.DockerRuntimeStatus{
		State:               string(status.State),
		InstalledVersion:    status.InstalledVersion,
		TargetVersion:       status.TargetVersion,
		ReasonCode:          status.ReasonCode,
		Message:             status.Message,
		CheckedAtUnixMs:     status.CheckedAt.UnixMilli(),
		RemoteInstallable:   status.RemoteInstallable,
		LocalInstallCommand: status.LocalInstallCommand,
		Step:                string(status.Step),
	}
	if status.ProgressPercent != nil {
		result.ProgressPercent = *status.ProgressPercent
	}
	return result
}

// BuildRegisterMessage constructs the registration message for Opfield.
func (p *DockerPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	arch := sysmetrics.GetArchitecture()
	kernelVer := sysmetrics.GetKernelVersion()

	capabilities := func() []string {
		if p.cfg.Docker.Mode == "builder" {
			values := []string{
				"docker_builder_profile_v1",
				"docker_registry_proxy_v1",
				"generic_relay_tunnel_v1",
				"relay_pool_v1",
			}
			if p.builderManager != nil && p.builderManager.Ready() == nil {
				values = append(
					values,
					"docker_builder_execution_v1",
					"docker_builder_dedicated_runtime_v1",
					"docker_builder_resource_limits_v1",
					"docker_builder_scan_disable_v1",
				)
			}
			return values
		}
		if p.cfg.Docker.IsStorageProfile() {
			values := []string{
				"managed_databases_v1",
				"managed_database_storage_images_v1",
				"managed_clickhouse_principals_v1",
				"managed_postgres_query_principal_v1",
				"managed_postgres_query_writer_v1",
				"managed_postgres_config_v1",
				managedCapabilityValkey,
				"managed_database_binding_principals_v2",
				managedDatabaseVersionUpdateCapability,
				"managed_storage_v1",
				"managed_storage_ext4_quota_v1",
				"managed_storage_iam_v1",
				// iam_update_policy: the migration write freeze rewrites key policies in place.
				"managed_storage_iam_policy_v1",
				"managed_storage_private_relay_v1",
				"managed_storage_seaweedfs_v1",
				managedTLSReloadCapability,
				"generic_relay_tunnel_v1",
				"relay_pool_v1",
				relayresume.Capability,
				handover.Capability,
				managedAvailabilityRoutesCapability,
				nodeKeeperWitnessCapability,
			}
			// The lease runtime runs on storage-profile daemons for their availability set members.
			values = append(values, p.leaseCapabilities()...)
			values = append(values, p.setMemberCapabilities()...)
			if p.backupHandler != nil {
				values = append(values, "database_backups_v1", "database_backups_deadline_v1", "database_backups_tls_verification_v1", storageCopyCapability)
			}
			values = append(values, p.opfieldNamesCapabilities()...)
			return values
		}
		values := []string{nodeKeeperWitnessCapability, "docker_deployments_v1", "docker_gpu_v1", dockerMigrationCapability, "docker_archive_v1", "docker_port_bind_ip_v1", "generic_relay_tunnel_v1", "relay_pool_v1", relayresume.Capability, handover.Capability, "proxy_secure_links_v1", "docker_registry_proxy_v1", "docker_runtime_management_v1", "docker_managed_volumes_v1", "docker_duplicate_label_filter_v1", "docker_duplicate_env_removal_v1", TaskCommandLookupCapability, dockerNetworkIsolationCapability}
		if p.cfg.Docker.Mode == "" && p.availability != nil {
			values = append(values, dockerAvailabilityCapability)
		}
		if p.availabilityHealth != nil {
			values = append(values, availabilityHTTPHealthCapability)
		}
		// Advertised only with a live watchdog (A12.4); the lease report's
		// watchdog_ready carries later changes within the session.
		values = append(values, p.leaseCapabilities()...)
		values = append(values, "managed_database_binding_listener_v1", managedStorageLinkCapability, managedLinkRuntimeCapability,
			managedLinkCompletedCapability, managedAvailabilityRoutesCapability)
		if p.secureLinks != nil {
			// The shared connector serves egress, container links and create_link_network (C7).
			values = append(values, secureLinkEgressCapability)
		}
		if p.volumeImages != nil && p.volumeImages.supported {
			values = append(values, "docker_volume_storage_images_v1")
		}
		if runsWithoutRoot() {
			values = append(values, nonRootCapability)
		}
		if p.getRuntimeStatus().State == runtimemanager.StateHealthy {
			values = append(values, "docker_runsc_healthy_v1")
		}
		if p.composeExecutor != nil {
			values = append(values, "docker_compose_v1", composeLoggingCapability)
		}
		values = append(values, p.opfieldNamesCapabilities()...)
		return values
	}()
	message := &pb.RegisterMessage{
		NodeId:        nodeID,
		Hostname:      hostname,
		DaemonVersion: lifecycle.Version,
		DaemonType:    "docker",
		CpuModel:      cpuModel,
		CpuCores:      int32(cpuCores),
		Architecture:  arch,
		KernelVersion: kernelVer,
		// Store docker version in the NginxVersion field as a capability hint.
		// Opfield uses DaemonType to interpret this field correctly.
		NginxVersion: p.version,
		Capabilities: capabilities,
	}
	if p.cfg.Docker.Mode != "builder" {
		message.DockerRuntimeStatus = protobufRuntimeStatus(p.getRuntimeStatus())
	}
	return message
}
