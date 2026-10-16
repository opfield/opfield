package builder

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
)

// commandOutputTailBytes bounds the end of a command's output kept to explain its failure.
const commandOutputTailBytes = 64 * 1024

// commandFailureMaxBytes bounds the failure summary sent as the build's error message.
const commandFailureMaxBytes = 2048

// outputTail keeps the last bytes of a command's (already redacted) output.
type outputTail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *outputTail) write(chunk []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, chunk...)
	if extra := len(t.buf) - commandOutputTailBytes; extra > 0 {
		t.buf = append([]byte(nil), t.buf[extra:]...)
	}
}

func (t *outputTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// commandFailure is a failed builder command: the cause its own output names (the failing Dockerfile step and its
// exit code for a build) instead of only the process exit status.
type commandFailure struct {
	summary string
	err     error
}

func (f *commandFailure) Error() string { return f.summary }
func (f *commandFailure) Unwrap() error { return f.err }

var (
	ansiEscape = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	// BuildKit progress prefixes a step's lines with "#<n> <seconds>".
	stepPrefix      = regexp.MustCompile(`^#\d+(?:\s+\d+(?:\.\d+)?)?\s+`)
	dockerfileLine  = regexp.MustCompile(`^(?:\S*/)?(?:Dockerfile|Containerfile)[^\s:]*:\d+$`)
	snippetMarker   = regexp.MustCompile(`^\s*\d+\s*\|\s*>>>\s?(.*)$`)
	exitCodePattern = regexp.MustCompile(`exit code: (\d+)`)
)

// describeCommandFailure turns a failed command into an error that names what failed: for BuildKit, the final
// `error:` line (the failing step's command and exit code) with the Dockerfile line it points at; for any other
// command, its last error line. Without such a line the exit status is kept. The output was redacted before it got
// here, so the summary holds no Build Secret.
func describeCommandFailure(name string, err error, output string) error {
	var exitErr *exec.ExitError
	if err == nil || !errors.As(err, &exitErr) {
		return err
	}
	summary := commandFailureSummary(output)
	if summary == "" {
		return err
	}
	if !exitCodePattern.MatchString(summary) {
		summary = fmt.Sprintf("%s (%s %s)", summary, name, err.Error())
	}
	if len(summary) > commandFailureMaxBytes {
		summary = summary[:commandFailureMaxBytes]
	}
	return &commandFailure{summary: summary, err: err}
}

func commandFailureSummary(output string) string {
	lines := strings.Split(ansiEscape.ReplaceAllString(output, ""), "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(stepPrefix.ReplaceAllString(lines[i], ""), " \r\t")
	}
	cause := ""
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "error:") || strings.HasPrefix(lower, "fatal:") {
			cause = strings.TrimSpace(line[strings.Index(line, ":")+1:])
			break
		}
	}
	if cause == "" {
		for i := len(lines) - 1; i >= 0; i-- {
			if line := strings.TrimSpace(lines[i]); line != "" {
				cause = line
				break
			}
		}
	}
	if cause == "" {
		return ""
	}
	// BuildKit prints the Dockerfile position of the failing step ("Dockerfile:3") and a snippet whose ">>>" line is
	// the failing instruction.
	location := ""
	for i := len(lines) - 1; i >= 0; i-- {
		if !dockerfileLine.MatchString(strings.TrimSpace(lines[i])) {
			continue
		}
		location = strings.TrimSpace(lines[i])
		for _, next := range lines[i+1:] {
			if match := snippetMarker.FindStringSubmatch(next); match != nil {
				if instruction := strings.TrimSpace(match[1]); instruction != "" {
					location += " `" + instruction + "`"
				}
				break
			}
		}
		break
	}
	if location != "" {
		return location + ": " + cause
	}
	return cause
}
