//go:build linux

package nginx

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// pidFixture is a host whose nginx.conf names <dir>/run/nginx/nginx.pid, with
// an nginx that, like nginx -t and -T, creates that file empty and fails
// while it cannot: "(2: ...)" without its directory, "(13: ...)" on a file it
// may not write (mode 0444 here, root's file on a host).
type pidFixture struct {
	dir     string
	runtime string
	pidFile string
	manager *Manager
}

func newPIDFixture(t *testing.T, euid int) pidFixture {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := pidFixture{dir: dir, runtime: filepath.Join(dir, "run")}
	f.pidFile = filepath.Join(f.runtime, "nginx", "nginx.pid")
	if err := os.Mkdir(f.runtime, 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "nginx")
	script := `#!/bin/sh
pid='` + f.pidFile + `'
case "$1" in -V) echo 'configure arguments: --prefix=/usr/share/nginx --pid-path=/nonexistent/nginx.pid' >&2; exit 0 ;; esac
if [ -e '` + dir + `/broken' ]; then echo 'nginx: [emerg] unknown directive "proxy_passs" in /etc/nginx/sites/a.conf:3' >&2; echo 'nginx: configuration file test failed' >&2; exit 1; fi
echo "nginx: the configuration file $3 syntax is ok" >&2
if [ ! -d "${pid%/*}" ]; then echo "nginx: [emerg] open() \"$pid\" failed (2: No such file or directory)" >&2; echo "nginx: configuration file $3 test failed" >&2; exit 1; fi
if [ -e "$pid" ] && [ "$(stat -c %a "$pid")" = 444 ]; then echo "nginx: [emerg] open() \"$pid\" failed (13: Permission denied)" >&2; echo "nginx: configuration file $3 test failed" >&2; exit 1; fi
: >> "$pid"
case "$1" in -T) echo "pid $pid;" ;; esac
echo 'nginx: configuration file test is successful' >&2
`
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "nginx.conf")
	if err := os.WriteFile(config, []byte("user www-data;\npid "+f.pidFile+";\nevents {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldRuntime, oldEUID, oldService, oldSystemd := pidRuntimeDir, pidRepairEUID, openRCNginxService, systemdRuntimeDir
	t.Cleanup(func() {
		pidRuntimeDir, pidRepairEUID, openRCNginxService, systemdRuntimeDir = oldRuntime, oldEUID, oldService, oldSystemd
	})
	pidRuntimeDir = f.runtime
	pidRepairEUID = func() int { return euid }
	openRCNginxService = filepath.Join(dir, "init.d-nginx")
	systemdRuntimeDir = filepath.Join(dir, "systemd")
	f.manager = NewManager(binary, filepath.Join(dir, "sites"), filepath.Join(dir, "certs"), config)
	return f
}

// A root daemon creates the missing pid directory itself, as the nginx service
// does when it starts: under Alpine after a reboot before nginx started.
func TestRootDaemonCreatesTheMissingPIDDirectory(t *testing.T) {
	f := newPIDFixture(t, 0)
	if valid, output := f.manager.TestConfig(); !valid {
		t.Fatalf("nginx -t failed: %s", output)
	}
	info, err := os.Stat(filepath.Dir(f.pidFile))
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o755 {
		t.Fatalf("pid directory = %v, %v", info, err)
	}
	if pidFile, err := f.manager.authoritativePidFile(); err != nil || pidFile != f.pidFile {
		t.Fatalf("pid file = %q, %v", pidFile, err)
	}
	if problem := f.manager.ServiceProblem(false); problem != "" {
		t.Fatalf("problem = %q", problem)
	}
	// Only a directory of /run.
	f = newPIDFixture(t, 0)
	pidRuntimeDir = filepath.Join(f.dir, "elsewhere")
	_, _ = f.manager.TestConfig()
	if _, err := os.Stat(filepath.Dir(f.pidFile)); !os.IsNotExist(err) {
		t.Fatalf("a pid directory outside /run was created: %v", err)
	}
}

// A run user's nginx under systemd loses /run/nginx whenever it stops
// (RuntimeDirectory=). The daemon cannot create it; the health report names
// nginx's own error and the command, not "exit status 1".
func TestRunUserDaemonReportsTheMissingPIDDirectory(t *testing.T) {
	f := newPIDFixture(t, 1000)
	if err := os.Mkdir(systemdRuntimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// The configuration itself is valid: only its pid file could not be
	// opened, which the service problem reports.
	valid, output := f.manager.TestConfig()
	if !valid || !strings.Contains(output, "(2: No such file or directory)") {
		t.Fatalf("nginx -t = %v: %s", valid, output)
	}
	if cached, _, checked := f.manager.CachedConfigValidity(); !cached || !checked {
		t.Fatalf("cached validity = %v, %v", cached, checked)
	}
	if _, err := os.Stat(filepath.Dir(f.pidFile)); !os.IsNotExist(err) {
		t.Fatalf("a run user created the pid directory: %v", err)
	}
	want := "nginx is not running and its pid directory " + filepath.Dir(f.pidFile) + " is gone; start nginx as root: systemctl start nginx"
	if problem := f.manager.ServiceProblem(false); problem != want {
		t.Fatalf("problem = %q, want %q", problem, want)
	}
	_, err := f.manager.authoritativePidFile()
	if err == nil || !strings.Contains(err.Error(), `open() "`+f.pidFile+`" failed (2: No such file or directory)`) {
		t.Fatalf("pid file error = %v", err)
	}
	// nginx starts: its service creates the directory, and the problem is gone.
	if err := os.Mkdir(filepath.Dir(f.pidFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if valid, output := f.manager.TestConfig(); !valid {
		t.Fatalf("nginx -t failed: %s", output)
	}
	if problem := f.manager.ServiceProblem(true); problem != "" {
		t.Fatalf("problem = %q", problem)
	}
}

// A root nginx -t leaves an empty pid file to root, and nginx run by the
// daemon's user can neither test nor start. The daemon removes that file from
// its own pid directory; nginx -t creates it again for the daemon's user.
func TestRunUserDaemonReplacesAnEmptyForeignPIDFile(t *testing.T) {
	f := newPIDFixture(t, os.Geteuid())
	if err := os.Mkdir(filepath.Dir(f.pidFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.pidFile, nil, 0o444); err != nil {
		t.Fatal(err)
	}
	if valid, output := f.manager.TestConfig(); !valid {
		t.Fatalf("nginx -t failed: %s", output)
	}
	if info, err := os.Stat(f.pidFile); err != nil || info.Mode().Perm() == 0o444 {
		t.Fatalf("pid file = %v, %v", info, err)
	}
	// A pid file that names a process is never removed.
	if err := os.Remove(f.pidFile); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.pidFile, []byte("4242\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	_, _ = f.manager.TestConfig()
	if data, err := os.ReadFile(f.pidFile); err != nil || string(data) != "4242\n" {
		t.Fatalf("a pid file naming a process was replaced: %q, %v", data, err)
	}
	if problem := f.manager.ServiceProblem(true); !strings.Contains(problem, "belongs to another user; as root: rm "+f.pidFile) {
		t.Fatalf("problem = %q", problem)
	}
}

// Alpine's nginx service tests the configuration as root before it starts
// nginx as command_user. Without the pid file's checkpath, that nginx cannot
// start again once stopped; only root can change the service, so the health
// report carries the command, which makes the service pass the check.
func TestRunUserDaemonReportsTheAlpineServiceThatLeavesThePIDFileToRoot(t *testing.T) {
	sed, err := exec.LookPath("sed")
	if err != nil {
		t.Skip("no sed")
	}
	f := newPIDFixture(t, 1000)
	stock := "#!/sbin/openrc-run\n\ncfgfile=${cfgfile:-/etc/nginx/nginx.conf}\npidfile=/run/nginx/nginx.pid\ncommand=${command:-/usr/sbin/nginx}\ncommand_args=\"-c $cfgfile\"\n\n" +
		"start_pre() {\n\tcheckpath --directory --mode 0755 --owner \"${command_user:-root:root}\" ${pidfile%/*}\n\t$command $command_args -t -q\n}\n"
	if err := os.WriteFile(openRCNginxService, []byte(stock), 0o755); err != nil {
		t.Fatal(err)
	}
	problem := f.manager.ServiceProblem(true)
	if !strings.HasPrefix(problem, "nginx cannot start again once stopped: /etc/init.d/nginx leaves its pid file to root; as root: sed -i ") ||
		strings.Contains(problem, "rc-service") {
		t.Fatalf("problem = %q", problem)
	}
	if stopped := f.manager.ServiceProblem(false); stopped != problem+" && rc-service nginx start" {
		t.Fatalf("problem while stopped = %q", stopped)
	}
	// The pid directory missing as well: the configuration still tests
	// valid, and the service's problem is the one to fix.
	if valid, output := f.manager.TestConfig(); !valid {
		t.Fatalf("nginx -t failed on the pid directory alone: %s", output)
	}
	if stopped := f.manager.ServiceProblem(false); !strings.HasPrefix(stopped, "nginx cannot start again once stopped") {
		t.Fatalf("problem = %q", stopped)
	}

	// The command fixes the service as the installer does.
	command := strings.Replace(openRCPIDFileFix, "/etc/init.d/nginx", openRCNginxService, 1)
	if output, err := exec.Command("/bin/sh", "-c", strings.Replace(command, "sed", sed, 1)).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v: %s", command, err, output)
	}
	fixed, _ := os.ReadFile(openRCNginxService)
	if !strings.Contains(string(fixed), "${pidfile%/*}\ncheckpath --file --mode 0644 --owner \"${command_user:-root:root}\" ${pidfile}\n\t$command") {
		t.Fatalf("fixed service:\n%s", fixed)
	}
	if problem := f.manager.ServiceProblem(false); strings.Contains(problem, "/etc/init.d/nginx") {
		t.Fatalf("problem after the fix = %q", problem)
	}
	// A root daemon runs a root nginx, which the service's test does not hurt.
	if err := os.WriteFile(openRCNginxService, []byte(stock), 0o755); err != nil {
		t.Fatal(err)
	}
	pidRepairEUID = func() int { return 0 }
	if problem := openRCPIDFileProblem(false); problem != "" {
		t.Fatalf("root problem = %q", problem)
	}
}

// The Debian 13 stand (F-4 of rc.3, pre-existing): nginx run as www-data was
// stopped, systemd removed /run/nginx, and every nginx -t of the daemon failed
// after "syntax is ok": host config resyncs, Pages previews and the report
// (configValid=false). A test that failed only on the pid file passes; any
// other failure still fails it.
func TestConfigTestPassesWhenOnlyThePIDFileFailed(t *testing.T) {
	f := newPIDFixture(t, 1000)
	if err := os.Mkdir(systemdRuntimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	conf := f.manager.globalCfg
	// Captured on CT 1138 (nginx 1.26, Debian 13) as www-data.
	debian := `2026/10/16 22:01:44 [warn] 760011#760011: the "user" directive makes sense only if the master process runs with super-user privileges, ignored in ` + conf + `:1
nginx: the configuration file ` + conf + ` syntax is ok
2026/10/16 22:01:44 [emerg] 760011#760011: open() "` + f.pidFile + `" failed (2: No such file or directory)
nginx: configuration file ` + conf + ` test failed
`
	for _, test := range []struct {
		name   string
		output string
		valid  bool
	}{
		{"pid directory gone", debian, true},
		{"pid file of another user (Alpine)", strings.Replace(debian, "(2: No such file or directory)", "(13: Permission denied)", 1), true},
		{"another file", strings.Replace(debian, f.pidFile, "/var/log/nginx/error.log", 1), false},
		{"another pid file", strings.Replace(debian, f.pidFile, "/run/other.pid", 1), false},
		{"a second failure", strings.Replace(debian, "nginx: configuration file", "nginx: [emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)\nnginx: configuration file", 1), false},
		{"configuration error", "nginx: [emerg] unknown directive \"proxy_passs\" in /etc/nginx/sites/a.conf:3\nnginx: configuration file " + conf + " test failed\n", false},
		{"no failure line", "nginx: the configuration file " + conf + " syntax is ok\nnginx: configuration file " + conf + " test failed\n", false},
	} {
		if got := f.manager.validDespitePIDFile([]byte(test.output)); got != test.valid {
			t.Errorf("%s: valid = %v, want %v", test.name, got, test.valid)
		}
	}

	// Through nginx -t: valid with the service problem kept, and a broken
	// configuration still fails.
	if valid, output := f.manager.TestConfig(); !valid {
		t.Fatalf("nginx -t = %v: %s", valid, output)
	}
	if problem := f.manager.ServiceProblem(false); !strings.Contains(problem, "pid directory "+filepath.Dir(f.pidFile)+" is gone; start nginx as root: systemctl start nginx") {
		t.Fatalf("problem = %q", problem)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "broken"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if valid, output := f.manager.TestConfig(); valid || !strings.Contains(output, "unknown directive") {
		t.Fatalf("broken configuration: nginx -t = %v: %s", valid, output)
	}
	if cached, _, _ := f.manager.CachedConfigValidity(); cached {
		t.Fatal("a broken configuration is cached as valid")
	}
}
