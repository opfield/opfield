package nginx

// nginx -t and -T create the pid file nginx.conf names (empty) when nginx is
// not running, and fail when they cannot:
//
//   - while the pid file's directory is missing: an nginx run by its own user
//     under systemd loses /run/nginx with RuntimeDirectory= whenever it stops,
//     and every nginx loses it with a reboot until its service creates it;
//   - while an empty pid file belongs to another user: a root nginx -t leaves
//     one, and Alpine's OpenRC service runs one before it starts an nginx run
//     by command_user, which then cannot start either (13: Permission
//     denied).
//
// The daemon repairs what its own rights allow and runs nginx once more. What
// only root can repair is the nginx service problem of the health report: one
// sentence with the command that fixes it.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	pidFileOpenFailure = regexp.MustCompile(`open\(\) "([^"]+)" failed \((2|13): `)
	nginxFailureLine   = regexp.MustCompile(`(?m)^.*\[(?:emerg|alert|crit)\].*$`)

	// Alpine's nginx service tests the configuration as root in start_pre
	// ($command $command_args -t -q). A checkpath of the pid file before it
	// gives the file to the user nginx runs as.
	openRCRootConfigTest   = regexp.MustCompile(`(?m)^\s*\$\{?command\}?\s+\$\{?command_args\}?\s+-t\b`)
	openRCPIDFileCheckpath = regexp.MustCompile(`(?m)^\s*checkpath\s(?:[^\n]*\s)?(?:-f|--file)\s[^\n]*\$\{?pidfile\}?\s*$`)

	// nginx -s reload fails like this while no nginx master runs: its pid file
	// is missing, empty (nginx -t leaves one) or names a process that is gone.
	// Only [error] and [alert] lines: a configuration file nginx cannot open
	// fails as [emerg] before nginx reads the pid file.
	nginxNotRunningFailure = regexp.MustCompile(`\[error\] [^\n]*open\(\) "[^"]+" failed \(2: |\[error\] [^\n]*invalid PID number "[^"]*" in "|\[alert\] [^\n]*kill\(\d+, \d+\) failed \(3: `)
)

// openRCPIDFileFix is the command that adds the pid file's checkpath to
// Alpine's nginx service, as the installer does (busybox and GNU sed).
const openRCPIDFileFix = `sed -i '/checkpath --directory/a checkpath --file --mode 0644 --owner "${command_user:-root:root}" ${pidfile}' /etc/init.d/nginx`

// Replaceable in tests: the host's nginx service files, and the effective uid
// the pid repairs act as.
var (
	openRCNginxService = "/etc/init.d/nginx"
	systemdRuntimeDir  = "/run/systemd/system"
	pidRepairEUID      = os.Geteuid
	runServiceCommand  = func(name string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), nginxServiceCommandTimeout)
		defer cancel()
		return exec.CommandContext(ctx, name, args...).CombinedOutput()
	}
)

const nginxServiceCommandTimeout = 90 * time.Second

// runNginx runs nginx with args. When nginx failed on its pid file, it repairs
// what the daemon may and runs nginx once more; what only root can repair is
// remembered for ServiceProblem until an nginx run succeeds.
func (m *Manager) runNginx(args ...string) ([]byte, error) {
	output, err := exec.Command(m.binary, args...).CombinedOutput()
	if err == nil {
		m.setPIDProblem("")
		return output, nil
	}
	repaired, problem := m.repairPIDFile(output)
	if repaired {
		output, err = exec.Command(m.binary, args...).CombinedOutput()
		if err == nil {
			m.setPIDProblem("")
			return output, nil
		}
		_, problem = m.repairPIDFile(output)
	}
	m.setPIDProblem(problem)
	return output, err
}

// repairPIDFile repairs the pid file a failed nginx run named, or says what
// root has to do.
func (m *Manager) repairPIDFile(output []byte) (bool, string) {
	match := pidFileOpenFailure.FindSubmatch(output)
	if match == nil {
		return false, ""
	}
	failed := filepath.Clean(string(match[1]))
	if pidFile, err := m.statedPIDFile(); err != nil || pidFile != failed {
		return false, ""
	}
	if string(match[2]) == "2" {
		if createPIDDirectory(failed) == nil {
			return true, ""
		}
		return false, fmt.Sprintf("nginx is not running and its pid directory %s is gone; start nginx as root: %s", filepath.Dir(failed), nginxStartCommand())
	}
	if removeForeignEmptyPIDFile(failed) == nil {
		return true, ""
	}
	return false, fmt.Sprintf("nginx's pid file %s belongs to another user; as root: rm %s", failed, failed)
}

