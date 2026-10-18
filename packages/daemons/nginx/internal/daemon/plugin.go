package daemon

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	sharedauth "github.com/opfield/opfield/daemon-shared/auth"
	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/logepisode"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	"github.com/opfield/opfield/daemon-shared/securelink"
	sharedstate "github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
	"github.com/opfield/opfield/nginx-daemon/internal/pages"
	"google.golang.org/grpc"
)

// NginxPlugin implements lifecycle.DaemonPlugin for the nginx daemon.
type NginxPlugin struct {
	// relayPathWake wakes resumable streams waiting to retry a move when a
	// relay lane or assignment may have made a path available
	// (relayresume.SourceConfig.Wake).
	relayPathWake               relayresume.Signal
	handoverOnce                sync.Once
	shutdownOnce                sync.Once
	cfg                         *config.Config
	baseCfg                     *lifecycle.BaseConfig
	mgr                         *nginx.Manager
	handler                     *Handler
	reporter                    *Reporter
	state                       *sharedstate.State
	logger                      *slog.Logger
	relayGrants                 *relayGrantStore
	secureLinks                 *sourceLinkManager
	registryLinks               *sourceLinkManager
	secureLinkState             *securelink.StateStore
	availabilityLease           *availabilityLeaseCoordinator
	pagesRuntime                *pages.Runtime
	pagesV1Available            bool
	pagesRuntimeConfigAvailable bool
	relayTunnelMu               sync.Mutex
	relayTunnels                []*nginxRelayTunnel
	// Lane rotation (relay_lanes.go), under relayTunnelMu: lanes rotated out that still carry tunnels, and per relay
	// and per data-only pool lane when they last rotated.
	retiringRelayTunnels       []*nginxRelayTunnel
	relayLaneRotations         map[string]*relayLaneRotation
	relayLaneRotatedAt         map[*nginxRelayTunnel]time.Time
	relaySelection             uint64
	configWatchMu              sync.Mutex
	validatedConfigFingerprint string
	pendingConfigFingerprint   string
	configFingerprintReady     bool
	// registryListenersRelease releases kept registry sockets no sync claimed.
	registryListenersRelease *time.Timer
	registryListenersOnce    sync.Once
	// secureLinkOutcomes logs Secure Link connection failures and holds per link and state change (L-1).
	secureLinkOutcomes logepisode.Tracker
	// relayPenalties orders relays that failed a link's tunnel recently after the others.
	relayPenalties relaybridge.RelayPenalties
	// relayStability is since when each relay has had a connected lane without a break: resumable streams return
	// to a nearer relay only once it was stable for a while (relayresume.Returner).
	relayStability relaybridge.RelayStability
	// relayRTT replaces relaybridge.Latency.RTT in tests.
	relayRTT func(string) (time.Duration, bool)
	// relayStreams is the source side of resumable relay streams (RSv1); relayStreamOutcomes logs their moves
	// and cuts per link and state change.
	relayStreams        *relayresume.Manager
	relayStreamOutcomes logepisode.Tracker
	// relayStreamTargetCuts notes streams their target ended by restarting without taking them over: expected, no
	// warning (rc.10 upgrade run, F-4).
	relayStreamTargetCuts logepisode.Tracker
	// Ingress groups: the reserved health endpoint's responder (nil when it could not start).
	ingressHealth *ingressHealthResponder
	// handover carries the Secure Link connections an update hands to the next process (live_handover.go);
	// handoverTracker settles what the last update did to them; liveCuts counts those an update cuts in any case.
	handover        *handover.Registry
	handoverTracker *handover.Tracker
	liveCuts        liveCuts
	// logBudget bounds the nginx logs (log_budget.go).
	logBudget logBudget

	// Session-scoped resources
	sessionCancel              context.CancelFunc
	conn                       *grpc.ClientConn
	maintenanceAccess          *maintenanceAccessServer
	maintenanceAccessSupported bool
	// maintenanceFlagsSupported: routes enter and leave maintenance through their flag files (maintenance_flags.go).
	maintenanceFlagsSupported bool
	// errorPagesSupported: the node keeps the Opfield error page variables (error_pages.go).
	errorPagesSupported bool
	// nginx.conf defines the access log format before the includes route configs come in by.
	accessLogFormatReady bool

	// namesMigrationDue: the node still runs with the pre-Opfield names and moves once the start is confirmed
	// (opfield_names.go); registrationChanged asks the control session to register the new capabilities.
	namesMigrationDue   bool
	namesMigrationMu    sync.Mutex
	registrationChanged chan struct{}
}

