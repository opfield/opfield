package leasefence

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestRecordsRoundTripAndMalformedFilesAreReported(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: testID, PolicyID: "p1", Slot: 2, DeadlineNs: 42}); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: "short"}); err == nil {
		t.Fatal("a record needs a full container id")
	}
	if err := os.WriteFile(filepath.Join(dir.RecordsDir(), "junk.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	records, problems, err := dir.ReadRecords()
	if err != nil || len(records) != 1 || len(problems) != 1 {
		t.Fatalf("records %+v problems %v err %v", records, problems, err)
	}
	if records[0].Slot != 2 || records[0].Version != FormatVersion || !records[0].Stale(42) || records[0].Stale(41) {
		t.Fatalf("record %+v", records[0])
	}
	if err := dir.DeleteRecord(testID); err != nil {
		t.Fatal(err)
	}
	if err := dir.DeleteRecord(testID); err != nil {
		t.Fatal("deleting a missing record is not an error")
	}
}

// A record is readable to the owner of the records directory whoever wrote it: after a switch of the daemon's user the
// directory is the new user's, and the records the previous daemon wrote must not stop it from recovering its copies.
func TestRecordsAreReadableToTheDirectoryOwner(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: testID, PolicyID: "p1", DeadlineNs: 42}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir.RecordsDir(), testID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("record mode %v, want 0644", info.Mode())
	}
}

// A record the daemon may not read (another user's, after a switch of the daemon's user) is an error for the daemon,
// never a missing record: a missing record makes its running copy look unfenced.
func TestRecordTheDaemonMayNotReadIsAnError(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteRecord(Record{ContainerID: testID, PolicyID: "p1", DeadlineNs: 42}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir.RecordsDir(), testID+".json"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(filepath.Join(dir.RecordsDir(), testID+".json")); err == nil {
		t.Skip("this process reads every file (root or CAP_DAC_READ_SEARCH)")
	}
	if records, err := dir.ReadableRecords(); !errors.Is(err, os.ErrPermission) || records != nil {
		t.Fatalf("records %+v err %v, want a permission error", records, err)
	}
	if records, problems, err := dir.ReadRecords(); err != nil || len(records) != 0 || len(problems) != 1 {
		t.Fatalf("the watchdog's read: records %+v problems %v err %v", records, problems, err)
	}
}

func TestHeartbeatFreshness(t *testing.T) {
	dir := Dir{Root: t.TempDir()}
	if err := dir.WriteHeartbeat(Heartbeat{NowNs: int64(10 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	heartbeat, err := dir.ReadHeartbeat()
	if err != nil {
		t.Fatal(err)
	}
	if !heartbeat.Fresh(10*time.Second+HeartbeatMaxAge) || heartbeat.Fresh(10*time.Second+HeartbeatMaxAge+1) {
		t.Fatal("heartbeat freshness window is wrong")
	}
	// Written between the reader's clock read and its file read: fresh.
	if age, ok := heartbeat.Age(9 * time.Second); !ok || age != 0 || !heartbeat.Fresh(9*time.Second) {
		t.Fatalf("a heartbeat written just after the reader's clock read must be fresh: age %s ok %v", age, ok)
	}
	if heartbeat.Fresh(10*time.Second - HeartbeatMaxAge - 1) {
		t.Fatal("a heartbeat far in the future cannot come from this clock")
	}
	if !heartbeat.Alive(10*time.Second+HeartbeatLostAge) || heartbeat.Alive(10*time.Second+HeartbeatLostAge+1) {
		t.Fatal("heartbeat loss window is wrong")
	}
	if (Heartbeat{}).Alive(time.Second) {
		t.Fatal("a heartbeat never written is not alive")
	}
}

func TestCgroupPathValidationAndCandidates(t *testing.T) {
	root := "/sys/fs/cgroup"
	valid := []string{
		root + "/system.slice/docker-" + testID + ".scope",
		root + "/docker/" + testID,
		root + "/pids/docker/" + testID,
		root + "/custom.slice/opfield-" + testID + ".scope",
	}
	for _, path := range valid {
		if !ValidCgroupPath(root, testID, path) {
			t.Errorf("%s should be valid", path)
		}
	}
	invalid := []string{
		"", "relative/" + testID, "/etc/" + testID, root, root + "/system.slice/sshd.service",
		root + "/docker/" + testID + "/../../system.slice", root + "/docker/other",
	}
	for _, path := range invalid {
		if ValidCgroupPath(root, testID, path) {
			t.Errorf("%s must be rejected", path)
		}
	}
	candidates := CgroupCandidates(root, testID, root+"/system.slice/sshd.service")
	for _, path := range candidates {
		if !ValidCgroupPath(root, testID, path) {
			t.Fatalf("candidate %s is not a path of the container", path)
		}
	}
	if CgroupCandidates(root, "bad", "") != nil {
		t.Fatal("invalid container ids have no candidates")
	}
}

func TestCgroupFromProcAndEmptiness(t *testing.T) {
	root := t.TempDir()
	v2 := "0::/system.slice/docker-" + testID + ".scope\n"
	if got := CgroupFromProc(root, v2); got != filepath.Join(root, "system.slice", "docker-"+testID+".scope") {
		t.Fatalf("v2 path %s", got)
	}
	v1 := "12:pids:/docker/" + testID + "\n11:memory:/docker/" + testID + "\n1:name=systemd:/docker/" + testID + "\n"
	if got := CgroupFromProc(root, v1); got != filepath.Join(root, "pids", "docker", testID) {
		t.Fatalf("v1 path %s", got)
	}
	empty, err := ContainerCgroupEmpty(root, testID, "")
	if err != nil || !empty {
		t.Fatalf("missing cgroup is empty: %v %v", empty, err)
	}
	scope := filepath.Join(root, "system.slice", "docker-"+testID+".scope")
	child := filepath.Join(scope, "init")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scope, "cgroup.procs"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "cgroup.procs"), []byte("77\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if empty, _ := ContainerCgroupEmpty(root, testID, ""); empty {
		t.Fatal("a process in a child cgroup keeps the container cgroup non-empty")
	}
}
