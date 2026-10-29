package lifecycle

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// ExtraArgs refuses arguments after a command that takes none (run, version): "run version", used as a version
// check, started a second daemon with its own launcher.
func ExtraArgs(args []string) error {
	if len(args) <= 2 {
		return nil
	}
	return fmt.Errorf("unexpected arguments after %q: %s", args[1], strings.Join(args[2:], " "))
}

// InstallTokenEnv carries the enrollment token to a daemon's install command. A command line argument is readable
// by every local user (ps, /proc/<pid>/cmdline) while the command runs; the environment only by its own user and
// root. The installers pass the token here; --token stays for automation that passes it on the command line.
const InstallTokenEnv = "OPFIELD_NODE_TOKEN"

// InstallTokenUsage names the ways an install command takes the enrollment token, for its usage line. The installers
// read it to tell whether the daemon takes the token from the environment.
const InstallTokenUsage = "the enrollment token comes from " + InstallTokenEnv + ", or --token <token> (--token - reads it from standard input)"

// InstallToken returns the enrollment token of an install command: the --token value when one was given ("-": the
// first line of stdin), else InstallTokenEnv. The variable is removed from the environment once read, so nothing
// the command starts inherits it.
func InstallToken(flag string, stdin io.Reader) (string, error) {
	environment := strings.TrimSpace(os.Getenv(InstallTokenEnv))
	_ = os.Unsetenv(InstallTokenEnv)
	switch flag {
	case "":
		return environment, nil
	case "-":
		line, err := bufio.NewReader(io.LimitReader(stdin, 4096)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", fmt.Errorf("read the enrollment token from standard input: %w", err)
		}
		return strings.TrimSpace(line), nil
	default:
		return flag, nil
	}
}
