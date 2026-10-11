package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/docker"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
)

var gatewayCertSHA256Pattern = regexp.MustCompile(`^sha256:[0-9a-fA-F]{64}$`)

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
			fmt.Printf("docker-daemon %s\n", Version)
			return
		case "install":
			runInstall()
			return
		case "runtime":
			os.Exit(runRuntimeCommand(os.Args[2:]))
		case "mount-volume-images":
			os.Exit(runMountVolumeImages(os.Args[2:]))
		case "hold-link-listeners":
			os.Exit(runHoldLinkListeners(os.Args[2:]))
		case "availability":
			os.Exit(runAvailabilityCommand(os.Args[2:], os.Stdout, os.Stderr))
		case "run":
			exitOnExtraArgs()
			// explicit run, continue below
		default:
			fmt.Fprintf(os.Stderr, "Usage: docker-daemon [run|install|runtime|mount-volume-images|hold-link-listeners|availability|version]\n")
			os.Exit(1)
		}
	}
	if err := lifecycle.BootstrapLauncher(lifecycle.LauncherSpec{
		DaemonType: "docker",
		StateDir:   "/var/lib/docker-daemon",
		ChildArgs:  os.Args[1:],
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher unavailable; continuing in direct mode: %v\n", err)
	}
	// Default: run the daemon
	configPath := os.Getenv("DOCKER_DAEMON_CONFIG")
	if configPath == "" {
		configPath = "/etc/docker-daemon/config.yaml"
	}

	logger := setupLogger("info", "json")

	cfg, err := config.Load(configPath)
	if err != nil {
		logger.Error("failed to load config", "path", configPath, "error", err)
		os.Exit(1)
	}
	logger = setupLogger(cfg.LogLevel, cfg.LogFormat)
	logger.Info("starting docker-daemon", "version", Version, "config", configPath)

	plugin := docker.NewDockerPlugin(cfg)

	d, err := lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, plugin, logger)
	if err != nil {
		logger.Error("failed to initialize daemon", "error", err)
		os.Exit(1)
	}
	lifecycle.NotifyLauncherLocalReadyAwaitingControl(Version)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		// While the relays are still reachable: they hold this daemon's
		// traffic for its next process instead of dropping it (B-13).
		d.PrepareShutdown()
		cancel()
	}()

	if err := d.Run(ctx); err != nil {
		lifecycle.LogDaemonExit(logger, "daemon exited with error", err)
		os.Exit(lifecycle.DaemonExitCode(err))
	}
}

