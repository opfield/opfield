package hostnames

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// ErrLegacyInUse is returned by Cleanup while a process, a service or the
// configuration still uses an old name; the next confirmed start tries again.
var ErrLegacyInUse = errors.New("old relay host names are still in use")

// Cleanup removes what is left of the old names once nothing uses them: the
// old service, the symlinks of the moved directories, the old program
// directory, the old witness user and the old OpenRC logs. It changes nothing
// while Run has not finished or any process still runs with an old path (the
// launcher, the worker or a witness started before the move, the old service).
func (m *Migrator) Cleanup() error {
	l := m.Layout
	if reason := m.legacyInUse(); reason != "" {
		return fmt.Errorf("%w: %s", ErrLegacyInUse, reason)
	}
	var failures []error
	if err := m.retireLegacyService(); err != nil {
		failures = append(failures, err)
	}
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
		if err := removeLegacyLink(pair); err != nil {
			failures = append(failures, err)
		}
	}
	if err := l.removeLegacyProgramDir(); err != nil {
		failures = append(failures, err)
	}
	if err := m.removeLegacyWitnessUser(); err != nil {
		failures = append(failures, err)
	}
	if len(failures) == 0 && m.Legacy().Total() == 0 {
		m.logger().Info("relay host uses only its Opfield names")
	}
	return errors.Join(failures...)
}

// legacyInUse names what still uses an old name ("" when nothing does).
func (m *Migrator) legacyInUse() string {
	l := m.Layout
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
		if hostrename.Legacy(pair) {
			return pair.Old + " has not moved"
		}
	}
	if legacy := filepath.Join(l.Program.Old, LegacyWorkerBinaryName); regularFile(legacy) && !regularFile(filepath.Join(l.Program.New, WorkerBinaryName)) {
		return "the relay worker binary has not moved"
	}
	if m.LauncherStateDir != "" && l.State.IsOldName(m.LauncherStateDir) {
		return "the launcher runs with " + m.LauncherStateDir
	}
	if m.Services != nil && m.Services.Active(LegacyServiceName) {
		return "the " + LegacyServiceName + " service runs"
	}
	configPath := filepath.Join(hostrename.Resolve(l.Config), ConfigFileName)
	if data, err := os.ReadFile(configPath); err == nil {
		for _, prefix := range l.legacyPrefixes() {
			if containsPath(string(data), prefix) {
				return configPath + " names " + prefix
			}
		}
	}
	if pid, prefix := l.processUsingLegacyPath(); pid != 0 {
		return fmt.Sprintf("process %d uses %s", pid, prefix)
	}
	return ""
}

func containsPath(text, prefix string) bool {
	return replacePathPrefix(text, prefix, "\x00") != text
}

// processUsingLegacyPath finds a process whose command line or environment
// names an old path.
func (l Layout) processUsingLegacyPath() (int, string) {
	entries, err := os.ReadDir(l.ProcDir)
	if err != nil {
		return 0, ""
	}
	prefixes := l.legacyPrefixes()
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		for _, name := range []string{"cmdline", "environ"} {
			data, err := os.ReadFile(filepath.Join(l.ProcDir, entry.Name(), name))
			if err != nil {
				continue
			}
			text := string(bytes.ReplaceAll(data, []byte{0}, []byte{'\n'}))
			for _, prefix := range prefixes {
				if containsPath(text, prefix) {
					return pid, prefix
				}
			}
		}
	}
	return 0, ""
}

// processOfUID reports whether a process runs with uid (real or effective).
func (l Layout) processOfUID(uid int) bool {
	entries, err := os.ReadDir(l.ProcDir)
	if err != nil {
		return true // cannot tell: assume one does
	}
	want := strconv.Itoa(uid)
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(l.ProcDir, entry.Name(), "status"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if fields := strings.Fields(line); len(fields) >= 3 && fields[0] == "Uid:" && (fields[1] == want || fields[2] == want) {
				return true
			}
		}
	}
	return false
}

