package watchdog

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

const containerID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type harness struct {
	t      *testing.T
	dir    leasefence.Dir
	cgroup string
	now    time.Duration
	killed []int
	dog    *Watchdog
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	base := t.TempDir()
	h := &harness{t: t, dir: leasefence.Dir{Root: filepath.Join(base, "run")}, cgroup: filepath.Join(base, "cgroup"), now: 100 * time.Second}
	if err := os.MkdirAll(h.dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	killer := CgroupKiller{Signal: func(pid int) error {
		h.killed = append(h.killed, pid)
		return nil
	}}
	h.dog = New(Config{
		Dir: h.dir, CgroupRoot: h.cgroup, Now: func() time.Duration { return h.now }, Killer: killer,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return h
}

// scope creates the systemd cgroup v2 directory of the container with pids.
func (h *harness) scope(pids ...int) string {
	h.t.Helper()
	path := filepath.Join(h.cgroup, "system.slice", "docker-"+containerID+".scope")
	if err := os.MkdirAll(path, 0o755); err != nil {
		h.t.Fatal(err)
	}
	var lines []string
	for _, pid := range pids {
		lines = append(lines, strconv.Itoa(pid))
	}
	if err := os.WriteFile(filepath.Join(path, "cgroup.procs"), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		h.t.Fatal(err)
	}
	return path
}

func (h *harness) record(deadline time.Duration, hint string) {
	h.t.Helper()
	if err := h.dir.WriteRecord(leasefence.Record{ContainerID: containerID, CgroupPath: hint, PolicyID: "p1", DeadlineNs: int64(deadline)}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) takeKilled() []int {
	out := h.killed
	h.killed = nil
	sort.Ints(out)
	return out
}

func TestStaleDeadlineKillsCgroupWithoutDockerd(t *testing.T) {
	h := newHarness(t)
	path := h.scope(41, 42)
	if err := os.WriteFile(filepath.Join(path, "cgroup.kill"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	h.record(h.now+10*time.Second, path)
	if result := h.dog.Pass(); result.Stale != 0 || len(h.takeKilled()) != 0 {
		t.Fatalf("armed record must not be enforced: %+v", result)
	}
	h.now += 10 * time.Second
	result := h.dog.Pass()
	if result.Stale != 1 || result.Killed != 2 || !result.Healthy {
		t.Fatalf("stale record not enforced: %+v", result)
	}
	if got := h.takeKilled(); len(got) != 2 || got[0] != 41 || got[1] != 42 {
		t.Fatalf("killed %v, want [41 42]", got)
	}
	if data, _ := os.ReadFile(filepath.Join(path, "cgroup.kill")); string(data) != "1" {
		t.Fatalf("cgroup.kill = %q, want 1", data)
	}
	if records, _, _ := h.dir.ReadRecords(); len(records) != 1 {
		t.Fatalf("the watchdog must never delete records (A12.3), have %d", len(records))
	}
}

func TestDeadDaemonRecordExpiresAndIsEnforced(t *testing.T) {
	h := newHarness(t)
	h.scope(7)
	// The daemon wrote a deadline (hint missing) and then died: nobody
	// renews it, so the watchdog fences at the deadline on its own.
	h.record(h.now+24*time.Second, "")
	for step := 0; step < 95; step++ {
		h.now += 250 * time.Millisecond
		h.dog.Pass()
		if len(h.killed) > 0 {
			t.Fatalf("killed at +%s, before the deadline", time.Duration(step+1)*250*time.Millisecond)
		}
	}
	h.now += 250 * time.Millisecond
	h.dog.Pass()
	if got := h.takeKilled(); len(got) != 1 || got[0] != 7 {
		t.Fatalf("killed %v at the deadline, want [7]", got)
	}
}

func TestLateDockerStartIsKilledOnTheNextPass(t *testing.T) {
	h := newHarness(t)
	h.record(0, "") // created standby, never held: always stale
	if result := h.dog.Pass(); result.Killed != 0 {
		t.Fatalf("no cgroup yet, nothing to kill: %+v", result)
	}
	h.scope() // docker created the cgroup, the process is not there yet
	h.dog.Pass()
	h.scope(99) // a docker start that completed late
	h.now += PassInterval
	h.dog.Pass()
	if got := h.takeKilled(); len(got) != 1 || got[0] != 99 {
		t.Fatalf("late start killed %v, want [99]", got)
	}
	h.scope(100) // restarted again: killed again
	h.now += PassInterval
	h.dog.Pass()
	if got := h.takeKilled(); len(got) != 1 || got[0] != 100 {
		t.Fatalf("second late start killed %v, want [100]", got)
	}
}

func TestForeignCgroupHintIsIgnored(t *testing.T) {
	h := newHarness(t)
	foreign := filepath.Join(h.cgroup, "system.slice", "sshd.service")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "cgroup.procs"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.record(0, foreign)
	h.dog.Pass()
	if got := h.takeKilled(); len(got) != 0 {
		t.Fatalf("a record must not make the watchdog kill a foreign cgroup, killed %v", got)
	}
}

func TestFrozenV1CgroupIsThawedBeforeKill(t *testing.T) {
	h := newHarness(t)
	freezer := filepath.Join(h.cgroup, "freezer", "docker", containerID)
	if err := os.MkdirAll(freezer, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"cgroup.procs": "5\n", "freezer.state": "FROZEN"} {
		if err := os.WriteFile(filepath.Join(freezer, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.record(0, "")
	h.dog.Pass()
	if state, _ := os.ReadFile(filepath.Join(freezer, "freezer.state")); string(state) != "THAWED" {
		t.Fatalf("freezer.state = %q, want THAWED", state)
	}
	if got := h.takeKilled(); len(got) != 1 || got[0] != 5 {
		t.Fatalf("killed %v, want [5]", got)
	}
}

func TestHeartbeatProvesTheKillLoopRuns(t *testing.T) {
	h := newHarness(t)
	h.dog.Heartbeat(h.dog.Pass().Healthy)
	heartbeat, err := h.dir.ReadHeartbeat()
	if err != nil || !heartbeat.Fresh(h.now) || heartbeat.NowNs != int64(h.now) {
		t.Fatalf("heartbeat %+v, err %v", heartbeat, err)
	}
	h.now += leasefence.HeartbeatMaxAge + time.Millisecond
	if heartbeat.Fresh(h.now) {
		t.Fatal("heartbeat must go stale when the loop stops")
	}
	// An unreadable record directory withholds the heartbeat.
	if err := os.RemoveAll(h.dir.RecordsDir()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.dir.RecordsDir(), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	result := h.dog.Pass()
	h.dog.Heartbeat(result.Healthy)
	if result.Healthy {
		t.Fatal("pass must be unhealthy when records cannot be read")
	}
	if again, _ := h.dir.ReadHeartbeat(); again.NowNs != heartbeat.NowNs {
		t.Fatal("heartbeat must not advance while enforcement is broken")
	}
}

// B-10 follow-up: a node rolled back to a docker daemon without the
// availability lease never renews or removes its deadline records. With no
// sign of a lease-aware daemon for leasefence.DaemonGoneAfter the watchdog
// removes them instead of killing every start of those containers until the
// next reboot; while one is around it never removes a record.
func TestOrphanedRecordsAreRemovedOnlyWithoutALeaseAwareDaemon(t *testing.T) {
	h := newHarness(t)
	h.now = time.Hour
	h.scope(11)
	write := func(written time.Duration) {
		h.t.Helper()
		if err := h.dir.WriteRecord(leasefence.Record{ContainerID: containerID, PolicyID: "p1", WrittenNs: int64(written)}); err != nil {
			h.t.Fatal(err)
		}
	}
	// A daemon before availability_lease_v2 wrote the standby record a
	// minute ago: it is around, the record is enforced.
	write(h.now - time.Minute)
	if result := h.dog.Pass(); result.Orphans != 0 || result.Killed != 1 {
		t.Fatalf("record of a live daemon: %+v", result)
	}
	h.takeKilled()
	// The daemon heartbeat keeps an old record enforced.
	write(h.now - 2*leasefence.DaemonGoneAfter)
	if err := h.dir.WriteDaemonHeartbeat(leasefence.Heartbeat{NowNs: int64(h.now - time.Second)}); err != nil {
		t.Fatal(err)
	}
	if result := h.dog.Pass(); result.Orphans != 0 || result.Killed != 1 {
		t.Fatalf("record with a fresh daemon heartbeat: %+v", result)
	}
	h.takeKilled()
	// Rolled back: no heartbeat, no record written for DaemonGoneAfter.
	h.now += leasefence.DaemonGoneAfter
	result := h.dog.Pass()
	if result.Orphans != 1 || result.Killed != 0 {
		t.Fatalf("orphaned record after a rollback: %+v", result)
	}
	if records, _, _ := h.dir.ReadRecords(); len(records) != 0 {
		t.Fatalf("orphaned record kept: %v", records)
	}
	if got := h.takeKilled(); len(got) != 0 {
		t.Fatalf("killed %v after the rollback", got)
	}
}

// A failure that repeats on every pass (4 per second) is logged when it starts and when it ends, not on every pass:
// OpenRC keeps the watchdog's output in a plain file (disk audit G4).
func TestRepeatedReadFailureLogsOncePerEpisode(t *testing.T) {
	h := newHarness(t)
	var out bytes.Buffer
	h.dog.cfg.Logger = slog.New(slog.NewTextHandler(&out, nil))
	if err := os.RemoveAll(h.dir.RecordsDir()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.dir.RecordsDir(), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for range 400 {
		if h.dog.Pass().Healthy {
			t.Fatal("pass must be unhealthy when records cannot be read")
		}
	}
	if lines := strings.Count(out.String(), "lease watchdog reading deadline records failing"); lines != 1 {
		t.Fatalf("logged %d failure lines for one episode:\n%s", lines, out.String())
	}
	if !strings.Contains(out.String(), "level=ERROR") {
		t.Fatalf("the failure must stay an error:\n%s", out.String())
	}
	if err := os.Remove(h.dir.RecordsDir()); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(h.dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if !h.dog.Pass().Healthy {
		t.Fatal("pass must recover")
	}
	if !strings.Contains(out.String(), "lease watchdog reading deadline records recovered") {
		t.Fatalf("recovery not logged:\n%s", out.String())
	}
}
