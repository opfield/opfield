package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

const testGiB = int64(1024 * 1024 * 1024)

// sparseImage creates a file of size bytes that occupies none of them, like
// an instance image after mkfs (or a trim) punched holes into it. It returns
// the bytes the file does not occupy: size on ext4 and tmpfs, slightly less
// where the filesystem allocates a block even for an empty file (ZFS: 512).
func sparseImage(t *testing.T, path string, size int64) int64 {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	allocated := allocatedBytes(t, path)
	if allocated > 64*1024 {
		t.Fatalf("the sparse image %s occupies %d bytes", path, allocated)
	}
	return size - allocated
}

// allocatedBytes is what the filesystem reports a file occupies (st_blocks).
func allocatedBytes(t *testing.T, path string) int64 {
	t.Helper()
	var stat unix.Stat_t
	if err := unix.Stat(path, &stat); err != nil {
		t.Fatal(err)
	}
	return stat.Blocks * 512
}

func statfsWithFree(free int64) func(string, *unix.Statfs_t) error {
	return func(_ string, stat *unix.Statfs_t) error {
		stat.Bsize, stat.Blocks, stat.Bavail = 4096, uint64(64*testGiB/4096), uint64(free/4096)
		return nil
	}
}

// The images on the disk are promised their full size: a create or grow is
// checked against the space they may still take, not only against what is
// free now, so a node cannot be filled by images that grow into their sizes.
func TestManagedDiskCapacityCountsWhatTheImagesArePromised(t *testing.T) {
	root := t.TempDir()
	// A database image and a storage image that occupy nothing yet.
	promised := sparseImage(t, filepath.Join(root, "images", "db.img"), 6*testGiB) +
		sparseImage(t, filepath.Join(root, "storage", "images", "s3-0.img"), 3*testGiB)
	// A record written in full occupies its size and promises nothing more (a
	// filesystem that compresses or allocates late, like ZFS, may report up to
	// its size as not yet occupied).
	if err := os.MkdirAll(filepath.Join(root, "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "records", "db.json"), []byte(strings.Repeat("x", 8192)), 0o600); err != nil {
		t.Fatal(err)
	}

	unallocated, err := unallocatedImageBytes(root)
	if err != nil {
		t.Fatal(err)
	}
	if unallocated < promised || unallocated > promised+8192 || promised < 9*testGiB-64*1024 {
		t.Fatalf("unallocated %d, want the %d bytes the two images are promised", unallocated, promised)
	}

	reservations := &managedDiskReservations{pending: map[uint64]int64{}}
	// 12 GiB free, plus what this filesystem counts as promised beyond the 9
	// GiB of the images (a record ZFS has not allocated yet), whole blocks.
	excess := (max(0, unallocated-9*testGiB) + 4095) / 4096 * 4096
	statfs := statfsWithFree(12*testGiB + excess)
	// 12 GiB free - 9 GiB promised - 1 GiB reserve leaves 2 GiB.
	release, err := reservations.reserve(root, 2*testGiB, testGiB, statfs, "insufficient managed storage capacity after reserve")
	if err != nil {
		t.Fatalf("2 GiB should fit: %v", err)
	}
	// A second create while the first holds its space does not fit.
	if _, err := reservations.reserve(root, testGiB, testGiB, statfs, "insufficient database storage capacity after reserve"); err == nil {
		t.Fatal("a create that only fits without the reservation in progress was accepted")
	} else {
		var refused *managedDiskCapacityError
		if !errors.As(err, &refused) || !strings.HasPrefix(err.Error(), "insufficient database storage capacity after reserve: ") {
			t.Fatalf("refusal %v", err)
		}
		if !strings.Contains(err.Error(), "existing instances may still take 11.0 GiB") {
			t.Fatalf("refusal does not say what is promised: %v", err)
		}
	}
	release()
	if _, err := reservations.reserve(root, 3*testGiB, testGiB, statfs, "insufficient managed storage capacity after reserve"); err == nil {
		t.Fatal("3 GiB fit next to 9 GiB promised on 12 GiB free with a 1 GiB reserve")
	}
	if release, err := reservations.reserve(root, testGiB, testGiB, statfs, "x"); err != nil {
		t.Fatalf("1 GiB after the release: %v", err)
	} else {
		release()
	}
}

// A disk whose images are promised more than it holds is reported
// oversubscribed (with how much is missing); one that holds them is not.
func TestManagedDiskOversubscription(t *testing.T) {
	root := t.TempDir()
	promised := sparseImage(t, filepath.Join(root, "images", "db.img"), 10*testGiB)
	if detail := managedDiskOversubscription(root, testGiB, statfsWithFree(20*testGiB)); detail != nil {
		t.Fatalf("a disk with room reported oversubscribed: %v", detail)
	}
	detail := managedDiskOversubscription(root, testGiB, statfsWithFree(8*testGiB))
	if detail == nil {
		t.Fatal("10 GiB promised on 8 GiB free is not reported")
	}
	// 3 GiB on ext4 and tmpfs (10 promised + 1 reserve - 8 free).
	want := promised + testGiB - 8*testGiB
	if short := detail["shortBytes"].(int64); short != want {
		t.Fatalf("shortBytes %d, want %d (10 GiB promised + 1 reserve - 8 free)", short, want)
	}
	usage, err := readManagedDiskUsage(root, statfsWithFree(8*testGiB))
	if err != nil {
		t.Fatal(err)
	}
	if usage.Available(testGiB) != -want || !usage.Oversubscribed(testGiB) {
		t.Fatalf("usage %+v", usage)
	}
}

// The health marker of the storage root no longer advertises space the
// existing images may still take.
func TestStorageRootHealthCountsPromisedSpace(t *testing.T) {
	root := t.TempDir()
	promised := sparseImage(t, filepath.Join(root, "storage", "images", "a-0.img"), 4*testGiB)
	m := &managedStorageManager{root: root, reserve: testGiB, statFilesystem: statfsWithFree(10 * testGiB)}
	mount, err := m.storageRootHealthMount()
	if err != nil {
		t.Fatal(err)
	}
	if want := 10*testGiB - promised - testGiB; mount.FreeBytes != want {
		t.Fatalf("allocatable %d, want 10 free - 4 promised - 1 reserve = %d", mount.FreeBytes, want)
	}
}

// An oversubscribed storage root reports no allocatable space and a use over
// 100%, which Opfield's built-in "Node disk oversubscribed" rule alerts on.
func TestStorageRootHealthShowsOversubscription(t *testing.T) {
	root := t.TempDir()
	promised := sparseImage(t, filepath.Join(root, "storage", "images", "a-0.img"), 12*testGiB)
	statfs := func(path string, stat *unix.Statfs_t) error {
		*stat = unix.Statfs_t{Bsize: 4096, Blocks: uint64(20 * testGiB / 4096), Bavail: uint64(10 * testGiB / 4096), Bfree: uint64(10 * testGiB / 4096)}
		return nil
	}
	m := &managedStorageManager{root: root, reserve: testGiB, statFilesystem: statfs}
	mount, err := m.storageRootHealthMount()
	if err != nil {
		t.Fatal(err)
	}
	// 10 free - 12 promised - 1 reserve: 3 GiB short of what the image may take.
	if mount.FreeBytes != 0 || mount.UsedBytes != 10*testGiB+promised+testGiB || mount.UsagePercent <= 100 {
		t.Fatalf("oversubscribed storage root mount = %+v", mount)
	}
}

// A filesystem that stopped writing (ext4 emergency_ro, a read-only
// superblock or mount) is read-only; a healthy one is not.
func TestReadOnlyMount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mounts", "a")
	for _, tc := range []struct {
		options, super string
		readOnly       bool
		reason         string
	}{
		{"rw,noatime", "rw", false, ""},
		{"rw,noatime", "rw,emergency_ro", true, "emergency_ro"},
		{"rw,noatime", "ro,errors=continue", true, "the filesystem was switched to read-only"},
		{"ro,noatime", "rw", true, "mounted read-only"},
	} {
		loops := newFakeLoops(t)
		loops.mounts = []mountEntry{{MountPoint: canonicalLoopPath(path), Number: "7:4", FSType: "ext4", Options: tc.options, SuperOptions: tc.super}}
		readOnly, reason := loops.host().readOnlyMount(path)
		if readOnly != tc.readOnly || reason != tc.reason {
			t.Fatalf("%s / %s: read-only %v (%q), want %v (%q)", tc.options, tc.super, readOnly, reason, tc.readOnly, tc.reason)
		}
	}
	if readOnly, _ := newFakeLoops(t).host().readOnlyMount(path); readOnly {
		t.Fatal("a disk that is not mounted is read-only")
	}
}