var _ lifecycle.ProxySecureLinkPlugin = (*NginxPlugin)(nil)
var _ lifecycle.ProxySecureLinkProbePlugin = (*NginxPlugin)(nil)
var _ lifecycle.PagesRouteProbePlugin = (*NginxPlugin)(nil)
var _ lifecycle.ShutdownPlugin = (*NginxPlugin)(nil)

// registryListenerAdoptionWindow bounds how long registry sockets kept by the
// previous process wait for the registry sync that adopts them. They queue
// connections meanwhile, which only a sync can serve.
const registryListenerAdoptionWindow = 30 * time.Second

// releaseUnclaimedRegistryListeners closes the registry sockets the previous
// process kept that the first registry sync did not adopt.
func (p *NginxPlugin) releaseUnclaimedRegistryListeners() {
	p.registryListenersOnce.Do(func() {
		if p.registryListenersRelease != nil {
			p.registryListenersRelease.Stop()
		}
		releaseUnclaimedUnder(p.registryLinks.socketDir)
	})
}

// secureLinkProxyPassPattern finds the proxy_pass a managed config marks as its Secure Link upstream, under the
// Opfield marker or, in a config rendered for the pre-Opfield names, the legacy one.
func secureLinkProxyPassPattern(linkID string, port int) *regexp.Regexp {
	portPattern := `[0-9]+`
	if port > 0 {
		portPattern = fmt.Sprintf("%d", port)
	}
	// legacy-name: the legacy managed secure link upstream marker of configs rendered for the pre-Opfield names — remove once
	// every node reports none
	return regexp.MustCompile(fmt.Sprintf(
		`(?m)(#[[:space:]]*(?:opfield|`+legacycompat.ObjectNameFamily+`)-managed-secure-link-upstream[[:space:]]+%s[[:space:]]*\r?\n[[:space:]]*proxy_pass[[:space:]]+https?://)127[.]0[.]0[.]1:%s`,
		regexp.QuoteMeta(linkID),
		portPattern,
	))
}

func replaceFirstSecureLinkProxyPass(content []byte, linkID string, oldPort, newPort int) ([]byte, bool) {
	pattern := secureLinkProxyPassPattern(linkID, oldPort)
	indices := pattern.FindSubmatchIndex(content)
	if indices == nil && oldPort > 0 {
		// A managed config may already be ahead of persisted listener state after
		// a crash. The per-host marker keeps this fallback out of unrelated or
		// user-owned raw configs.
		indices = secureLinkProxyPassPattern(linkID, 0).FindSubmatchIndex(content)
	}
	if indices == nil {
		return content, false
	}
	prefix := content[indices[2]:indices[3]]
	replacement := []byte(fmt.Sprintf("%s127.0.0.1:%d", prefix, newPort))
	next := make([]byte, 0, len(content)-indices[1]+indices[0]+len(replacement))
	next = append(next, content[:indices[0]]...)
	next = append(next, replacement...)
	next = append(next, content[indices[1]:]...)
	return next, true
}

// NewNginxPlugin creates a new NginxPlugin with the given config.
func NewNginxPlugin(cfg *config.Config) *NginxPlugin {
	return &NginxPlugin{cfg: cfg, handover: handover.NewRegistry(), registrationChanged: make(chan struct{}, 1)}
}

// RegistrationChanged signals that the node's capabilities changed (the node moved to the Opfield names): the control
// session registers again.
func (p *NginxPlugin) RegistrationChanged() <-chan struct{} { return p.registrationChanged }

func (p *NginxPlugin) refreshRegistration() {
	select {
	case p.registrationChanged <- struct{}{}:
	default:
	}
}

func (p *NginxPlugin) Type() string {
	return "nginx"
}

func (p *NginxPlugin) SetLogger(logger *slog.Logger) {
	p.logger = logger
	if p.handler != nil {
		p.handler.logger = logger
	}
	if p.reporter != nil {
		p.reporter.logger = logger
	}
}

