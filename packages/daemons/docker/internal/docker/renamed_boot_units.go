package docker

import (
	"errors"
	"os"
	"path/filepath"
)

// The boot steps were installed under the legacy unit names
// before Opfield. The daemon installs them under their
// Opfield names at every start. A new unit does not run while the old one is
// installed (a launcher rollback before the start was confirmed may bring back
// a daemon that maintains only the old one), and the old one is removed once
// the start is confirmed (lifecycle.OnStartConfirmed), so a node never runs a
// boot step twice.
// legacy-name: legacy boot step units of pre-Opfield daemons — remove once every node reports none
const (
	legacyVolumeImageBootService  = "gateway-volume-images"
	legacyLinkListenerBootService = "gateway-link-listeners"
)

// systemdLegacyGuard is the [Unit] line that keeps a new boot unit from running
// while the old one is installed.
func systemdLegacyGuard(host volumeImageBootHost, legacy string) string {
	return "ConditionPathExists=!" + filepath.Join(host.systemdDir, legacy+".service") + "\n"
}

// openrcLegacyGuard is the start() prologue doing the same for OpenRC.
func openrcLegacyGuard(host volumeImageBootHost, legacy string) string {
	return "\tif [ -e " + shellQuote(filepath.Join(host.openrcDir, legacy)) + " ]; then\n" +
		"\t\teinfo \"" + legacy + " runs instead\"\n" +
		"\t\treturn 0\n" +
		"\tfi\n"
}

// retireLegacyBootUnit removes the old boot unit once the start is confirmed.
func retireLegacyBootUnit(host volumeImageBootHost, legacy string) error {
	if !host.confirmed {
		return nil
	}
	switch {
	case host.systemd:
		path := filepath.Join(host.systemdDir, legacy+".service")
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		_ = host.run("systemctl", "disable", "--quiet", legacy+".service")
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return host.run("systemctl", "daemon-reload")
	case host.openrc:
		path := filepath.Join(host.openrcDir, legacy)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if _, err := os.Lstat(filepath.Join(host.runlevels, "boot", legacy)); err == nil {
			if err := host.run("rc-update", "del", legacy, "boot"); err != nil {
				return err
			}
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return host.run("rc-update", "-u")
	}
	return nil
}

// legacyBootUnits counts the old boot units still installed.
func legacyBootUnits(host volumeImageBootHost) uint32 {
	var count uint32
	for _, legacy := range []string{legacyVolumeImageBootService, legacyLinkListenerBootService} {
		if host.systemd {
			if _, err := os.Lstat(filepath.Join(host.systemdDir, legacy+".service")); err == nil {
				count++
			}
		} else if host.openrc {
			if _, err := os.Lstat(filepath.Join(host.openrcDir, legacy)); err == nil {
				count++
			}
		}
	}
	return count
}