func TestParseMountInfoKeepsOptions(t *testing.T) {
	line := "736 2293 7:4 / /var/lib/docker-daemon/databases/mounts/2ed4c161 rw,noatime shared:1298 - ext4 /dev/loop4 rw,emergency_ro\n"
	mounts, err := parseMountInfo(strings.NewReader(line))
	if err != nil || len(mounts) != 1 {
		t.Fatalf("%v %v", mounts, err)
	}
	if got := mounts[0]; got.Options != "rw,noatime" || got.SuperOptions != "rw,emergency_ro" || got.FSType != "ext4" || got.Source != "/dev/loop4" {
		t.Fatalf("%+v", got)
	}
}

// repairHarness is a disk repair with fakes for everything it touches.
type repairHarness struct {
	t       *testing.T
	mu      sync.Mutex
	loops   *fakeLoops
	root    string
	image   string
	mount   string
	wanted  bool
	repairs []managedDiskRepair
	calls   []string
	fsck    func() (int, string, error)
	free    int64
	startFn func() error
}

func newRepairHarness(t *testing.T) *repairHarness {
	root := t.TempDir()
	h := &repairHarness{t: t, loops: newFakeLoops(t), root: root, wanted: true, free: 10 * testGiB,
		image: filepath.Join(root, "images", "db.img"), mount: filepath.Join(root, "mounts", "db")}
	writeFile(t, h.image)
	if err := os.MkdirAll(h.mount, 0o700); err != nil {
		t.Fatal(err)
	}
	h.loops.attach("/dev/loop4", "7:4", h.image)
	h.loops.mounts = append(h.loops.mounts, mountEntry{MountPoint: canonicalLoopPath(h.mount), Number: "7:4", FSType: "ext4", Options: "rw,noatime", SuperOptions: "rw,emergency_ro"})
	h.fsck = func() (int, string, error) { return 1, "db.img: 12/393216 files, recovered journal\n", nil }
	return h
}

