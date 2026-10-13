package nginx

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// F-7: only the master named by the managed nginx's pid file counts. A
// foreign nginx master on the host (every process below claims to be one)
// does not make a stopped node nginx look running.
func TestIsRunningCountsOnlyTheManagedMaster(t *testing.T) {
	savedCmdline, savedDefaults := processCmdline, defaultPIDFiles
	t.Cleanup(func() { processCmdline, defaultPIDFiles = savedCmdline, savedDefaults })
	defaultPIDFiles = nil
	cmdline := "nginx: master process nginx -g daemon off;"
	processCmdline = func(int) (string, error) { return cmdline, nil }

	dir := t.TempDir()
	pidFile := filepath.Join(dir, "nginx.pid")
	globalConfig := filepath.Join(dir, "nginx.conf")
	if err := os.WriteFile(globalConfig, []byte("pid "+pidFile+";\nevents {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := NewManager("nginx", dir, dir, globalConfig)
	manager.resolvePIDFile = func() (string, error) { return pidFile, nil }
	readable := false
	manager.readPID = func(path string) (int, error) {
		if !readable {
			return 0, os.ErrNotExist
		}
		return os.Getpid(), nil
	}

	if manager.IsRunning() {
		t.Fatal("no pid file: the managed nginx is stopped whatever else runs")
	}
	// Through the authoritative pid file.
	readable = true
	manager.pids = masterPIDCache{}
	if !manager.IsRunning() {
		t.Fatal("the managed master runs")
	}
	cmdline = "/usr/bin/some-other-program"
	if manager.IsRunning() {
		t.Fatal("a pid file naming a process that is no nginx master (a reused pid) counts as stopped")
	}
	// Without the authoritative path (nginx -T fails): the pid file nginx.conf names.
	cmdline = "nginx: master process /usr/sbin/nginx"
	manager.pids = masterPIDCache{}
	manager.resolvePIDFile = func() (string, error) { return "", errors.New("nginx -T failed") }
	if manager.IsRunning() {
		t.Fatal("no pid file named by nginx.conf: stopped")
	}
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !manager.IsRunning() {
		t.Fatal("the master named by nginx.conf's pid file runs")
	}
	if managedMasterAlive(0) || managedMasterAlive(-1) {
		t.Fatal("no pid is no master")
	}
}
