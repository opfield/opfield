package listenerkeep

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// SystemdDropInName is the drop-in that gives a daemon's systemd unit a file
// descriptor store, so its kept listeners also outlive a restart of the unit.
const SystemdDropInName = "30-listener-keep.conf"

// systemdDropIn is written for units installed before the unit template set
// these itself. NotifyAccess=main lets the unit's main process (the launcher)
// store descriptors; nothing else of the unit changes.
const systemdDropIn = "# Written by the Opfield daemon: keep its listening sockets across restarts.\n" + systemdDropInBody

// legacy-name: drop-in header of pre-Opfield daemons, rewritten in place (the settings are the same) — remove once every node reports none
const legacySystemdDropIn = "# Written by the Gateway daemon: keep its listening sockets across restarts.\n" + systemdDropInBody

const systemdDropInBody = "[Service]\n" +
	"FileDescriptorStoreMax=4096\n" +
	"NotifyAccess=main\n"

// EnsureSystemdStore gives the systemd unit running this process a file
// descriptor store when it has none, and reports whether it installed one.
// The unit's processes see it from their next start. Outside systemd, or when
// the unit already has a store, it does nothing.
func EnsureSystemdStore() (bool, error) {
	return ensureSystemdStore("/run/systemd/system", "/proc/self/cgroup", "/etc/systemd/system", runSystemctl)
}

func runSystemctl(args ...string) (string, error) {
	systemctl, err := exec.LookPath("systemctl")
	if err != nil {
		return "", err
	}
	output, err := exec.Command(systemctl, args...).CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func ensureSystemdStore(runtimeDir, cgroupPath, unitDir string, systemctl func(...string) (string, error)) (bool, error) {
	if _, err := os.Stat(runtimeDir); err != nil {
		return false, nil
	}
	unit, err := systemdUnitOf(cgroupPath)
	if err != nil || unit == "" {
		return false, err
	}
	directory := filepath.Join(unitDir, unit+".d")
	path := filepath.Join(directory, SystemdDropInName)
	if current, err := os.ReadFile(path); err == nil && string(current) == legacySystemdDropIn {
		// Only the comment differs: no reload needed.
		if err := atomicfile.WriteFile(path, []byte(systemdDropIn), 0o644); err != nil {
			return false, err
		}
	}
	if value, err := systemctl("show", "--property=FileDescriptorStoreMax", "--value", unit); err == nil {
		if count, parseErr := strconv.Atoi(value); parseErr == nil && count > 0 {
			return false, nil
		}
	}
	if current, err := os.ReadFile(path); err == nil && string(current) == systemdDropIn {
		return false, nil
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return false, err
	}
	if err := atomicfile.WriteFile(path, []byte(systemdDropIn), 0o644); err != nil {
		return false, err
	}
	if output, err := systemctl("daemon-reload"); err != nil {
		return true, fmt.Errorf("reload systemd: %w: %s", err, output)
	}
	return true, nil
}

// SystemdUnit names the systemd service unit this process runs in, or "".
func SystemdUnit() (string, error) {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return "", nil
	}
	return systemdUnitOf("/proc/self/cgroup")
}

// systemdUnitOf names the service unit whose cgroup the process is in.
func systemdUnitOf(cgroupPath string) (string, error) {
	file, err := os.Open(cgroupPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.SplitN(scanner.Text(), ":", 3)
		if len(fields) != 3 {
			continue
		}
		for _, component := range strings.Split(fields[2], "/") {
			if strings.HasSuffix(component, ".service") && !strings.HasPrefix(component, "user@") {
				return component, nil
			}
		}
	}
	return "", scanner.Err()
}