func (p *NginxPlugin) Init(baseCfg *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.baseCfg = baseCfg
	p.logger = logger
	// The names this start uses (opfield_names.go): before anything reads a path of the node.
	p.namesMigrationDue = resolveNames(p.cfg, baseCfg.StateDir, logger)

	// Verify nginx is available
	mgr := nginx.NewManager(p.cfg.Nginx.Binary, p.cfg.Nginx.ConfigDir, p.cfg.Nginx.CertsDir, p.cfg.Nginx.GlobalConfig)
	version, err := mgr.GetVersion()
	if err != nil {
		return fmt.Errorf("nginx not found at %s: %w", p.cfg.Nginx.Binary, err)
	}
	logger.Info("nginx detected", "version", version)
	p.mgr = mgr
	mgr.SetConfigTestObserver(p.observeConfigTest)
	reloadPending := mgr.SetReloadPendingMarker(filepath.Join(baseCfg.StateDir, "nginx-reload-pending"))
	p.maintenanceAccessSupported, err = mgr.HasSecureLinkModule()
	if err != nil {
		return err
	}
	if !p.maintenanceAccessSupported {
		logger.Warn("nginx secure_link module is unavailable; maintenance access codes are disabled")
	} else if err := prepareMaintenanceFlagDir(maintenanceFlagDir()); err != nil {
		logger.Warn("maintenance flag directory is unavailable; maintenance changes reload nginx", "path", maintenanceFlagDir(), "error", err)
	} else {
		p.maintenanceFlagsSupported = true
	}
	p.relayGrants, err = newRelayGrantStore(baseCfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize relay grant store: %w", err)
	}
	p.relayStreams = newRelayStreamManager(p)
	p.startRelayStreamReturner(context.Background())
	// Secure Link peers are authorized against the cached master PID: no
	// subprocess per connection (B-22). Resolve it now, off the first
	// connection's path.
	go func() { _, _ = mgr.CachedPID() }()
	p.secureLinks = newSourceLinkManager(p.openProxySecureLink, p.cfg.Nginx.Binary, p.mgr.CachedPID)
	p.registryLinks = newSourceLinkManagerAt(
		p.openRegistrySecureLink,
		registrySecureLinkSocketDir(),
		p.cfg.Nginx.Binary,
		p.mgr.CachedPID,
	)
	p.secureLinks.shedLog = p.secureLinkShedLog("proxy secure-link")
	p.secureLinks.loopbackFailed = func(linkID, address string, err error) {
		// The Unix socket serves on; a config that uses the endpoint gets refused connections (another local
		// service holds the port: Opfield's SECURE_LINK_LOOPBACK_PORT moves every endpoint).
		logger.Warn("proxy secure-link loopback endpoint cannot listen", "link_id", linkID, "address", address, "error", err)
	}
	p.registryLinks.shedLog = p.secureLinkShedLog("registry ingress")
	p.secureLinkState, err = securelink.NewStateStore(baseCfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize proxy secure-link state: %w", err)
	}
	// Units installed before the template carried it get a file descriptor
	// store, so Secure Link sockets also survive a restart of the whole unit.
	// It applies to the running unit: under a launcher without a keeper, the
	// sockets created below are stored on the launcher's behalf at once.
	if installed, storeErr := listenerkeep.EnsureSystemdStore(); storeErr != nil {
		logger.Warn("could not give the daemon unit a file descriptor store; a unit restart refuses Secure Link connections briefly", "error", storeErr)
	} else if installed {
		logger.Info("gave the daemon unit a file descriptor store for Secure Link sockets", "drop_in", listenerkeep.SystemdDropInName)
	}
	p.availabilityLease = newAvailabilityLeaseCoordinator(baseCfg.StateDir, p.secureLinks, logger)
	p.availabilityLease.start()
	// Adopt the sockets the previous process kept before the slower start-up work (Pages storage, nginx
	// checks): connections made during a restart wait in their backlog until this point.
	removeStaleTemporarySockets(p.secureLinks.socketDir)
	removeStaleTemporarySockets(p.registryLinks.socketDir)
	if restored := p.secureLinkState.Get(); len(restored.Bindings) > 0 {
		statuses, restoreErr := p.secureLinks.sync(restored)
		if restoreErr != nil {
			return fmt.Errorf("restore proxy secure-link listeners: %w", restoreErr)
		}
		if reconcileErr := p.reconcileRestoredSecureLinkPorts(restored, statuses); reconcileErr != nil {
			return fmt.Errorf("reconcile restored proxy secure-link ports: %w", reconcileErr)
		}
		if saveErr := p.secureLinkState.Save(normalizeSourceBindings(restored, statuses)); saveErr != nil {
			return fmt.Errorf("persist restored proxy secure-link listeners: %w", saveErr)
		}
	}
	// Restoring adopted every proxy Secure Link socket the previous process
	// kept for a binding it still has; the others were removed meanwhile.
	if released := releaseUnclaimedUnder(p.secureLinks.socketDir); len(released) > 0 {
		logger.Info("released kept Secure Link sockets without a binding", "sockets", len(released))
	}
	// The connections the previous process handed over go back under their bindings, before the relay lanes start
	// (live_handover.go).
	p.restoreHandover()
	p.registryListenersRelease = time.AfterFunc(registryListenerAdoptionWindow, p.releaseUnclaimedRegistryListeners)
	p.pagesRuntime, err = pages.New(p.cfg.Nginx.PagesRoot, p.cfg.Nginx.ConfigDir, p.cfg.Nginx.CertsDir, p.mgr)
	if err != nil {
		logger.Warn("Opfield Pages runtime is unavailable; Pages capability is disabled", "error", err)
	} else if err := p.pagesRuntime.SetHtpasswdDir(p.cfg.Nginx.HtpasswdDir); err != nil {
		logger.Warn("Opfield Pages htpasswd directory is unsafe; Pages capability is disabled", "error", err)
		p.pagesRuntime = nil
	} else if err := p.pagesRuntime.RepairStorage(); err != nil {
		logger.Warn("Opfield Pages storage is unavailable; Pages capability is disabled", "error", err)
		p.pagesRuntime = nil
	} else {
		// nginx workers must reach the releases through the daemon's state
		// directory, which state writes create owner-only (N-22).
		p.pagesRuntime.SetReaderAccess(baseCfg.StateDir, p.secureLinks.socketOwnerUID)
		p.pagesRuntime.SetUnknownHostsAnswered(p.unknownHostsAnswered)
		if err := p.pagesRuntime.RepairTraversal(); err != nil {
			logger.Warn("nginx workers may not reach Opfield Pages releases; Pages deliveries stay not ready until they can", "error", err)
		}
		// Set this only after every v1 runtime dependency has initialized and the
		// confined storage root has passed a real filesystem preflight. This is
		// deliberately a capability gate, not a daemon-version heuristic.
		p.pagesV1Available = true
		p.pagesRuntimeConfigAvailable, err = nginxBuildHasSubFilter(p.cfg.Nginx.Binary)
		if err != nil {
			logger.Warn("Opfield Pages runtime configuration is unavailable; capability is disabled", "error", err)
			p.pagesRuntimeConfigAvailable = false
		} else if !p.pagesRuntimeConfigAvailable {
			logger.Warn("Opfield Pages runtime configuration is unavailable; nginx was built without http_sub_module")
		}
	}

	// Clean up leftover .tmp files from potential crashes
	nginx.CleanTmpFiles(p.cfg.Nginx.ConfigDir)
	nginx.CleanTmpFiles(p.cfg.Nginx.CertsDir)

	globalConfigModified := false
	configDirModified := false

	// Ensure the managed HTTPS catch-all default server is present, so an
	// unmatched SNI/Host cannot fall through to an arbitrary route (this
	// covers nodes provisioned before the installer wrote it).
	if p.ensureManagedDefaultServer(logger) {
		configDirModified = true
	}

	// The reserved ingress health endpoint (ingress groups): config generation variable, reserved-hostname
	// server and default-server location, then the local responder nginx proxies to.
	healthChanged, healthReady := p.ensureIngressHealthConfig(logger)
	if healthChanged {
		configDirModified = true
	}
	// The shared maps of the flag-checked maintenance guard; without them Opfield keeps rendering the guard only
	// during maintenance.
	if p.maintenanceFlagsSupported && p.ensureMaintenanceGuardMaps(logger) {
		configDirModified = true
	}
	// The Opfield pages nginx answers its own errors with; without them Opfield renders routes without error_page.
	if p.ensureErrorPages(logger) {
		configDirModified = true
	}
	if p.pagesRuntime != nil {
		p.pagesRuntime.SetErrorPages(p.errorPagesSupported)
	}
	if p.errorPagesSupported && p.ensureDefaultHTTPServerErrorPages(logger) {
		configDirModified = true
	}

	if healthReady {
		if responder, err := startIngressHealthResponder(p, logger); err != nil {
			logger.Warn("ingress health responder is unavailable; this node cannot join ingress groups", "error", err)
		} else {
			p.ingressHealth = responder
		}
	}

	// Ensure the daemon's log format is present in nginx.conf.
	if modified, err := nginx.EnsureLogFormat(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to inject log format", "error", err)
	} else if modified {
		logger.Info("injected the daemon's log format into nginx.conf")
		globalConfigModified = true
	}
	// Route configs log with that format, so it must come before the includes that bring them in.
	if ready, modified, err := nginx.EnsureLogFormatFirst(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to move the log format above the includes of nginx.conf", "error", err)
	} else {
		p.accessLogFormatReady = ready
		if modified {
			logger.Info("moved the daemon's log format above the includes of nginx.conf")
			globalConfigModified = true
		}
	}

	// Pages preview hostnames can exceed nginx's platform-default server-name
	// hash bucket. Keep the managed minimum in the global http block.
	if modified, err := nginx.EnsureServerNamesHashBucketSize(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to configure server names hash bucket size", "error", err)
	} else if modified {
		logger.Info("configured server names hash bucket size for Opfield Pages")
		globalConfigModified = true
	}

	if reloadPending {
		// A change written before the previous process stopped may not run yet.
		if valid, output := mgr.TestConfig(); valid {
			configDirModified = true
		} else {
			logger.Warn("nginx configuration changed before the daemon stopped is invalid and is not loaded", "output", output)
		}
	}
	if globalConfigModified || configDirModified {
		mgr.Reload()
	}
	if valid, output := mgr.TestConfig(); !valid {
		logger.Warn("nginx configuration is invalid", "output", output)
	}

	if p.namesMigrationDue {
		// The move to the Opfield names waits until the launcher can no longer roll back to a daemon that knows only
		// the pre-Opfield ones.
		lifecycle.OnStartConfirmed(func() { go p.migrateNames() })
	}
	return nil
}

