// Package hostnames moves a relay node from its pre-Opfield host names
// (state, config and program directories, the supervisor service and the
// witness user; see legacycompat) to its Opfield names.
//
// The move runs on a confirmed start only (lifecycle.OnStartConfirmed): the
// launcher can no longer roll the supervisor back to a release that knows only
// the old names. It never restarts the service and never stops the worker, so
// the streams of the relay are not touched:
//   - directories move under their new name and the old name stays a symlink
//     to it, for the processes started before the move (the launcher, the
//     worker, running witnesses, the old service unit), which keep their old
//     paths in memory;
//   - the worker binary and the service wrapper are linked into the new
//     program directory; the old one keeps its files until nothing uses it;
//   - the new service is installed and enabled and the old one disabled, but
//     the running service keeps its old name until it next starts (a reboot,
//     or a restart by the machine owner).
//
// On a later confirmed start that runs entirely under the new names, Cleanup
// removes what is left of the old ones: the symlinks, the old program
// directory, the old service and the old witness user.
//
// Every step looks at what is on disk and does only what is missing, so a crash
// or reboot at any point is finished by the next confirmed start.
package hostnames

import (
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"strings"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// Directory pairs of a relay node.
var (
	StateDir   = hostrename.Pair{Old: legacycompat.StateRoot + "-relay-supervisor", New: "/var/lib/opfield-relay"}
	ConfigDir  = hostrename.Pair{Old: "/etc/" + legacycompat.RelaySupervisorName, New: "/etc/opfield-relay"}
	ProgramDir = hostrename.Pair{Old: "/usr/local/lib/" + legacycompat.RelayProgramName, New: "/usr/local/lib/opfield-relay"}
	WitnessDir = hostrename.Pair{Old: legacycompat.StateRoot + "-relay-witness", New: "/var/lib/opfield-relay-witness"}
)

const (
	ConfigFileName = "config.yaml"

	// ServiceName is the systemd unit (.service) and OpenRC service.
	ServiceName = "opfield-relay-supervisor"
	// legacy-name: legacycompat.RelaySupervisorName service — remove once every node reports none
	LegacyServiceName = legacycompat.RelaySupervisorName

	// WorkerBinaryName is the relay worker binary in ProgramDir.
	WorkerBinaryName = "opfield-relay"
	// legacy-name: legacycompat.RelayProgramName worker binary — remove once every node reports none
	LegacyWorkerBinaryName = legacycompat.RelayProgramName
	// RunnerName is the service's start wrapper in ProgramDir.
	RunnerName = "run-supervisor"

	// WitnessUser runs the witnesses of a root supervisor.
	WitnessUser = "opfield-witness"
	// legacy-name: legacycompat.WitnessUser user — remove once every node reports none
	LegacyWitnessUser = legacycompat.WitnessUser

	// LogDir holds the OpenRC service logs.
	LogDir = "/var/log"
)

// Layout is where a node keeps the paths this package handles. System is the
// real one; tests use one under a temporary root.
type Layout struct {
	State, Config, Program, Witness          hostrename.Pair
	SystemdDir, InitDir, RunlevelDir, LogDir string
	ProcDir                                  string
}

// System is the layout of a real relay node.
var System = Layout{
	State: StateDir, Config: ConfigDir, Program: ProgramDir, Witness: WitnessDir,
	SystemdDir: "/etc/systemd/system", InitDir: "/etc/init.d", RunlevelDir: "/etc/runlevels/default", LogDir: LogDir,
	ProcDir: "/proc",
}

// Under returns l with every path under root (for tests).
func (l Layout) Under(root string) Layout {
	pair := func(p hostrename.Pair) hostrename.Pair {
		return hostrename.Pair{Old: filepath.Join(root, p.Old), New: filepath.Join(root, p.New)}
	}
	return Layout{
		State: pair(l.State), Config: pair(l.Config), Program: pair(l.Program), Witness: pair(l.Witness),
		SystemdDir: filepath.Join(root, l.SystemdDir), InitDir: filepath.Join(root, l.InitDir),
		RunlevelDir: filepath.Join(root, l.RunlevelDir), LogDir: filepath.Join(root, l.LogDir),
		ProcDir: filepath.Join(root, l.ProcDir),
	}
}

// DefaultStateDir is the state directory of the supervisor now: the old one
// until it moved.
func DefaultStateDir() string { return hostrename.Resolve(StateDir) }

// DefaultConfigPath is the configuration file of the supervisor now.
func DefaultConfigPath() string { return ConfigDir.Join(ConfigFileName) }

// DefaultWorkerBinary is the relay worker binary of a configuration that names
// none: the Opfield one once it exists.
func DefaultWorkerBinary() string {
	return System.workerBinary()
}

func (l Layout) workerBinary() string {
	current := filepath.Join(l.Program.New, WorkerBinaryName)
	if regularFile(current) {
		return current
	}
	// legacy-name: /usr/local/lib/legacycompat.RelayProgramName/legacycompat.RelayProgramName until the program directory moved — remove once every node reports none
	if legacy := filepath.Join(l.Program.Old, LegacyWorkerBinaryName); regularFile(legacy) {
		return legacy
	}
	return current
}

// WitnessIdentity is the directory and user a root supervisor runs witnesses
// with: the Opfield ones once the witness directory moved (or never existed),
// else the old ones, which the running witnesses already use.
func WitnessIdentity() (root, user string) { return System.witnessIdentity() }

func (l Layout) witnessIdentity() (root, user string) {
	root = hostrename.Resolve(l.Witness)
	if root == l.Witness.Old {
		return root, LegacyWitnessUser
	}
	return root, WitnessUser
}

// WitnessScopeNames is the systemd scope of a witness under its Opfield name,
// then under the name an older supervisor started it with.
func WitnessScopeNames(id string) []string {
	if len(id) > 32 {
		id = id[:32]
	}
	return []string{
		WitnessUser + "-" + id + ".scope",
		// legacy-name: legacycompat.WitnessUser-<id>.scope of witnesses an older supervisor started — remove once every node reports none
		LegacyWitnessUser + "-" + id + ".scope",
	}
}

// RepairInterrupted finishes a directory move a crash interrupted between its
// two renames (the old name a dangling link, the directory under a staging
// name). It runs at every start, before anything resolves a path: such a state
// would resolve to a new directory that does not exist yet. Nothing else moves
// here before the start is confirmed.
func RepairInterrupted() error {
	return System.repairInterrupted()
}

func (l Layout) repairInterrupted() error {
	var failures []error
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
		info, err := os.Lstat(pair.Old)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		if _, err := os.Stat(pair.Old); err == nil {
			continue
		}
		if _, err := os.Lstat(pair.New); !errors.Is(err, os.ErrNotExist) {
			continue
		}
		if _, err := hostrename.Move(pair); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// mapLegacyPath maps a path under an old name to its Opfield name; the worker
// binary also gets its new file name.
func (l Layout) mapLegacyPath(path string) string {
	if path == filepath.Join(l.Program.Old, LegacyWorkerBinaryName) {
		return filepath.Join(l.Program.New, WorkerBinaryName)
	}
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Program, l.Witness} {
		if pair.IsOldName(path) {
			return pair.ToNew(path)
		}
	}
	return path
}

// legacyPrefixes are the old names a process may still use.
func (l Layout) legacyPrefixes() []string {
	return []string{l.State.Old, l.Config.Old, l.Program.Old, l.Witness.Old}
}

// replaceLegacyPaths rewrites every old name in text (a service unit, an
// init script) to its Opfield name.
func (l Layout) replaceLegacyPaths(text string) string {
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Program, l.Witness} {
		text = replacePathPrefix(text, pair.Old, pair.New)
	}
	return text
}

// replacePathPrefix replaces old where it is a whole path or a path prefix
// (followed by '/', a quote, whitespace or the end), never inside a longer name.
func replacePathPrefix(text, old, replacement string) string {
	var out strings.Builder
	for {
		index := strings.Index(text, old)
		if index < 0 {
			out.WriteString(text)
			return out.String()
		}
		end := index + len(old)
		boundary := end == len(text) || strings.ContainsRune("/\"' \t\n:", rune(text[end]))
		out.WriteString(text[:index])
		if boundary {
			out.WriteString(replacement)
		} else {
			out.WriteString(old)
		}
		text = text[end:]
	}
}
