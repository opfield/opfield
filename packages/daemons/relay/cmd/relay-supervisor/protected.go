package main

import (
	"fmt"
	"io"
	"os"

	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"github.com/opfield/opfield/relay-supervisor/internal/hostnames"
)

// protectedUsage names the service and configuration file of this node: the
// Opfield ones, or the pre-Opfield ones until the node moved to them.
func protectedUsage() string {
	return `Usage: relay-supervisor protected <status|on|off> [--allow-database-witness]
  status                    Show whether protected mode is on in the relay configuration
  on                        Turn protected mode on: Opfield can no longer open a console, run commands,
                            read or write files or collect host diagnostics on this machine; it can
                            only update the relay with official signed releases and route traffic
  on --allow-database-witness
                            Turn protected mode on and allow database availability witness processes
  off                       Turn protected mode off
The change applies when the relay supervisor restarts:
  ` + restartCommand() + `
The configuration file is RELAY_SUPERVISOR_CONFIG, or ` + hostnames.DefaultConfigPath() + `.`
}

// restartCommand is how the machine owner restarts the relay supervisor.
func restartCommand() string {
	service := hostnames.RunningServiceName()
	return "systemctl restart " + service + " (OpenRC: rc-service " + service + " restart)"
}

func supervisorConfigPath() string {
	if path := os.Getenv("RELAY_SUPERVISOR_CONFIG"); path != "" {
		return path
	}
	return hostnames.DefaultConfigPath()
}

// runProtectedCommand runs `relay-supervisor protected ...` and returns the
// exit code. It edits only the local configuration file: protected mode is
// the machine owner's setting, and the running supervisor picks it up on its
// next start.
func runProtectedCommand(args []string, configPath string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, protectedUsage())
		return 2
	}
	action, rest := args[0], args[1:]
	allowWitness := false
	for _, arg := range rest {
		if arg == "--allow-database-witness" && action == "on" {
			allowWitness = true
			continue
		}
		fmt.Fprintf(stderr, "unexpected argument %q\n%s\n", arg, protectedUsage())
		return 2
	}
	switch action {
	case "status":
		cfg, err := config.Load(configPath)
		if err != nil {
			fmt.Fprintf(stderr, "load relay supervisor config: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, protectedStatus(cfg.Protected))
		return 0
	case "on", "off":
		if _, err := config.Load(configPath); err != nil {
			fmt.Fprintf(stderr, "load relay supervisor config: %v\n", err)
			return 1
		}
		enabled := action == "on"
		if err := config.SetProtected(configPath, enabled, enabled && allowWitness); err != nil {
			fmt.Fprintf(stderr, "update %s: %v\n", configPath, err)
			return 1
		}
		fmt.Fprintf(stdout, "%s written to %s.\n", protectedStatus(config.ProtectedConfig{Enabled: enabled, AllowDatabaseWitness: enabled && allowWitness}), configPath)
		fmt.Fprintln(stdout, "Restart the relay supervisor to apply it: "+restartCommand()+".")
		return 0
	case "-h", "--help", "help":
		fmt.Fprintln(stdout, protectedUsage())
		return 0
	default:
		fmt.Fprintf(stderr, "unknown action %q\n%s\n", action, protectedUsage())
		return 2
	}
}

func protectedStatus(protected config.ProtectedConfig) string {
	if !protected.Enabled {
		return "Protected mode: off"
	}
	if protected.AllowDatabaseWitness {
		return "Protected mode: on (database availability witness allowed)"
	}
	return "Protected mode: on (database availability witness not allowed)"
}
