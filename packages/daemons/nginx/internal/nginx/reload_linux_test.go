//go:build linux

package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// reloadFixture is a host whose nginx.conf names <dir>/run/nginx/nginx.pid,
// with an nginx that answers -s reload as nginx does: it fails while the pid
// file is missing or empty (nginx -t leaves it empty while no master runs),
// and on a configuration file it cannot open (include), before the pid file.
type reloadFixture struct {
	dir      string
	pidFile  string
	reloads  string
	manager  *Manager
	services [][]string
}

func newReloadFixture(t *testing.T, euid int, initSystem string) *reloadFixture {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &reloadFixture{dir: dir, pidFile: filepath.Join(dir, "run", "nginx", "nginx.pid"), reloads: filepath.Join(dir, "reloads")}
	if err := os.MkdirAll(filepath.Dir(f.pidFile), 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "nginx")
	script := `#!/bin/sh
pid='` + f.pidFile + `'
case "$1" in -V) echo 'configure arguments: --prefix=/usr/share/nginx --pid-path=/nonexistent/nginx.pid' >&2; exit 0 ;; esac
if [ -e '` + filepath.Join(dir, "broken-include") + `' ]; then echo "nginx: [emerg] open() \"/etc/nginx/missing.conf\" failed (2: No such file or directory) in /etc/nginx/nginx.conf:9" >&2; exit 1; fi
if [ ! -d "${pid%/*}" ]; then echo "nginx: [emerg] open() \"$pid\" failed (2: No such file or directory)" >&2; exit 1; fi
if [ "$1" = "-s" ]; then
  if [ ! -e "$pid" ]; then echo "nginx: [error] open() \"$pid\" failed (2: No such file or directory)" >&2; exit 1; fi
  if [ ! -s "$pid" ]; then echo "nginx: [error] invalid PID number \"\" in \"$pid\"" >&2; exit 1; fi
  echo reload >> '` + f.reloads + `'
  exit 0
fi
: >> "$pid"
`
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "nginx.conf")
	if err := os.WriteFile(config, []byte("pid "+f.pidFile+";\nevents {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldRuntime, oldEUID, oldService, oldSystemd, oldRun := pidRuntimeDir, pidRepairEUID, openRCNginxService, systemdRuntimeDir, runServiceCommand
	t.Cleanup(func() {
		pidRuntimeDir, pidRepairEUID, openRCNginxService, systemdRuntimeDir, runServiceCommand = oldRuntime, oldEUID, oldService, oldSystemd, oldRun
	})
	pidRuntimeDir = filepath.Join(dir, "run")
	pidRepairEUID = func() int { return euid }
	openRCNginxService = filepath.Join(dir, "init.d-nginx")
	systemdRuntimeDir = filepath.Join(dir, "systemd")
	switch initSystem {
	case "systemd":
		if err := os.Mkdir(systemdRuntimeDir, 0o755); err != nil {
			t.Fatal(err)
		}
	case "openrc":
		if err := os.WriteFile(openRCNginxService, []byte("#!/sbin/openrc-run\npidfile=/run/nginx/nginx.pid\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// The service starts nginx: its master writes the pid file.
	runServiceCommand = func(name string, args ...string) ([]byte, error) {
		f.services = append(f.services, append([]string{name}, args...))
		return nil, os.WriteFile(f.pidFile, []byte("4242\n"), 0o644)
	}
	f.manager = NewManager(binary, filepath.Join(dir, "sites"), filepath.Join(dir, "certs"), config)
	return f
}

func (f *reloadFixture) reloadCount(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(f.reloads)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "reload")
}

func TestReloadSignalsARunningNginx(t *testing.T) {
	f := newReloadFixture(t, 0, "systemd")
	if err := os.WriteFile(f.pidFile, []byte("4242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if f.reloadCount(t) != 1 || len(f.services) != 0 {
		t.Fatalf("reloads = %d, service commands = %v", f.reloadCount(t), f.services)
	}
}

// nginx -t leaves an empty pid file while no master runs (the directory was
// kept by RuntimeDirectoryPreserve=); a daemon run as nginx's user says how
// to start nginx and never starts it itself.
func TestRunUserReloadOfAStoppedNginxSaysHowToStartIt(t *testing.T) {
	for _, test := range []struct{ initSystem, want string }{
		{"systemd", "nginx is not running: start it with systemctl start nginx"},
		{"openrc", "nginx is not running: start it with rc-service nginx start"},
		{"", "nginx is not running: start its service"},
	} {
		t.Run(test.initSystem, func(t *testing.T) {
			f := newReloadFixture(t, 1000, test.initSystem)
			if valid, output := f.manager.TestConfig(); !valid {
				t.Fatalf("nginx -t failed: %s", output)
			}
			err := f.manager.Reload()
			if err == nil || err.Error() != test.want {
				t.Fatalf("reload error = %v, want %q", err, test.want)
			}
			if len(f.services) != 0 {
				t.Fatalf("a run-user daemon ran %v", f.services)
			}
		})
	}
}

// Without its pid directory (systemd removed it with nginx's stop) the reload
// error says nginx is not running, and the health report keeps the problem
// with the root command.
func TestRunUserReloadWithoutThePIDDirectory(t *testing.T) {
	f := newReloadFixture(t, 1000, "systemd")
	if err := os.Remove(filepath.Dir(f.pidFile)); err != nil {
		t.Fatal(err)
	}
	// nginx -s reload only reads the pid file, so it fails as [error] here.
	if err := os.WriteFile(f.manager.binary, []byte("#!/bin/sh\ncase \"$1\" in -V) exit 0 ;; esac\necho \"nginx: [error] open() \\\""+f.pidFile+"\\\" failed (2: No such file or directory)\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := f.manager.Reload()
	if err == nil || err.Error() != "nginx is not running: start it with systemctl start nginx" {
		t.Fatalf("reload error = %v", err)
	}
	if problem := f.manager.ServiceProblem(false); !strings.Contains(problem, "pid directory "+filepath.Dir(f.pidFile)+" is gone") {
		t.Fatalf("problem = %q", problem)
	}
	if len(f.services) != 0 {
		t.Fatalf("a run-user daemon ran %v", f.services)
	}
}

// A root daemon brings a stopped nginx up through its service.
func TestRootReloadOfAStoppedNginxStartsItsService(t *testing.T) {
	for _, test := range []struct {
		initSystem string
		want       string
	}{
		{"systemd", "systemctl reload-or-restart nginx"},
		{"openrc", "rc-service nginx restart"},
	} {
		t.Run(test.initSystem, func(t *testing.T) {
			f := newReloadFixture(t, 0, test.initSystem)
			if err := f.manager.Reload(); err != nil {
				t.Fatalf("reload: %v", err)
			}
			if len(f.services) != 1 || strings.Join(f.services[0], " ") != test.want {
				t.Fatalf("service commands = %v, want %q", f.services, test.want)
			}
			if f.reloadCount(t) != 0 {
				t.Fatal("a stopped nginx was signalled")
			}
		})
	}
}

// A root daemon without a known service manager does not start nginx either.
func TestRootReloadWithoutAServiceManagerSaysHowToStartIt(t *testing.T) {
	f := newReloadFixture(t, 0, "")
	err := f.manager.Reload()
	if err == nil || err.Error() != "nginx is not running: start its service" || len(f.services) != 0 {
		t.Fatalf("reload error = %v, service commands = %v", err, f.services)
	}
}

// A configuration nginx cannot load is a reload failure, never a stopped nginx.
func TestReloadOfABrokenConfigurationStartsNothing(t *testing.T) {
	f := newReloadFixture(t, 0, "systemd")
	if err := os.WriteFile(filepath.Join(f.dir, "broken-include"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	err := f.manager.Reload()
	if err == nil || !strings.HasPrefix(err.Error(), "nginx reload failed: ") || strings.Contains(err.Error(), "not running") {
		t.Fatalf("reload error = %v", err)
	}
	if len(f.services) != 0 {
		t.Fatalf("service commands = %v", f.services)
	}
}
