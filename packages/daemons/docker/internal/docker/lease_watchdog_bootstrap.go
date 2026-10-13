package docker

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/updateauth"
)

// watchdogMissingCapability tells Opfield this node has no lease watchdog
// and cannot install one itself (non-root daemon or no service manager); the
// policy mode reason then asks to re-run the node installer.
const watchdogMissingCapability = "availability_lease_watchdog_missing_v1"

const (
	bootstrapRetryMin   = time.Minute
	bootstrapRetryMax   = 30 * time.Minute
	bootstrapPollPeriod = time.Minute
)

// watchdogBootstrap installs a missing lease watchdog on nodes installed
// before the watchdog existed (existing nodes update only the daemon binary).
// It bootstraps only when there is no heartbeat, no binary and no service
// file; it never updates or stops an existing watchdog, which stays
// independent of the daemon afterwards (A12.5). The one thing it keeps in
// line on an existing watchdog is the release channel of its self-update
// (alignChannel). Release resolution, signed manifest verification and the
// service files are the installer's and the watchdog self-update's
// (daemon-shared/leasewatchdog).
type watchdogBootstrap struct {
	logger          *slog.Logger
	heartbeatFresh  func() bool
	exists          func(path string) bool
	euid            func() int
	serviceManager  func() string // "systemd", "openrc" or ""
	recordsOwner    func() string
	releasesURL     string
	artifactBaseURL string
	channel         string
	release         bool
	fetch           func(ctx context.Context) (string, *updateauth.DaemonManifestPayload, error)
	replace         func(downloadURL, version, sha256, manifest, daemonType, destination string, logger *slog.Logger) error
	selfTest        func(ctx context.Context, path string) error
	readFile        func(path string) ([]byte, error)
	writeFile       func(path string, data []byte, mode os.FileMode) error
	rename          func(from, to string) error
	remove          func(path string) error
	run             func(ctx context.Context, name string, args ...string) error
	wait            func(ctx context.Context, d time.Duration) bool
	onPresent       func()

	mu         sync.Mutex
	reason     string
	reasonSeen bool
}

func newWatchdogBootstrap(logger *slog.Logger, heartbeatFresh func() bool, releasesURL, artifactBaseURL string) *watchdogBootstrap {
	channel := "stable"
	if strings.Contains(lifecycle.Version, "-rc.") {
		channel = "preview"
	}
	b := &watchdogBootstrap{
		logger: logger, heartbeatFresh: heartbeatFresh, releasesURL: releasesURL, artifactBaseURL: artifactBaseURL, channel: channel,
		// The channel this daemon updates on; a development build never
		// changes the watchdog's.
		release:        strings.HasPrefix(lifecycle.Version, "v"),
		exists:         func(path string) bool { _, err := os.Stat(path); return err == nil },
		euid:           os.Geteuid,
		serviceManager: detectServiceManager,
		recordsOwner: func() string {
			if current, err := user.Current(); err == nil {
				return current.Username
			}
			return "root"
		},
		replace:   lifecycle.ReplaceBinaryAtPath,
		selfTest:  func(ctx context.Context, path string) error { return exec.CommandContext(ctx, path, "self-test").Run() },
		readFile:  os.ReadFile,
		writeFile: os.WriteFile,
		rename:    os.Rename,
		remove:    os.Remove,
		run: func(ctx context.Context, name string, args ...string) error {
			return exec.CommandContext(ctx, name, args...).Run()
		},
		wait: func(ctx context.Context, d time.Duration) bool {
			select {
			case <-ctx.Done():
				return false
			case <-time.After(d):
				return true
			}
		},
	}
	client := &http.Client{Timeout: time.Minute}
	b.fetch = func(ctx context.Context) (string, *updateauth.DaemonManifestPayload, error) {
		tag, err := leasewatchdog.NextTag(ctx, client, b.releasesURL, b.channel, "")
		if err != nil {
			return "", nil, err
		}
		if tag == "" {
			return "", nil, errors.New("no lease watchdog release is published")
		}
		return leasewatchdog.FetchManifest(ctx, client, b.artifactBaseURL, tag)
	}
	return b
}

