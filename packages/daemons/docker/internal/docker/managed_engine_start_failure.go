package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// An engine that dies while it starts (a crash, a config the server refuses,
// a CPU without an instruction it needs) fails the operation at once with
// what it died of and its last log lines, instead of the readiness timeout.
// The log of the failed start is kept on the node, so the database's logs
// still show it after the container is removed (a create that failed has no
// record and no container).

const (
	// engineFailureLogLines is how many log lines of a failed start the node keeps.
	engineFailureLogLines = 500
	// engineFailureExcerptBytes bounds the log excerpt an error carries
	// (Opfield keeps about 480 characters of an operation error).
	engineFailureExcerptBytes = 280
)

// errEngineExited marks an engine that stopped while the daemon waited for it.
var errEngineExited = errors.New("managed database engine exited during start")

// engineExit is the state of an engine container that stopped by itself.
type engineExit struct {
	ExitCode  int
	OOMKilled bool
}

// crashedEngine reports how the engine container exited when it stopped by
// itself: a non-zero exit, a signal or an out-of-memory kill. A container
// that runs, restarts or was stopped on purpose (exit 0, SIGTERM, SIGKILL
// without OOM) is not a crash.
func (m *managedDatabaseManager) crashedEngine(ctx context.Context, containerID string) (engineExit, bool) {
	inspect, err := m.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil {
		return engineExit{}, false
	}
	state := inspect.Container.State
	if state.Running || state.Restarting || state.Paused {
		return engineExit{}, false
	}
	exit := engineExit{ExitCode: state.ExitCode, OOMKilled: state.OOMKilled}
	return exit, engineExitIsCrash(exit)
}

func engineExitIsCrash(exit engineExit) bool {
	if exit.OOMKilled {
		return true
	}
	switch exit.ExitCode {
	case 0, 128 + 9, 128 + 15:
		return false
	}
	return exit.ExitCode > 0
}

// describeEngineExit names an exit: the code and the signal it stands for.
func describeEngineExit(exit engineExit) string {
	if exit.OOMKilled {
		return fmt.Sprintf("exit code %d (killed for memory: out of memory)", exit.ExitCode)
	}
	switch exit.ExitCode {
	case 128 + 4:
		return "exit code 132 (SIGILL, illegal instruction: the CPU lacks an instruction the engine needs)"
	case 128 + 6:
		return "exit code 134 (SIGABRT, the engine aborted)"
	case 128 + 7:
		return "exit code 135 (SIGBUS, bus error)"
	case 128 + 8:
		return "exit code 136 (SIGFPE, arithmetic fault)"
	case 128 + 11:
		return "exit code 139 (SIGSEGV, segmentation fault)"
	}
	if exit.ExitCode > 128 {
		return fmt.Sprintf("exit code %d (signal %d)", exit.ExitCode, exit.ExitCode-128)
	}
	return fmt.Sprintf("exit code %d", exit.ExitCode)
}

// engineExitError is the error of an engine that crashed while it started,
// with the lines of its log that say why.
func engineExitError(exit engineExit, lines []string) error {
	suffix := ""
	if excerpt := engineLogExcerpt(lines); excerpt != "" {
		suffix = "; last log: " + excerpt
	}
	return fmt.Errorf("%w with %s%s", errEngineExited, describeEngineExit(exit), suffix)
}

// engineLogExcerpt picks the log lines that say why an engine died: the
// first crash line of a Valkey/Redis crash report (its register dump and
// stack follow and say nothing to an operator) and the lines before the
// report, else the last lines, newest last, within engineFailureExcerptBytes.
func engineLogExcerpt(lines []string) string {
	cleaned := make([]string, 0, len(lines))
	for _, line := range lines {
		if line = strings.TrimSpace(line); line != "" {
			cleaned = append(cleaned, line)
		}
	}
	picked := cleaned
	for index, line := range cleaned {
		if !strings.Contains(line, "BUG REPORT START") {
			continue
		}
		picked = append([]string{}, cleaned[:index]...)
		for _, after := range cleaned[index+1:] {
			if strings.Contains(after, "crashed by signal") {
				picked = append(picked, after)
				break
			}
		}
		break
	}
	excerpt := ""
	for index := len(picked) - 1; index >= 0; index-- {
		candidate := picked[index]
		if excerpt != "" {
			candidate += " | " + excerpt
		}
		if len(candidate) > engineFailureExcerptBytes {
			if excerpt == "" {
				excerpt = "…" + strings.ToValidUTF8(picked[index][len(picked[index])-engineFailureExcerptBytes+1:], "")
			}
			break
		}
		excerpt = candidate
	}
	return excerpt
}

func (m *managedDatabaseManager) failureLogPath(id string) string {
	return filepath.Join(m.root, "failures", id+".json")
}

// engineFailureLog is the log of an engine's last failed start.
type engineFailureLog struct {
	ContainerID string    `json:"containerId"`
	Error       string    `json:"error"`
	FailedAt    time.Time `json:"failedAt"`
	Lines       []string  `json:"lines"`
}

// keepFailedStartLog reads the log of a container whose start failed, before
// it is removed, keeps it for the database's logs and returns it.
func (m *managedDatabaseManager) keepFailedStartLog(ctx context.Context, id, containerID string, cause error) []string {
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	lines, err := m.client.ContainerLogs(readCtx, containerID, engineFailureLogLines, true, "", "")
	if err != nil {
		m.logger.Warn("read the log of a managed database engine that failed to start", "id", id, "error", err)
		return nil
	}
	record := engineFailureLog{ContainerID: containerID, FailedAt: time.Now().UTC(), Lines: lines}
	if cause != nil {
		record.Error = cause.Error()
	}
	data, err := json.Marshal(record)
	if err == nil {
		if err = os.MkdirAll(filepath.Dir(m.failureLogPath(id)), 0700); err == nil {
			err = atomicfile.WriteFile(m.failureLogPath(id), data, 0600)
		}
	}
	if err != nil {
		m.logger.Warn("keep the log of a managed database engine that failed to start", "id", id, "error", err)
	}
	return withoutLogTimestamps(lines)
}

// withoutLogTimestamps drops the timestamp Docker puts before each line.
func withoutLogTimestamps(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if stamp, rest, ok := strings.Cut(line, " "); ok {
			if _, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
				line = rest
			}
		}
		out = append(out, line)
	}
	return out
}

// failedStartLog returns the kept log of the database's last failed start,
// the newest tail lines of it when tail is positive.
func (m *managedDatabaseManager) failedStartLog(id string, tail int, timestamps bool) ([]string, bool) {
	if !managedDatabaseIDPattern.MatchString(id) {
		return nil, false
	}
	data, err := os.ReadFile(m.failureLogPath(id))
	if err != nil {
		return nil, false
	}
	var record engineFailureLog
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, false
	}
	lines := record.Lines
	if !timestamps {
		lines = withoutLogTimestamps(lines)
	}
	if tail > 0 && len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	if lines == nil {
		lines = []string{}
	}
	return lines, true
}

// forgetFailedStart drops the kept log once the engine started, or with the database.
func (m *managedDatabaseManager) forgetFailedStart(id string) {
	if err := os.Remove(m.failureLogPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.logger.Warn("remove the kept log of a failed managed database start", "id", id, "error", err)
	}
}
