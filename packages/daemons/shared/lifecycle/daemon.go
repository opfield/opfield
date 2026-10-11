package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/auth"
	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/enrollment"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"google.golang.org/grpc"
)

// Version is set via -ldflags at build time; falls back to "dev".
var Version = "dev"

// DaemonBase is the shared daemon lifecycle manager.
// It handles enrollment, mTLS, reconnection, and delegates
// daemon-specific behavior to the DaemonPlugin.
type DaemonBase struct {
	// grantSyncs keeps relay grant syncs one at a time across sessions: a run of a session that ended may still be
	// in flight when the next session's first bundle arrives (grant_sync_worker.go).
	grantSyncs sync.Mutex
	// results carries async command results across control session reconnects (result_outbox.go).
	results resultOutbox

	cfg                   *BaseConfig
	cfgPath               string
	state                 *state.State
	connector             *connector.Connector
	plugin                DaemonPlugin
	sysReporter           *sysmetrics.SystemReporter
	logger                *slog.Logger
	baseHandler           slog.Handler // original handler, never wrapped
	tunnelIdentityChanged chan struct{}
	// controlReconnect asks the running control session to reconnect, so the
	// gateway sees a renewed certificate (and promotes it) before the relay
	// tunnel switches to it.
	controlReconnect chan struct{}
	// tunnelIdentityPending is set after a renewal; the tunnel is told to
	// switch identities once the gateway accepted the renewed certificate.
	tunnelIdentityPending atomic.Bool
	// sessionReceivedCommand is set by runSession once the gateway sent a
	// command, i.e. accepted the registration. Only the Run loop reads it.
	sessionReceivedCommand bool
	prepareShutdownOnce    sync.Once
	// launcherChanged reconnects the control session once the launcher
	// updated itself in place, so the gateway sees its version and features.
	launcherChanged chan struct{}
	// afterUpdateRestart is the service restart right after an update that
	// carried no connection (launcher_after_update.go), once requested.
	afterUpdateRestart atomic.Pointer[launcherServiceRestart]
	// consoleUserRefusal is set at startup when console.user names a user
	// this daemon cannot switch to; console sessions are refused with it.
	consoleUserRefusal string
	// protected is set at startup when the node owner turned protected mode
	// on in the local config (protected.go). It never changes at run time.
	protected bool
}

// NewDaemonBase creates a new DaemonBase with the given plugin.
func NewDaemonBase(cfg *BaseConfig, cfgPath string, plugin DaemonPlugin, logger *slog.Logger) (*DaemonBase, error) {
	// Wrap logger with startup buffer so pre-session logs can be replayed
	startupLogger := slog.New(stream.NewStartupLogHandler(logger.Handler()))
	if err := plugin.Init(cfg, startupLogger); err != nil {
		return nil, fmt.Errorf("plugin init: %w", err)
	}

	// Load state
	st, err := state.Load(cfg.StateDir)
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}

	protected := pluginProtected(plugin)
	if protected {
		startupLogger.Info("protected mode is on: console, command execution, file access and host diagnostics are refused, and only official signed updates to the same or a newer release are installed")
	}
	return &DaemonBase{
		protected:             protected,
		cfg:                   cfg,
		cfgPath:               cfgPath,
		state:                 st,
		plugin:                plugin,
		sysReporter:           newSystemReporter(),
		logger:                startupLogger,
		baseHandler:           logger.Handler(), // original handler without startup buffer
		tunnelIdentityChanged: make(chan struct{}, 1),
		controlReconnect:      make(chan struct{}, 1),
		launcherChanged:       make(chan struct{}, 1),
		consoleUserRefusal:    checkConsoleUser(cfg, startupLogger),
	}, nil
}

