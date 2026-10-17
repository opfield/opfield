//go:build !linux

package exec

import (
	"context"
	"errors"
)

// AgentSandboxSupported reports whether this build can run agent commands in
// the sandbox; only Linux daemons can.
func AgentSandboxSupported() bool { return false }

// RunAgentCommand refuses: the agent console sandbox needs Linux namespaces.
func RunAgentCommand(context.Context, []string, string, int64) (CommandResult, error) {
	return CommandResult{}, errors.New("agent console commands need the Linux sandbox, which this daemon build does not have")
}
