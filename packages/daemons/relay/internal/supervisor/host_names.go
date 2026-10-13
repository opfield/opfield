package supervisor

import (
	"errors"
	"log/slog"
	"maps"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
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
	if !p.systemLayout() {
		return
	}
	if os.Geteuid() != 0 {
		lifecycle.OnStartConfirmed(func() {
			migrator := &hostnames.Migrator{Layout: hostnames.System, Users: hostnames.SystemUsers{}}
			warnHostNamesNeedInstaller(p.logger, migrator.Legacy(), currentUserName())
		})
		return
	}
	lifecycle.OnStartConfirmed(p.runHostNames)
}

// warnHostNamesNeedInstaller tells the owner of a relay that runs as its own
// user, and so cannot move its root-owned directories and service, how it gets
// its Opfield names; the health report lists what is left (legacy names).
func warnHostNamesNeedInstaller(logger *slog.Logger, legacy hostnames.LegacyCount, runUser string) {
	if len(legacy) == 0 || logger == nil {
		return
	}
	attrs := []any{"run_user", runUser}
	var left []string
	var total uint32
	for _, kind := range slices.Sorted(maps.Keys(legacy)) {
		attrs = append(attrs, kind, legacy[kind])
		total += legacy[kind]
		left = append(left, legacyKindName(kind, legacy[kind]))
	}
	them := "them"
	if total == 1 {
		them = "it"
	}
	logger.Warn("relay host keeps its pre-Opfield "+joinWords(left)+": a relay running as its own user cannot move "+them+"; "+
		"run the relay installer of this release again as root with OPFIELD_RELAY_RUN_USER="+runUser+" (it keeps the enrollment)", attrs...)
}

// legacyKindName names a kind of what is left under the old names (R-4: the
// warning names only the kinds that are left).
func legacyKindName(kind string, count uint32) string {
	switch kind {
	case "paths":
		if count == 1 {
			return "path"
		}
		return "paths"
	case "services":
		if count == 1 {
			return "service"
		}
		return "services"
	case "users":
		return "witness user"
	}
	return kind
}

func joinWords(words []string) string {
	if len(words) <= 1 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}

func currentUserName() string {
	if found, err := user.Current(); err == nil && found.Username != "" {
		return found.Username
	}
	return strconv.Itoa(os.Geteuid())
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