// Run starts the daemon lifecycle: enroll, connect, session loop.
func (d *DaemonBase) Run(ctx context.Context) error {
	if shutdown, ok := d.plugin.(ShutdownPlugin); ok {
		defer shutdown.Shutdown()
	}
	// Step 1: Enroll if not yet enrolled
	if !d.cfg.IsEnrolled() {
		if err := d.enroll(); err != nil {
			if recordErr := recordEnrollmentFailure(d.cfg.StateDir, err); recordErr != nil {
				d.logger.Warn("could not record the enrollment failure for the installer", "error", recordErr)
			}
			return fmt.Errorf("enrollment: %w", err)
		}
	}

	// Step 2: Set up mTLS connector
	tlsMgr := auth.NewTLSManager(d.cfg.TLS.CACert, d.cfg.TLS.ClientCert, d.cfg.TLS.ClientKey)
	d.connector = connector.NewConnector(d.cfg.Gateway.Address, tlsMgr, d.logger)

	// Step 3: Start background cert renewal
	go runCertRenewal(ctx, d)
	if !d.protected {
		// A protected node reports no IP addresses, so it does not look its
		// public address up either.
		go d.sysReporter.RunPublicIPDiscovery(ctx)
	}
	go d.watchLauncher(ctx)
	if relayTunnel, ok := d.plugin.(RelayTunnelPlugin); ok {
		// The tunnel owns one process-lifetime ClientConn. It is intentionally
		// outside runSessionCycle: control reconnects must not cancel tunnel
		// streams or the TCP sessions multiplexed through them.
		if poolTunnel, poolCapable := relayTunnel.(RelayPoolTunnelPlugin); poolCapable {
			go runProcessRelayPool(ctx, d.connector, poolTunnel, d.state.NodeID, d.tunnelIdentityChanged, d.logger)
		} else {
			go runProcessRelayTunnel(
				ctx,
				d.connector.ConnectWithRetry,
				relayTunnel,
				d.state.NodeID,
				d.tunnelIdentityChanged,
				d.logger,
			)
		}
	}

	// Step 4: Connect and run (with reconnection loop)
	backoff := controlSessionBackoff{}
	// failingSince: when the sessions began to fail (zero while they work).
	var failingSince time.Time
	for {
		d.sessionReceivedCommand = false
		startedAt := time.Now()
		err := d.runSessionCycle(ctx)
		if ctx.Err() != nil {
			d.logger.Info("shutting down")
			return nil
		}
		if plan := d.afterUpdateRestart.Swap(nil); plan != nil {
			err = &RestartRequestedError{Message: "restarting the whole service once after the update", serviceRestart: plan}
		}
		// Fatal errors: do NOT reconnect, exit immediately
		if fatal, ok := err.(*FatalError); ok {
			d.logger.Error("fatal: "+fatal.Message, "action", "exiting")
			return fmt.Errorf("fatal: %s", fatal.Message)
		}
		if restart, ok := err.(*RestartRequestedError); ok {
			d.logger.Info(restart.Message, "action", "restarting")
			exitingForUpdate.Store(true)
			d.PrepareShutdown()
			restart.serviceStopped = restart.serviceRestart.run(d.logger)
			return restart
		}
		var delay time.Duration
		if rejected, ok := err.(*RegistrationRejectedError); ok {
			// Exiting would only let the supervisor restart us every few
			// seconds. Stay up and retry rarely: an operator may restore the
			// node (or re-enroll this host) without touching the daemon.
			delay = backoff.nextRejected()
			d.logger.Error("Opfield rejected registration; retrying later", "reason", rejected.Message, "retry_in", delay)
		} else {
			// The relay can remain reachable while its app upstream is
			// restarting, and a gateway can refuse a registration outright.
			// Both end the session immediately without any command, so the
			// transport-level connector backoff is never reached. Back off
			// exponentially until a session is accepted again.
			lasted := time.Since(startedAt)
			delay = backoff.next(d.sessionReceivedCommand, lasted)
			if d.sessionReceivedCommand || lasted >= controlSessionQuickFailure || failingSince.IsZero() {
				failingSince = time.Now()
			}
			log := d.logger.Warn
			if sessionEndExpected(err, time.Since(failingSince)) {
				log = d.logger.Info
			}
			log("session ended, reconnecting", "error", err, "retry_in", delay)
		}
		if !waitForControlSessionReconnectDelay(ctx, delay) {
			return nil
		}
	}
}

// sessionEndExpected reports a control session end that is information, not a
// warning (failingFor: how long the sessions have failed). The relay or
// Gateway on the way stopped on purpose (its update or restart), or this
// daemon reconnects on purpose: the session moves, nothing failed. Or a
// Gateway or relay restarting for its update refuses the connection for a
// while (stand rc.13 O-d): a longer outage warns, as the connector's own
// retries do.
func sessionEndExpected(err error, failingFor time.Duration) bool {
	return connector.PlannedDisconnect(err) || (connector.RefusedDial(err) && failingFor < connector.RestartQuiet)
}

const (
	// A Gateway that comes back (restart, update, outage) hears from every
	// node within 15 s: the cap before jitter (connector.Jitter, up to 1.5
	// times). Availability lease reconciliation after a takeover waits for the
	// voters' reports (stand run ha18/b: 33 s with a 60 s cap), and an attempt
	// against a relay whose Gateway upstream is down fails at the relay
	// without reaching the Gateway. The transport's own retry
	// (connector.MaxBackoff) has the same cap.
	controlSessionMaxReconnectDelay = connector.MaxBackoff
	// A session shorter than this that never received a command counts as a
	// failed attempt for backoff purposes.
	controlSessionQuickFailure      = 10 * time.Second
	controlSessionRejectedBaseDelay = time.Minute
	controlSessionRejectedMaxDelay  = 30 * time.Minute
)

