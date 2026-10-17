package exec

import (
	"bytes"
	"context"
	"fmt"
	"os"
	osexec "os/exec"
)

type CommandResult struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr,omitempty"`
	ExitCode  int    `json:"exitCode"`
	Truncated bool   `json:"truncated,omitempty"`
	// TimedOut: the command was stopped at its time limit; the output is what
	// it wrote until then.
	TimedOut bool `json:"timedOut,omitempty"`
	// Agent console commands: the user the command ran as, how it was
	// sandboxed (AgentSandbox*) and, when the daemon is not root, what that
	// limits, as a sentence for the agent.
	RunAs   string `json:"runAs,omitempty"`
	Sandbox string `json:"sandbox,omitempty"`
	Limits  string `json:"limits,omitempty"`
}

type limitedBuffer struct {
	buf       bytes.Buffer
	limit     int64
	written   int64
	truncated bool
}

func (w *limitedBuffer) Write(p []byte) (int, error) {
	w.written += int64(len(p))
	if int64(w.buf.Len()) >= w.limit {
		w.truncated = true
		return len(p), nil
	}
	remaining := int(w.limit - int64(w.buf.Len()))
	if len(p) > remaining {
		w.buf.Write(p[:remaining])
		w.truncated = true
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

func (w *limitedBuffer) String() string {
	return w.buf.String()
}

func (w *limitedBuffer) Truncated() bool {
	return w.truncated || w.written > w.limit
}

// RunCommand executes a bounded one-shot command on the host OS.
// runAsUser is an optional OS username; empty means run as daemon's user.
func RunCommand(ctx context.Context, command []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	if len(command) == 0 {
		return CommandResult{}, fmt.Errorf("command is required")
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 128 * 1024
	}

	cmd := osexec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Env = os.Environ()

	if err := applyRunAsUser(cmd, runAsUser); err != nil {
		return CommandResult{}, err
	}

	stdout := &limitedBuffer{limit: maxOutputBytes}
	stderr := &limitedBuffer{limit: maxOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}

	result := CommandResult{
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		ExitCode:  exitCode,
		Truncated: stdout.Truncated() || stderr.Truncated(),
	}
	if err != nil {
		return result, err
	}
	return result, nil
}