// runMountVolumeImages is the boot step the daemon installs before Docker:
// it mounts the disk-image volume images, or makes the mount point of one
// that cannot be mounted read-only (see docker.MountVolumeImagesAtBoot).
func runMountVolumeImages(args []string) int {
	flags := flag.NewFlagSet("mount-volume-images", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	stateDir := flags.String("state-dir", "/var/lib/docker-daemon", "daemon state directory")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	logger := setupLogger("info", "text")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if err := docker.MountVolumeImagesAtBoot(ctx, *stateDir, logger); err != nil {
		logger.Error("disk-image volumes are not all mounted", "error", err)
		return 1
	}
	return 0
}

// runHoldLinkListeners is the boot step the daemon installs before Docker: it opens the database link listeners the
// daemon held last, so workloads Docker starts at boot are not refused (see docker.HoldLinkListenersAtBoot).
func runHoldLinkListeners(args []string) int {
	flags := flag.NewFlagSet("hold-link-listeners", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	stateDir := flags.String("state-dir", "/var/lib/docker-daemon", "daemon state directory")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	logger := setupLogger("info", "text")
	if err := docker.HoldLinkListenersAtBoot(*stateDir, logger); err != nil {
		logger.Error("database link listeners are not open before Docker", "error", err)
		return 1
	}
	return 0
}

func runRuntimeCommand(args []string) int {
	if len(args) < 2 || (args[0] != "preflight" && args[0] != "install") || args[1] != "runsc" {
		fmt.Fprintln(os.Stderr, "Usage: docker-daemon runtime [preflight|install] runsc [--json|--plain] [--non-interactive] [--silent]")
		return 2
	}
	flags := flag.NewFlagSet("runtime", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	jsonOutput := flags.Bool("json", false, "write structured JSON status")
	plainOutput := flags.Bool("plain", false, "write a single plain-text status line")
	_ = flags.Bool("non-interactive", false, "disable interactive prompts")
	silent := flags.Bool("silent", false, "suppress progress and status output")
	if err := flags.Parse(args[2:]); err != nil {
		return 2
	}
	if *jsonOutput && *plainOutput {
		fmt.Fprintln(os.Stderr, "--json and --plain are mutually exclusive")
		return 2
	}
	manager := runtimemanager.NewManager()
	if !*silent && !*jsonOutput && !*plainOutput {
		manager.ProgressWriter = os.Stdout
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	status := manager.Preflight(ctx)
	var commandErr error
	if args[0] == "install" {
		status, commandErr = manager.Install(ctx)
	}
	if !*silent {
		switch {
		case *jsonOutput:
			encoded, _ := json.Marshal(status)
			fmt.Println(string(encoded))
		case *plainOutput:
			fmt.Printf("%s\t%s\t%s\n", status.State, status.ReasonCode, status.Message)
		default:
			fmt.Printf("Secure Runtime: %s\n", status.State)
			if status.InstalledVersion != "" {
				fmt.Printf("Installed version: %s\n", status.InstalledVersion)
			}
			if status.Message != "" {
				fmt.Println(status.Message)
			}
			if !status.RemoteInstallable && status.LocalInstallCommand != "" {
				fmt.Printf("Local setup: %s\n", status.LocalInstallCommand)
			}
		}
	}
	if commandErr != nil && !*silent {
		fmt.Fprintln(os.Stderr, commandErr)
	}
	return runtimeCommandExitCode(status.State, commandErr)
}

// runtimeCommandExitCode reports the runtime state; an install that did not install never exits 0.
func runtimeCommandExitCode(state runtimemanager.State, commandErr error) int {
	switch state {
	case runtimemanager.StateHealthy:
		if commandErr != nil {
			return 30
		}
		return 0
	case runtimemanager.StateInstallable:
		return 10
	case runtimemanager.StateUnsupported:
		return 20
	default:
		return 30
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
		fmt.Fprintf(os.Stderr, "Usage: docker-daemon install --gateway <address> --token <token> --gateway-cert-sha256 <sha256:hex> [--mode builder] [--docker-socket <host>]\n")
		os.Exit(1)
	}

	var address, token, certSHA256, dockerSocket, mode string
	for i := 2; i < len(os.Args)-1; i++ {
		switch os.Args[i] {
		case "--gateway":
			address = os.Args[i+1]
		case "--token":
			token = os.Args[i+1]
		case "--gateway-cert-sha256":
			certSHA256 = os.Args[i+1]
		case "--docker-socket":
			dockerSocket = os.Args[i+1]
		case "--mode":
			mode = os.Args[i+1]
		}
	}

	if address == "" || token == "" || certSHA256 == "" {
		fmt.Fprintf(os.Stderr, "--gateway, --token, and --gateway-cert-sha256 are required\n")
		os.Exit(1)
	}
	if !gatewayCertSHA256Pattern.MatchString(certSHA256) {
		fmt.Fprintf(os.Stderr, "--gateway-cert-sha256 must use sha256:<64-hex> format\n")
		os.Exit(1)
	}
	if mode != "" && mode != "builder" {
		fmt.Fprintln(os.Stderr, "--mode must be omitted or set to builder")
		os.Exit(1)
	}

	configDir := "/etc/docker-daemon"
	configPath := configDir + "/config.yaml"
	if mode != "builder" && dockerSocket == "" {
		dockerSocket = detectDockerSocket()
	}
	if mode == "builder" && dockerSocket != "" {
		fmt.Fprintln(os.Stderr, "--docker-socket is not allowed in builder mode")
		os.Exit(1)
	}

	if err := os.MkdirAll(configDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create config dir: %v\n", err)
		os.Exit(1)
	}

	dockerConfig := fmt.Sprintf("  socket: %q\n  allowlist: [\"*\"]\n", dockerSocket)
	if mode == "builder" {
		dockerConfig = "  mode: \"builder\"\n"
	}
	configContent := fmt.Sprintf(`gateway:
  address: "%s"
  token: "%s"
  cert_sha256: "%s"

tls:
  ca_cert: "/etc/docker-daemon/certs/ca.pem"
  client_cert: "/etc/docker-daemon/certs/node.pem"
  client_key: "/etc/docker-daemon/certs/node-key.pem"

state_dir: "/var/lib/docker-daemon"
log_level: "info"
log_format: "json"

docker:
%s`, address, token, certSHA256, dockerConfig)

	if err := os.WriteFile(configPath, []byte(configContent), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Config written to %s\n", configPath)

	// Create systemd service unit
	serviceContent := dockerDaemonSystemdUnitForMode(mode)
	servicePath := "/etc/systemd/system/docker-daemon.service"
	if err := os.WriteFile(servicePath, []byte(serviceContent), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write systemd unit: %v\n", err)
		fmt.Println("You can start the daemon manually: docker-daemon run")
	} else {
		fmt.Printf("Systemd service written to %s\n", servicePath)
		fmt.Println("Enable and start: systemctl enable --now docker-daemon")
	}
}

func detectDockerSocket() string {
	out, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err == nil {
		host := strings.TrimSpace(string(out))
		if host != "" && host != "<no value>" {
			return host
		}
	}
	return "unix:///var/run/docker.sock"
}

func dockerDaemonSystemdUnit() string {
	return dockerDaemonSystemdUnitForMode("")
}

func dockerDaemonSystemdUnitForMode(mode string) string {
	if mode == "builder" {
		return dockerDaemonSystemdUnitForDockerUnit("")
	}
	return dockerDaemonSystemdUnitForDockerUnit(detectDockerSystemdUnit())
}

func dockerDaemonSystemdUnitForDockerUnit(unit string) string {
	after := "network-online.target"
	wants := "network-online.target"
	if unit != "" {
		after += " " + unit
		wants += " " + unit
	}
	return fmt.Sprintf(`[Unit]
Description=Gateway Docker Daemon
After=%s
Wants=%s

[Service]
Type=simple
ExecStart=/usr/local/bin/docker-daemon run
Restart=always
RestartSec=5
Environment=DOCKER_DAEMON_CONFIG=/etc/docker-daemon/config.yaml
# Link sockets outlive a daemon restart in the file descriptor store.
FileDescriptorStoreMax=4096
NotifyAccess=main

[Install]
WantedBy=multi-user.target
`, after, wants)
}

func detectDockerSystemdUnit() string {
	for _, unit := range []string{"docker.service", "snap.docker.dockerd.service"} {
		if systemdUnitExists(unit) {
			return unit
		}
	}
	return ""
}

func systemdUnitExists(unit string) bool {
	if err := exec.Command("systemctl", "cat", unit).Run(); err == nil {
		return true
	}
	out, err := exec.Command("systemctl", "list-unit-files", "--type=service", "--no-legend", unit).Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == unit {
			return true
		}
	}
	return false
}

// exitOnExtraArgs ends with the usage when run or version got arguments (lifecycle.ExtraArgs).
func exitOnExtraArgs() {
	if err := lifecycle.ExtraArgs(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "%v\nUsage: docker-daemon [run|install|runtime|mount-volume-images|hold-link-listeners|version]\n", err)
		os.Exit(1)
	}
}
