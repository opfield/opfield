package hostnames

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/hostrename"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"gopkg.in/yaml.v3"
)

// runnerScript is the service's start wrapper (the installer writes the same).
const runnerScript = "#!/bin/sh\nset -eu\nexec /usr/local/bin/relay-supervisor run \"$@\"\n"

// Migrator moves one relay node to the Opfield names. Run it as root on a
// confirmed start.
type Migrator struct {
	Layout Layout
	// Services is the init system (nil: none, manual mode).
	Services ServiceManager
	Users    UserManager
	Logger   *slog.Logger
	// WithWorkerLocked runs fn while no worker update or identity renewal
	// replaces the worker binary or its identity (nil: runs fn).
	WithWorkerLocked func(fn func() error) error
	// SetWorkerBinary makes the supervisor start the worker from path from now
	// on (nil: nothing to tell).
	SetWorkerBinary func(path string)
	// LauncherStateDir is the state directory the launcher of this process
	// uses ("" without a launcher).
	LauncherStateDir string
}

// UserManager looks up and deletes system users.
type UserManager interface {
	UID(name string) (int, bool)
	Delete(name string) error
}

// SystemUsers is the UserManager of the node.
type SystemUsers struct{}

func (SystemUsers) UID(name string) (int, bool) {
	found, err := user.Lookup(name)
	if err != nil {
		return 0, false
	}
	uid, err := strconv.Atoi(found.Uid)
	return uid, err == nil
}

func (SystemUsers) Delete(name string) error {
	if path, err := exec.LookPath("userdel"); err == nil {
		if err := run(path, name); err != nil {
			return err
		}
		// useradd --user-group made a group of the same name; userdel removes
		// it on most systems, groupdel the rest.
		if group, err := exec.LookPath("groupdel"); err == nil {
			_ = exec.Command(group, name).Run()
		}
		return nil
	}
	if path, err := exec.LookPath("deluser"); err == nil {
		if err := run(path, name); err != nil {
			return err
		}
		if group, err := exec.LookPath("delgroup"); err == nil {
			_ = exec.Command(group, name).Run()
		}
		return nil
	}
	return errors.New("neither userdel nor deluser is available")
}

func (m *Migrator) logger() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

func (m *Migrator) withWorkerLocked(fn func() error) error {
	if m.WithWorkerLocked == nil {
		return fn()
	}
	return m.WithWorkerLocked(fn)
}

// Run moves directories, the worker binary, the configuration and the
// service to their Opfield names. It does what is missing and reports what it
// could not do; nothing it leaves undone stops the relay.
func (m *Migrator) Run() error {
	l := m.Layout
	var failures []error
	// A relay installed with the Opfield names gets no old names; one that had
	// them keeps them as links (also for a directory an interrupted move left
	// under its new name only).
	linkOld := len(m.Legacy()) > 0
	// The directories and the worker binary move while no worker update or
	// identity renewal writes into them.
	if err := m.withWorkerLocked(func() error {
		var moveFailures []error
		for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
			outcome, err := hostrename.MoveLinked(pair, linkOld)
			if err != nil {
				moveFailures = append(moveFailures, fmt.Errorf("move %s: %w", pair.Old, err))
				continue
			}
			if outcome == hostrename.Moved {
				m.logger().Info("moved a relay directory to its Opfield name", "from", pair.Old, "to", pair.New)
			}
		}
		if err := m.ensureProgramDir(); err != nil {
			moveFailures = append(moveFailures, err)
		}
		return errors.Join(moveFailures...)
	}); err != nil {
		failures = append(failures, err)
	}
	configPath := filepath.Join(hostrename.Resolve(l.Config), ConfigFileName)
	if changed, err := m.rewriteConfig(configPath); err != nil {
		failures = append(failures, fmt.Errorf("rewrite %s: %w", configPath, err))
	} else if changed {
		m.logger().Info("relay configuration uses the Opfield paths", "path", configPath)
	}
	if changed, err := lifecycle.MigrateControlConfigKey(configPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		failures = append(failures, fmt.Errorf("rename the control section of %s: %w", configPath, err))
	} else if changed {
		m.logger().Info("relay configuration names its control plane section opfield", "path", configPath)
	}
	if err := m.switchService(); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

