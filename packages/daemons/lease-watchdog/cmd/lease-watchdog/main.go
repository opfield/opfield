// Command lease-watchdog enforces Docker Availability lease deadlines on a
// node independently of docker-daemon and dockerd (A2.2, A12). It runs as
// root under its own service unit, reads deadline records from tmpfs, kills
// the cgroup of any container past its deadline, and writes a heartbeat the
// daemon requires before it acquires, starts or renews a lease.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/lease-watchdog/internal/update"
	"github.com/opfield/opfield/lease-watchdog/internal/watchdog"
)

// Version is set at build time: -X main.Version=vX.Y.Z.
var Version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	// The service logs to stdout, as docker-daemon does: under OpenRC its
	// output_log gets the log and error_log only what the runtime itself
	// prints (O-10). The one-shot commands keep stdout for their answer.
	logOutput := os.Stderr
	if os.Args[1] == "run" {
		logOutput = os.Stdout
	}
	logger := slog.New(slog.NewJSONHandler(logOutput, &slog.HandlerOptions{Level: slog.LevelInfo}))
	var err error
	switch os.Args[1] {
	case "run":
		err = run(os.Args[2:], logger)
	case "update":
		err = updateOnce(os.Args[2:], logger)
	case "status":
		err = status(os.Args[2:])
	case "self-test":
		err = selfTest(os.Args[2:])
	case "version", "--version", "-version":
		if len(os.Args) > 2 {
			usage()
			os.Exit(2)
		}
		fmt.Printf("lease-watchdog %s\n", Version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		logger.Error("lease watchdog failed", "command", os.Args[1], "error", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lease-watchdog run|update|status|self-test|version [flags]")
}

type updateFlags struct {
	releasesURL, artifactBaseURL, channel *string
}

func addUpdateFlags(fs *flag.FlagSet) updateFlags {
	return updateFlags{
		releasesURL:     fs.String("releases-url", update.DefaultReleasesURL, "update service releases endpoint"),
		artifactBaseURL: fs.String("artifact-base-url", update.DefaultArtifactBaseURL, "update service artifact base"),
		channel:         fs.String("channel", "stable", "release channel: stable or preview"),
	}
}

func run(args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	root := fs.String("dir", leasefence.DefaultRoot, "tmpfs directory shared with docker-daemon")
	cgroupRoot := fs.String("cgroup-root", leasefence.DefaultCgroupRoot, "cgroupfs mount")
	owner := fs.String("records-owner", "", "user that runs docker-daemon and writes deadline records, when its configuration directory is missing")
	daemonConfigDir := fs.String("daemon-config-dir", defaultDaemonConfigDir, "docker-daemon configuration directory: its owner is the user that runs docker-daemon")
	autoUpdate := fs.Bool("auto-update", false, "install new watchdog releases automatically")
	interval := fs.Duration("update-interval", 6*time.Hour, "average interval between update checks")
	updates := addUpdateFlags(fs)
	_ = fs.Parse(args)
	if fs.NArg() > 0 {
		// "run version" used as a version check would start a second watchdog.
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	dir := leasefence.Dir{Root: *root}
	fallback, err := lookupOwner(*owner)
	if err != nil {
		return err
	}
	if *root == leasefence.DefaultRoot || *root == leasefence.LegacyRoot {
		// Meet a docker daemon of either release in one directory: the
		// pre-Opfield name becomes a link to the Opfield one.
		if _, err := leasefence.EnsureDefaultRoot(); err != nil {
			logger.Warn("lease record directory keeps its pre-Opfield name", "error", err)
		}
	}
	if err := prepareDirectories(dir); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("lease watchdog started", "version", Version, "dir", *root, "cgroup_root", *cgroupRoot)
	restart := make(chan string, 1)
	if *autoUpdate {
		go updateLoop(ctx, updates, *interval, logger, restart)
	}
	enforcer := watchdog.New(watchdog.Config{Dir: dir, CgroupRoot: *cgroupRoot, Logger: logger, Build: Version,
		Owner: watchdog.ConfigDirOwner(*daemonConfigDir, fallback)})
	done := make(chan struct{})
	runCtx, cancel := context.WithCancel(context.Background())
	go func() {
		enforcer.Run(runCtx)
		close(done)
	}()
	go migrateLegacyService(ctx, logger)
	select {
	case <-ctx.Done():
	case tag := <-restart:
		logger.Info("lease watchdog updated; exiting for the supervisor to restart it", "tag", tag)
	}
	// Deadline records stay on tmpfs; the next process enforces them at once.
	cancel()
	<-done
	return nil
}

// defaultDaemonConfigDir is the docker-daemon configuration directory the node installer creates.
const defaultDaemonConfigDir = "/etc/docker-daemon"

// prepareDirectories creates the records directory; the enforcer gives it its owner from the first pass.
func prepareDirectories(dir leasefence.Dir) error {
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		return fmt.Errorf("create lease record directory: %w", err)
	}
	return os.Chmod(filepath.Dir(dir.RecordsDir()), 0o755)
}

// lookupOwner resolves --records-owner (no owner when it is empty).
func lookupOwner(owner string) (watchdog.Owner, error) {
	if owner == "" {
		return func() (int, int, bool) { return 0, 0, false }, nil
	}
	account, err := user.Lookup(owner)
	if err != nil {
		return nil, fmt.Errorf("records owner %q: %w", owner, err)
	}
	uid, uidErr := strconv.Atoi(account.Uid)
	gid, gidErr := strconv.Atoi(account.Gid)
	if uidErr != nil || gidErr != nil {
		return nil, fmt.Errorf("records owner %q has a non-numeric id", owner)
	}
	return func() (int, int, bool) { return uid, gid, true }, nil
}

func updateLoop(ctx context.Context, flags updateFlags, interval time.Duration, logger *slog.Logger, restart chan<- string) {
	if interval < time.Minute {
		interval = time.Minute
	}
	for {
		// Jitter spreads a fleet over the interval so a bad release cannot
		// take every node's watchdog down at once.
		wait := interval/2 + time.Duration(rand.Int64N(int64(interval)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		result, err := checkUpdate(ctx, flags, logger)
		if err != nil {
			logger.Warn("lease watchdog update check failed", "error", err)
			continue
		}
		if result.Updated {
			restart <- result.Tag
			return
		}
	}
}

func checkUpdate(ctx context.Context, flags updateFlags, logger *slog.Logger) (update.Result, error) {
	executable, err := os.Executable()
	if err != nil {
		return update.Result{}, err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}
	return update.Check(ctx, update.Config{
		ReleasesURL: *flags.releasesURL, ArtifactBaseURL: *flags.artifactBaseURL, Channel: *flags.channel,
		Current: Version, Executable: executable, Replace: lifecycle.ReplaceBinaryAtPath, Logger: logger,
		SelfTest: func(ctx context.Context, path string) error {
			return exec.CommandContext(ctx, path, "self-test").Run()
		},
	})
}

func updateOnce(args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	flags := addUpdateFlags(fs)
	_ = fs.Parse(args)
	result, err := checkUpdate(context.Background(), flags, logger)
	if err != nil {
		return err
	}
	if !result.Updated {
		fmt.Println("lease-watchdog is up to date")
		return nil
	}
	fmt.Printf("lease-watchdog updated to %s; restart the %s service\n", result.Tag, leasewatchdog.UnitName)
	return nil
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	root := fs.String("dir", leasefence.DefaultRoot, "tmpfs directory shared with docker-daemon")
	_ = fs.Parse(args)
	dir := leasefence.Dir{Root: *root}
	now := leasefence.Now()
	heartbeat, err := dir.ReadHeartbeat()
	switch {
	case err != nil:
		fmt.Printf("heartbeat: missing (%v)\n", err)
	case heartbeat.Fresh(now):
		fmt.Printf("heartbeat: fresh (pid %d, build %s)\n", heartbeat.PID, heartbeat.Build)
	default:
		fmt.Printf("heartbeat: stale by %s\n", now-time.Duration(heartbeat.NowNs))
	}
	records, problems, err := dir.ReadRecords()
	if err != nil {
		return err
	}
	for _, record := range records {
		state := "armed, " + (record.Deadline() - now).Round(time.Millisecond).String() + " left"
		if record.Stale(now) {
			state = "stale: enforcing"
		}
		fmt.Printf("%s policy=%s slot=%d %s\n", record.ContainerID[:12], record.PolicyID, record.Slot, state)
	}
	for _, problem := range problems {
		fmt.Printf("malformed: %s\n", problem)
	}
	return nil
}

// selfTest proves a staged binary starts and can use this host's clock.
func selfTest(_ []string) error {
	if leasefence.Now() <= 0 {
		return errors.New("CLOCK_BOOTTIME is unavailable")
	}
	fmt.Printf("lease-watchdog %s ok\n", Version)
	return nil
}

// migrateLegacyService moves a node from the pre-Opfield gateway-lease-watchdog
// service to opfield-lease-watchdog once this watchdog enforces (its first
// pass ran), so the switch-over gap is one stop and one start.
func migrateLegacyService(ctx context.Context, logger *slog.Logger) {
	if os.Geteuid() != 0 {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err != nil {
		logger.Warn("lease watchdog service keeps its pre-Opfield name", "error", err)
		return
	}
	_, systemdErr := os.Stat("/run/systemd/system")
	_, openrcErr := os.Stat("/sbin/openrc-run")
	host := leasewatchdog.ServiceHost{
		Systemd: systemdErr == nil,
		OpenRC:  systemdErr != nil && openrcErr == nil,
		Run: func(ctx context.Context, name string, args ...string) error {
			runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			output, err := exec.CommandContext(runCtx, name, args...).CombinedOutput()
			if err != nil {
				return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
			}
			return nil
		},
		Detach:             detachServiceSwitch(systemdErr == nil),
		UnderLegacyService: leasewatchdog.UnderLegacyUnit,
	}
	result, err := leasewatchdog.MigrateLegacyService(ctx, host, executable, strings.Join(os.Args[1:], " "))
	switch {
	case err != nil:
		logger.Warn("lease watchdog service keeps its pre-Opfield name; retried on the next start", "service", leasewatchdog.LegacyUnitName, "error", err)
	case result == leasewatchdog.SwitchingOver:
		logger.Info("moving the lease watchdog to its Opfield service; this process stops and the new service starts", "from", leasewatchdog.LegacyUnitName, "to", leasewatchdog.UnitName)
	case result == leasewatchdog.RemovedLegacy:
		logger.Info("removed the pre-Opfield lease watchdog service", "service", leasewatchdog.LegacyUnitName)
	}
}

// detachServiceSwitch runs the switch-over step outside this process's
// service: under systemd as a transient unit (stopping the old unit kills
// every process of its cgroup), under OpenRC in its own session.
func detachServiceSwitch(systemd bool) func(script string) error {
	return func(script string) error {
		if systemd {
			output, err := exec.Command("systemd-run", "--unit="+leasewatchdog.UnitName+"-switch", "--collect", "--quiet", "/bin/sh", "-c", script).CombinedOutput()
			if err != nil {
				return fmt.Errorf("systemd-run: %w: %s", err, strings.TrimSpace(string(output)))
			}
			return nil
		}
		command := exec.Command("/bin/sh", "-c", script)
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := command.Start(); err != nil {
			return err
		}
		return command.Process.Release()
	}
}