func (h *repairHarness) job() diskRepairJob {
	host := h.loops.host()
	return diskRepairJob{
		label: "managed database", id: "db", reason: "emergency_ro", lock: &h.mu, loops: host, root: h.root,
		statfs: statfsWithFree(h.free), logger: slog.New(slog.DiscardHandler),
		fsck: func(_ context.Context, image string) (int, string, error) {
			h.calls = append(h.calls, "fsck "+image)
			if mounted, _ := host.isMounted(canonicalLoopPath(h.mount)); mounted {
				h.t.Fatal("e2fsck ran on a mounted disk")
			}
			return h.fsck()
		},
		load: func() (diskRepairTarget, bool, error) {
			var last *managedDiskRepair
			if len(h.repairs) > 0 {
				last = &h.repairs[len(h.repairs)-1]
			}
			return diskRepairTarget{ImagePath: h.image, MountPath: h.mount, ContainerID: "c1", Repair: last}, h.wanted, nil
		},
		persist: func(repair managedDiskRepair) error {
			h.repairs = append(h.repairs, repair)
			return nil
		},
		stop: func(_ context.Context, containerID string) error {
			h.calls = append(h.calls, "stop "+containerID)
			return nil
		},
		start: func(ctx context.Context) error {
			h.calls = append(h.calls, "start")
			if h.startFn != nil {
				return h.startFn()
			}
			_, err := host.mountImage(ctx, h.image, h.mount, "noatime")
			return err
		},
		now: func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC) },
	}
}

func (h *repairHarness) states() []string {
	var states []string
	for _, repair := range h.repairs {
		states = append(states, repair.State)
	}
	return states
}