func detectServiceManager() string {
	if info, err := os.Stat("/run/systemd/system"); err == nil && info.IsDir() {
		if _, err := exec.LookPath("systemctl"); err == nil {
			return "systemd"
		}
	}
	_, rcService := exec.LookPath("rc-service")
	_, rcUpdate := exec.LookPath("rc-update")
	if rcService == nil && rcUpdate == nil {
		return "openrc"
	}
	return ""
}

// present reports whether any trace of a watchdog exists; then it is never
// touched.
func (b *watchdogBootstrap) present() bool {
	return b.heartbeatFresh() || b.exists(leasewatchdog.BinaryPath) || b.exists(leasewatchdog.SystemdUnitPath) || b.exists(leasewatchdog.OpenRCPath) ||
		// legacy-name: gateway-lease-watchdog service of pre-Opfield nodes (the watchdog moves itself) — remove once every node reports none
		b.exists(leasewatchdog.LegacyBinaryPath) || b.exists(leasewatchdog.LegacySystemdUnitPath) || b.exists(leasewatchdog.LegacyOpenRCPath)
}

// evaluate returns whether the watchdog is missing and, when this daemon
// cannot install it, why.
func (b *watchdogBootstrap) evaluate() (missing bool, reason string) {
	switch {
	case b.present():
		return false, ""
	case b.euid() != 0:
		return true, "lease watchdog missing and the docker daemon runs without root: re-run the node installer"
	case b.serviceManager() == "":
		return true, "lease watchdog missing and no systemd or OpenRC is available: re-run the node installer"
	}
	return true, ""
}

// Unavailable reports a missing watchdog this daemon cannot install, for
// the node capabilities (watchdogMissingCapability).
func (b *watchdogBootstrap) Unavailable() (bool, string) {
	if b == nil {
		return false, ""
	}
	missing, reason := b.evaluate()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reason = reason
	if missing && reason != "" && !b.reasonSeen {
		b.reasonSeen = true
		b.logger.Warn(reason)
	}
	return missing && reason != "", reason
}

// Run bootstraps a missing watchdog in the background, retrying with jitter,
// and signals onPresent once a watchdog (bootstrapped or installed by the
// operator) runs. It never blocks daemon startup or renewals.
func (b *watchdogBootstrap) Run(ctx context.Context) {
	delay := bootstrapRetryMin
	// Only a watchdog that appears while this process runs changes the
	// capabilities it registered with.
	startedFresh := b.heartbeatFresh()
	if err := b.alignChannel(ctx); err != nil {
		b.logger.Warn("could not align the lease watchdog's release channel with this daemon's", "channel", b.channel, "error", err)
	}
	for ctx.Err() == nil {
		missing, reason := b.evaluate()
		if !missing {
			if b.heartbeatFresh() {
				if b.onPresent != nil && !startedFresh {
					b.onPresent()
				}
				return
			}
			// Installed but not (yet) running: never touch it; watch.
			if !b.wait(ctx, bootstrapPollPeriod) {
				return
			}
			continue
		}
		if reason != "" {
			b.Unavailable()
			if !b.wait(ctx, bootstrapPollPeriod) {
				return
			}
			continue
		}
		if err := b.install(ctx); err != nil {
			b.logger.Warn("lease watchdog bootstrap failed; retrying", "error", err, "retry_in", delay)
			if !b.wait(ctx, jittered(delay)) {
				return
			}
			delay = min(delay*2, bootstrapRetryMax)
			continue
		}
		b.logger.Info("lease watchdog bootstrapped as its own service", "binary", leasewatchdog.BinaryPath)
		delay = bootstrapRetryMin
		if !b.wait(ctx, 2*time.Second) {
			return
		}
	}
}

// jittered spreads retries over ±25% so a fleet does not retry in lockstep.
func jittered(d time.Duration) time.Duration {
	spread := int64(d) / 2
	return d - time.Duration(spread/2) + time.Duration(rand.Int64N(spread+1))
}

