package leasewatchdog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ServiceHost is what MigrateLegacyService works on; tests point it elsewhere.
type ServiceHost struct {
	Systemd bool
	OpenRC  bool
	// Root prefixes every host path (empty on a real host).
	Root string
	// Run runs a service manager command and waits for it.
	Run func(ctx context.Context, name string, args ...string) error
	// Detach starts a shell script that outlives this process and the service
	// it runs in: the step that stops the old service stops this process.
	Detach func(script string) error
	// UnderLegacyService reports whether this process runs as the old service.
	UnderLegacyService func() bool
}

func (h ServiceHost) path(path string) string { return filepath.Join(h.Root, path) }

// MigrationResult is what MigrateLegacyService did.
type MigrationResult int

const (
	// NothingToMigrate: no pre-Opfield service is installed.
	NothingToMigrate MigrationResult = iota
	// SwitchingOver: the new service is installed and enabled, and a detached
	// step stops this process's old service, removes it and starts the new
	// one. The caller keeps enforcing until it is stopped.
	SwitchingOver
	// RemovedLegacy: this process already runs as the new service; the old
	// service left over was stopped and removed.
	RemovedLegacy
)

// MigrateLegacyService moves an installed pre-Opfield watchdog service to the
// Opfield one: it copies executable to BinaryPath, writes and enables the new
// service with the arguments of the old one, then stops, disables and removes
// the old service and starts the new one. Every step is idempotent, and the
// order keeps a node that crashes or reboots in between with exactly one
// enabled service that can start: the new one is enabled before the old one is
// removed, and does not start while the old one is installed.
func MigrateLegacyService(ctx context.Context, host ServiceHost, executable string, fallbackArgs string) (MigrationResult, error) {
	switch {
	case host.Systemd:
		return migrateSystemd(ctx, host, executable, fallbackArgs)
	case host.OpenRC:
		return migrateOpenRC(ctx, host, executable, fallbackArgs)
	default:
		return NothingToMigrate, nil
	}
}

func migrateSystemd(ctx context.Context, host ServiceHost, executable, fallbackArgs string) (MigrationResult, error) {
	legacyUnit := host.path(LegacySystemdUnitPath)
	content, err := os.ReadFile(legacyUnit)
	if errors.Is(err, os.ErrNotExist) {
		return NothingToMigrate, removeLegacyBinary(host, executable)
	}
	if err != nil {
		return NothingToMigrate, err
	}
	args := serviceArgs(string(content), "ExecStart="+LegacyBinaryPath+" ", "", fallbackArgs)
	if err := installBinary(executable, host.path(BinaryPath)); err != nil {
		return NothingToMigrate, err
	}
	if err := writeIfChanged(host.path(SystemdUnitPath), SystemdUnit(BinaryPath, args), 0o644); err != nil {
		return NothingToMigrate, err
	}
	for _, command := range [][]string{{"daemon-reload"}, {"enable", "--quiet", UnitName + ".service"}} {
		if err := host.Run(ctx, "systemctl", command...); err != nil {
			return NothingToMigrate, fmt.Errorf("systemctl %s: %w", strings.Join(command, " "), err)
		}
	}
	// The old unit file goes before its enablement links: while it exists it
	// blocks the new unit's guard, so a crash between a disable and the rm
	// would leave no watchdog that starts at boot.
	steps := []string{
		"systemctl stop " + LegacyUnitName + ".service",
		"rm -f " + shellQuote(LegacySystemdUnitPath),
		"rm -f " + legacySystemdWantsGlob,
		"systemctl daemon-reload",
		"systemctl start " + UnitName + ".service",
		"rm -f " + shellQuote(LegacyBinaryPath),
		legacyBackupStep,
	}
	if host.UnderLegacyService() {
		// Outside the old unit's cgroup (systemd-run in Detach), or stopping
		// the old unit would end the step with it.
		if err := host.Detach(strings.Join(steps, "; ")); err != nil {
			return NothingToMigrate, err
		}
		return SwitchingOver, nil
	}
	_ = host.Run(ctx, "systemctl", "stop", LegacyUnitName+".service")
	if err := os.Remove(legacyUnit); err != nil && !errors.Is(err, os.ErrNotExist) {
		return NothingToMigrate, err
	}
	if err := removeMatching(host.path(legacySystemdWantsGlob)); err != nil {
		return NothingToMigrate, err
	}
	if err := host.Run(ctx, "systemctl", "daemon-reload"); err != nil {
		return NothingToMigrate, err
	}
	return RemovedLegacy, removeLegacyBinary(host, executable)
}

