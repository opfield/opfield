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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// fakeLoops is the kernel's loop and mount state. Image files are real files
// in a temporary directory; loop devices and mounts exist only here.
type fakeLoops struct {
	t      *testing.T
	mounts []mountEntry
	loops  []loopDevice
	ids    map[string][2]uint64
	// busy counts the unmount attempts of a path that fail before one succeeds.
	busy map[string]int
	// held devices stay bound after losetup -d, like a device another mount
	// namespace still holds open.
	held     map[string]bool
	calls    []string
	onDetach func(device string)
	// attachErr fails every attach, like a node without a free loop device;
	// failImages fails the attach of single images.
	attachErr  error
	failImages map[string]bool
}

func newFakeLoops(t *testing.T) *fakeLoops {
	return &fakeLoops{t: t, ids: map[string][2]uint64{}, busy: map[string]int{}, held: map[string]bool{}}
}

func (f *fakeLoops) host() *loopHost {
	return &loopHost{
		loops:  func() ([]loopDevice, error) { return slices.Clone(f.loops), nil },
		mounts: func() ([]mountEntry, error) { return slices.Clone(f.mounts), nil },
		identity: func(device string) (uint64, uint64, bool) {
			id, ok := f.ids[device]
			return id[0], id[1], ok
		},
		unmount: func(_ context.Context, path string) error {
			f.calls = append(f.calls, "umount "+path)
			if f.busy[path] > 0 {
				f.busy[path]--
				return errors.New("target is busy")
			}
			for i := len(f.mounts) - 1; i >= 0; i-- {
				if f.mounts[i].MountPoint == path {
					f.mounts = slices.Delete(f.mounts, i, i+1)
					return nil
				}
			}
			return errors.New("not mounted")
		},
		detach: func(_ context.Context, device string) error {
			f.calls = append(f.calls, "detach "+device)
			if f.onDetach != nil {
				f.onDetach(device)
			}
			if !f.held[device] {
				f.loops = slices.DeleteFunc(f.loops, func(loop loopDevice) bool { return loop.Path == device })
			}
			return nil
		},
		sleep: func(context.Context, time.Duration) error { return nil },
		attach: func(_ context.Context, image string) (string, error) {
			f.calls = append(f.calls, "attach "+image)
			if f.attachErr != nil {
				return "", f.attachErr
			}
			if f.failImages[image] {
				return "", errNoFreeLoopDevice
			}
			number := strconv.Itoa(100 + len(f.loops))
			f.attach("/dev/loop"+number, "7:"+number, image)
			return "/dev/loop" + number, nil
		},
		mount: func(_ context.Context, device, path, _ string) error {
			f.calls = append(f.calls, "mount "+device+" "+path)
			f.mount("7:"+strings.TrimPrefix(device, "/dev/loop"), path)
			return nil
		},
		placeholder: func(_ context.Context, path string) error {
			f.calls = append(f.calls, "placeholder "+path)
			f.mounts = append(f.mounts, mountEntry{MountPoint: canonicalLoopPath(path), Number: "0:99", FSType: "tmpfs", Source: volumePlaceholderSource})
			return nil
		},
	}
}

// attach binds device to the existing file at image.
func (f *fakeLoops) attach(device, number, image string) {
	f.t.Helper()
	dev, ino, err := fileIdentity(image)
	if err != nil {
		f.t.Fatal(err)
	}
	f.loops = append(f.loops, loopDevice{Path: device, Number: number, BackingFile: canonicalLoopPath(image)})
	f.ids[device] = [2]uint64{dev, ino}
}

// attachDeleted binds device to an unlinked file that was named image.
func (f *fakeLoops) attachDeleted(device, number, image string) {
	f.t.Helper()
	dev, _, err := fileIdentity(filepath.Dir(image))
	if err != nil {
		f.t.Fatal(err)
	}
	f.loops = append(f.loops, loopDevice{Path: device, Number: number, BackingFile: canonicalLoopPath(image), Deleted: true})
	f.ids[device] = [2]uint64{dev, 1}
}

func (f *fakeLoops) mount(number, path string) {
	f.mounts = append(f.mounts, mountEntry{MountPoint: canonicalLoopPath(path), Number: number})
}

