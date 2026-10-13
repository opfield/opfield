package supervisor

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/relay-supervisor/internal/hostnames"
)

// hostNamesRetry is how long a failed move to the Opfield names waits before
// it is tried again in the same process; a restart tries at once.
var hostNamesRetry = 10 * time.Minute

// systemLayout reports whether this supervisor uses the host paths of a node
// installed by the relay installer (not a test or a custom layout).
func (p *Plugin) systemLayout() bool {
	state := filepath.Clean(p.cfg.StateDir)
	return state == hostnames.StateDir.Old || state == hostnames.StateDir.New
}

// scheduleHostNames moves the node to its Opfield host names once this start
// is confirmed (the launcher can no longer roll the supervisor back). Only a
// root supervisor can: the directories, the service and the witness user
// belong to root; a supervisor running as its own user moves when the
// installer runs again.
func (p *Plugin) scheduleHostNames() {
	if os.Geteuid() != 0 || !p.systemLayout() {
		return
	}
	lifecycle.OnStartConfirmed(p.runHostNames)
}

func (p *Plugin) hostNamesMigrator() *hostnames.Migrator {
	return &hostnames.Migrator{
		Layout:           hostnames.System,
		Services:         hostnames.DetectServices(),
		Users:            hostnames.SystemUsers{},
		Logger:           p.logger,
		WithWorkerLocked: p.worker.withUpdateLock,
		SetWorkerBinary: func(path string) {
			p.worker.setBinaryPath(path)
			p.cfg.Worker.BinaryPath = path
		},
		LauncherStateDir: launcherStateDir(),
	}
}

func (p *Plugin) runHostNames() {
	for attempt := 1; ; attempt++ {
		migrator := p.hostNamesMigrator()
		err := migrator.Run()
		if err == nil {
			cleanupErr := migrator.Cleanup()
			switch {
			case cleanupErr == nil:
			case errors.Is(cleanupErr, hostnames.ErrLegacyInUse):
				// The processes started before the move keep the old names
				// until the service next starts.
				p.logger.Info("relay host keeps its pre-Opfield names until the next start of the service", "reason", cleanupErr.Error())
			default:
				p.logger.Warn("removing the pre-Opfield relay host names failed; the next start tries again", "error", cleanupErr)
			}
			return
		}
		p.logger.Warn("moving the relay host to its Opfield names failed; the relay keeps running under the names it has", "error", err, "attempt", attempt)
		if attempt >= 3 {
			return
		}
		time.Sleep(hostNamesRetry)
	}
}

// reportLegacyHostNames adds what this node still has under its pre-Opfield
// names to the health report.
func (p *Plugin) reportLegacyHostNames(report *pb.HealthReport) {
	if report == nil || !p.systemLayout() {
		return
	}
	migrator := &hostnames.Migrator{Layout: hostnames.System, Users: hostnames.SystemUsers{}}
	for kind, count := range migrator.Legacy() {
		lifecycle.AddLegacyNames(report, kind, count)
	}
}

// launcherStateDir is the state directory the launcher of this process uses.
func launcherStateDir() string {
	if value := os.Getenv(lifecycle.LauncherStateDirEnv); value != "" {
		return value
	}
	// legacy-name: GATEWAY_DAEMON_LAUNCHER_STATE_DIR set by a pre-Opfield launcher — remove once every node reports none
	return os.Getenv("GATEWAY_DAEMON_LAUNCHER_STATE_DIR")
}