func migrateOpenRC(ctx context.Context, host ServiceHost, executable, fallbackArgs string) (MigrationResult, error) {
	legacyScript := host.path(LegacyOpenRCPath)
	content, err := os.ReadFile(legacyScript)
	if errors.Is(err, os.ErrNotExist) {
		return NothingToMigrate, removeLegacyBinary(host, executable)
	}
	if err != nil {
		return NothingToMigrate, err
	}
	args := serviceArgs(string(content), `command_args="`, `"`, fallbackArgs)
	if err := installBinary(executable, host.path(BinaryPath)); err != nil {
		return NothingToMigrate, err
	}
	if err := writeIfChanged(host.path(OpenRCPath), OpenRCScript(BinaryPath, args), 0o755); err != nil {
		return NothingToMigrate, err
	}
	if _, err := os.Lstat(host.path(filepath.Join("/etc/runlevels/default", UnitName))); err != nil {
		if err := host.Run(ctx, "rc-update", "add", UnitName, "default"); err != nil {
			return NothingToMigrate, fmt.Errorf("rc-update add %s: %w", UnitName, err)
		}
	}
	// OpenRC compares the dependency cache with the scripts' mtimes in whole
	// seconds: a cache built in the second the script was written misses it at
	// the next boot. Rebuild it now that the script is there.
	if err := host.Run(ctx, "rc-update", "-u"); err != nil {
		return NothingToMigrate, fmt.Errorf("rc-update -u: %w", err)
	}
	// The script goes before its runlevel links, as in migrateSystemd.
	steps := []string{
		"rc-service " + LegacyUnitName + " stop",
		"rm -f " + shellQuote(LegacyOpenRCPath),
		"rm -f " + legacyOpenRCRunlevelGlob,
		"rc-update -u",
		"rc-service " + UnitName + " start",
		"rm -f " + shellQuote(LegacyBinaryPath),
		legacyBackupStep,
	}
	if host.UnderLegacyService() {
		if err := host.Detach(strings.Join(steps, "; ")); err != nil {
			return NothingToMigrate, err
		}
		return SwitchingOver, nil
	}
	_ = host.Run(ctx, "rc-service", "--ifstarted", LegacyUnitName, "stop")
	if err := os.Remove(legacyScript); err != nil && !errors.Is(err, os.ErrNotExist) {
		return NothingToMigrate, err
	}
	if err := removeMatching(host.path(legacyOpenRCRunlevelGlob)); err != nil {
		return NothingToMigrate, err
	}
	if err := host.Run(ctx, "rc-update", "-u"); err != nil {
		return NothingToMigrate, fmt.Errorf("rc-update -u: %w", err)
	}
	return RemovedLegacy, removeLegacyBinary(host, executable)
}

// legacyBackupStep is moveLegacyBackup for the detached switch-over.
var legacyBackupStep = "if [ -e " + shellQuote(LegacyBinaryPath+".previous") + " ]; then " +
	"if [ -e " + shellQuote(BinaryPath+".previous") + " ]; then rm -f " + shellQuote(LegacyBinaryPath+".previous") + "; " +
	"else mv -f " + shellQuote(LegacyBinaryPath+".previous") + " " + shellQuote(BinaryPath+".previous") + "; fi; fi"

// Enablement links of the old service; removed by hand because systemctl
// disable and rc-update del need the definition that is already gone.
const (
	legacySystemdWantsGlob   = "/etc/systemd/system/*.wants/" + LegacyUnitName + ".service"
	legacyOpenRCRunlevelGlob = "/etc/runlevels/*/" + LegacyUnitName
)

func removeMatching(pattern string) error {
	paths, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// serviceArgs reads the watchdog arguments from the old service definition:
// the rest of the line after prefix (up to suffix), else fallback.
func serviceArgs(definition, prefix, suffix, fallback string) string {
	for _, line := range strings.Split(definition, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		value := strings.TrimPrefix(line, prefix)
		if suffix != "" {
			if !strings.HasSuffix(value, suffix) {
				continue
			}
			value = strings.TrimSuffix(value, suffix)
		}
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return fallback
}

// removeLegacyBinary removes the old binary once no service uses it, unless
// this process is that binary.
func removeLegacyBinary(host ServiceHost, executable string) error {
	legacy := host.path(LegacyBinaryPath)
	if filepath.Clean(executable) == filepath.Clean(legacy) {
		return nil
	}
	if err := os.Remove(legacy); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return moveLegacyBackup(host)
}

// moveLegacyBackup gives the backup the watchdog's self-update kept of its
// pre-Opfield previous binary the Opfield name, or
// removes it when the Opfield binary has a backup of its own (O-7).
func moveLegacyBackup(host ServiceHost) error {
	legacy := host.path(LegacyBinaryPath) + ".previous"
	current := host.path(BinaryPath) + ".previous"
	if _, err := os.Lstat(legacy); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if _, err := os.Lstat(current); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(legacy, current); err == nil {
			return nil
		}
	}
	if err := os.Remove(legacy); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// installBinary copies the running executable to destination atomically,
// unless it already is that file.
func installBinary(executable, destination string) error {
	if filepath.Clean(executable) == filepath.Clean(destination) {
		return nil
	}
	if source, err := os.Stat(executable); err == nil {
		if existing, err := os.Stat(destination); err == nil && os.SameFile(source, existing) {
			return nil
		}
	}
	input, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	staged := destination + ".next"
	output, err := os.OpenFile(staged, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		_ = os.Remove(staged)
		return err
	}
	if err := output.Sync(); err != nil {
		output.Close()
		_ = os.Remove(staged)
		return err
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(staged)
		return err
	}
	return os.Rename(staged, destination)
}

func writeIfChanged(path, content string, mode os.FileMode) error {
	if current, err := os.ReadFile(path); err == nil && string(current) == content {
		return os.Chmod(path, mode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	staged := path + ".next"
	if err := os.WriteFile(staged, []byte(content), mode); err != nil {
		return err
	}
	if err := os.Chmod(staged, mode); err != nil {
		_ = os.Remove(staged)
		return err
	}
	return os.Rename(staged, path)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// UnderLegacyUnit reports whether this process runs in the pre-Opfield systemd
// unit (its cgroup), or as the pre-Opfield OpenRC service (its supervisor's
// pid file names this process or its parent).
func UnderLegacyUnit() bool {
	if data, err := os.ReadFile("/proc/self/cgroup"); err == nil && strings.Contains(string(data), "/"+LegacyUnitName+".service") {
		return true
	}
	if os.Getenv("RC_SVCNAME") == LegacyUnitName {
		return true
	}
	if data, err := os.ReadFile("/run/" + LegacyUnitName + ".pid"); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && (pid == os.Getpid() || pid == os.Getppid()) {
			return true
		}
	}
	return false
}