type secureLinkConfigChange struct {
	path string
	old  []byte
	next []byte
}

func (p *NginxPlugin) reconcileRestoredSecureLinkPorts(
	restored *pb.SyncProxySecureLinksCommand,
	statuses []sourceLinkStatus,
) error {
	ports := make(map[string]int, len(statuses))
	for _, status := range statuses {
		ports[status.LinkID] = status.Port
	}
	changes := make([]secureLinkConfigChange, 0)
	for _, binding := range restored.Bindings {
		if !binding.SourceConfigManaged {
			continue
		}
		port := ports[binding.LinkId]
		if port == 0 {
			continue
		}
		path := p.mgr.ConfigPath(binding.LinkId)
		current, err := nginx.ReadFile(path)
		if err != nil {
			return err
		}
		if current == nil {
			continue
		}
		next, changed := replaceFirstSecureLinkProxyPass(current, binding.LinkId, int(binding.ListenerPort), port)
		if !changed || bytes.Equal(current, next) {
			continue
		}
		changes = append(changes, secureLinkConfigChange{path: path, old: current, next: next})
	}
	if len(changes) == 0 {
		return nil
	}
	if _, err := p.mgr.BeginChange(); err != nil {
		return err
	}
	rollback := func(applied int) {
		for index := applied - 1; index >= 0; index-- {
			_ = nginx.WriteAtomic(changes[index].path, changes[index].old)
		}
	}
	for index, change := range changes {
		if err := nginx.WriteAtomic(change.path, change.next); err != nil {
			rollback(index)
			return err
		}
	}
	valid, output := p.mgr.TestConfig()
	if !valid {
		rollback(len(changes))
		return fmt.Errorf("nginx config test failed after secure-link port recovery: %s", output)
	}
	if err := p.mgr.Reload(); err != nil {
		rollback(len(changes))
		return err
	}
	p.logger.Info("reconciled proxy secure-link listener ports after restart", "host_count", len(changes))
	return nil
}

