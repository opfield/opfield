package lifecycle

import (
	"fmt"
	"strconv"
	"strings"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// Protected mode is for a node installed on a machine the Gateway operator
// does not own (a relay on a trusted third party's host). The node owner turns
// it on in the daemon's local config file; nothing Gateway sends can turn it
// off. In protected mode the daemon refuses every command that reaches into
// the host (console, one-shot commands, file access, host diagnostics) and
// every command it does not know to be safe, reports only aggregate resource
// usage instead of the host inventory, and accepts no update to an older
// release. Updates stay limited to artifacts signed with the embedded release
// key, as for every daemon.
const (
	// NodeProtectedCapability marks a daemon running in protected mode.
	NodeProtectedCapability = "node_protected_v1"

	protectedModeRefusal = "refused: this node runs in protected mode, set by its owner in the daemon's local configuration. Opfield cannot open a console, run commands, read or write files or collect host diagnostics on it; it can only update it with official signed releases and route traffic through it"
)

// ProtectedModePlugin is implemented by plugins that can run in protected
// mode (the relay supervisor).
type ProtectedModePlugin interface {
	// ProtectedMode reports whether the node owner turned protected mode on
	// in the local config. It does not change while the process runs.
	ProtectedMode() bool
	// ProtectedCommandAllowed reports whether a daemon-specific command may
	// run in protected mode. Commands not listed here are refused.
	ProtectedCommandAllowed(cmd *pb.GatewayCommand) bool
}

// pluginProtected reports whether the plugin runs in protected mode.
func pluginProtected(plugin DaemonPlugin) bool {
	protected, ok := plugin.(ProtectedModePlugin)
	return ok && protected.ProtectedMode()
}

// protectedCommandAllowed reports whether cmd may run on a protected node.
// The shared lifecycle allows only health and stats requests, the log stream
// switch for the daemon's own logs, a signed daemon update and the fixed
// host-identity read (Gateway's own file, no caller-chosen path). Everything
// else must be allowed by the plugin.
func protectedCommandAllowed(plugin DaemonPlugin, cmd *pb.GatewayCommand) bool {
	switch payload := cmd.GetPayload().(type) {
	case *pb.GatewayCommand_RequestHealth,
		*pb.GatewayCommand_RequestStats,
		*pb.GatewayCommand_SetDaemonLogStream,
		*pb.GatewayCommand_UpdateDaemon:
		return true
	case *pb.GatewayCommand_NodeFile:
		return payload.NodeFile.GetAction() == "ensure-host-identity"
	case *pb.GatewayCommand_NodeExec, *pb.GatewayCommand_ExecInput:
		return false
	}
	protected, ok := plugin.(ProtectedModePlugin)
	return ok && protected.ProtectedCommandAllowed(cmd)
}

// refuseProtectedCommand returns the refusal for a command a protected node
// does not run, or nil when it may run (or the node is not protected).
func refuseProtectedCommand(protected bool, plugin DaemonPlugin, cmd *pb.GatewayCommand) *pb.CommandResult {
	if !protected || protectedCommandAllowed(plugin, cmd) {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.GetCommandId(), Success: false, Error: protectedModeRefusal}
}

// protectedCapabilities lists the registration markers of a protected node:
// protected mode itself, and the host console and file access it disables,
// so Gateway versions that know only those markers hide them as well.
func protectedCapabilities(protected bool) []string {
	if !protected {
		return nil
	}
	return []string{NodeProtectedCapability, NodeConsoleDisabledCapability, NodeFilesDisabledCapability}
}

// protectRegistration removes host details a protected node does not report.
// Hostname, architecture (updates are chosen by it) and core count stay.
func protectRegistration(protected bool, register *pb.RegisterMessage) {
	if !protected || register == nil {
		return
	}
	register.CpuModel = ""
	register.KernelVersion = ""
}

// ProtectedUpdateRefusal returns why a protected node refuses an update from
// the running version to target, or "" when it may install it. A protected
// node accepts only the same or a newer release: an older one (signed, but
// from before protected mode, or with its fixes missing) could reopen the host.
func ProtectedUpdateRefusal(running, target string) string {
	runningVersion, runningOK := parseReleaseVersion(running)
	targetVersion, targetOK := parseReleaseVersion(target)
	if !targetOK {
		return fmt.Sprintf("refused: this node runs in protected mode and installs only release versions; %q is not one", target)
	}
	if !runningOK {
		return fmt.Sprintf("refused: this node runs in protected mode and cannot compare its version %q with %s", running, target)
	}
	if compareReleaseVersions(targetVersion, runningVersion) < 0 {
		return fmt.Sprintf("refused: this node runs in protected mode and accepts no update to an older release (%s is older than the running %s)", target, running)
	}
	return ""
}

type releaseVersion struct {
	core       [3]int
	prerelease []string
}

// parseReleaseVersion parses vMAJOR.MINOR.PATCH with an optional
// -prerelease and +build suffix (the build suffix is ignored).
func parseReleaseVersion(value string) (releaseVersion, bool) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	if index := strings.IndexByte(value, '+'); index >= 0 {
		value = value[:index]
	}
	var version releaseVersion
	core := value
	if index := strings.IndexByte(value, '-'); index >= 0 {
		core = value[:index]
		prerelease := value[index+1:]
		if prerelease == "" {
			return releaseVersion{}, false
		}
		version.prerelease = strings.Split(prerelease, ".")
		for _, part := range version.prerelease {
			if part == "" {
				return releaseVersion{}, false
			}
		}
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return releaseVersion{}, false
	}
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 || part == "" {
			return releaseVersion{}, false
		}
		version.core[index] = number
	}
	return version, true
}

// compareReleaseVersions orders versions as semantic versions do: a
// prerelease comes before its release.
func compareReleaseVersions(a, b releaseVersion) int {
	for index := range a.core {
		if a.core[index] != b.core[index] {
			if a.core[index] < b.core[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a.prerelease) == 0 && len(b.prerelease) == 0:
		return 0
	case len(a.prerelease) == 0:
		return 1
	case len(b.prerelease) == 0:
		return -1
	}
	for index := 0; index < len(a.prerelease) && index < len(b.prerelease); index++ {
		left, right := a.prerelease[index], b.prerelease[index]
		if left == right {
			continue
		}
		leftNumber, leftErr := strconv.Atoi(left)
		rightNumber, rightErr := strconv.Atoi(right)
		switch {
		case leftErr == nil && rightErr == nil:
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		case leftErr == nil:
			return -1
		case rightErr == nil:
			return 1
		case left < right:
			return -1
		default:
			return 1
		}
	}
	switch {
	case len(a.prerelease) < len(b.prerelease):
		return -1
	case len(a.prerelease) > len(b.prerelease):
		return 1
	}
	return 0
}

// protectedUpdateRefusal returns why this daemon refuses a self-update to
// target in protected mode, or "" when it may install it.
func (d *DaemonBase) protectedUpdateRefusal(target string) string {
	if !d.protected {
		return ""
	}
	return ProtectedUpdateRefusal(Version, target)
}

// commandKind names the payload of a command for logs (node_exec, node_file, ...).
func commandKind(cmd *pb.GatewayCommand) string {
	message := cmd.ProtoReflect()
	oneof := message.Descriptor().Oneofs().ByName("payload")
	if oneof == nil {
		return "unknown"
	}
	field := message.WhichOneof(oneof)
	if field == nil {
		return "empty"
	}
	return string(field.Name())
}