// install fetches the verified release, stages and self-tests it, installs
// the binary, then writes the installer's service file and starts it.
func (b *watchdogBootstrap) install(ctx context.Context) error {
	manifest, payload, err := b.fetch(ctx)
	if err != nil {
		return err
	}
	staged := leasewatchdog.BinaryPath + ".next"
	defer func() { _ = b.remove(staged) }()
	if err := b.replace(payload.DownloadURL, payload.Version, payload.SHA256, manifest, leasewatchdog.DaemonType, staged, b.logger); err != nil {
		return fmt.Errorf("download lease watchdog: %w", err)
	}
	testCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := b.selfTest(testCtx, staged); err != nil {
		return fmt.Errorf("lease watchdog self-test: %w", err)
	}
	if b.present() {
		// The operator's installer got there first; leave its watchdog alone.
		return nil
	}
	if err := b.rename(staged, leasewatchdog.BinaryPath); err != nil {
		return fmt.Errorf("install lease watchdog: %w", err)
	}
	if err := b.installService(ctx); err != nil {
		// Undo this attempt so the next one starts clean instead of finding a
		// half-installed watchdog it must not touch.
		_ = b.remove(leasewatchdog.SystemdUnitPath)
		_ = b.remove(leasewatchdog.OpenRCPath)
		_ = b.remove(leasewatchdog.BinaryPath)
		return err
	}
	return nil
}

func (b *watchdogBootstrap) installService(ctx context.Context) error {
	// A development build never moves the watchdog off the stable channel.
	channel := "stable"
	if b.release {
		channel = b.channel
	}
	args := leasewatchdog.RunArgs(b.recordsOwner(), orDefaultURL(b.releasesURL, leasewatchdog.DefaultReleasesURL), orDefaultURL(b.artifactBaseURL, leasewatchdog.DefaultArtifactBaseURL), channel)
	switch b.serviceManager() {
	case "systemd":
		if err := b.writeFile(leasewatchdog.SystemdUnitPath, []byte(leasewatchdog.SystemdUnit(leasewatchdog.BinaryPath, args)), 0o644); err != nil {
			return fmt.Errorf("write lease watchdog unit: %w", err)
		}
		for _, command := range [][]string{{"daemon-reload"}, {"enable", leasewatchdog.UnitName}, {"start", leasewatchdog.UnitName}} {
			if err := b.run(ctx, "systemctl", command...); err != nil {
				return fmt.Errorf("systemctl %s: %w", strings.Join(command, " "), err)
			}
		}
	case "openrc":
		if err := b.writeFile(leasewatchdog.OpenRCPath, []byte(leasewatchdog.OpenRCScript(leasewatchdog.BinaryPath, args)), 0o755); err != nil {
			return fmt.Errorf("write lease watchdog service: %w", err)
		}
		if err := b.run(ctx, "rc-update", "add", leasewatchdog.UnitName, "default"); err != nil {
			return fmt.Errorf("rc-update: %w", err)
		}
		if err := b.run(ctx, "rc-service", leasewatchdog.UnitName, "start"); err != nil {
			return fmt.Errorf("rc-service: %w", err)
		}
	default:
		return errors.New("no service manager for the lease watchdog")
	}
	return nil
}