// SetState is called by the daemon wrapper to provide the shared state.
func (p *NginxPlugin) SetState(st *sharedstate.State) {
	p.state = st
	p.reporter = NewReporter(p.cfg, p.mgr, p.logger)
	p.handler = NewHandler(p.cfg, p.mgr, st, p.logger, p.secureLinkState, p.pagesRuntime, p.pagesRuntimeConfigAvailable)
	if p.maintenanceFlagsSupported {
		p.handler.maintenanceFlagDir = maintenanceFlagDir()
	}
	if p.secureLinks != nil {
		p.handler.secureLinkListeners = p.secureLinks
	}
	p.handler.reporter = p.reporter
	p.startLogBudget()
}

func (p *NginxPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	nginxVersion, _ := p.mgr.GetVersion()
	uptime, _ := p.mgr.GetUptime()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	arch := sysmetrics.GetArchitecture()
	kernelVer := sysmetrics.GetKernelVersion()

	configVersionHash := p.state.GetExtraString("config_version_hash")

	return &pb.RegisterMessage{
		NodeId:             nodeID,
		Hostname:           hostname,
		NginxVersion:       nginxVersion,
		ConfigVersionHash:  configVersionHash,
		DaemonVersion:      lifecycle.Version,
		NginxUptimeSeconds: int64(uptime.Seconds()),
		NginxRunning:       p.mgr.IsRunning(),
		CpuModel:           cpuModel,
		CpuCores:           int32(cpuCores),
		Architecture:       arch,
		KernelVersion:      kernelVer,
		DaemonType:         "nginx",
		Capabilities:       p.capabilities(),
	}
}