// controlSessionBackoff grows the reconnect delay while sessions keep failing
// quickly without the gateway ever sending a command, and resets once a
// session was accepted. Every delay is jittered: the nodes that lost the same
// Gateway or relay come back spread out, not in one burst.
type controlSessionBackoff struct {
	failures int
	rejected int
	// random draws the jitter from [0, 1); nil is math/rand.
	random func() float64
}

func (b *controlSessionBackoff) next(receivedCommand bool, lasted time.Duration) time.Duration {
	b.rejected = 0
	random := b.random
	if random == nil {
		random = rand.Float64
	}
	if receivedCommand || lasted >= controlSessionQuickFailure {
		b.failures = 0
		return connector.Jitter(controlSessionReconnectDelay, random)
	}
	b.failures++
	return connector.Jitter(exponentialDelay(controlSessionReconnectDelay, b.failures-1, controlSessionMaxReconnectDelay), random)
}

func (b *controlSessionBackoff) nextRejected() time.Duration {
	b.failures = 0
	b.rejected++
	return exponentialDelay(controlSessionRejectedBaseDelay, b.rejected-1, controlSessionRejectedMaxDelay)
}

func exponentialDelay(base time.Duration, exponent int, max time.Duration) time.Duration {
	delay := base
	for i := 0; i < exponent && delay < max; i++ {
		delay *= 2
	}
	if delay > max {
		return max
	}
	return delay
}

type relayTunnelConnect func(context.Context) (*grpc.ClientConn, error)

const controlSessionReconnectDelay = time.Second

func waitForControlSessionReconnect(ctx context.Context) bool {
	return waitForControlSessionReconnectDelay(ctx, controlSessionReconnectDelay)
}

