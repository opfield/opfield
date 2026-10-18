package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/outputcap"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"github.com/opfield/opfield/relay-supervisor/internal/hostnames"
	"github.com/opfield/opfield/relay-supervisor/internal/supervisor"
)

var Version = "dev"

func main() {
	// The launcher and its probe report this version too.
	lifecycle.Version = Version
	if lifecycle.IsLauncherProbeCommand(os.Args) {
		lifecycle.PrintLauncherProbe()
		return
	}
	if lifecycle.IsLauncherCommand(os.Args) {
		if err := lifecycle.RunLauncherCommand(os.Args, nil); err != nil {
			fmt.Fprintf(os.Stderr, "launcher failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-version":
			exitOnExtraArgs()
			fmt.Printf("relay-supervisor %s\n", Version)
			return
		case "run":
			exitOnExtraArgs()
		case "protected":
			os.Exit(runProtectedCommand(os.Args[2:], supervisorConfigPath(), os.Stdout, os.Stderr))
		default:
			fmt.Fprintln(os.Stderr, "Usage: relay-supervisor [run|version|protected]")
			os.Exit(1)
		}
	}
	// A directory move a crash interrupted is finished before anything below
	// resolves a path (the move itself runs on a confirmed start, see
	// hostnames).
	if err := hostnames.RepairInterrupted(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: finishing an interrupted move of the relay directories: %v\n", err)
	}
	if err := lifecycle.BootstrapLauncher(lifecycle.LauncherSpec{
		DaemonType: "relay",
		StateDir:   hostnames.DefaultStateDir(),
		ChildArgs:  os.Args[1:],
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher unavailable; continuing in direct mode: %v\n", err)
	}
	configPath := supervisorConfigPath()
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load relay supervisor config: %v\n", err)
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel(cfg.LogLevel)}))
	// OpenRC and manual-mode hosts append the output to a plain file: keep it bounded.
	outputcap.Start(logger)
	if err := supervisor.RecoverWorkerIdentity(cfg.Worker.IdentityDir); err != nil {
		logger.Error("repair the relay worker identity", "error", err)
	}
	if err := supervisor.RecoverInterruptedReenrollment(&cfg.BaseConfig); err != nil {
		logger.Error("restore relay supervisor identity from an interrupted re-enrollment", "error", err)
	}
	if completeInterruptedEnrollment(cfg, configPath, logger) != nil {
		os.Exit(1)
	}
	reenrollment, err := supervisor.BeginReenrollment(&cfg.BaseConfig)
	if err != nil {
		logger.Error("re-enrollment skipped; continuing with the current identity", "error", err)
	} else if reenrollment != nil {
		logger.Warn("configuration carries an enrollment token; re-enrolling this relay with Opfield")
	}
	daemon, err := lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, supervisor.New(cfg).WithConfigPath(supervisorConfigPath), logger)
	if err != nil {
		restoreIdentity(reenrollment, logger)
		logger.Error("initialize relay supervisor", "error", err)
		os.Exit(1)
	}
	lifecycle.NotifyLauncherLocalReadyAwaitingControl(Version)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	err = daemon.Run(ctx)
	if err != nil && reenrollment != nil && ctx.Err() == nil && supervisor.HasPendingEnrollment(cfg) {
		// Opfield handed over the new identity but persisting it failed: finish
		// it, since the previous identity is already superseded.
		if completeInterruptedEnrollment(cfg, configPath, logger) != nil {
			os.Exit(1)
		}
		daemon, err = lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, supervisor.New(cfg).WithConfigPath(supervisorConfigPath), logger)
		if err == nil {
			err = daemon.Run(ctx)
		}
	} else if err != nil && reenrollment != nil && !cfg.IsEnrolled() && ctx.Err() == nil {
		// The enrollment did not complete: keep running as the relay was.
		logger.Error("re-enrollment failed; continuing with the previous identity", "error", err)
		recordEnrollmentFailure(cfg, err, logger)
		if !restoreIdentity(reenrollment, logger) {
			os.Exit(1)
		}
		if supervisor.EnrollmentTokenRejected(err) {
			if clearErr := lifecycle.ClearTokenFromFile(configPath); clearErr != nil {
				logger.Warn("failed to clear the rejected enrollment token from the configuration", "error", clearErr)
			}
		}
		cfg.Control.Token = ""
		daemon, err = lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, supervisor.New(cfg).WithConfigPath(supervisorConfigPath), logger)
		if err == nil {
			err = daemon.Run(ctx)
		}
	}
	if err != nil {
		if ctx.Err() == nil && !cfg.IsEnrolled() {
			// The first enrollment failed: the supervisor never got an identity.
			recordEnrollmentFailure(cfg, err, logger)
		}
		lifecycle.LogDaemonExit(logger, "relay supervisor stopped", err)
		os.Exit(lifecycle.DaemonExitCode(err))
	}
}

// completeInterruptedEnrollment finishes an enrollment whose bundle arrived
// but was not fully persisted. That enrollment consumed the token.
func completeInterruptedEnrollment(cfg *config.Config, configPath string, logger *slog.Logger) error {
	completed, err := supervisor.CompletePendingEnrollment(cfg)
	if err != nil {
		logger.Error("complete the interrupted relay enrollment", "error", err)
		return err
	}
	if completed {
		logger.Warn("completed an interrupted relay enrollment")
		cfg.Control.Token = ""
		if clearErr := lifecycle.ClearTokenFromFile(configPath); clearErr != nil {
			logger.Warn("failed to clear the used enrollment token from the configuration", "error", clearErr)
		}
	}
	return nil
}

// recordEnrollmentFailure tells the installer, which waits for it, that the
// token it wrote was not accepted.
func recordEnrollmentFailure(cfg *config.Config, err error, logger *slog.Logger) {
	if recordErr := supervisor.RecordEnrollmentOutcome(cfg.StateDir, err); recordErr != nil {
		logger.Warn("record the relay enrollment outcome", "error", recordErr)
	}
}

func restoreIdentity(reenrollment *supervisor.Reenrollment, logger *slog.Logger) bool {
	if reenrollment == nil {
		return true
	}
	if err := reenrollment.Restore(); err != nil {
		logger.Error("restore the previous relay supervisor identity", "error", err)
		return false
	}
	return true
}

func logLevel(value string) slog.Level {
	switch value {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// exitOnExtraArgs ends with the usage when run or version got arguments (lifecycle.ExtraArgs).
func exitOnExtraArgs() {
	if err := lifecycle.ExtraArgs(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "%v\nUsage: relay-supervisor [run|version|protected]\n", err)
		os.Exit(1)
	}
}