func (p *NginxPlugin) HandleCommand(cmd *pb.OpfieldCommand) *pb.CommandResult {
	if payload, ok := cmd.Payload.(*pb.OpfieldCommand_SyncDockerRegistryBindings); ok {
		result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
		detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}
		return result
	}
	if payload, ok := cmd.Payload.(*pb.OpfieldCommand_ConfigureNginxLogs); ok {
		result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
		detail, err := p.ConfigureNginxLogs(payload.ConfigureNginxLogs)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}
		return result
	}
	if payload, ok := cmd.Payload.(*pb.OpfieldCommand_SyncAvailabilityLease); ok {
		result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
		detail, err := p.SyncAvailabilityLease(payload.SyncAvailabilityLease)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}
		return result
	}
	return p.handler.HandleCommand(cmd)
}

// SyncAvailabilityLease adopts policy keys, key rotations, the voter config
// and every policy manifest carried by OpfieldCommand 75 (T3's contract).
func (p *NginxPlugin) SyncAvailabilityLease(command *pb.SyncAvailabilityLeaseCommand) (string, error) {
	if p.availabilityLease == nil {
		return "", errors.New("availability lease coordination is unavailable")
	}
	return p.availabilityLease.apply(command)
}

func (p *NginxPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	report := p.reporter.CollectHealth(base)
	if p.availabilityLease != nil {
		if lease := p.availabilityLease.buildReport(); lease != nil {
			report.AvailabilityLease = lease
		}
	}
	if p.ingressHealth != nil {
		report.IngressHealth = p.ingressHealth.report()
	}
	if report != nil && naming.Legacy() {
		lifecycle.AddLegacyNames(report, "nginx", 1)
	}
	if p.relayStreams != nil && report != nil {
		report.RelayStreams = relayStreamStatsReport(p.relayStreams.Stats())
	}
	if report != nil {
		report.UpdateConnections = p.updateConnections()
		report.NginxLogs = p.logUsageReport()
	}
	return report
}

// Shutdown stops the availability-lease coordinator's background loops. A
// stop that does not wait for the lifecycle (Daemon.Run) calls it too.
func (p *NginxPlugin) Shutdown() {
	p.shutdownOnce.Do(func() {
		if p.availabilityLease != nil {
			p.availabilityLease.close()
		}
		p.ingressHealth.close()
		p.leaveStreamTotals()
	})
}

func (p *NginxPlugin) CollectStats() *pb.StatsReport {
	return p.reporter.CollectStats()
}