func waitForControlSessionReconnectDelay(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func runProcessRelayTunnel(
	ctx context.Context,
	connect relayTunnelConnect,
	plugin RelayTunnelPlugin,
	nodeID string,
	identityChanged <-chan struct{},
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		laneCount := 1
		var runtimeChanged <-chan struct{}
		if runtime, ok := plugin.(RelayTunnelRuntimePlugin); ok {
			laneCount = runtime.RelayTunnelLaneCount()
			if laneCount < 1 {
				laneCount = 1
			}
			if laneCount > 16 {
				laneCount = 16
			}
			runtimeChanged = runtime.RelayTunnelRuntimeChanged()
		}
		connections := make([]*grpc.ClientConn, 0, laneCount)
		var connectErr error
		for lane := 0; lane < laneCount; lane++ {
			conn, err := connect(ctx)
			if err != nil {
				connectErr = err
				break
			}
			connections = append(connections, conn)
		}
		if connectErr != nil {
			for _, conn := range connections {
				if conn != nil {
					_ = conn.Close()
				}
			}
			if ctx.Err() != nil {
				return
			}
			logger.Warn("relay tunnel lane connection failed, retrying", "error", connectErr)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				continue
			}
		}
		tunnelCtx, cancelTunnel := context.WithCancel(ctx)
		tunnelEnded := make(chan struct{}, laneCount)
		for _, conn := range connections {
			laneConn := conn
			go func() {
				plugin.RunRelayTunnels(tunnelCtx, laneConn, nodeID)
				tunnelEnded <- struct{}{}
			}()
		}
		rotated := false
		resized := false
		ended := 0
		select {
		case <-ctx.Done():
		case <-identityChanged:
			rotated = true
			logger.Info("relay tunnel identity changed, reconnecting")
		case <-runtimeChanged:
			resized = true
			logger.Info("relay tunnel runtime changed, resizing lanes")
		case <-tunnelEnded:
			ended = 1
		}
		cancelTunnel()
		for _, conn := range connections {
			if conn != nil {
				_ = conn.Close()
			}
		}
		for ended < len(connections) {
			select {
			case <-tunnelEnded:
				ended++
			case <-ctx.Done():
				return
			}
		}
		if ctx.Err() != nil {
			return
		}
		if rotated || resized {
			continue
		}
		logger.Warn("relay tunnel lifecycle ended unexpectedly, restarting")
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// requestControlReconnect makes the control session reconnect with the
// current credentials. The relay tunnel switches after the gateway accepted them.
func (d *DaemonBase) requestControlReconnect() {
	d.tunnelIdentityPending.Store(true)
	select {
	case d.controlReconnect <- struct{}{}:
	default:
	}
}

// launcherWatchInterval is how often a daemon checks whether its launcher
// updated itself in place, and whether an update now would restart its whole
// service (ServiceRestartExpected).
var launcherWatchInterval = 30 * time.Second

func (d *DaemonBase) watchLauncher(ctx context.Context) {
	last := LauncherFeatures()
	if !last.Managed {
		return
	}
	var expectation serviceRestartExpectation
	expectation.refresh(last)
	ticker := time.NewTicker(launcherWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		current := LauncherFeatures()
		expectation.refresh(current)
		if current.equal(last) {
			continue
		}
		last = current
		select {
		case d.launcherChanged <- struct{}{}:
		default:
		}
	}
}

func (d *DaemonBase) notifyTunnelIdentityChanged() {
	select {
	case d.tunnelIdentityChanged <- struct{}{}:
	default:
	}
}

func (d *DaemonBase) enroll() error {
	d.logger.Info("enrolling with Opfield", "address", d.cfg.Gateway.Address)
	if d.cfg.Gateway.CertSHA256 == "" {
		return fmt.Errorf("gateway.cert_sha256 is required for initial enrollment")
	}

	hostname, _ := os.Hostname()
	osInfo := fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH)
	hostIdentityID, err := loadOrCreateHostIdentity(d.cfg.HostIdentityPath)
	if err != nil {
		return err
	}

	resp, err := enrollment.Enroll(
		d.cfg.Gateway.Address,
		d.cfg.Gateway.Token,
		d.cfg.Gateway.CertSHA256,
		hostname,
		"", // nginxVersion — filled by plugin if applicable
		osInfo,
		Version,
		d.plugin.Type(),
		hostIdentityID,
	)
	if err != nil {
		return err
	}
	if resp.HostIdentityId != "" && resp.HostIdentityId != hostIdentityID {
		return fmt.Errorf("Opfield returned a conflicting host identity")
	}

	// Save credentials
	if err := d.saveCertificates(resp.CaCertificate, resp.ClientCertificate, resp.ClientKey); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}
	if enrollmentPlugin, ok := d.plugin.(EnrollmentBundlePlugin); ok {
		if err := enrollmentPlugin.PersistEnrollmentBundle(resp); err != nil {
			return fmt.Errorf("persist enrollment bundle: %w", err)
		}
	}

	d.state.SetEnrolled(resp.NodeId)
	d.state.SetCertExpiry(resp.CertExpiresAt)
	if err := d.state.Save(); err != nil {
		return fmt.Errorf("save state: %w", err)
	}

	// Clear token from config file on disk to prevent re-use
	d.cfg.Gateway.Token = ""
	if err := ClearTokenFromFile(d.cfgPath); err != nil {
		d.logger.Warn("failed to clear token from config file", "error", err)
	}
	d.logger.Info("enrolled successfully", "node_id", resp.NodeId)
	return nil
}

func (d *DaemonBase) runSessionCycle(ctx context.Context) error {
	conn, err := d.connector.ConnectWithRetry(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	return runSession(ctx, conn, d)
}

func (d *DaemonBase) saveCertificates(caCert, clientCert, clientKey []byte) error {
	return auth.SaveCredentials(
		d.cfg.TLS.CACert,
		d.cfg.TLS.ClientCert,
		d.cfg.TLS.ClientKey,
		caCert,
		clientCert,
		clientKey,
	)
}

// GetState returns the daemon's state for use by plugins.
func (d *DaemonBase) GetState() *state.State {
	return d.state
}

// exitingForUpdate is set once the daemon exits to hand over to its staged
// update: the launcher starts the next process at once.
var exitingForUpdate atomic.Bool

// ExitingForUpdate reports a daemon that exits to hand over to its staged
// update, as opposed to a stop or a restart of its unit: only then does the
// launcher start the next process at once, so a plugin may hand its live
// connections over (shared/handover).
func ExitingForUpdate() bool { return exitingForUpdate.Load() }

// PrepareShutdown lets the plugin announce the restart to its peers while
// the daemon still reaches them (RestartAnnouncerPlugin). Call it before
// cancelling the context of Run; later calls do nothing.
func (d *DaemonBase) PrepareShutdown() {
	d.prepareShutdownOnce.Do(func() {
		if !exitingForUpdate.Load() && candidateStopHandsOver() {
			// Stopped on trial, most likely for a rollback: the previous
			// daemon starts next and takes the connections over
			// (launcher_candidate_stop.go).
			d.logger.Info("update candidate stopped on trial; handing connections over to the daemon that starts next", "version", Version)
			exitingForUpdate.Store(true)
		}
		if announcer, ok := d.plugin.(RestartAnnouncerPlugin); ok {
			announcer.AnnounceRestart()
		}
	})
}