// ensureProgramDir puts the worker binary and the service wrapper into the
// Opfield program directory. The old directory is not moved: the running
// service starts from it until it next starts under its new name, and a
// directory that went missing for an instant would leave a crashed service
// unable to start. It keeps its files until Cleanup.
func (m *Migrator) ensureProgramDir() error {
	l := m.Layout
	oldInfo, err := os.Lstat(l.Program.Old)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if oldInfo.Mode()&os.ModeSymlink != 0 {
		// The installer of an earlier run, or a machine owner, linked it.
		return nil
	}
	if err := os.MkdirAll(l.Program.New, oldInfo.Mode().Perm()); err != nil {
		return fmt.Errorf("create %s: %w", l.Program.New, err)
	}
	if stat, ok := oldInfo.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(l.Program.New, int(stat.Uid), int(stat.Gid))
	}
	runner := filepath.Join(l.Program.New, RunnerName)
	if !regularFile(runner) {
		content := []byte(runnerScript)
		if existing, err := os.ReadFile(filepath.Join(l.Program.Old, RunnerName)); err == nil {
			content = []byte(l.replaceLegacyPaths(string(existing)))
		}
		if err := atomicfile.WriteFile(runner, content, 0o755); err != nil {
			return fmt.Errorf("write %s: %w", runner, err)
		}
		if err := os.Chmod(runner, 0o755); err != nil {
			return err
		}
	}
	legacyWorker := filepath.Join(l.Program.Old, LegacyWorkerBinaryName)
	worker := filepath.Join(l.Program.New, WorkerBinaryName)
	if !regularFile(worker) && regularFile(legacyWorker) {
		if err := linkOrCopy(legacyWorker, worker); err != nil {
			return fmt.Errorf("place the relay worker binary at %s: %w", worker, err)
		}
	}
	if regularFile(worker) && m.SetWorkerBinary != nil {
		m.SetWorkerBinary(worker)
	}
	return nil
}

// linkOrCopy makes destination a hard link of source, or a copy where links
// do not work, published atomically with source's mode and owner.
func linkOrCopy(source, destination string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	temporary := destination + ".opfield-move"
	_ = os.Remove(temporary)
	if err := os.Link(source, temporary); err != nil {
		if err := copyFile(source, temporary, info.Mode().Perm()); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			_ = os.Lchown(temporary, int(stat.Uid), int(stat.Gid))
		}
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	syncDir(filepath.Dir(destination))
	return nil
}

func copyFile(source, destination string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func syncDir(path string) {
	if dir, err := os.Open(path); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}

// configPathKeys are the keys of the supervisor configuration that hold host
// paths, by section ("" for the top level).
var configPathKeys = map[string][]string{
	"":       {"state_dir", "host_identity_path"},
	"tls":    {"ca_cert", "client_cert", "client_key"},
	"worker": {"binary_path", "identity_dir", "state_dir"},
}

// rewriteConfig points the paths of the configuration at the Opfield names,
// keeping every other key, its order and comments. A path is rewritten only
// when its new name exists.
func (m *Migrator) rewriteConfig(path string) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return false, fmt.Errorf("parse config: %w", err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return false, errors.New("config file is not a YAML mapping")
	}
	root := document.Content[0]
	changed := false
	for section, keys := range configPathKeys {
		mapping := root
		if section != "" {
			mapping = mappingValue(root, section)
			if mapping == nil || mapping.Kind != yaml.MappingNode {
				continue
			}
		}
		for _, key := range keys {
			value := mappingValue(mapping, key)
			if value == nil || value.Kind != yaml.ScalarNode {
				continue
			}
			original := filepath.Clean(value.Value)
			mapped := m.Layout.mapLegacyPath(original)
			if mapped == original || !m.Layout.movedFor(original, mapped) {
				continue
			}
			value.Value = mapped
			value.Style = 0
			changed = true
		}
	}
	if !changed {
		return false, nil
	}
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return false, err
	}
	if err := encoder.Close(); err != nil {
		return false, err
	}
	if err := atomicfile.WriteFile(path, out.Bytes(), info.Mode().Perm()); err != nil {
		return false, err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(path, int(stat.Uid), int(stat.Gid))
	}
	return true, nil
}