func (p *NginxPlugin) capabilities() []string {
	capabilities := []string{"nginx_certificate_distribution_v2", "generic_relay_tunnel_v1", "relay_pool_v1", "proxy_secure_links_v1", "nginx_secure_link_socket_only_v1", "nginx_registry_ingress_v1", NginxSecureLinkLoopbackCapability, managedAvailabilityRoutesCapability, nginx.LogBudgetCapability}
	if p.relayStreams != nil {
		capabilities = append(capabilities, relayresume.Capability, handover.Capability)
	}
	if p.maintenanceAccessSupported {
		capabilities = append(capabilities, "proxy_maintenance_access_v1")
	}
	if p.maintenanceFlagsSupported {
		capabilities = append(capabilities, maintenanceFlagCapability)
	}
	if p.errorPagesSupported {
		capabilities = append(capabilities, nginx.ErrorPagesCapability)
	}
	if p.pagesV1Available && p.pagesRuntime != nil {
		capabilities = append(capabilities, "nginx_pages_v1", "nginx_pages_route_probe_v1", "nginx_pages_preview_revocation_v1", "nginx_pages_preview_access_v1", "nginx_pages_preview_client_ip_v1", pagesDeferredReloadCapability)
	}
	if p.pagesRuntimeConfigAvailable && p.pagesRuntime != nil {
		capabilities = append(capabilities, "nginx_pages_config_v1")
		if p.pagesV1Available {
			capabilities = append(capabilities, "nginx_pages_reconcile_v1")
		}
	}
	if p.availabilityLease != nil {
		capabilities = append(capabilities, availabilityLeaseCapability)
	}
	if p.ingressHealth != nil {
		capabilities = append(capabilities, ingressGroupCapability)
	}
	if !naming.Legacy() {
		capabilities = append(capabilities, naming.Capability)
	}
	if p.accessLogFormatReady {
		capabilities = append(capabilities, AccessLogFormatCapability)
	}
	return capabilities
}

func nginxBuildHasSubFilter(binary string) (bool, error) {
	output, err := exec.Command(binary, "-V").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("nginx build check failed: %w", err)
	}
	return nginxBuildOutputHasSubFilter(output), nil
}

func nginxBuildOutputHasSubFilter(output []byte) bool {
	return strings.Contains(string(output), "--with-http_sub_module")
}

func (p *NginxPlugin) OnSessionStart(ctx context.Context, _ *stream.Writer) error {
	sessionCtx, cancel := context.WithCancel(ctx)
	p.sessionCancel = cancel
	p.validateConfigIfStale(time.Now())
	go p.runConfigValidation(sessionCtx)
	go p.runDiskHousekeeping(sessionCtx)
	if !p.maintenanceAccessSupported {
		return nil
	}
	tlsManager := sharedauth.NewTLSManager(p.baseCfg.TLS.CACert, p.baseCfg.TLS.ClientCert, p.baseCfg.TLS.ClientKey)
	// The address the control session uses now: it follows a move of Opfield
	// to another address (lifecycle.ControlAddress).
	conn, err := connector.NewConnector(lifecycle.ControlAddress(p.baseCfg.Control.Address), tlsManager, p.logger).Connect(sessionCtx)
	if err != nil {
		cancel()
		return err
	}
	accessServer, err := startMaintenanceAccessServer(conn, p.logger)
	if err != nil {
		_ = conn.Close()
		cancel()
		return err
	}
	p.conn = conn
	p.maintenanceAccess = accessServer

	// Start log stream if we have a connection
	// The log stream is managed at the session level for nginx
	return nil
}

func (p *NginxPlugin) OnSessionEnd() {
	p.maintenanceAccess.close(p.socketsHandedOver())
	p.maintenanceAccess = nil
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
	if p.sessionCancel != nil {
		p.sessionCancel()
		p.sessionCancel = nil
	}
}

// RunLogStream runs the log streaming loop for the nginx daemon.
// This is called from the daemon wrapper which has access to the connection.
func (p *NginxPlugin) RunLogStream(ctx context.Context, conn *grpc.ClientConn) {
	backoff := 500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}

		err := p.runLogStreamSession(ctx, conn)
		if ctx.Err() != nil {
			return
		}
		p.logger.Debug("log stream stopped, reconnecting", "error", err)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 5*time.Second {
			backoff *= 2
		}
	}
}