func (m *Manager) setPIDProblem(problem string) {
	m.problemMu.Lock()
	m.pidProblem = problem
	m.problemMu.Unlock()
}

// ServiceProblem is a problem of the host's nginx service that only root can
// fix, with the command that fixes it, or "".
func (m *Manager) ServiceProblem(nginxRunning bool) string {
	if problem := openRCPIDFileProblem(nginxRunning); problem != "" {
		return problem
	}
	m.problemMu.Lock()
	defer m.problemMu.Unlock()
	return m.pidProblem
}

// openRCPIDFileProblem: Alpine's nginx service tests the configuration as
// root before it starts nginx as command_user. Without a checkpath of the pid
// file first, the test leaves the file to root whenever it is missing (after
// every stop and every reboot), and nginx run by the daemon's user cannot
// start again.
func openRCPIDFileProblem(nginxRunning bool) string {
	if pidRepairEUID() == 0 {
		return ""
	}
	source, err := os.ReadFile(openRCNginxService)
	if err != nil || !strings.HasPrefix(string(source), "#!/sbin/openrc-run\n") ||
		!openRCRootConfigTest.Match(source) || openRCPIDFileCheckpath.Match(source) {
		return ""
	}
	problem := "nginx cannot start again once stopped: /etc/init.d/nginx leaves its pid file to root; as root: " + openRCPIDFileFix
	if !nginxRunning {
		problem += " && rc-service nginx start"
	}
	return problem
}

func nginxStartCommand() string {
	if _, err := os.Stat(systemdRuntimeDir); err == nil {
		return "systemctl start nginx"
	}
	if hasOpenRCNginxService() {
		return "rc-service nginx start"
	}
	return "start its service"
}

func hasOpenRCNginxService() bool {
	source, err := os.ReadFile(openRCNginxService)
	return err == nil && strings.HasPrefix(string(source), "#!/sbin/openrc-run\n")
}

// startStoppedNginx is what a reload does when no nginx master runs. A root
// daemon brings nginx up through its service, so nginx runs in the service's
// own unit and outlives the daemon. A daemon run as nginx's user never starts
// nginx itself (it would run in the daemon's cgroup and stop with it): it says
// which command root has to run.
func (m *Manager) startStoppedNginx() error {
	var command []string
	if pidRepairEUID() == 0 {
		if _, err := os.Stat(systemdRuntimeDir); err == nil {
			command = []string{"systemctl", "reload-or-restart", "nginx"}
		} else if hasOpenRCNginxService() {
			command = []string{"rc-service", "nginx", "restart"}
		}
	}
	if command == nil {
		start := nginxStartCommand()
		if start == "start its service" {
			return errors.New("nginx is not running: start its service")
		}
		return fmt.Errorf("nginx is not running: start it with %s", start)
	}
	if output, err := runServiceCommand(command[0], command[1:]...); err != nil {
		return fmt.Errorf("nginx is not running and %s failed: %s: %w", strings.Join(command, " "), strings.TrimSpace(string(output)), err)
	}
	m.setPIDProblem("")
	return nil
}

// statedPIDFile is the pid file nginx.conf names, else the one nginx was
// built with: what nginx -t opens, read without nginx -T, which fails while
// nginx cannot open it.
func (m *Manager) statedPIDFile() (string, error) {
	if m.globalCfg != "" {
		if contents, err := os.ReadFile(m.globalCfg); err == nil {
			if configured, err := effectivePIDDirective(contents); err == nil && configured != "" {
				return m.resolveNginxPath(configured)
			}
		}
	}
	pidPath, err := m.configureArgument("--pid-path=")
	if err != nil || pidPath == "" {
		return "", fmt.Errorf("nginx pid path is unavailable")
	}
	return m.resolveNginxPath(pidPath)
}

// nginxFailure is what a failed nginx run said, for an error message.
func nginxFailure(output []byte) string {
	if lines := nginxFailureLine.FindAll(output, -1); len(lines) > 0 {
		return strings.TrimSpace(string(lines[len(lines)-1]))
	}
	return strings.TrimSpace(string(output))
}
