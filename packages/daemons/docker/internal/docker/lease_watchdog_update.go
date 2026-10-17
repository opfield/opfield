package docker

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// The lease watchdog updates itself on its own release line at a random time
// every 3 to 9 hours (A12.5). After an update of this daemon that left the node
// with an older watchdog (a pre-Opfield one keeps its old service name until
// it updates), the daemon has the watchdog check for its update at once, once
// the update of this daemon is committed (F-8). It runs the watchdog's own
// update command, which verifies, self-tests and installs the release as its
// self-update does, and restarts the service only when a new binary was
// installed; deadline records stay on tmpfs and the next process enforces them
// at once.

// leaseWatchdogBuild is the build of the running lease watchdog, as its
// heartbeat names it ("" when no watchdog runs).
func leaseWatchdogBuild() string {
	heartbeat, err := (leasefence.Dir{}).ReadHeartbeat()
	if err != nil || !heartbeat.Alive(leasefence.Now()) {
		return ""
	}
	return heartbeat.Build
}

var leaseWatchdogRefreshOnce sync.Once

// scheduleLeaseWatchdogRefresh has an older watchdog update itself once this
// start is confirmed.
func (p *DockerPlugin) scheduleLeaseWatchdogRefresh() {
	leaseWatchdogRefreshOnce.Do(func() {
		lifecycle.OnStartConfirmed(func() {
			go func() {
				b := newWatchdogBootstrap(p.logger, func() bool { return false }, p.cfg.Docker.LeaseWatchdogReleasesURL, p.cfg.Docker.LeaseWatchdogArtifactBaseURL)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer cancel()
				if err := b.alignChannel(ctx); err != nil {
					p.logger.Warn("could not align the lease watchdog's release channel with this daemon's", "channel", b.channel, "error", err)
				}
				if err := b.updateOlder(ctx, leaseWatchdogBuild(), lifecycle.Version); err != nil {
					p.logger.Warn("the lease watchdog update check after this daemon's update failed; the watchdog checks again on its own", "error", err)
				}
			}()
		})
	})
}

// updateOlder runs the update check of the installed watchdog when running,
// the build of the running watchdog, is older than daemon. Only an
// auto-updating watchdog service the installer (or the bootstrap) wrote is
// touched, with the release endpoints and channel of its own command line.
func (b *watchdogBootstrap) updateOlder(ctx context.Context, running, daemon string) error {
	if !b.release || b.euid() != 0 || !leasewatchdog.Older(running, daemon) {
		return nil
	}
	manager := b.serviceManager()
	type service struct{ path, prefix, suffix, binary, unit string }
	var candidates []service
	switch manager {
	case "systemd":
		candidates = []service{
			{leasewatchdog.SystemdUnitPath, "ExecStart=" + leasewatchdog.BinaryPath + " ", "", leasewatchdog.BinaryPath, leasewatchdog.UnitName},
			// legacy-name: legacycompat.LeaseWatchdogName service the watchdog has not moved yet — remove once every node reports none
			{leasewatchdog.LegacySystemdUnitPath, "ExecStart=" + leasewatchdog.LegacyBinaryPath + " ", "", leasewatchdog.LegacyBinaryPath, leasewatchdog.LegacyUnitName},
		}
	case "openrc":
		candidates = []service{
			{leasewatchdog.OpenRCPath, `command_args="`, `"`, leasewatchdog.BinaryPath, leasewatchdog.UnitName},
			// legacy-name: legacycompat.LeaseWatchdogName service the watchdog has not moved yet — remove once every node reports none
			{leasewatchdog.LegacyOpenRCPath, `command_args="`, `"`, leasewatchdog.LegacyBinaryPath, leasewatchdog.LegacyUnitName},
		}
	default:
		return nil
	}
	// The pre-Opfield service runs while it is installed (the new one does
	// not start next to it), so it goes first.
	for _, candidate := range []service{candidates[1], candidates[0]} {
		data, err := b.readFile(candidate.path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		args, ok := watchdogRunArgs(string(data), candidate.prefix, candidate.suffix)
		if !ok {
			// Not the auto-updating service the installer writes.
			return nil
		}
		output, err := b.runOutput(ctx, candidate.binary, watchdogUpdateArgs(args)...)
		if err != nil {
			return fmt.Errorf("%s update: %w: %s", candidate.binary, err, strings.TrimSpace(output))
		}
		if !strings.Contains(output, "updated to") {
			b.logger.Info("the lease watchdog is older than this daemon and has no newer release yet", "watchdog", running, "daemon", daemon)
			return nil
		}
		b.logger.Info("updated the lease watchdog after this daemon's update; restarting it", "watchdog", running, "daemon", daemon,
			"service", candidate.unit, "result", strings.TrimSpace(output))
		if manager == "systemd" {
			return b.run(ctx, "systemctl", "try-restart", candidate.unit)
		}
		return b.run(ctx, "rc-service", "--ifstarted", candidate.unit, "restart")
	}
	return nil
}

// watchdogRunArgs returns the watchdog arguments of the service line that
// starts with prefix and ends with suffix, when it runs the auto-updating
// watchdog.
func watchdogRunArgs(content, prefix, suffix string) ([]string, bool) {
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) || len(line) < len(prefix)+len(suffix) {
			continue
		}
		fields := strings.Fields(line[len(prefix) : len(line)-len(suffix)])
		if len(fields) == 0 || fields[0] != "run" || !autoUpdates(fields) {
			return nil, false
		}
		return fields[1:], true
	}
	return nil, false
}

// watchdogUpdateArgs is the update command with the release endpoints and the
// channel of the watchdog's run arguments.
func watchdogUpdateArgs(runArgs []string) []string {
	update := []string{"update"}
	for i := 0; i < len(runArgs); i++ {
		name, value, inline := strings.Cut(strings.TrimLeft(runArgs[i], "-"), "=")
		if !strings.HasPrefix(runArgs[i], "-") {
			continue
		}
		switch name {
		case "releases-url", "artifact-base-url", "channel":
			if !inline {
				if i+1 >= len(runArgs) {
					continue
				}
				i++
				value = runArgs[i]
			}
			update = append(update, "--"+name, value)
		}
	}
	return update
}

func runCommandOutput(ctx context.Context, name string, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(output), err
}