func (p *NginxPlugin) runLogStreamSession(ctx context.Context, conn *grpc.ClientConn) error {
	rawStream, err := connector.OpenLogStream(ctx, conn)
	if err != nil {
		return fmt.Errorf("open log stream: %w", err)
	}

	logStream := stream.NewLogStreamWriter(rawStream)

	// Track active tailers per hostId
	tailers := make(map[string]context.CancelFunc)

	for ctx.Err() == nil {
		ctrl, err := logStream.Recv()
		if err != nil {
			for _, cancel := range tailers {
				cancel()
			}
			return fmt.Errorf("receive log control: %w", err)
		}

		if ctrl.GetSubscribe() != nil {
			sub := ctrl.GetSubscribe()
			hostId := sub.HostId
			tailLines := int(sub.TailLines)

			// Validate hostId to prevent path traversal
			if !isValidUUID(hostId) {
				p.logger.Warn("invalid hostId in log subscribe", "hostId", hostId)
				continue
			}

			accessLogPath := fmt.Sprintf("%s/proxy-%s.access.log", p.cfg.Nginx.LogsDir, hostId)
			errorLogPath := fmt.Sprintf("%s/proxy-%s.error.log", p.cfg.Nginx.LogsDir, hostId)

			if tailLines < 0 {
				lines, _ := nginx.TailLastN(accessLogPath, -tailLines)
				for _, line := range lines {
					parsed := nginx.ParseLogLine(hostId, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hostId,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
				logStream.Send(&pb.LogStreamMessage{
					Payload: &pb.LogStreamMessage_SubscribeAck{
						SubscribeAck: &pb.LogSubscribeAck{HostId: hostId},
					},
				})
				continue
			}

			// Cancel existing tailer for this host if any
			if cancel, ok := tailers[hostId]; ok {
				cancel()
			}

			tailCtx, cancel := context.WithCancel(ctx)
			tailers[hostId] = cancel

			if tailLines > 0 {
				lines, _ := nginx.TailLastN(accessLogPath, tailLines)
				for _, line := range lines {
					parsed := nginx.ParseLogLine(hostId, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hostId,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
			}

			// Tail access logs
			go func(hid string, lp string) {
				lines := make(chan string, 100)
				go nginx.TailFile(tailCtx, lp, lines)
				for line := range lines {
					parsed := nginx.ParseLogLine(hid, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hid,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
			}(hostId, accessLogPath)

			// Tail error logs
			go func(hid string, lp string) {
				lines := make(chan string, 100)
				go nginx.TailFile(tailCtx, lp, lines)
				for line := range lines {
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:  hid,
								Raw:     line,
								LogType: "error",
								Level:   nginx.ParseErrorLevel(line),
							},
						},
					})
				}
			}(hostId, errorLogPath)

			logStream.Send(&pb.LogStreamMessage{
				Payload: &pb.LogStreamMessage_SubscribeAck{
					SubscribeAck: &pb.LogSubscribeAck{HostId: hostId},
				},
			})

		} else if ctrl.GetUnsubscribe() != nil {
			hostId := ctrl.GetUnsubscribe().HostId
			if cancel, ok := tailers[hostId]; ok {
				cancel()
				delete(tailers, hostId)
			}
		}
	}

	return ctx.Err()
}

// ensureManagedDefaultServer writes the managed HTTPS catch-all and reports whether the config
// directory changed. A node whose nginx already has its own 443 default_server (integrate mode)
// rejects a second one, and an invalid tree would block every later route sync, so the file stays
// only when the configuration is valid with it or was already invalid without it.
func (p *NginxPlugin) ensureManagedDefaultServer(logger *slog.Logger) bool {
	modified, err := nginx.EnsureDefaultServer(p.cfg.Nginx.ConfigDir)
	if err != nil {
		logger.Warn("failed to write managed default HTTPS server", "error", err)
		return false
	}
	if !modified {
		return false
	}
	valid, output := p.mgr.TestConfig()
	if valid {
		logger.Info("wrote managed default HTTPS server (TLS catch-all)")
		return true
	}
	if err := nginx.RemoveFile(nginx.DefaultServerConfigPath(p.cfg.Nginx.ConfigDir)); err != nil {
		logger.Warn("failed to remove conflicting managed default HTTPS server", "error", err)
		return true
	}
	if validWithout, _ := p.mgr.TestConfig(); validWithout {
		logger.Warn(
			"managed default HTTPS server not installed: it conflicts with this node's nginx configuration, whose own default server keeps answering unmatched TLS hostnames",
			"output", output,
		)
		return false
	}
	if _, err := nginx.EnsureDefaultServer(p.cfg.Nginx.ConfigDir); err != nil {
		logger.Warn("failed to restore managed default HTTPS server", "error", err)
		return true
	}
	logger.Info("wrote managed default HTTPS server (TLS catch-all); the nginx configuration was already invalid")
	return true
}