// retireLegacyService removes the old unit or init script (the running
// service is the Opfield one now) and the guard of the new one.
func (m *Migrator) retireLegacyService() error {
	if m.Services == nil {
		return nil
	}
	l := m.Layout
	switch m.Services.Kind() {
	case "systemd":
		legacyUnit := filepath.Join(l.SystemdDir, LegacyServiceName+".service")
		unit := filepath.Join(l.SystemdDir, ServiceName+".service")
		changed := false
		if _, err := os.Lstat(legacyUnit); err == nil {
			if !regularFile(unit) {
				return nil // never switched: nothing to retire
			}
			if err := m.Services.Disable(LegacyServiceName); err != nil {
				return err
			}
			if err := os.Remove(legacyUnit); err != nil {
				return err
			}
			if err := os.RemoveAll(legacyUnit + ".d"); err != nil {
				return err
			}
			changed = true
		}
		if content, err := os.ReadFile(unit); err == nil {
			if stripped := l.withoutSystemdGuard(string(content)); stripped != string(content) {
				if err := writeIfChanged(unit, stripped, 0o644); err != nil {
					return err
				}
				changed = true
			}
		}
		if changed {
			m.logger().Info("removed the pre-Opfield relay supervisor unit", "unit", LegacyServiceName)
			return m.Services.Reload()
		}
	case "openrc":
		legacyScript := filepath.Join(l.InitDir, LegacyServiceName)
		script := filepath.Join(l.InitDir, ServiceName)
		if _, err := os.Lstat(legacyScript); err == nil {
			if !regularFile(script) {
				return nil
			}
			if err := m.Services.Disable(LegacyServiceName); err != nil {
				return err
			}
			if err := os.Remove(legacyScript); err != nil {
				return err
			}
			m.logger().Info("removed the pre-Opfield relay supervisor service", "service", LegacyServiceName)
			if err := m.Services.Reload(); err != nil {
				return err
			}
		}
		if content, err := os.ReadFile(script); err == nil {
			if stripped := l.withoutOpenRCGuard(string(content)); stripped != string(content) {
				if err := writeIfChanged(script, stripped, 0o755); err != nil {
					return err
				}
				if err := m.Services.Reload(); err != nil {
					return err
				}
			}
		}
		for _, suffix := range []string{"log", "err"} {
			legacy := filepath.Join(l.LogDir, LegacyServiceName+"."+suffix)
			if _, err := os.Lstat(legacy); err != nil {
				continue
			}
			// The old service's log is kept as the previous log of the new one.
			previous := filepath.Join(l.LogDir, ServiceName+"."+suffix+".1")
			if _, err := os.Lstat(previous); err == nil {
				continue
			}
			if err := os.Rename(legacy, previous); err != nil {
				return err
			}
		}
	}
	return nil
}

// removeLegacyLink removes the old name of a moved directory once it is only
// a link to the new one.
func removeLegacyLink(pair hostrename.Pair) error {
	info, err := os.Lstat(pair.Old)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return nil
	}
	oldInfo, err := os.Stat(pair.Old)
	if err != nil {
		return nil
	}
	newInfo, err := os.Stat(pair.New)
	if err != nil || !os.SameFile(oldInfo, newInfo) {
		return nil
	}
	return os.Remove(pair.Old)
}

// removeLegacyProgramDir removes the files the old program directory held
// (the service wrapper and the worker binary, now in the new one) and the
// directory when that left it empty. Files of anyone else stay.
func (l Layout) removeLegacyProgramDir() error {
	info, err := os.Lstat(l.Program.Old)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		if target, err := os.Stat(l.Program.Old); err == nil {
			if current, err := os.Stat(l.Program.New); err == nil && os.SameFile(target, current) {
				return os.Remove(l.Program.Old)
			}
		}
		return nil
	}
	if !regularFile(filepath.Join(l.Program.New, RunnerName)) || !regularFile(filepath.Join(l.Program.New, WorkerBinaryName)) {
		return nil
	}
	entries, err := os.ReadDir(l.Program.Old)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == RunnerName || name == LegacyWorkerBinaryName || strings.HasPrefix(name, LegacyWorkerBinaryName+".") {
			if entry.Type().IsRegular() {
				if err := os.Remove(filepath.Join(l.Program.Old, name)); err != nil {
					return err
				}
			}
		}
	}
	if err := os.Remove(l.Program.Old); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Not empty: something else lives there; leave it.
		return nil
	}
	return nil
}

// removeLegacyWitnessUser deletes the old witness user once no process runs
// as it (witnesses start as the Opfield user after the move).
func (m *Migrator) removeLegacyWitnessUser() error {
	if m.Users == nil {
		return nil
	}
	uid, ok := m.Users.UID(LegacyWitnessUser)
	if !ok || uid == 0 {
		return nil
	}
	if m.Layout.processOfUID(uid) {
		return nil
	}
	if err := m.Users.Delete(LegacyWitnessUser); err != nil {
		return fmt.Errorf("delete the user %s: %w", LegacyWitnessUser, err)
	}
	m.logger().Info("deleted the pre-Opfield witness user", "user", LegacyWitnessUser)
	return nil
}

// LegacyCount is what a node still has under its old names, by kind (for
// the daemon's legacy name report).
type LegacyCount map[string]uint32

func (c LegacyCount) Total() uint32 {
	var total uint32
	for _, count := range c {
		total += count
	}
	return total
}

// Legacy counts what is left under the old names.
func (m *Migrator) Legacy() LegacyCount {
	l := m.Layout
	count := LegacyCount{}
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
		if _, err := os.Lstat(pair.Old); err == nil {
			count["paths"]++
		}
	}
	if _, err := os.Lstat(l.Program.Old); err == nil {
		count["paths"]++
	}
	for _, path := range []string{filepath.Join(l.SystemdDir, LegacyServiceName+".service"), filepath.Join(l.InitDir, LegacyServiceName)} {
		if _, err := os.Lstat(path); err == nil {
			count["services"]++
		}
	}
	if m.Users != nil {
		if _, ok := m.Users.UID(LegacyWitnessUser); ok {
			count["users"]++
		}
	}
	for kind, value := range count {
		if value == 0 {
			delete(count, kind)
		}
	}
	return count
}