func (f *fakeLoops) bound(device string) bool {
	return slices.ContainsFunc(f.loops, func(loop loopDevice) bool { return loop.Path == device })
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func newTestDatabaseManager(t *testing.T, loops *fakeLoops) *managedDatabaseManager {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"images", "mounts", "records", "tls"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{}
	cfg.StateDir = t.TempDir()
	return &managedDatabaseManager{cfg: cfg, root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host()}
}

func saveTestDatabase(t *testing.T, m *managedDatabaseManager, id string) managedDatabaseRecord {
	t.Helper()
	record := managedDatabaseRecord{
		ID:             id,
		ImagePath:      filepath.Join(m.root, "images", id+".img"),
		MountPath:      filepath.Join(m.root, "mounts", id),
		DesiredRunning: true,
	}
	writeFile(t, record.ImagePath)
	if err := os.MkdirAll(record.MountPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func TestManagedDatabaseRemoveUnmountsDetachesThenDeletes(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	record := saveTestDatabase(t, m, "db1")
	mountPath := canonicalLoopPath(record.MountPath)
	loops.attach("/dev/loop7", "7:7", record.ImagePath)
	// Stacked mounts, and a mount that is busy for two attempts.
	loops.mount("7:7", record.MountPath)
	loops.mount("7:7", record.MountPath)
	loops.busy[mountPath] = 2
	loops.onDetach = func(string) {
		if len(loops.mounts) != 0 {
			t.Fatalf("loop device detached while still mounted: %v", loops.mounts)
		}
		if !exists(record.ImagePath) {
			t.Fatal("image removed before its loop device was detached")
		}
	}

	if err := m.remove(context.Background(), record); err != nil {
		t.Fatalf("remove: %v", err)
	}
	want := []string{"umount " + mountPath, "umount " + mountPath, "umount " + mountPath, "umount " + mountPath, "detach /dev/loop7"}
	if !slices.Equal(loops.calls, want) {
		t.Fatalf("calls = %v, want %v", loops.calls, want)
	}
	if exists(record.ImagePath) || exists(m.recordPath(record.ID)) || exists(record.MountPath) {
		t.Fatal("image, record or mount point left after a completed delete")
	}
}

// A loop bound to the image under another name (an older layout or mount
// view) is found by its backing inode and detached before the image goes:
// it was left bound to the deleted image until a reboot.
func TestManagedDatabaseRemoveDetachesTheImageUnderAnotherName(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	record := saveTestDatabase(t, m, "db-old-layout")
	dev, ino, err := fileIdentity(record.ImagePath)
	if err != nil {
		t.Fatal(err)
	}
	loops.loops = append(loops.loops, loopDevice{Path: "/dev/loop9", Number: "7:9", BackingFile: "/images/db-old-layout.img"})
	loops.ids["/dev/loop9"] = [2]uint64{dev, ino}
	// Another guest's device with the same name but another inode is never touched.
	loops.loops = append(loops.loops, loopDevice{Path: "/dev/loop8", Number: "7:8", BackingFile: "/images/db-old-layout.img"})
	loops.ids["/dev/loop8"] = [2]uint64{dev, ino + 1}
	if err := m.remove(context.Background(), record); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if !slices.Contains(loops.calls, "detach /dev/loop9") || slices.Contains(loops.calls, "detach /dev/loop8") {
		t.Fatalf("calls = %v", loops.calls)
	}
}

func TestManagedDatabaseRemoveReportsHeldLoopAndRepairFinishesIt(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	record := saveTestDatabase(t, m, "db1")
	loops.attach("/dev/loop7", "7:7", record.ImagePath)
	loops.mount("7:7", record.MountPath)
	loops.held["/dev/loop7"] = true

	err := m.remove(context.Background(), record)
	if err == nil || !strings.Contains(err.Error(), "still in use") {
		t.Fatalf("remove error = %v, want a loop device still in use", err)
	}
	if !exists(record.ImagePath) {
		t.Fatal("image removed while its loop device is still bound")
	}
	saved, err := m.loadRecord(record.ID)
	if err != nil || !saved.Deleting || saved.DesiredRunning {
		t.Fatalf("record after failed delete = %+v, %v; want it kept and marked deleting", saved, err)
	}
	if err := m.ensureMounted(context.Background(), &saved); err == nil {
		t.Fatal("an instance being deleted was mounted again")
	}

	// The holder lets go; the repair pass completes the delete.
	delete(loops.held, "/dev/loop7")
	m.repairLoopImages(context.Background())
	if loops.bound("/dev/loop7") || exists(record.ImagePath) || exists(m.recordPath(record.ID)) {
		t.Fatal("repair did not finish the interrupted delete")
	}
}

func TestLoopImageRepairReleasesOnlyOrphans(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	images, mounts := filepath.Join(m.root, "images"), filepath.Join(m.root, "mounts")

	live := saveTestDatabase(t, m, "live")
	loops.attach("/dev/loop0", "7:0", live.ImagePath)
	loops.mount("7:0", live.MountPath)
	stopped := saveTestDatabase(t, m, "stopped") // attached, not mounted: still an instance's
	loops.attach("/dev/loop1", "7:1", stopped.ImagePath)
	loops.attachDeleted("/dev/loop8", "7:8", live.ImagePath) // an instance's name: left alone

	// Deleted instances: mounted without file, and bound without file.
	loops.attachDeleted("/dev/loop7", "7:7", filepath.Join(images, "gone7.img"))
	loops.mount("7:7", filepath.Join(mounts, "gone7"))
	loops.attachDeleted("/dev/loop4", "7:4", filepath.Join(images, "gone4.img"))
	// A failed create's image without a record or a loop device, and a mount
	// point an earlier release left after a delete.
	failed := filepath.Join(images, "failed.img")
	writeFile(t, failed)
	leftover := filepath.Join(mounts, "leftover")
	writeFile(t, filepath.Join(leftover, "written-while-unmounted"))

	// Not this daemon's: another guest's identical path, a node it cannot
	// open, a foreign filesystem, a path outside its directories, a mount
	// outside its directories.
	loops.loops = append(loops.loops, loopDevice{Path: "/dev/loop2", Number: "7:2", BackingFile: filepath.Join(canonicalLoopPath(images), "foreign.img")})
	loops.ids["/dev/loop2"] = [2]uint64{1, 2}
	loops.loops = append(loops.loops, loopDevice{Path: "/dev/loop3", Number: "7:3", BackingFile: filepath.Join(canonicalLoopPath(images), "ghost.img"), Deleted: true})
	loops.attachDeleted("/dev/loop11", "7:11", filepath.Join(images, "otherfs.img"))
	loops.ids["/dev/loop11"] = [2]uint64{loops.ids["/dev/loop11"][0] + 1, 1}
	loops.loops = append(loops.loops, loopDevice{Path: "/dev/loop5", Number: "7:5", BackingFile: "/var/lib/elsewhere/x.img", Deleted: true})
	loops.ids["/dev/loop5"] = [2]uint64{1, 1}
	loops.attachDeleted("/dev/loop6", "7:6", filepath.Join(images, "held.img"))
	loops.mounts = append(loops.mounts, mountEntry{MountPoint: "/mnt/elsewhere", Number: "7:6"})

	// Backup workspaces: a deleted one is released, a running one is not.
	backupImages := filepath.Join(m.root, "backups", "images")
	running := filepath.Join(backupImages, "run2.img")
	writeFile(t, running)
	loops.attach("/dev/loop10", "7:10", running)
	workspace := filepath.Join(m.cfg.StateDir, backupStateDirectory, "run1", "work")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	loops.attachDeleted("/dev/loop9", "7:9", filepath.Join(backupImages, "run1.img"))
	loops.mount("7:9", workspace)

	m.repairLoopImages(context.Background())

	for _, device := range []string{"/dev/loop7", "/dev/loop4", "/dev/loop9"} {
		if loops.bound(device) {
			t.Errorf("orphaned %s still bound", device)
		}
	}
	for _, device := range []string{"/dev/loop0", "/dev/loop1", "/dev/loop8", "/dev/loop2", "/dev/loop3", "/dev/loop11", "/dev/loop5", "/dev/loop6", "/dev/loop10"} {
		if !loops.bound(device) {
			t.Errorf("%s was detached but is not an orphan of this daemon", device)
		}
	}
	for _, call := range loops.calls {
		if strings.Contains(call, "/live") || strings.Contains(call, "elsewhere") || strings.Contains(call, "loop6") {
			t.Errorf("repair touched a live instance or a foreign mount: %s", call)
		}
	}
	if exists(failed) {
		t.Error("orphaned image of a failed create was not removed")
	}
	if exists(leftover) || !exists(live.MountPath) || !exists(stopped.MountPath) {
		t.Error("repair must remove orphaned mount points and only those")
	}
	if !exists(live.ImagePath) || !exists(stopped.ImagePath) || !exists(running) {
		t.Error("repair removed an image that belongs to an instance or a running backup")
	}
}

func TestManagedStorageRepairReleasesRemovedMembers(t *testing.T) {
	loops := newFakeLoops(t)
	root := t.TempDir()
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host()}
	for _, dir := range []string{"storage/images", "storage/mounts", "storage/records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	member := func(id string, removed, deleteData bool, device, number string) managedStorageRecord {
		record := managedStorageRecord{
			ID: id, Removed: removed, DeleteData: deleteData, DesiredRunning: !removed,
			ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
			MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
		}
		writeFile(t, record.ImagePath)
		if err := os.MkdirAll(record.MountPath, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(record)
		if err := os.WriteFile(m.recordPath(id), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		loops.attach(device, number, record.ImagePath)
		loops.mount(number, record.MountPath)
		return record
	}
	running := member("11111111-1111-4111-8111-111111111111", false, false, "/dev/loop0", "7:0")
	kept := member("22222222-2222-4222-8222-222222222222", true, false, "/dev/loop1", "7:1")
	deleting := member("33333333-3333-4333-8333-333333333333", true, true, "/dev/loop2", "7:2")

	m.repairLoopImages(context.Background())

	if !loops.bound("/dev/loop0") || !exists(running.ImagePath) {
		t.Error("repair released a running member")
	}
	if loops.bound("/dev/loop1") || exists(kept.MountPath) || !exists(kept.ImagePath) || !exists(m.recordPath(kept.ID)) {
		t.Error("a removed member must lose its mount and loop device but keep its data")
	}
	if loops.bound("/dev/loop2") || exists(deleting.ImagePath) || exists(m.recordPath(deleting.ID)) {
		t.Error("an interrupted data deletion was not finished")
	}
}

func TestReadLoopDevicesAndMountInfo(t *testing.T) {
	sys := t.TempDir()
	for name, files := range map[string]map[string]string{
		"loop7": {"dev": "7:7\n", "loop/backing_file": "/var/lib/docker-daemon/databases/images/a b.img (deleted)\n"},
		"loop1": {"dev": "7:1\n"}, // unbound: no loop/ attributes
		"sda":   {"dev": "8:0\n"},
	} {
		for file, content := range files {
			writeFile(t, filepath.Join(sys, name, file))
			if err := os.WriteFile(filepath.Join(sys, name, file), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	devices, err := readLoopDevices(sys)
	if err != nil {
		t.Fatal(err)
	}
	want := []loopDevice{{Path: "/dev/loop7", Number: "7:7", BackingFile: "/var/lib/docker-daemon/databases/images/a b.img", Deleted: true}}
	if !slices.Equal(devices, want) {
		t.Fatalf("loop devices = %+v, want %+v", devices, want)
	}

	mounts, err := parseMountInfo(strings.NewReader(
		"36 35 98:0 / / rw,noatime master:1 - ext4 /dev/root rw\n" +
			"90 36 7:7 / /var/lib/docker-daemon/databases/mounts/a\\040b rw,noatime shared:40 - ext4 /dev/loop7 rw\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 2 || mounts[1] != (mountEntry{MountPoint: "/var/lib/docker-daemon/databases/mounts/a b", Number: "7:7", FSType: "ext4", Source: "/dev/loop7", Options: "rw,noatime", SuperOptions: "rw"}) {
		t.Fatalf("mounts = %+v", mounts)
	}
}

// Every exit of a backup run must release its workspace: a run of this
// process releases its own, and after a daemon restart reconciliation does
// it for runs whose runner is gone or never existed, but not for a runner
// that is still running. A staging Redis goes with its run's workspace, and
// one whose run has no workspace left is removed as well.
func TestBackupWorkspaceReconcileReleasesRunsWithoutRunner(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	created := time.Now().UTC().Format(time.RFC3339Nano)
	stages := map[string]string{"stage-done": "done", "stage-alive": "alive", "stage-ancient": "ancient", "stage-interrupted": "interrupted"}
	removed := map[string]bool{}
	engine := func(request *http.Request) (*http.Response, error) {
		body, code := "[]", http.StatusOK
		switch {
		case request.Method == http.MethodDelete && strings.Contains(request.URL.Path, "/containers/stage-"):
			removed[filepath.Base(request.URL.Path)] = true
			code, body = http.StatusNoContent, ""
		case strings.HasSuffix(request.URL.Path, "/containers/json") && strings.Contains(request.URL.Query().Get("filters"), backupRedisStageManagedValue):
			var filters map[string]map[string]bool
			if err := json.Unmarshal([]byte(request.URL.Query().Get("filters")), &filters); err != nil {
				t.Fatal(err)
			}
			items := []map[string]any{}
			for id, runID := range stages {
				if removed[id] || (len(filters["label"]) > 1 && !filters["label"][backupRunnerRunLabel+"="+runID]) {
					continue
				}
				items = append(items, map[string]any{"Id": id, "Labels": map[string]string{backupRunnerManagedLabel: backupRedisStageManagedValue, backupRunnerRunLabel: runID}})
			}
			encoded, _ := json.Marshal(items)
			body = string(encoded)
		case strings.HasSuffix(request.URL.Path, "/containers/alive/json"):
			body = `{"Id":"alive","Created":"` + created + `","State":{"Running":true,"Status":"running"},` +
				`"Config":{"Labels":{"` + backupRunnerManagedLabel + `":"backup-runner","` + backupRunnerRunLabel + `":"alive"}}}`
		case strings.HasSuffix(request.URL.Path, "/containers/gone/json"):
			body, code = `{"message":"No such container: gone"}`, http.StatusNotFound
		case !strings.HasSuffix(request.URL.Path, "/containers/json"):
			t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
		}
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(engine)}))
	if err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{cfg: m.cfg, client: &Client{cli: cli}, databaseManager: m}
	runtime := &backupRuntime{plugin: plugin, root: filepath.Join(m.cfg.StateDir, backupStateDirectory),
		runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}, active: map[string]bool{}}
	workspace := func(runID, number string) string {
		image := filepath.Join(m.root, "backups", "images", runID+".img")
		writeFile(t, image)
		work := filepath.Join(runtime.root, runID, "work")
		if err := os.MkdirAll(work, 0o700); err != nil {
			t.Fatal(err)
		}
		loops.attach("/dev/loop"+number, "7:"+number, image)
		loops.mount("7:"+number, work)
		return image
	}
	lost := workspace("lost", "1")   // daemon lost the run before its runner existed
	done := workspace("done", "2")   // terminal, cleanup interrupted by a restart
	gone := workspace("gone", "3")   // runner vanished while the daemon was down
	alive := workspace("alive", "4") // runner still running after a restart
	busy := workspace("busy", "5")   // executing in this process
	// accepted and persisted, but the daemon restarted before its runner existed
	interrupted := workspace("interrupted", "6")
	runtime.active["busy"] = true
	for _, status := range []backupRunStatus{
		{RunID: "interrupted", Status: "queued", Phase: "queued"},
		{RunID: "done", Status: "completed", Phase: "backup"},
		{RunID: "gone", Status: "running", Phase: "backup", ContainerID: "gone"},
		{RunID: "alive", Status: "running", Phase: "backup", ContainerID: "alive"},
	} {
		if err := runtime.persist(status); err != nil {
			t.Fatal(err)
		}
	}

	runtime.reconcileWorkspaces()

	for image, device := range map[string]string{lost: "/dev/loop1", done: "/dev/loop2", gone: "/dev/loop3", interrupted: "/dev/loop6"} {
		if exists(image) || loops.bound(device) {
			t.Errorf("workspace %s of a run without a runner was not released", filepath.Base(image))
		}
	}
	for image, device := range map[string]string{alive: "/dev/loop4", busy: "/dev/loop5"} {
		if !exists(image) || !loops.bound(device) {
			t.Errorf("workspace %s of a live run was released", filepath.Base(image))
		}
	}
	if status, err := runtime.load("interrupted"); err != nil || status.Status != "failed" || status.Phase != "interrupted" {
		t.Errorf("interrupted run = %+v, %v; want failed/interrupted", status, err)
	}
	for id, want := range map[string]bool{"stage-done": true, "stage-ancient": true, "stage-interrupted": true, "stage-alive": false} {
		if removed[id] != want {
			t.Errorf("staging Redis %s removed = %v, want %v", id, removed[id], want)
		}
	}
}
