package lifecycle

import (
	"context"
	"errors"
	"log/slog"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
	"google.golang.org/grpc"
)

// FatalError is returned when the daemon must exit and NOT retry.
type FatalError struct {
	Message string
}

func (e *FatalError) Error() string {
	return e.Message
}

// RestartRequestedError is returned when the daemon should exit immediately
// so its supervisor can restart it (e.g. after a successful self-update).
type RestartRequestedError struct {
	Message string
	// serviceRestart, when set, restarts the whole service for the update
	// (launcher_service_restart.go).
	serviceRestart *launcherServiceRestart
	// serviceStopped: the service manager stopped the daemon for that
	// restart, so the daemon exits 0 (a planned stop, not a failure).
	serviceStopped bool
}

func (e *RestartRequestedError) Error() string {
	return e.Message
}

// DaemonExitCode maps the intentional self-update handoff to a dedicated code
// while preserving the ordinary non-zero failure contract for every other
// daemon error.
func DaemonExitCode(err error) int {
	var restart *RestartRequestedError
	if errors.As(err, &restart) {
		if restart.serviceStopped {
			// The whole service restarts for the update: the stopping launcher
			// passes this status on as its own, and only 0 (or a signal) keeps
			// the planned restart from being recorded as a failure of the unit.
			return 0
		}
		return LauncherUpdateExitCode
	}
	return 1
}

// RestartRequested reports whether err is the intentional exit for a restart
// (a staged self-update): a normal exit, not a failure.
func RestartRequested(err error) bool {
	var restart *RestartRequestedError
	return errors.As(err, &restart)
}

// LogDaemonExit logs why Run returned: at info for a requested restart (a
// staged self-update is a normal exit), at error for anything else.
func LogDaemonExit(logger *slog.Logger, message string, err error) {
	if RestartRequested(err) {
		logger.Info("daemon exiting for its supervisor to restart it", "reason", err.Error())
		return
	}
	logger.Error(message, "error", err)
}

// DaemonPlugin defines the interface that daemon-specific logic must implement.
// The lifecycle manager calls these methods at appropriate points in the
// enrollment, connection, and session lifecycle.
type DaemonPlugin interface {
	// Type returns the daemon type string (e.g., "nginx", "monitoring").
	Type() string

	// Init is called once at startup to initialize plugin-specific resources.
	Init(cfg *BaseConfig, logger *slog.Logger) error

	// BuildRegisterMessage constructs the registration message sent to the
	// Opfield when a new session begins.
	BuildRegisterMessage(nodeID string) *pb.RegisterMessage

	// HandleCommand processes an Opfield command and returns a result.
	HandleCommand(cmd *pb.OpfieldCommand) *pb.CommandResult

	// CollectHealth enriches a base health report with plugin-specific metrics.
	// The base report already contains system-level metrics.
	CollectHealth(base *pb.HealthReport) *pb.HealthReport

	// CollectStats returns plugin-specific statistics, or nil if not applicable.
	CollectStats() *pb.StatsReport

	// OnSessionStart is called when a new gRPC session is established.
	// Plugins can use this to start background tasks tied to the session.
	// The writer allows plugins to send asynchronous messages (e.g. exec output).
	OnSessionStart(ctx context.Context, writer *stream.Writer) error

	// OnSessionEnd is called when a gRPC session ends (before reconnect).
	// Plugins should clean up session-specific resources.
	OnSessionEnd()

	// SetLogger replaces the plugin's logger (called when session logger is created).
	SetLogger(logger *slog.Logger)
}

// EnrollmentBundlePlugin receives daemon-type-specific material carried by the
// System-CA-authenticated enrollment response before the daemon is marked
// enrolled. Relay supervisors use it to atomically pin policy trust and stage
// the worker server identity.
type EnrollmentBundlePlugin interface {
	PersistEnrollmentBundle(response *pb.EnrollResponse) error
}

// RegistrationRefreshPlugin is implemented by plugins whose registration
// capabilities can change while the process runs (for example once a lease
// watchdog becomes available): a signal reconnects the control session so
// Opfield receives a fresh RegisterMessage.
type RegistrationRefreshPlugin interface {
	RegistrationChanged() <-chan struct{}
}

