package leasewatchdog

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type fakeServiceHost struct {
	host     ServiceHost
	commands []string
	detached []string
}

func newFakeServiceHost(t *testing.T, systemd, underLegacy bool) *fakeServiceHost {
	f := &fakeServiceHost{}
	f.host = ServiceHost{
		Systemd: systemd, OpenRC: !systemd, Root: t.TempDir(),
		Run: func(_ context.Context, name string, args ...string) error {
			f.commands = append(f.commands, name+" "+strings.Join(args, " "))
			return nil
		},
		Detach:             func(script string) error { f.detached = append(f.detached, script); return nil },
		UnderLegacyService: func() bool { return underLegacy },
	}
	return f
}

func (f *fakeServiceHost) write(t *testing.T, path, content string) {
	t.Helper()
	full := f.host.path(path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeServiceHost) exists(path string) bool {
	_, err := os.Lstat(f.host.path(path))
	return err == nil
}

const legacyArgs = "run --records-owner dockerd --auto-update --releases-url https://u.test/r --artifact-base-url https://u.test/a --channel preview"

func TestNewServicesNeverRunNextToTheLegacyOne(t *testing.T) {
	if !strings.Contains(SystemdUnit(BinaryPath, "ARGS"), "ConditionPathExists=!"+LegacySystemdUnitPath+"\n") {
		t.Fatal("systemd unit lacks the guard against the pre-Opfield unit")
	}
	if !strings.Contains(OpenRCScript(BinaryPath, "ARGS"), "if [ -e "+LegacyOpenRCPath+" ]; then") {
		t.Fatal("OpenRC service lacks the guard against the pre-Opfield service")
	}
	if strings.Contains(SystemdUnit(BinaryPath, "ARGS"), "gateway-lease-watchdog.log") || UnitName != "opfield-lease-watchdog" {
		t.Fatal("new service carries the old name")
	}
}

// A watchdog started by the old systemd unit installs the new one with the old
// arguments, enables it, and leaves the stop/remove/start to a step outside its
// own unit; the order keeps one startable unit through any crash.
func TestMigrateFromTheLegacySystemdUnit(t *testing.T) {
	f := newFakeServiceHost(t, true, true)
	f.write(t, LegacySystemdUnitPath, SystemdUnit(LegacyBinaryPath, legacyArgs))
	f.write(t, LegacyBinaryPath, "binary-v2")
	result, err := MigrateLegacyService(context.Background(), f.host, f.host.path(LegacyBinaryPath), "run")
	if err != nil || result != SwitchingOver {
		t.Fatalf("result %v, %v", result, err)
	}
	unit, err := os.ReadFile(f.host.path(SystemdUnitPath))
	if err != nil || !strings.Contains(string(unit), "ExecStart="+BinaryPath+" "+legacyArgs+"\n") {
		t.Fatalf("new unit keeps the old arguments:\n%s %v", unit, err)
	}
	if binary, err := os.ReadFile(f.host.path(BinaryPath)); err != nil || string(binary) != "binary-v2" {
		t.Fatalf("binary not installed under the new name: %q %v", binary, err)
	}
	if !slices.Equal(f.commands, []string{"systemctl daemon-reload", "systemctl enable --quiet " + UnitName + ".service"}) {
		t.Fatalf("commands %v", f.commands)
	}
	if len(f.detached) != 1 {
		t.Fatalf("detached %v", f.detached)
	}
	script := f.detached[0]
	stop := strings.Index(script, "systemctl stop "+LegacyUnitName)
	remove := strings.Index(script, "rm -f '"+LegacySystemdUnitPath+"'")
	unlink := strings.Index(script, "rm -f "+legacySystemdWantsGlob)
	start := strings.Index(script, "systemctl start "+UnitName)
	if stop < 0 || remove < stop || unlink < remove || start < unlink || strings.Contains(script, "disable") {
		t.Fatalf("switch step order: %s", script)
	}
	if !f.exists(LegacySystemdUnitPath) {
		t.Fatal("the old unit must stay until the detached step stops it")
	}
	// A crash before the detached step ran: the next start repeats, idempotent.
	f.commands, f.detached = nil, nil
	if result, err := MigrateLegacyService(context.Background(), f.host, f.host.path(LegacyBinaryPath), "run"); err != nil || result != SwitchingOver {
		t.Fatalf("rerun %v %v", result, err)
	}
}

// Running as the new unit with an old one left over (an old installer brought it back): it is removed.
func TestMigrateRemovesALeftoverLegacyUnit(t *testing.T) {
	f := newFakeServiceHost(t, true, false)
	f.write(t, LegacySystemdUnitPath, SystemdUnit(LegacyBinaryPath, legacyArgs))
	f.write(t, LegacyBinaryPath, "old")
	f.write(t, BinaryPath, "new")
	legacyWants := "/etc/systemd/system/multi-user.target.wants/" + LegacyUnitName + ".service"
	f.write(t, legacyWants, "")
	result, err := MigrateLegacyService(context.Background(), f.host, f.host.path(BinaryPath), "run")
	if err != nil || result != RemovedLegacy {
		t.Fatalf("result %v, %v", result, err)
	}
	if f.exists(LegacySystemdUnitPath) || f.exists(legacyWants) || f.exists(LegacyBinaryPath) || len(f.detached) != 0 {
		t.Fatalf("leftover not removed (detached %v)", f.detached)
	}
	if !slices.Contains(f.commands, "systemctl stop "+LegacyUnitName+".service") {
		t.Fatalf("commands %v", f.commands)
	}
	f.commands = nil
	if result, err := MigrateLegacyService(context.Background(), f.host, f.host.path(BinaryPath), "run"); err != nil || result != NothingToMigrate || len(f.commands) != 0 {
		t.Fatalf("nothing left: %v %v %v", result, err, f.commands)
	}
}

func TestMigrateFromTheLegacyOpenRCService(t *testing.T) {
	f := newFakeServiceHost(t, false, true)
	f.write(t, LegacyOpenRCPath, OpenRCScript(LegacyBinaryPath, legacyArgs))
	f.write(t, LegacyBinaryPath, "binary-v2")
	result, err := MigrateLegacyService(context.Background(), f.host, f.host.path(LegacyBinaryPath), "run")
	if err != nil || result != SwitchingOver {
		t.Fatalf("result %v, %v", result, err)
	}
	script, err := os.ReadFile(f.host.path(OpenRCPath))
	if err != nil || !strings.Contains(string(script), `command_args="`+legacyArgs+`"`) || !strings.Contains(string(script), "start_pre()") {
		t.Fatalf("new OpenRC service:\n%s %v", script, err)
	}
	if !slices.Equal(f.commands, []string{"rc-update add " + UnitName + " default"}) {
		t.Fatalf("commands %v", f.commands)
	}
	if len(f.detached) != 1 || !strings.Contains(f.detached[0], "rc-service "+LegacyUnitName+" stop") || !strings.Contains(f.detached[0], "rc-service "+UnitName+" start") {
		t.Fatalf("detached %v", f.detached)
	}
}

func TestServiceArgsFallBack(t *testing.T) {
	if got := serviceArgs("[Service]\nExecStart=/other/bin run\n", "ExecStart="+LegacyBinaryPath+" ", "", "run --x"); got != "run --x" {
		t.Fatalf("got %q", got)
	}
}
