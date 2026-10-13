package hostnames

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ServiceManager is the init system of the node, as far as the switch of the
// service name needs it.
type ServiceManager interface {
	// Kind is "systemd" or "openrc".
	Kind() string
	// Reload makes the init system read changed unit files.
	Reload() error
	// Enable starts the service at boot (it does not start it now).
	Enable(name string) error
	// Disable stops starting the service at boot (it does not stop it now).
	Disable(name string) error
	// Active reports whether the service runs now.
	Active(name string) bool
}

// DetectServices returns the init system of this node, or nil without one
// (a supervisor the installer started in manual mode).
func DetectServices() ServiceManager {
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		if path, err := exec.LookPath("systemctl"); err == nil {
			return systemd{systemctl: path}
		}
	}
	service, serviceErr := exec.LookPath("rc-service")
	update, updateErr := exec.LookPath("rc-update")
	if serviceErr == nil && updateErr == nil {
		return openrc{service: service, update: update, runlevelDir: System.RunlevelDir}
	}
	return nil
}

type systemd struct{ systemctl string }

func (s systemd) Kind() string  { return "systemd" }
func (s systemd) Reload() error { return run(s.systemctl, "daemon-reload") }
func (s systemd) Enable(name string) error {
	return run(s.systemctl, "enable", name+".service")
}
func (s systemd) Disable(name string) error {
	return run(s.systemctl, "disable", name+".service")
}
func (s systemd) Active(name string) bool {
	return exec.Command(s.systemctl, "is-active", "--quiet", name+".service").Run() == nil
}

type openrc struct {
	service, update, runlevelDir string
}

func (o openrc) Kind() string { return "openrc" }

// Reload rebuilds the dependency cache: OpenRC compares it with the scripts'
// mtimes in whole seconds, so a cache built in the second a script was written
// misses that script at the next boot.
func (o openrc) Reload() error { return run(o.update, "-u") }
func (o openrc) Enable(name string) error {
	if _, err := os.Lstat(o.runlevelDir + "/" + name); err == nil {
		return nil
	}
	return run(o.update, "add", name, "default")
}
func (o openrc) Disable(name string) error {
	if _, err := os.Lstat(o.runlevelDir + "/" + name); err != nil {
		return nil
	}
	return run(o.update, "del", name, "default")
}
func (o openrc) Active(name string) bool {
	return exec.Command(o.service, name, "status").Run() == nil
}

func run(name string, args ...string) error {
	var output bytes.Buffer
	command := exec.Command(name, args...)
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(output.String()))
	}
	return nil
}

// systemdGuardLine keeps the Opfield unit from starting at boot while the old
// one is still enabled: when a crash came between enabling the new unit and
// disabling the old one, only the old unit starts, and its supervisor finishes
// the switch. Cleanup removes the line once the old unit is gone.
func (l Layout) systemdGuardLine() string {
	// legacy-name: guard on the gateway-relay-supervisor unit — remove once every node reports none
	return "ConditionPathExists=!" + l.SystemdDir + "/multi-user.target.wants/" + LegacyServiceName + ".service"
}

// withSystemdGuard adds the guard right after [Unit] (once).
func (l Layout) withSystemdGuard(unit string) string {
	guard := l.systemdGuardLine()
	if strings.Contains(unit, guard) {
		return unit
	}
	if index := strings.Index(unit, "[Unit]\n"); index >= 0 {
		at := index + len("[Unit]\n")
		return unit[:at] + guard + "\n" + unit[at:]
	}
	return "[Unit]\n" + guard + "\n" + unit
}

func (l Layout) withoutSystemdGuard(unit string) string {
	return strings.ReplaceAll(unit, l.systemdGuardLine()+"\n", "")
}

// openrcGuard does in the Opfield init script what systemdGuardLine does in
// the unit: refuse to start while the old service is still in the default
// runlevel.
func (l Layout) openrcGuard() string {
	return "    # legacy-name: guard on the gateway-relay-supervisor service — remove once every node reports none\n" +
		"    if [ -e " + l.RunlevelDir + "/" + LegacyServiceName + " ]; then\n" +
		"        eerror \"" + LegacyServiceName + " still starts at boot and runs the relay supervisor\"\n" +
		"        return 1\n" +
		"    fi\n"
}

func (l Layout) withOpenRCGuard(script string) string {
	guard := l.openrcGuard()
	if strings.Contains(script, guard) {
		return script
	}
	if index := strings.Index(script, "start_pre() {\n"); index >= 0 {
		at := index + len("start_pre() {\n")
		return script[:at] + guard + script[at:]
	}
	if !strings.HasSuffix(script, "\n") {
		script += "\n"
	}
	return script + "\nstart_pre() {\n" + guard + "}\n"
}

func (l Layout) withoutOpenRCGuard(script string) string {
	return strings.ReplaceAll(script, l.openrcGuard(), "")
}

// openrcLogName maps the OpenRC log files to their Opfield names.
func (l Layout) replaceLegacyLogs(text string) string {
	return strings.ReplaceAll(text, l.LogDir+"/"+LegacyServiceName+".", l.LogDir+"/"+ServiceName+".")
}

// RunningServiceName is the service a machine owner restarts to restart the
// supervisor: the old one while it still runs (until the next start after the
// move), else the Opfield one.
func RunningServiceName() string {
	return System.runningServiceName(DetectServices())
}

func (l Layout) runningServiceName(services ServiceManager) string {
	if services != nil && services.Active(LegacyServiceName) {
		return LegacyServiceName
	}
	for _, path := range []string{filepath.Join(l.SystemdDir, ServiceName+".service"), filepath.Join(l.InitDir, ServiceName)} {
		if _, err := os.Lstat(path); err == nil {
			return ServiceName
		}
	}
	for _, path := range []string{filepath.Join(l.SystemdDir, LegacyServiceName+".service"), filepath.Join(l.InitDir, LegacyServiceName)} {
		if _, err := os.Lstat(path); err == nil {
			return LegacyServiceName
		}
	}
	return ServiceName
}
