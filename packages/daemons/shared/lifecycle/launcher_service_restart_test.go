package lifecycle

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// writeLauncherProbeExecutable writes a daemon binary whose launcher has the
// given features; nil features: a binary that predates the features probe.
func writeLauncherProbeExecutable(t *testing.T, path string, features []string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	probe := "echo " + legacycompat.LauncherProbe + " 1"
	if features != nil {
		probe = `if [ "$2" = --features ]; then echo '{"protocol":1,"version":"v2","features":["` + strings.Join(features, `","`) + `"]}'; else echo ` + legacycompat.LauncherProbe + ` 1; fi`
	}
	contents := "#!/bin/sh\ncase \"$1\" in\nversion) echo test-daemon v2 ;;\nlauncher-probe) " + probe + " ;;\nesac\n"
	if err := os.WriteFile(path, []byte(contents), 0755); err != nil {
		t.Fatal(err)
	}
}

type serviceRestartFixture struct {
	stateDir     string
	binary       string
	launcherPath string
	launcherPID  int
}

// newServiceRestartFixture: a node whose launcher process (launcherPID) runs
// the installed launcher copy, which predates self-update, with an update to a
// version that has it staged in the journal.
func newServiceRestartFixture(t *testing.T) serviceRestartFixture {
	t.Helper()
	dir := t.TempDir()
	f := serviceRestartFixture{stateDir: filepath.Join(dir, "state"), binary: filepath.Join(dir, "bin", "docker-daemon"), launcherPID: 4242}
	f.launcherPath = canonicalLauncherPath(f.stateDir, f.binary)
	writeLauncherProbeExecutable(t, f.binary, launcherBinaryFeatures)
	writeLauncherProbeExecutable(t, f.launcherPath, nil)
	if err := writeJSONFileAtomic(filepath.Join(f.stateDir, "launcher", "owner.json"), &launcherOwner{PID: f.launcherPID, ProtocolVersion: 1}, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := stageLauncherUpdate(f.stateDir, "docker", f.binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	return f
}

// stageNext stages a launcher with features as the trial the next start tries.
func (f serviceRestartFixture) stageNext(t *testing.T, features []string) {
	t.Helper()
	next := stagedLauncherPath(f.launcherPath)
	writeLauncherProbeExecutable(t, next, features)
	sum, err := executableChecksum(next)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeLauncherRefreshState(f.stateDir, &launcherRefreshState{Phase: launcherRefreshPhaseTrial, LauncherPath: f.launcherPath, TargetSHA256: sum, TargetVersion: "v1"}); err != nil {
		t.Fatal(err)
	}
}

func useServiceManager(t *testing.T, manager launcherServiceManager) {
	t.Helper()
	old := launcherServiceManagerOf
	launcherServiceManagerOf = func(int) launcherServiceManager { return manager }
	t.Cleanup(func() { launcherServiceManagerOf = old })
}

// An update under a launcher process that predates self-update restarts the
// whole service when a service manager starts it again, and otherwise stays
// under the running launcher and says why.
func TestUpdateUnderOldLauncherRestartsTheService(t *testing.T) {
	keeperOnly := LauncherInfo{Managed: true, Features: []string{LauncherFeatureListenerKeep}}
	systemdAlways := launcherServiceManager{kind: launcherManagerSystemd, unit: "docker-daemon.service", restart: "always"}
	for _, test := range []struct {
		name     string
		launcher LauncherInfo
		manager  launcherServiceManager
		euid     int
		staged   []string
		method   string
		detail   string
	}{
		{name: "systemd as root", launcher: keeperOnly, manager: systemdAlways, euid: 0, staged: launcherBinaryFeatures, method: launcherRestartSystemctl},
		{name: "systemd as a run user", launcher: keeperOnly, manager: systemdAlways, euid: 1000, staged: launcherBinaryFeatures, method: launcherRestartSignal},
		{name: "launcher without keeper", launcher: LauncherInfo{Managed: true}, manager: systemdAlways, euid: 1000, staged: launcherBinaryFeatures, method: launcherRestartSignal},
		{name: "OpenRC", launcher: keeperOnly, manager: launcherServiceManager{kind: launcherManagerOpenRC}, euid: 1000, staged: launcherBinaryFeatures, method: launcherRestartSignal},
		{name: "unit that does not restart a clean exit", launcher: keeperOnly, manager: launcherServiceManager{kind: launcherManagerSystemd, unit: "docker-daemon.service", restart: "on-failure"}, euid: 1000, staged: launcherBinaryFeatures, detail: "Restart=on-failure"},
		{name: "manual mode", launcher: keeperOnly, manager: launcherServiceManager{}, euid: 0, staged: launcherBinaryFeatures, detail: "manual mode"},
		{name: "no newer launcher staged", launcher: keeperOnly, manager: systemdAlways, euid: 0, detail: "no newer launcher is staged"},
		{name: "staged launcher predates self-update", launcher: keeperOnly, manager: systemdAlways, euid: 0, staged: []string{LauncherFeatureListenerKeep}, detail: "no newer launcher is staged"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newServiceRestartFixture(t)
			if test.staged != nil {
				f.stageNext(t, test.staged)
			}
			useServiceManager(t, test.manager)
			plan := planLauncherServiceRestart(f.stateDir, f.binary, test.launcher, f.launcherPID, test.euid)
			if plan == nil || plan.method != test.method {
				t.Fatalf("plan = %+v, want method %q", plan, test.method)
			}
			if test.method == "" && !strings.Contains(plan.detail, test.detail) {
				t.Fatalf("detail = %q, want it to name %q", plan.detail, test.detail)
			}
			if test.method != "" && !strings.Contains(plan.detail, "restarts the whole service") {
				t.Fatalf("detail = %q", plan.detail)
			}
		})
	}

	t.Run("launcher that updates itself", func(t *testing.T) {
		f := newServiceRestartFixture(t)
		f.stageNext(t, launcherBinaryFeatures)
		if plan := planLauncherServiceRestart(f.stateDir, f.binary, LauncherInfo{Managed: true, Version: "v1", Features: launcherBinaryFeatures}, f.launcherPID, 0); plan != nil {
			t.Fatalf("a launcher that updates itself got a service restart: %+v", plan)
		}
	})
	// A launcher of 2.11.4-rc.6 has self-update but took OpenRC for manual
	// mode: under OpenRC it never execs in place, so the update restarts the
	// service into a launcher that recognizes OpenRC.
	rc6 := LauncherInfo{Managed: true, Version: "v1", Features: []string{LauncherFeatureListenerKeep, LauncherFeatureSelfUpdate}}
	openRC := launcherServiceManager{kind: launcherManagerOpenRC}
	t.Run("self-updating launcher that took OpenRC for manual mode", func(t *testing.T) {
		f := newServiceRestartFixture(t)
		f.stageNext(t, launcherBinaryFeatures)
		useServiceManager(t, openRC)
		plan := planLauncherServiceRestart(f.stateDir, f.binary, rc6, f.launcherPID, 1000)
		if plan == nil || plan.method != launcherRestartSignal || !strings.Contains(plan.detail, "cannot update itself in place under OpenRC") || !strings.Contains(plan.detail, "restarts the whole service") {
			t.Fatalf("plan = %+v", plan)
		}
		// Only a launcher that recognizes OpenRC is worth the restart.
		f.stageNext(t, rc6.Features)
		if plan := planLauncherServiceRestart(f.stateDir, f.binary, rc6, f.launcherPID, 1000); plan == nil || plan.method != "" || !strings.Contains(plan.detail, "no newer launcher is staged") {
			t.Fatalf("plan = %+v", plan)
		}
	})
	t.Run("self-updating launcher under systemd or in manual mode", func(t *testing.T) {
		for _, manager := range []launcherServiceManager{systemdAlways, {}} {
			f := newServiceRestartFixture(t)
			f.stageNext(t, launcherBinaryFeatures)
			useServiceManager(t, manager)
			if plan := planLauncherServiceRestart(f.stateDir, f.binary, rc6, f.launcherPID, 0); plan != nil {
				t.Fatalf("%s: plan = %+v", manager, plan)
			}
		}
	})
	t.Run("update to a version that predates self-update", func(t *testing.T) {
		f := newServiceRestartFixture(t)
		f.stageNext(t, launcherBinaryFeatures)
		writeLauncherProbeExecutable(t, f.binary, nil)
		useServiceManager(t, systemdAlways)
		if plan := planLauncherServiceRestart(f.stateDir, f.binary, keeperOnly, f.launcherPID, 0); plan == nil || plan.method != "" || !strings.Contains(plan.detail, "new daemon version") {
			t.Fatalf("plan = %+v", plan)
		}
	})
	t.Run("launcher process not identified", func(t *testing.T) {
		f := newServiceRestartFixture(t)
		f.stageNext(t, launcherBinaryFeatures)
		useServiceManager(t, systemdAlways)
		if plan := planLauncherServiceRestart(f.stateDir, f.binary, keeperOnly, f.launcherPID+1, 0); plan == nil || plan.method != "" {
			t.Fatalf("plan = %+v", plan)
		}
	})
}

// The restart marks the update journal, stops the launcher and returns once
// the stopping launcher stopped this daemon; the next start then tries the
// staged launcher together with the update.
func TestServiceRestartStopsTheLauncherAndStartsTheStagedLauncher(t *testing.T) {
	f := newServiceRestartFixture(t)
	f.stageNext(t, launcherBinaryFeatures)
	// A launcher that stops its daemon (this process) when it is stopped.
	launcher := exec.Command("/bin/sh", "-c", "trap 'kill -TERM "+strconv.Itoa(os.Getpid())+"; exit 0' TERM; while :; do sleep 0.05; done")
	if err := launcher.Start(); err != nil {
		t.Fatal(err)
	}
	launcherDone := make(chan error, 1)
	go func() { launcherDone <- launcher.Wait() }()
	defer func() { _ = launcher.Process.Kill() }()
	time.Sleep(100 * time.Millisecond) // let the shell install its trap

	plan := &launcherServiceRestart{stateDir: f.stateDir, launcherPID: launcher.Process.Pid, method: launcherRestartSignal, manager: launcherServiceManager{kind: launcherManagerOpenRC}}
	started := time.Now()
	if stopped := plan.run(discardLauncherLogger()); !stopped {
		t.Fatal("run did not report the stop by the service manager")
	}
	if waited := time.Since(started); waited >= launcherServiceRestartWait {
		t.Fatalf("the daemon was not stopped by the launcher (waited %s)", waited)
	}
	select {
	case <-launcherDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the launcher was not stopped")
	}
	pending, err := readLauncherUpdateState(f.stateDir)
	if err != nil || pending == nil || !pending.ServiceRestart || pending.Phase != "staged" {
		t.Fatalf("update journal = %+v, %v", pending, err)
	}

	// The start after the restart tries the staged launcher with the update.
	if selected := selectLauncherForStart(f.stateDir, f.launcherPath); selected != stagedLauncherPath(f.launcherPath) {
		t.Fatalf("the start selected %s", selected)
	}
	if state, err := readLauncherRefreshState(f.stateDir); err != nil || state.Attempts != 1 {
		t.Fatalf("refresh journal = %+v, %v", state, err)
	}
}

// A pending update that does not restart the service stays with the launcher
// it was staged under, at a start of the service and in place.
func TestPendingUpdateKeepsTheInstalledLauncher(t *testing.T) {
	f := newServiceRestartFixture(t)
	f.stageNext(t, launcherBinaryFeatures)
	if selected := selectLauncherForStart(f.stateDir, f.launcherPath); selected != f.launcherPath {
		t.Fatalf("the start selected %s", selected)
	}
	if target, err := claimLauncherSelfUpdate(f.stateDir, f.launcherPath, map[string]bool{}); err != nil || target != "" {
		t.Fatalf("exec in place during an update: %q, %v", target, err)
	}
	if state, err := readLauncherRefreshState(f.stateDir); err != nil || state.Attempts != 0 {
		t.Fatalf("refresh journal = %+v, %v", state, err)
	}
	// Once the update is committed, the staged launcher is due in place.
	if err := removeLauncherUpdateState(f.stateDir); err != nil {
		t.Fatal(err)
	}
	if target, err := claimLauncherSelfUpdate(f.stateDir, f.launcherPath, map[string]bool{}); err != nil || target != stagedLauncherPath(f.launcherPath) {
		t.Fatalf("exec in place after the update: %q, %v", target, err)
	}
	// A staged launcher that cannot take over in place waits for a start.
	f.stageNext(t, []string{LauncherFeatureListenerKeep})
	cannotResume := map[string]bool{}
	if target, err := claimLauncherSelfUpdate(f.stateDir, f.launcherPath, cannotResume); err != nil || target != "" || len(cannotResume) != 1 {
		t.Fatalf("exec in place into a launcher without self-update: %q, %v", target, err)
	}
}

// A daemon reports the launcher that runs now, as its owner record says.
func TestLauncherFeaturesFollowTheRunningLauncher(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv(LauncherManagedEnv, "1")
	t.Setenv(LauncherStateDirEnv, stateDir)
	owner := launcherOwner{PID: os.Getppid(), ProtocolVersion: 1, Version: "v2", Features: launcherBinaryFeatures}
	if err := writeJSONFileAtomic(filepath.Join(stateDir, "launcher", "owner.json"), &owner, 0600); err != nil {
		t.Fatal(err)
	}
	info := LauncherFeatures()
	if !info.Managed || info.Version != "v2" || !info.Has(LauncherFeatureSelfUpdate) || !info.Has(LauncherFeatureListenerKeep) {
		t.Fatalf("launcher = %+v", info)
	}
	if capabilities := strings.Join(info.Capabilities(), ","); capabilities != "launcher_listener_keep_v1,launcher_self_update_v1,launcher_openrc_v1" {
		t.Fatalf("capabilities = %s", capabilities)
	}
}

// OpenRC's supervisor is told by its executable, else its command line, else
// its comm, which the kernel cuts to "supervise-daemo" (seen on Alpine with
// every daemon type, root and run users alike).
func TestDetectLauncherServiceManagerRecognizesOpenRC(t *testing.T) {
	oldUnit, oldRoot := launcherSystemdUnit, launcherProcRoot
	t.Cleanup(func() { launcherSystemdUnit, launcherProcRoot = oldUnit, oldRoot })
	launcherSystemdUnit = func() (string, error) { return "", nil }
	const launcherPID = 342863
	for _, test := range []struct {
		name   string
		parent int
		files  map[string]string // "exe" is the link's target
		openRC bool
	}{
		{name: "run user: command line", parent: 342862, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": "supervise-daemon\x00docker-daemon\x00--start\x00--pidfile\x00/run/docker-daemon.pid\x00"}, openRC: true},
		{name: "root: executable", parent: 342862, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": "supervise-daemon\x00nginx-daemon\x00", "exe": "/sbin/supervise-daemon"}, openRC: true},
		{name: "command line with a path", parent: 342862, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": "/sbin/supervise-daemon\x00monitoring-daemon\x00"}, openRC: true},
		{name: "comm alone", parent: 342862, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": ""}, openRC: true},
		{name: "shell", parent: 342862, files: map[string]string{"comm": "bash\n", "cmdline": "-bash\x00", "exe": "/usr/bin/bash"}},
		{name: "another program with the same 15 characters", parent: 342862, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": "supervise-daemonized\x00"}},
		{name: "reparented to init", parent: 1, files: map[string]string{"comm": "supervise-daemo\n", "cmdline": "supervise-daemon\x00"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			launcherProcRoot = t.TempDir()
			write := func(pid int, name, contents string) {
				t.Helper()
				dir := filepath.Join(launcherProcRoot, strconv.Itoa(pid))
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatal(err)
				}
				if name == "exe" {
					if err := os.Symlink(contents, filepath.Join(dir, name)); err != nil {
						t.Fatal(err)
					}
					return
				}
				if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0644); err != nil {
					t.Fatal(err)
				}
			}
			write(launcherPID, "stat", strconv.Itoa(launcherPID)+" (docker-daemon-l) S "+strconv.Itoa(test.parent)+" 342862 342862 0 -1 4194560")
			for name, contents := range test.files {
				write(test.parent, name, contents)
			}
			manager := detectLauncherServiceManager(launcherPID)
			if got := manager.kind == launcherManagerOpenRC; got != test.openRC {
				t.Fatalf("service manager = %s, want OpenRC %v", manager, test.openRC)
			}
			if test.openRC && !manager.respawns() {
				t.Fatal("OpenRC does not start the launcher again")
			}
		})
	}
}

// Without D-Bus a run user reads Restart= from the unit's files.
func TestSystemdUnitFileRestartCombinesDropIns(t *testing.T) {
	etc, lib := t.TempDir(), t.TempDir()
	write := func(path, contents string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	directories := []string{etc, lib}
	if _, ok := systemdUnitFileRestart("docker-daemon.service", directories); ok {
		t.Fatal("a missing unit has a Restart= setting")
	}
	write(filepath.Join(lib, "docker-daemon.service"), "[Unit]\nRestart=no\n[Service]\nType=simple\nRestart=on-failure\n")
	if restart, ok := systemdUnitFileRestart("docker-daemon.service", directories); !ok || restart != "on-failure" {
		t.Fatalf("Restart = %q, %v", restart, ok)
	}
	write(filepath.Join(etc, "docker-daemon.service"), "[Service]\nExecStart=/usr/local/bin/docker-daemon run\nRestart=always\n")
	write(filepath.Join(lib, "docker-daemon.service.d", "20-old.conf"), "[Service]\nRestart=on-failure\n")
	write(filepath.Join(etc, "docker-daemon.service.d", "10-reset.conf"), "[Service]\nRestart=\n")
	write(filepath.Join(etc, "docker-daemon.service.d", "20-old.conf"), "[Service]\nRestart=always\n")
	if restart, ok := systemdUnitFileRestart("docker-daemon.service", directories); !ok || restart != "always" {
		t.Fatalf("Restart = %q, %v", restart, ok)
	}
}

// The start after a service restart for an update runs the updated binary's
// launcher at once, not the older launcher the previous daemon staged (O-4).
func TestServiceRestartStartsTheUpdatedLauncher(t *testing.T) {
	f := newServiceRestartFixture(t)
	// The launcher the previous daemon staged: older than the updated binary.
	f.stageNext(t, []string{LauncherFeatureListenerKeep, LauncherFeatureSelfUpdate})
	if err := markLauncherUpdateServiceRestart(f.stateDir, true); err != nil {
		t.Fatal(err)
	}
	if err := stageServiceRestartLauncher(f.stateDir, f.launcherPath, f.binary); err != nil {
		t.Fatal(err)
	}
	next := stagedLauncherPath(f.launcherPath)
	if selected := selectLauncherForStart(f.stateDir, f.launcherPath); selected != next {
		t.Fatalf("the start selected %s", selected)
	}
	binarySum, _ := executableChecksum(f.binary)
	if nextSum, err := executableChecksum(next); err != nil || nextSum != binarySum {
		t.Fatalf("the start runs a launcher other than the updated binary (%s, %v)", nextSum, err)
	}
	state, err := readLauncherRefreshState(f.stateDir)
	if err != nil || state.Phase != launcherRefreshPhaseTrial || state.TargetVersion != "v2" || state.Attempts != 1 {
		t.Fatalf("refresh journal = %+v, %v", state, err)
	}
	// A start that comes back (a crash on trial) keeps the attempts counted.
	if err := stageServiceRestartLauncher(f.stateDir, f.launcherPath, f.binary); err != nil {
		t.Fatal(err)
	}
	if state, err := readLauncherRefreshState(f.stateDir); err != nil || state.Attempts != 1 {
		t.Fatalf("refresh journal after a second start = %+v, %v", state, err)
	}
	// A binary that failed its launcher trial here is not staged again.
	if err := withLauncherRefreshLock(f.stateDir, func() error {
		current, err := readLauncherRefreshState(f.stateDir)
		if err != nil {
			return err
		}
		return abandonLauncherRefresh(f.stateDir, current, "test")
	}); err != nil {
		t.Fatal(err)
	}
	if err := stageServiceRestartLauncher(f.stateDir, f.launcherPath, f.binary); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(next); !os.IsNotExist(err) {
		t.Fatalf("an abandoned launcher was staged again: %v", err)
	}
}

// Only a start for a service-restart update stages the updated binary: any
// other pending update keeps the launcher it was staged under.
func TestUpdateWithoutServiceRestartKeepsTheStagedLauncher(t *testing.T) {
	f := newServiceRestartFixture(t)
	f.stageNext(t, launcherBinaryFeatures)
	before, _ := executableChecksum(stagedLauncherPath(f.launcherPath))
	if err := stageServiceRestartLauncher(f.stateDir, f.launcherPath, f.binary); err != nil {
		t.Fatal(err)
	}
	if after, _ := executableChecksum(stagedLauncherPath(f.launcherPath)); after != before {
		t.Fatal("the staged launcher changed for an update without a service restart")
	}
}
