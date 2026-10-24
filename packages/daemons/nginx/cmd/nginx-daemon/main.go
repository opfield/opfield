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
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/outputcap"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/daemon"
)

var certSHA256Pattern = regexp.MustCompile(`^sha256:[0-9a-fA-F]{64}$`)

func main() {
	// The launcher and its probe report this version too.
	lifecycle.Version = daemon.Version
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
			fmt.Printf("nginx-daemon %s\n", daemon.Version)
			return
		case "install":
			runInstall()
			return
		case "upgrade-nginx":
			exitOnExtraArgs()
			runUpgradeNginx()
			return
		case "run":
			exitOnExtraArgs()
			// explicit run, continue below
		default:
			fmt.Fprintf(os.Stderr, "Usage: nginx-daemon [run|install|upgrade-nginx|version]\n")
			os.Exit(1)
		}
	}
	if err := lifecycle.BootstrapLauncher(lifecycle.LauncherSpec{
		DaemonType: "nginx",
		StateDir:   "/var/lib/nginx-daemon",
		ChildArgs:  os.Args[1:],
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher unavailable; continuing in direct mode: %v\n", err)
	}
	// Take over the Secure Link sockets the previous process kept, before
	// nginx or anything else is started.
	listenerkeep.Init()
	// Default: run the daemon
	configPath := os.Getenv("NGINX_DAEMON_CONFIG")
	if configPath == "" {
		configPath = "/etc/nginx-daemon/config.yaml"
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
	logger.Info("starting nginx-daemon", "version", daemon.Version, "config", configPath)

	d, err := daemon.New(cfg, configPath, logger)
	if err != nil {
		logger.Error("failed to initialize daemon", "error", err)
		os.Exit(1)
	}
	lifecycle.NotifyLauncherLocalReadyAwaitingControl(daemon.Version)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		// A restart or update must not refuse a connection: the sockets go to
		// the next daemon process first (B-13).
		d.HandOverListeners()
		cancel()
	}()

	if err := d.Run(ctx); err != nil {
		lifecycle.LogDaemonExit(logger, "daemon exited with error", err)
		os.Exit(lifecycle.DaemonExitCode(err))
	}
}

func defaultNginxConfigDir() string { return "/etc/nginx/opfield/conf.d" }

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
		fmt.Fprintf(os.Stderr, "Usage: nginx-daemon install --opfield <address> --token <token> --opfield-cert-sha256 <sha256:hex>\n")
		os.Exit(1)
	}

	var address, token, certSHA256 string
	for i := 2; i < len(os.Args)-1; i++ {
		switch os.Args[i] {
		// legacy-name: legacycompat.AddressFlag and legacycompat.CertFlag of installers and scripts written before 2.12.1 — remove once
		// no installer passes them
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
	if !certSHA256Pattern.MatchString(certSHA256) {
		fmt.Fprintf(os.Stderr, "--opfield-cert-sha256 must use sha256:<64-hex> format\n")
		os.Exit(1)
	}

	configDir := "/etc/nginx-daemon"
	configPath := configDir + "/config.yaml"

	if err := os.MkdirAll(configDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create config dir: %v\n", err)
		os.Exit(1)
	}

	kept, err := writeInstallConfig(configPath, address, token, certSHA256)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write config: %v\n", err)
		os.Exit(1)
	}
	if kept {
		fmt.Printf("Kept the existing %s; set its Opfield address, token and certificate fingerprint\n", configPath)
	}
	fmt.Printf("Config written to %s\n", configPath)

	// Create systemd service unit
	serviceContent := `[Unit]
Description=Opfield Nginx Daemon
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/nginx-daemon run
Restart=always
RestartSec=5
Environment=NGINX_DAEMON_CONFIG=/etc/nginx-daemon/config.yaml
FileDescriptorStoreMax=4096
NotifyAccess=main

[Install]
WantedBy=multi-user.target
`
	servicePath := "/etc/systemd/system/nginx-daemon.service"
	if err := os.WriteFile(servicePath, []byte(serviceContent), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write systemd unit: %v\n", err)
		fmt.Println("You can start the daemon manually: nginx-daemon run")
	} else {
		fmt.Printf("Systemd service written to %s\n", servicePath)
		fmt.Println("Enable and start: systemctl enable --now nginx-daemon")
	}
}

// exitOnExtraArgs ends with the usage when run or version got arguments (lifecycle.ExtraArgs).
func exitOnExtraArgs() {
	if err := lifecycle.ExtraArgs(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "%v\nUsage: nginx-daemon [run|install|upgrade-nginx|version]\n", err)
		os.Exit(1)
	}
}