func orDefaultURL(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// alignInstalledWatchdogChannel aligns the release channel of a watchdog on a
// node whose lease runtime does not run (storage and database nodes, or a
// runtime that could not start): the installer may have put a watchdog there
// too, and it still updates itself (rc.20 M-8).
func alignInstalledWatchdogChannel(logger *slog.Logger, releasesURL, artifactBaseURL string) {
	b := newWatchdogBootstrap(logger, func() bool { return false }, releasesURL, artifactBaseURL)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := b.alignChannel(ctx); err != nil {
		logger.Warn("could not align the lease watchdog's release channel with this daemon's", "channel", b.channel, "error", err)
	}
}

// alignChannel makes an installed watchdog's self-update follow the release
// channel this daemon updates on. The node installer writes the service
// without --channel, i.e. stable, so on a preview-channel node the watchdog
// never took a release candidate while the daemons moved on (rc.20 M-8). Only
// the channel flag of the auto-updating watchdog service the installer (or
// this bootstrap) wrote is changed, never another flag or a service an
// operator rewrote; when the file changed, the service manager reloads it and
// restarts the watchdog if it runs. Deadline records stay on tmpfs and the
// next process enforces them at once, as after the watchdog's own
// self-update.
func (b *watchdogBootstrap) alignChannel(ctx context.Context) error {
	if !b.release || b.euid() != 0 {
		return nil
	}
	var path, prefix, suffix string
	var mode os.FileMode
	unit := leasewatchdog.UnitName
	manager := b.serviceManager()
	switch manager {
	case "systemd":
		path, prefix, mode = leasewatchdog.SystemdUnitPath, "ExecStart="+leasewatchdog.BinaryPath+" ", 0o644
	case "openrc":
		path, prefix, suffix, mode = leasewatchdog.OpenRCPath, `command_args="`, `"`, 0o755
	default:
		return nil
	}
	data, err := b.readFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		// legacy-name: gateway-lease-watchdog service the watchdog has not moved yet — remove once every node reports none
		unit = leasewatchdog.LegacyUnitName
		if manager == "systemd" {
			path, prefix = leasewatchdog.LegacySystemdUnitPath, "ExecStart="+leasewatchdog.LegacyBinaryPath+" "
		} else {
			path = leasewatchdog.LegacyOpenRCPath
		}
		data, err = b.readFile(path)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	updated, changed := serviceWithChannel(string(data), prefix, suffix, b.channel)
	if !changed {
		return nil
	}
	// A dot name: neither systemd nor OpenRC takes it for a service while
	// it is staged.
	staged := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".next")
	if err := b.writeFile(staged, []byte(updated), mode); err != nil {
		return fmt.Errorf("write lease watchdog service: %w", err)
	}
	if err := b.rename(staged, path); err != nil {
		_ = b.remove(staged)
		return fmt.Errorf("install lease watchdog service: %w", err)
	}
	b.logger.Info("lease watchdog now follows this daemon's release channel; restarting it", "channel", b.channel, "service", path)
	if manager == "systemd" {
		for _, command := range [][]string{{"daemon-reload"}, {"try-restart", unit}} {
			if err := b.run(ctx, "systemctl", command...); err != nil {
				return fmt.Errorf("systemctl %s: %w", strings.Join(command, " "), err)
			}
		}
		return nil
	}
	if err := b.run(ctx, "rc-service", "--ifstarted", unit, "restart"); err != nil {
		return fmt.Errorf("rc-service restart: %w", err)
	}
	return nil
}

// serviceWithChannel sets the channel in the watchdog command line of a
// service file: the line that starts with prefix and ends with suffix and
// runs the watchdog with --auto-update. It reports whether anything changed.
func serviceWithChannel(content, prefix, suffix, channel string) (string, bool) {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) || len(line) < len(prefix)+len(suffix) {
			continue
		}
		args := line[len(prefix) : len(line)-len(suffix)]
		fields := strings.Fields(args)
		if len(fields) == 0 || fields[0] != "run" || !autoUpdates(fields) {
			return content, false
		}
		updated, changed := argsWithChannel(args, channel)
		if !changed {
			return content, false
		}
		lines[i] = prefix + updated + suffix
		return strings.Join(lines, "\n"), true
	}
	return content, false
}

// autoUpdates reports whether the watchdog flags enable its self-update.
func autoUpdates(fields []string) bool {
	for _, field := range fields {
		switch strings.TrimLeft(field, "-") {
		case "auto-update", "auto-update=true", "auto-update=1":
			return strings.HasPrefix(field, "-")
		}
	}
	return false
}

// argsWithChannel returns the watchdog run arguments with channel selected:
// the --channel flag is dropped for stable (the watchdog's default) and set
// for any other channel. It reports whether the effective channel changed.
func argsWithChannel(args, channel string) (string, bool) {
	fields := strings.Fields(args)
	current := "stable"
	kept := make([]string, 0, len(fields)+2)
	for i := 0; i < len(fields); i++ {
		name, value, inline := strings.Cut(strings.TrimLeft(fields[i], "-"), "=")
		if !strings.HasPrefix(fields[i], "-") || name != "channel" {
			kept = append(kept, fields[i])
			continue
		}
		if !inline && i+1 < len(fields) {
			i++
			value = fields[i]
		}
		current = value
	}
	if current == channel {
		return args, false
	}
	if channel != "stable" {
		kept = append(kept, "--channel", channel)
	}
	return strings.Join(kept, " "), true
}
