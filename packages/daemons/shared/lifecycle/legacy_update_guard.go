package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

var legacyVersionMarkerPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$`)

var legacySystemdUnits = map[string]string{
	"docker":     "docker-daemon.service",
	"nginx":      "nginx-daemon.service",
	"monitoring": "monitoring-daemon.service",
	"relay":      legacycompat.RelaySupervisorName + ".service",
}

// retireLegacyUpdateGuard removes only artifacts produced by the retired
// Opfield systemd update guard. It is intentionally outside the launcher
// process: protocol-v1 launchers never inspect or mutate init-system state.
func retireLegacyUpdateGuard(daemonType, binaryPath string) error {
	var failures []error
	for _, suffix := range []string{".update-state.json", ".update-pending", ".update-outcome.json"} {
		path := binaryPath + suffix
		removed, err := removeRecognizedLegacyMarker(path, suffix, os.Geteuid())
		if err != nil {
			failures = append(failures, err)
		}
		_ = removed
	}
	unit, ok := legacySystemdUnits[daemonType]
	if !ok {
		return errors.Join(failures...)
	}
	dropIn := filepath.Join("/etc/systemd/system", unit+".d", "20-update-rollback.conf")
	removed, err := removeRecognizedLegacyDropIn(dropIn, binaryPath, 0)
	if err != nil {
		failures = append(failures, err)
	}
	if removed {
		if systemctl, lookErr := exec.LookPath("systemctl"); lookErr == nil {
			if output, reloadErr := exec.Command(systemctl, "daemon-reload").CombinedOutput(); reloadErr != nil {
				failures = append(failures, fmt.Errorf("reload systemd after legacy update-guard removal: %w: %s", reloadErr, strings.TrimSpace(string(output))))
			}
		}
	}
	return errors.Join(failures...)
}

func removeRecognizedLegacyDropIn(path, binaryPath string, expectedOwner int) (bool, error) {
	contents, info, err := readOwnedRegularFile(path, expectedOwner)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	_ = info
	text := string(contents)
	if !strings.Contains(text, "update-guard") || !strings.Contains(text, filepath.Clean(binaryPath)) || !strings.Contains(text, "20-update-rollback") && !strings.Contains(text, "ExecStartPre") {
		return false, fmt.Errorf("preserved unrecognized legacy update-guard drop-in %s", path)
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	return true, syncDirectory(filepath.Dir(path))
}

func removeRecognizedLegacyMarker(path, suffix string, expectedOwner int) (bool, error) {
	contents, _, err := readOwnedRegularFile(path, expectedOwner)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	recognized := false
	switch suffix {
	case ".update-pending":
		trimmed := strings.TrimSpace(string(contents))
		recognized = legacyVersionMarkerPattern.MatchString(trimmed) || recognizedLegacyJSON(contents, "")
	case ".update-state.json":
		recognized = recognizedLegacyJSON(contents, "")
	case ".update-outcome.json":
		recognized = recognizedLegacyJSON(contents, "rolled_back")
	}
	if !recognized {
		return false, fmt.Errorf("preserved unrecognized legacy update marker %s", path)
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	return true, syncDirectory(filepath.Dir(path))
}

func recognizedLegacyJSON(contents []byte, requiredStatus string) bool {
	var value struct {
		SchemaVersion int    `json:"schemaVersion"`
		FromVersion   string `json:"fromVersion"`
		TargetVersion string `json:"targetVersion"`
		Status        string `json:"status"`
	}
	if json.Unmarshal(contents, &value) != nil || value.SchemaVersion != 1 || value.FromVersion == "" || value.TargetVersion == "" {
		return false
	}
	return requiredStatus == "" || value.Status == requiredStatus
}

func readOwnedRegularFile(path string, expectedOwner int) ([]byte, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, info, fmt.Errorf("refusing non-regular legacy update artifact %s", path)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != expectedOwner {
		return nil, info, fmt.Errorf("refusing legacy update artifact owned by uid %d: %s", stat.Uid, path)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, info, err
	}
	return contents, info, nil
}
