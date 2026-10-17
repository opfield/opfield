package main

import (
	"context"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"log/slog"
	"os"
	"os/signal"
	"regexp"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/outputcap"
	"github.com/opfield/opfield/monitoring-daemon/internal/config"
	"github.com/opfield/opfield/monitoring-daemon/internal/monitoring"
)

var opfieldCertSHA256Pattern = regexp.MustCompile(`^sha256:[0-9a-fA-F]{64}$`)

// Version is set via -ldflags at build time; falls back to "dev".
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
			fmt.Printf("monitoring-daemon %s\n", Version)
			return
		case "install":
			runInstall()
			return
		case "run":
			exitOnExtraArgs()
			// explicit run, continue below
		default:
			fmt.Fprintf(os.Stderr, "Usage: monitoring-daemon [run|install|version]\n")
			os.Exit(1)
		}
	}
	if err := lifecycle.BootstrapLauncher(lifecycle.LauncherSpec{
		DaemonType: "monitoring",
		StateDir:   "/var/lib/monitoring-daemon",
		ChildArgs:  os.Args[1:],
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher unavailable; continuing in direct mode: %v\n", err)
	}
	// Default: run the daemon
	configPath := os.Getenv("MONITORING_DAEMON_CONFIG")
	if configPath == "" {
		configPath = "/etc/monitoring-daemon/config.yaml"
	}

	logger := setupLogger("info", "json")
	// OpenRC and manual-mode hosts append the output to a plain file: keep it bounded.
	outputcap.Start(logger)

	cfg, err := config.Load(configPath)
	if err != nil {
		logger.Error("failed to load config", "path", configPath, "error", err)
		os.Exit(1)
	}
	logger = setupLogger(cfg.LogLevel, cfg.LogFormat)
	logger.Info("starting monitoring-daemon", "version", Version, "config", configPath)

	plugin := monitoring.NewMonitoringPlugin()

	d, err := lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, plugin, logger)
	if err != nil {
		logger.Error("failed to initialize daemon", "error", err)
		os.Exit(1)
	}
	lifecycle.MigrateControlConfigKeyOnConfirmedStart(&cfg.BaseConfig, configPath, logger)
	lifecycle.NotifyLauncherLocalReadyAwaitingControl(Version)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		cancel()
	}()

	if err := d.Run(ctx); err != nil {
		lifecycle.LogDaemonExit(logger, "daemon exited with error", err)
		os.Exit(lifecycle.DaemonExitCode(err))
	}
}

func setupLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: lvl}

	var handler slog.Handler
	if format == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	return slog.New(handler)
}

func runInstall() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: monitoring-daemon install --opfield <address> --token <token> --opfield-cert-sha256 <sha256:hex>\n")
		os.Exit(1)
	}

	var address, token, certSHA256 string
	for i := 2; i < len(os.Args)-1; i++ {
		switch os.Args[i] {
		// legacy-name: legacycompat.AddressFlag and legacycompat.CertFlag used by customer automation — drop with a changelog notice
		case "--opfield", legacycompat.AddressFlag:
			address = os.Args[i+1]
		case "--token":
			token = os.Args[i+1]
		case "--opfield-cert-sha256", legacycompat.CertFlag:
			certSHA256 = os.Args[i+1]
		}
	}

	if address == "" || token == "" || certSHA256 == "" {
		fmt.Fprintf(os.Stderr, "--opfield, --token, and --opfield-cert-sha256 are required\n")
		os.Exit(1)
	}
	if !opfieldCertSHA256Pattern.MatchString(certSHA256) {
		fmt.Fprintf(os.Stderr, "--opfield-cert-sha256 must use sha256:<64-hex> format\n")
		os.Exit(1)
	}

	configDir := "/etc/monitoring-daemon"
	configPath := configDir + "/config.yaml"

	if err := os.MkdirAll(configDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create config dir: %v\n", err)
		os.Exit(1)
	}

	configContent := fmt.Sprintf(`opfield:
  address: "%s"
  token: "%s"
  cert_sha256: "%s"

tls:
  ca_cert: "/etc/monitoring-daemon/certs/ca.pem"
  client_cert: "/etc/monitoring-daemon/certs/node.pem"
  client_key: "/etc/monitoring-daemon/certs/node-key.pem"

state_dir: "/var/lib/monitoring-daemon"
log_level: "info"
log_format: "json"
`, address, token, certSHA256)

	if err := os.WriteFile(configPath, []byte(configContent), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Config written to %s\n", configPath)

	// Create systemd service unit
	serviceContent := `[Unit]
Description=Opfield Monitoring Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/monitoring-daemon run
Restart=always
RestartSec=5
Environment=MONITORING_DAEMON_CONFIG=/etc/monitoring-daemon/config.yaml

[Install]
WantedBy=multi-user.target
`
	servicePath := "/etc/systemd/system/monitoring-daemon.service"
	if err := os.WriteFile(servicePath, []byte(serviceContent), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write systemd unit: %v\n", err)
		fmt.Println("You can start the daemon manually: monitoring-daemon run")
	} else {
		fmt.Printf("Systemd service written to %s\n", servicePath)
		fmt.Println("Enable and start: systemctl enable --now monitoring-daemon")
	}
}

// exitOnExtraArgs ends with the usage when run or version got arguments (lifecycle.ExtraArgs).
func exitOnExtraArgs() {
	if err := lifecycle.ExtraArgs(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "%v\nUsage: monitoring-daemon [run|install|version]\n", err)
		os.Exit(1)
	}
}