// A read-only disk is repaired: the engine is stopped, the image unmounted and
// detached, e2fsck -p runs on it, and it is mounted again and the engine
// started; the record says what happened.
func TestDiskRepairStopsChecksRemountsAndStarts(t *testing.T) {
	h := newRepairHarness(t)
	h.job().run(context.Background())

	if want := []string{"stop c1", "fsck " + h.image, "start"}; !slices.Equal(h.calls, want) {
		t.Fatalf("steps %v, want %v", h.calls, want)
	}
	if want := []string{diskRepairRepairing, diskRepairRepaired}; !slices.Equal(h.states(), want) {
		t.Fatalf("recorded %v, want %v", h.states(), want)
	}
	last := h.repairs[len(h.repairs)-1]
	if last.Detail != "e2fsck repaired the filesystem" || last.Reason != "emergency_ro" {
		t.Fatalf("outcome %+v", last)
	}
	if !slices.Contains(h.loops.calls, "detach /dev/loop4") {
		t.Fatalf("the image was not detached before the check: %v", h.loops.calls)
	}
}

// A filesystem e2fsck -p cannot repair stays unmounted with its engine
// stopped, and the record says the repair failed and why.
func TestDiskRepairThatE2fsckCannotFinishFails(t *testing.T) {
	h := newRepairHarness(t)
	h.fsck = func() (int, string, error) {
		return 4, "db.img: UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY.\n\t(i.e., without -a or -p options)\n", nil
	}
	h.job().run(context.Background())

	if slices.Contains(h.calls, "start") {
		t.Fatalf("the engine was started on a disk e2fsck could not repair: %v", h.calls)
	}
	last := h.repairs[len(h.repairs)-1]
	if last.State != diskRepairFailed || !strings.Contains(last.Detail, "exit status 4") || !strings.Contains(last.Detail, "RUN fsck MANUALLY") {
		t.Fatalf("outcome %+v", last)
	}
	if mounted, _ := h.loops.host().isMounted(canonicalLoopPath(h.mount)); mounted {
		t.Fatal("the disk that failed its repair is mounted")
	}
}

// Without free space on the node's disk a repair would fail on the image's
// holes; it waits, keeps the engine stopped and is resumed later.
func TestDiskRepairWaitsForFreeSpace(t *testing.T) {
	h := newRepairHarness(t)
	h.free = 100 * mebibyte
	h.job().run(context.Background())

	if slices.ContainsFunc(h.calls, func(call string) bool { return strings.HasPrefix(call, "fsck") }) {
		t.Fatalf("e2fsck ran without free space: %v", h.calls)
	}
	last := h.repairs[len(h.repairs)-1]
	if last.State != diskRepairRepairing || !strings.Contains(last.Detail, "waiting for free space") {
		t.Fatalf("state %+v, want a repair that waits", last)
	}

	// A watch that finds it still waiting records nothing new.
	recorded := len(h.repairs)
	h.job().run(context.Background())
	if len(h.repairs) != recorded {
		t.Fatalf("a repair that still waits recorded again: %+v", h.repairs[recorded:])
	}
	if h.repairs[0].At != h.repairs[len(h.repairs)-1].At {
		t.Fatalf("a waiting repair moved its start: %+v", h.repairs)
	}

	// Once there is room, the next watch resumes it.
	h.free = 10 * testGiB
	h.job().run(context.Background())
	if h.repairs[len(h.repairs)-1].State != diskRepairRepaired {
		t.Fatalf("resumed repair ended %+v", h.repairs[len(h.repairs)-1])
	}
}

// An instance deleted or stopped while e2fsck runs is left as it is.
func TestDiskRepairLeavesAnInstanceThatWasDeletedMeanwhile(t *testing.T) {
	h := newRepairHarness(t)
	h.fsck = func() (int, string, error) {
		h.wanted = false
		return 0, "", nil
	}
	h.job().run(context.Background())
	if slices.Contains(h.calls, "start") {
		t.Fatalf("a deleted instance's engine was started: %v", h.calls)
	}
}

// An engine that does not start on the repaired disk fails the repair.
func TestDiskRepairReportsAnEngineThatDoesNotStart(t *testing.T) {
	h := newRepairHarness(t)
	h.startFn = func() error { return errors.New("the filesystem is still read-only (emergency_ro)") }
	h.job().run(context.Background())
	last := h.repairs[len(h.repairs)-1]
	if last.State != diskRepairFailed || !strings.Contains(last.Detail, "still read-only") {
		t.Fatalf("outcome %+v", last)
	}
}

