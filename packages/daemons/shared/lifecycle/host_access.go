package lifecycle

import (
	"errors"
	"fmt"
	"log/slog"

	"github.com/opfield/opfield/daemon-shared/exec"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Host access switches live only in the daemon config file on the node, so
// the Gateway cannot turn a disabled feature back on remotely. The daemon
// advertises a disabled feature at registration so the Gateway refuses it
// before dispatching a command.
const (
	NodeConsoleDisabledCapability = "node_console_disabled_v1"
	NodeFilesDisabledCapability   = "node_files_disabled_v1"
	// NodeConsoleUserUnavailableCapability marks a console.user this daemon
	// cannot start sessions as; every console session is refused.
	NodeConsoleUserUnavailableCapability = "node_console_user_unavailable_v1"

	nodeConsoleDisabledError = "console is disabled in this node's daemon configuration (set console.enabled: true in the daemon config file and restart the daemon to enable it)"
	nodeFilesDisabledError   = "file access is disabled in this node's daemon configuration (set files.enabled: true in the daemon config file and restart the daemon to enable it)"
)

// IsEnabled reports whether the host console is enabled (default true).
func (c ConsoleConfig) IsEnabled() bool {
	return c.Enabled == nil || *c.Enabled
}

// IsEnabled reports whether host file access is enabled (default true).
func (c FilesConfig) IsEnabled() bool {
	return c.Enabled == nil || *c.Enabled
}

// hostAccessCapabilities lists the registration markers for the host access
// features this config disables.
func (c *BaseConfig) hostAccessCapabilities() []string {
	var values []string
	if !c.Console.IsEnabled() {
		values = append(values, NodeConsoleDisabledCapability)
	}
	if !c.Files.IsEnabled() {
		values = append(values, NodeFilesDisabledCapability)
	}
	return values
}

// refuseDisabledNodeExec returns the refusal for a node console command when
// the console is disabled, or nil when the command may run. Every node exec
// action (create, resize, run) is refused.
func refuseDisabledNodeExec(cfg *BaseConfig, cmd *pb.OpfieldCommand) *pb.CommandResult {
	if cfg.Console.IsEnabled() {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: false, Error: nodeConsoleDisabledError}
}

// refuseDisabledNodeFile returns the refusal for a node file command when
// file access is disabled, or nil when the command may run. The fixed
// ensure-host-identity operation is not host file access (callers choose no
// path) and stays available.
func refuseDisabledNodeFile(cfg *BaseConfig, cmd *pb.OpfieldCommand) *pb.CommandResult {
	if cfg.Files.IsEnabled() || cmd.GetNodeFile().GetAction() == "ensure-host-identity" {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: false, Error: nodeFilesDisabledError}
}

// consoleUserRefusal is the refusal for every console session when
// console.user names a user this daemon cannot switch to, or "" when the
// console may run as the configured user. Root daemons can switch to any
// user; others only run sessions as themselves.
func consoleUserRefusal(cfg *BaseConfig) string {
	if !cfg.Console.IsEnabled() || cfg.Console.User == "" {
		return ""
	}
	err := exec.CheckRunAsUser(cfg.Console.User)
	if !errors.Is(err, exec.ErrCannotSwitchUser) {
		return ""
	}
	return fmt.Sprintf("console.user %q needs a root daemon: %v. Remove console.user from the daemon config file, or run the daemon as root, and restart the daemon.", cfg.Console.User, err)
}

// checkConsoleUser runs once at startup: it logs why console.user cannot be
// used and returns the refusal for console sessions. A user that does not
// exist yet only gets a warning; its sessions fail until it is created.
func checkConsoleUser(cfg *BaseConfig, logger *slog.Logger) string {
	refusal := consoleUserRefusal(cfg)
	if refusal != "" {
		logger.Error("console.user cannot be used; console sessions are refused", "console_user", cfg.Console.User, "reason", refusal)
		return refusal
	}
	if cfg.Console.IsEnabled() && cfg.Console.User != "" {
		if err := exec.CheckRunAsUser(cfg.Console.User); err != nil {
			logger.Warn("console.user is not a user on this host; console sessions fail until it exists", "console_user", cfg.Console.User, "error", err)
		}
	}
	return ""
}

// refuseUnavailableConsoleUser returns the refusal for a node console command
// when console.user cannot be used, or nil when the command may run.
func refuseUnavailableConsoleUser(refusal string, cmd *pb.OpfieldCommand) *pb.CommandResult {
	if refusal == "" {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: false, Error: refusal}
}