// OpfieldContactPlugin is implemented by plugins that track when Opfield last reached the daemon: every command
// received on the control stream (Opfield asks the nodes of manual availability pairs for a report every few
// seconds) is a contact; a manual pair's primary self-fences when it had none for its bound.
type OpfieldContactPlugin interface {
	NoteOpfieldContact()
}

// HealthRefreshPlugin is implemented by plugins whose health report can change between the periodic reports in a
// way Opfield should see at once (a container that exited on its own): each signal sends a report now.
type HealthRefreshPlugin interface {
	HealthRefreshRequested() <-chan struct{}
}

// RestartAnnouncerPlugin is implemented by plugins that tell their peers the
// daemon is about to restart, while it can still reach them (B-13): the
// relays then hold the daemon's traffic for its next process instead of
// treating it as gone. It runs once, before the context of Run is cancelled
// or Run returns to hand over to an update.
type RestartAnnouncerPlugin interface {
	AnnounceRestart()
}

type ShutdownPlugin interface {
	Shutdown()
}

// LogStreamPlugin is implemented by plugins that maintain a separate
// bidirectional log stream beside the command stream.
type LogStreamPlugin interface {
	RunLogStream(ctx context.Context, conn *grpc.ClientConn)
}

// MigrationStreamPlugin is implemented by Docker plugins that maintain the
// separately authenticated migration artifact stream.
type MigrationStreamPlugin interface {
	RunMigrationStream(ctx context.Context, conn *grpc.ClientConn, nodeID string)
}

// RelayTunnelPlugin is implemented by daemons that consume generic, signed
// relay assignments using their process-lifetime mTLS connection.
type RelayTunnelPlugin interface {
	RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, nodeID string)
	SyncRelayGrants(command *pb.SyncRelayGrantsCommand) (detail string, err error)
}

// RelayTunnelRuntimePlugin allows a source daemon to resize its physical
// HTTP/2 lane pool from persisted Opfield settings without an environment
// variable or process restart.
type RelayTunnelRuntimePlugin interface {
	RelayTunnelLaneCount() int
	RelayTunnelRuntimeChanged() <-chan struct{}
}

type RelayTunnelTarget struct {
	ID                     string
	Addresses              []string
	CertificateIdentity    string
	CertificateFingerprint string
}

// RelayPoolTunnelPlugin separates the canonical Opfield control target from
// the relay instances used for payload lanes. Targets are complete desired
// state and every configured lane is opened independently per target.
type RelayPoolTunnelPlugin interface {
	RelayTunnelPlugin
	RelayTunnelRuntimePlugin
	RelayTunnelTargets() []RelayTunnelTarget
	RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, nodeID, relayInstanceID string)
}

// RelayLaneDialerPlugin is told, before RunRelayTargetTunnels runs a lane, the lane's position among its relay
// target's lanes (0 first) and how to dial another connection like it (the same relay, address and identity), to
// replace the lane's connection while it runs.
type RelayLaneDialerPlugin interface {
	RelayLaneDialer(conn *grpc.ClientConn, index int, dial func(context.Context) (*grpc.ClientConn, error))
}

type RelayCandidateProbePlugin interface {
	ProbeRelayCandidate(command *pb.ProbeRelayCandidateCommand) (detail string, err error)
}

// ProxySecureLinkPlugin is implemented by nginx and general Docker daemons.
// The command is a complete desired-state snapshot, so reconnects and daemon
// restarts can reconcile listeners and connector bindings idempotently.
type ProxySecureLinkPlugin interface {
	SyncProxySecureLinks(command *pb.SyncProxySecureLinksCommand) (detail string, err error)
}

// ProxySecureLinkProbePlugin is implemented only by nginx-daemon, which owns
// the loopback source listener used for full-path HTTP health probes.
type ProxySecureLinkProbePlugin interface {
	ProbeProxySecureLink(command *pb.ProbeProxySecureLinkCommand) (detail string, err error)
}

// PagesRouteProbePlugin is implemented only by nginx-daemon. It probes the
// managed Route through node-local nginx using the real HTTP Host and TLS SNI.
type PagesRouteProbePlugin interface {
	ProbePagesRoute(command *pb.ProbePagesRouteCommand) (detail string, err error)
}