func TestDiskRepairDetail(t *testing.T) {
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	if diskRepairDetail(nil, false) != nil {
		t.Fatal("an instance without a repair reports one")
	}
	failed := &managedDiskRepair{State: diskRepairFailed, Reason: "emergency_ro", Detail: "exit status 4", At: at}
	if got := diskRepairDetail(failed, false); got["state"] != diskRepairFailed || got["detail"] != "exit status 4" || got["at"] != "2026-10-09T12:00:00Z" {
		t.Fatalf("%v", got)
	}
	// A failed repair a restart retries is repairing while it runs.
	if got := diskRepairDetail(failed, true); got["state"] != diskRepairRepairing || got["detail"] != nil {
		t.Fatalf("%v", got)
	}
}

// The unrequested stops of an engine are reported for a day; two of them
// within minutes, without a minute of running since, are a crash loop.
func TestEngineIncidents(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	incidents := newEngineIncidents()
	incidents.now = func() time.Time { return now }

	incidents.record("db", false)
	if incidents.crashLooping("db", time.Time{}) {
		t.Fatal("one crash is a crash loop")
	}
	now = now.Add(70 * time.Second)
	incidents.record("db", true)
	if !incidents.crashLooping("db", now.Add(-10*time.Second)) {
		t.Fatal("two crashes within minutes and 10 s of running are not a crash loop")
	}
	if incidents.crashLooping("db", now.Add(-2*time.Minute)) {
		t.Fatal("an engine that has run for two minutes is in a crash loop")
	}
	detail := incidents.detail("db")
	if detail["restarts"] != 2 || detail["oomKills"] != 1 || detail["lastOomAt"] != "2026-10-09T12:01:10Z" {
		t.Fatalf("%v", detail)
	}
	now = now.Add(25 * time.Hour)
	if incidents.detail("db") != nil || incidents.crashLooping("db", time.Time{}) {
		t.Fatal("stops older than a day are still reported")
	}
	var none *engineIncidents
	none.record("db", true)
	if none.detail("db") != nil {
		t.Fatal("a manager without a tracker reports stops")
	}
}

func inspectDatabase(t *testing.T, m *managedDatabaseManager, id string) map[string]any {
	t.Helper()
	detail, err := m.handle(context.Background(), "inspect", id, "")
	if err != nil {
		t.Fatal(err)
	}
	var inspected map[string]any
	if err := json.Unmarshal([]byte(detail), &inspected); err != nil {
		t.Fatal(err)
	}
	return inspected
}

// Opfield must not show a database ready while its engine keeps failing:
// two stops of its own within minutes, and it is reported stopped (engineExited)
// even in the seconds it runs between two restarts. Its stops of the last day
// are reported with it.
func TestDatabaseInspectReportsAnEngineThatKeepsFailing(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"c1": true}, policy: map[string]string{}}
	m.client = docker.client()
	m.incidents = newEngineIncidents()
	record := saveTestDatabase(t, m, id)
	record.ContainerID = "c1"
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	if got := inspectDatabase(t, m, id); got["status"] != "ready" || got["engineExited"] != nil {
		t.Fatalf("healthy engine: %v", got)
	}
	m.incidents.record(id, true)
	m.incidents.record(id, false)
	got := inspectDatabase(t, m, id)
	if got["status"] != "stopped" || got["engineExited"] != true {
		t.Fatalf("crash-looping engine: %v", got)
	}
	incidents, _ := got["engineIncidents"].(map[string]any)
	if incidents["restarts"] != float64(2) || incidents["oomKills"] != float64(1) || incidents["lastOomAt"] == nil {
		t.Fatalf("engine incidents %v", got["engineIncidents"])
	}
}