// movedFor reports whether original (under an old name) may be written as
// mapped: the worker binary once it is in the new program directory, any
// other path once its directory moved (the file itself may not exist yet, as
// the certificates of a relay that has not enrolled).
func (l Layout) movedFor(original, mapped string) bool {
	if original == filepath.Join(l.Program.Old, LegacyWorkerBinaryName) {
		return regularFile(mapped)
	}
	for _, pair := range []hostrename.Pair{l.State, l.Config, l.Witness} {
		if pair.IsOldName(original) {
			return !hostrename.Legacy(pair) && isDir(pair.New)
		}
	}
	if l.Program.IsOldName(original) {
		_, err := os.Lstat(mapped)
		return err == nil
	}
	return false
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

// switchService installs the service under its Opfield name, enables it and
// disables the old one, without stopping or restarting anything: the running
// supervisor keeps its service until it next starts.
func (m *Migrator) switchService() error {
	if m.Services == nil {
		return nil
	}
	l := m.Layout
	switch m.Services.Kind() {
	case "systemd":
		legacyUnit := filepath.Join(l.SystemdDir, LegacyServiceName+".service")
		legacy, err := os.ReadFile(legacyUnit)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		unit := filepath.Join(l.SystemdDir, ServiceName+".service")
		if err := writeIfChanged(unit, l.withSystemdGuard(l.replaceLegacyPaths(string(legacy))), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", unit, err)
		}
		if err := l.copyDropIns(legacyUnit+".d", unit+".d"); err != nil {
			return err
		}
		if err := m.Services.Reload(); err != nil {
			return err
		}
	case "openrc":
		legacyScript := filepath.Join(l.InitDir, LegacyServiceName)
		legacy, err := os.ReadFile(legacyScript)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		script := filepath.Join(l.InitDir, ServiceName)
		if err := writeIfChanged(script, l.withOpenRCGuard(l.replaceLegacyLogs(l.replaceLegacyPaths(string(legacy)))), 0o755); err != nil {
			return fmt.Errorf("write %s: %w", script, err)
		}
		if err := m.Services.Reload(); err != nil {
			return err
		}
	default:
		return nil
	}
	// Enable the new service first: a crash before the old one is disabled
	// leaves both enabled, and the guard lets only the old one start.
	if err := m.Services.Enable(ServiceName); err != nil {
		return err
	}
	if err := m.Services.Disable(LegacyServiceName); err != nil {
		return err
	}
	m.logger().Info("relay supervisor service installed under its Opfield name; it takes over at the next start of the service", "service", ServiceName)
	return nil
}

// copyDropIns copies the administrator's drop-ins of the old unit to the new
// one, except the retired update guard.
func (l Layout) copyDropIns(from, to string) error {
	entries, err := os.ReadDir(from)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".conf") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(from, entry.Name()))
		if err != nil {
			return err
		}
		if strings.Contains(string(content), "update-guard") {
			continue
		}
		if err := os.MkdirAll(to, 0o755); err != nil {
			return err
		}
		if err := writeIfChanged(filepath.Join(to, entry.Name()), l.replaceLegacyPaths(string(content)), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func writeIfChanged(path, content string, mode os.FileMode) error {
	if current, err := os.ReadFile(path); err == nil && string(current) == content {
		return nil
	}
	if err := atomicfile.WriteFile(path, []byte(content), mode); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}