// A disk whose repair failed keeps the engine stopped and says so; a start
// tries the repair again (and is refused until it finished), and the engine
// runs again once the disk is repaired.
func TestDatabaseStartRetriesAFailedDiskRepair(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"c1": false}, policy: map[string]string{}}
	m.client = docker.client()
	m.statFilesystem = statfsWithFree(10 * testGiB)
	var fscks []string
	m.runFsck = func(_ context.Context, image string) (int, string, error) {
		fscks = append(fscks, image)
		return 1, "repaired\n", nil
	}
	record := saveTestDatabase(t, m, id)
	record.ContainerID = "c1"
	record.DiskRepair = &managedDiskRepair{State: diskRepairFailed, Reason: "emergency_ro", Detail: "exit status 4", At: time.Now().UTC()}
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	got := inspectDatabase(t, m, id)
	repair, _ := got["diskRepair"].(map[string]any)
	if got["status"] != "stopped" || repair["state"] != diskRepairFailed || repair["detail"] != "exit status 4" {
		t.Fatalf("failed repair: %v", got)
	}
	if err := m.startStoppedEngine(context.Background(), id, ""); err != nil || docker.running["c1"] {
		t.Fatalf("the supervisor started an engine whose disk failed its repair (%v)", err)
	}

	if _, err := m.handle(context.Background(), "start", id, ""); err == nil || !strings.Contains(err.Error(), "being repaired") {
		t.Fatalf("start of a disk that failed its repair: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		current, err := m.loadRecord(id)
		if err == nil && current.DiskRepair != nil && current.DiskRepair.State == diskRepairRepaired && !m.repairs.running(id) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("repair did not finish: %+v", current.DiskRepair)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(fscks) != 1 || fscks[0] != record.ImagePath || !docker.running["c1"] {
		t.Fatalf("fsck %v, engine running %v", fscks, docker.running["c1"])
	}
	if got := inspectDatabase(t, m, id); got["status"] != "ready" {
		t.Fatalf("after the repair: %v", got)
	}
}

// A removal also removes a container of the member that a recreation the
// daemon could not finish left behind (the stand: "-0" next to "-0-replaced").
func TestStorageRemovalRemovesLeftoverMemberContainers(t *testing.T) {
	var removed []string
	var filters string
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			reply := func(code int, body string) (*http.Response, error) {
				return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			}
			switch {
			case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/containers/json"):
				filters = request.URL.Query().Get("filters")
				return reply(http.StatusOK, `[{"Id":"left1","Names":["/gateway-storage-s-0"]}]`)
			case request.Method == http.MethodDelete && strings.HasSuffix(request.URL.Path, "/containers/left1"):
				removed = append(removed, "left1")
				return reply(http.StatusNoContent, "")
			}
			t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
			return reply(http.StatusNotFound, `{"message":"not found"}`)
		})}))
	if err != nil {
		t.Fatal(err)
	}
	m := &managedStorageManager{client: &Client{cli: cli}, logger: slog.New(slog.DiscardHandler)}
	if err := m.removeMemberContainers(context.Background(), managedStorageRecord{ID: "s", MemberIndex: 0}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(removed, []string{"left1"}) {
		t.Fatalf("removed %v", removed)
	}
	if !strings.Contains(filters, managedStorageLabel+"=s") || !strings.Contains(filters, managedStorageMemberLabel+"=0") {
		t.Fatalf("listed with filters %s, want the member's labels", filters)
	}
}

// Each instance disk is trimmed every interval, and at every watch while the
// node's disk is below its reserve.
func TestDiskTrimsSpacing(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	trims := newDiskTrims()
	trims.now = func() time.Time { return now }
	if !trims.due("storage/a", false) {
		t.Fatal("a disk never trimmed is not due")
	}
	now = now.Add(diskWatchInterval)
	if trims.due("storage/a", false) {
		t.Fatal("a disk trimmed 30 s ago is due")
	}
	if !trims.due("storage/a", true) {
		t.Fatal("a disk is not trimmed while the node's disk is below its reserve")
	}
	now = now.Add(diskTrimInterval)
	if !trims.due("storage/a", false) {
		t.Fatal("a disk is not trimmed after an interval")
	}
	if !nodeDiskTight("/", 2*testGiB, statfsWithFree(testGiB)) || nodeDiskTight("/", 2*testGiB, statfsWithFree(4*testGiB)) {
		t.Fatal("tight node disk misjudged")
	}
}
