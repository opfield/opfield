package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

const gibibyte = 1024 * mebibyte

// The free-space guard SeaweedFS stops writing at leaves room to compact a
// full volume, for every allowed disk size: a disk that filled up with
// deleted objects can always be compacted again.
func TestSeaweedFSSizingLeavesRoomToCompactAtTheGuard(t *testing.T) {
	sizes := []int64{minimumStorageBytes, 1280 * mebibyte, 2 * gibibyte, 8 * gibibyte, 12 * gibibyte, 40 * gibibyte,
		41 * gibibyte, 64 * gibibyte, 100 * gibibyte, gibibyte * 1024, maximumStorageBytes}
	for _, size := range sizes {
		sizing := seaweedfsSizingFor(size)
		if sizing.MinFreeSpaceMiB < 2*sizing.VolumeSizeLimitMB {
			t.Errorf("%d bytes: guard %d MiB is less than two %d MiB volumes", size, sizing.MinFreeSpaceMiB, sizing.VolumeSizeLimitMB)
		}
		// A full volume whose objects are all deleted, on a disk that stopped
		// taking writes just below the guard.
		volume := seaweedfsVolume{ID: 1, Size: uint64(sizing.VolumeSizeLimitMB * mebibyte), DeletedByteCount: uint64(sizing.VolumeSizeLimitMB * mebibyte),
			FileCount: 4096, DeleteCount: 4096, ReadOnly: true}
		space := storageSpace{Free: sizing.MinFreeSpaceMiB*mebibyte - 1, Total: size}
		if !seaweedfsFull(space, sizing) {
			t.Fatalf("%d bytes: a disk below the guard is not full", size)
		}
		if plan := planSeaweedFSReclaim([]seaweedfsVolume{volume}, space, sizing); !slices.Equal(plan.VolumeIDs, []uint32{1}) {
			t.Errorf("%d bytes: a full volume of deleted objects is not compacted at the guard: %+v", size, plan)
		}
	}
}

// The master's /vol/status answer as SeaweedFS 4.47 writes it.
const seaweedfsVolumeStatusSample = `{"Version":"30GB 4.47 7b1e0b6e","Volumes":{"DataCenters":{"DefaultDataCenter":{"DefaultRack":{"127.0.0.1:8080":[
{"Id":3,"Size":134250000,"ReplicaPlacement":{"node":0,"rack":0,"dc":0},"Ttl":{"Count":0,"Unit":0},"DiskType":"","DiskId":0,"Collection":"backups","Version":3,"FileCount":17,"DeleteCount":16,"DeletedByteCount":125829120,"ReadOnly":false,"CompactRevision":0,"ModifiedAtSecond":1791700000,"RemoteStorageName":"","RemoteStorageKey":"","ReadOnlyCanDelete":false},
{"Id":4,"Size":8,"Collection":"backups","FileCount":0,"DeleteCount":0,"DeletedByteCount":0,"ReadOnly":true}
]}}},"Free":310,"Max":320}}`

func TestParseSeaweedFSVolumeStatus(t *testing.T) {
	volumes, err := parseSeaweedFSVolumeStatus([]byte(seaweedfsVolumeStatusSample))
	if err != nil {
		t.Fatal(err)
	}
	want := []seaweedfsVolume{
		{ID: 3, Collection: "backups", Size: 134250000, DeletedByteCount: 125829120, FileCount: 17, DeleteCount: 16},
		{ID: 4, Collection: "backups", Size: 8, ReadOnly: true},
	}
	slices.SortFunc(volumes, func(a, b seaweedfsVolume) int { return int(a.ID) - int(b.ID) })
	if !slices.Equal(volumes, want) {
		t.Fatalf("volumes %+v, want %+v", volumes, want)
	}
	if _, err := parseSeaweedFSVolumeStatus([]byte("<html>")); err == nil {
		t.Fatal("a non-JSON answer parsed")
	}
}

func volumeOf(id uint32, sizeMiB, deletedMiB int64, readOnly bool) seaweedfsVolume {
	return seaweedfsVolume{ID: id, Size: uint64(sizeMiB * mebibyte), DeletedByteCount: uint64(deletedMiB * mebibyte), FileCount: 10, DeleteCount: 5, ReadOnly: readOnly}
}

func TestPlanSeaweedFSReclaim(t *testing.T) {
	sizing := seaweedfsSizingFor(8 * gibibyte) // 128 MiB volumes, 409 MiB guard
	volumes := []seaweedfsVolume{
		volumeOf(1, 128, 64, false),                                 // half deleted
		volumeOf(2, 128, 128, false),                                // all deleted
		volumeOf(3, 128, 13, false),                                 // a tenth deleted
		{ID: 4, Size: 2 * mebibyte, DeletedByteCount: mebibyte / 2}, // a quarter, but under 1 MiB
		volumeOf(5, 128, 128, true),                                 // read-only
		volumeOf(6, 128, 0, false),                                  // nothing deleted
	}

	plenty := storageSpace{Free: 6 * gibibyte, Total: 8 * gibibyte}
	plan := planSeaweedFSReclaim(volumes, plenty, sizing)
	if plan.Threshold != seaweedfsReclaimThreshold || !slices.Equal(plan.VolumeIDs, []uint32{2, 1}) {
		t.Fatalf("with free space: %+v, want volumes 2 and 1 at %v", plan, seaweedfsReclaimThreshold)
	}
	if plan.Garbage != 192*mebibyte {
		t.Fatalf("planned garbage %d", plan.Garbage)
	}

	// With under a quarter of the disk free, nearly all garbage goes.
	pressure := storageSpace{Free: 1 * gibibyte, Total: 8 * gibibyte}
	plan = planSeaweedFSReclaim(volumes, pressure, sizing)
	if plan.Threshold != seaweedfsPressureReclaimThreshold || !slices.Equal(plan.VolumeIDs, []uint32{2, 1, 3}) {
		t.Fatalf("under pressure: %+v", plan)
	}

	// Full: SeaweedFS reports every volume read-only; those are compacted too,
	// as far as the free space (and what earlier compactions free) allows.
	full := storageSpace{Free: 140 * mebibyte, Total: 8 * gibibyte}
	plan = planSeaweedFSReclaim(volumes, full, sizing)
	if !slices.Equal(plan.VolumeIDs, []uint32{2, 5, 1, 3}) {
		t.Fatalf("full: %+v", plan)
	}
	tight := storageSpace{Free: 100 * mebibyte, Total: 8 * gibibyte}
	if plan := planSeaweedFSReclaim(volumes, tight, sizing); len(plan.VolumeIDs) != 0 {
		t.Fatalf("without room for a copy of any volume: %+v", plan)
	}
}

func TestSeaweedFSVacuumScript(t *testing.T) {
	got := seaweedfsVacuumScript(seaweedfsReclaim{Threshold: 0.02, VolumeIDs: []uint32{7, 3}})
	if want := "lock\nvolume.vacuum -garbageThreshold=0.02 -volumeId=7,3\nunlock\n"; got != want {
		t.Fatalf("script %q, want %q", got, want)
	}
}

type engineCall struct {
	container string
	command   []string
	stdin     string
}

// reclaimTestStorage is a running SeaweedFS storage of 8 GiB whose disk has
// free bytes free; engine commands are answered with the given volume status.
func reclaimTestStorage(t *testing.T, free int64, status string) (*managedStorageManager, string, *[]engineCall, *fakeEngineDocker) {
	t.Helper()
	m, docker, _, id := newTestStorageEngine(t)
	record, err := m.loadRecord(id)
	if err != nil {
		t.Fatal(err)
	}
	record.Engine = managedStorageEngineSeaweedFS
	record.StorageBytes = 8 * gibibyte
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	m.statFilesystem = func(path string, stat *unix.Statfs_t) error {
		if path == m.root {
			// The node's disk for managed instances, with room.
			stat.Bsize, stat.Blocks, stat.Bavail = 1, 64*gibibyte, 32*gibibyte
			return nil
		}
		if path != record.MountPath {
			t.Errorf("stat of %s, want the storage disk", path)
		}
		stat.Bsize, stat.Blocks, stat.Bavail = 1, 8*gibibyte, uint64(free)
		return nil
	}
	var calls []engineCall
	m.execEngine = func(_ context.Context, container string, command []string, stdin string) ([]byte, error) {
		calls = append(calls, engineCall{container, command, stdin})
		if command[0] == "curl" {
			return []byte(status), nil
		}
		return nil, nil
	}
	return m, id, &calls, docker
}

func volumeStatus(t *testing.T, volumes ...seaweedfsVolume) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"Volumes": map[string]any{"DataCenters": map[string]any{
		"DefaultDataCenter": map[string]any{"DefaultRack": map[string]any{"127.0.0.1:8080": volumes}}}}})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// A storage that filled up with deleted objects gets their space back on the
// next pass without anyone acting: its read-only volumes are compacted by id.
func TestReclaimCompactsTheDeletedObjectsOfAFullStorage(t *testing.T) {
	m, _, calls, _ := reclaimTestStorage(t, 200*mebibyte, volumeStatus(t,
		volumeOf(11, 130, 130, true), volumeOf(12, 130, 5, true), volumeOf(13, 130, 120, true)))

	m.reclaimSpace(context.Background())

	if len(*calls) != 2 {
		t.Fatalf("engine commands %+v, want the volume status and one vacuum", *calls)
	}
	if got := (*calls)[0]; got.container != "s1" || !slices.Equal(got.command, seaweedfsVolumeStatusCommand) {
		t.Fatalf("status command %+v", got)
	}
	vacuum := (*calls)[1]
	if vacuum.container != "s1" || !slices.Equal(vacuum.command, seaweedfsShellCommand) {
		t.Fatalf("vacuum command %+v", vacuum)
	}
	if want := "lock\nvolume.vacuum -garbageThreshold=0.02 -volumeId=11,13,12\nunlock\n"; vacuum.stdin != want {
		t.Fatalf("vacuum script %q, want %q", vacuum.stdin, want)
	}
}

// Nothing is compacted while no volume has enough deleted objects, and
// storages that do not run SeaweedFS (or do not run) are left alone.
func TestReclaimLeavesStoragesWithoutGarbageAlone(t *testing.T) {
	m, id, calls, _ := reclaimTestStorage(t, 6*gibibyte, volumeStatus(t, volumeOf(1, 128, 10, false)))
	m.reclaimSpace(context.Background())
	if len(*calls) != 1 || (*calls)[0].command[0] != "curl" {
		t.Fatalf("engine commands %+v, want only the volume status", *calls)
	}

	*calls = nil
	record, _ := m.loadRecord(id)
	for _, change := range []func(*managedStorageRecord){
		func(r *managedStorageRecord) { r.Engine = managedStorageEngineMinIO },
		func(r *managedStorageRecord) { r.DesiredRunning = false },
		func(r *managedStorageRecord) { r.Removed = true },
	} {
		changed := record
		change(&changed)
		if err := m.saveRecord(changed); err != nil {
			t.Fatal(err)
		}
		m.reclaimSpace(context.Background())
	}
	if len(*calls) != 0 {
		t.Fatalf("engine commands for storages that are not running SeaweedFS: %+v", *calls)
	}
}

// An engine that does not answer (it is starting) is retried on the next pass.
func TestReclaimSkipsAnEngineThatDoesNotAnswer(t *testing.T) {
	m, _, calls, _ := reclaimTestStorage(t, 200*mebibyte, "")
	m.execEngine = func(_ context.Context, container string, command []string, stdin string) ([]byte, error) {
		*calls = append(*calls, engineCall{container, command, stdin})
		return nil, errors.New("container is not running")
	}
	m.reclaimSpace(context.Background())
	if len(*calls) != 1 {
		t.Fatalf("engine commands %+v", *calls)
	}
}

// A serving storage whose disk is below the guard is reported full, so
// Opfield can show it; one with room is not.
func TestInspectReportsAFullSeaweedFSStorage(t *testing.T) {
	for _, tc := range []struct {
		free int64
		full bool
	}{{200 * mebibyte, true}, {2 * gibibyte, false}} {
		m, id, _, docker := reclaimTestStorage(t, tc.free, "")
		m.probeReady = func(context.Context, managedStorageRecord) error { return nil }
		docker.running["s1"] = true
		detail, err := m.handle(context.Background(), "inspect", id, "")
		if err != nil {
			t.Fatal(err)
		}
		var inspected struct {
			Status      string `json:"status"`
			StorageFull bool   `json:"storageFull"`
		}
		if err := json.Unmarshal([]byte(detail), &inspected); err != nil {
			t.Fatal(err)
		}
		if inspected.Status != "ready" || inspected.StorageFull != tc.full {
			t.Fatalf("free %d: %s, want ready with storageFull %v", tc.free, detail, tc.full)
		}
		if !tc.full && strings.Contains(detail, "storageFull") {
			t.Fatalf("a storage with room reports storageFull: %s", detail)
		}
	}
}

// A pass logs that it gave space back only when it did (O-16: a read-only
// storage logged "gave back ... freedBytes 0" every 30 s).
func TestReclaimLogsOnlySpaceItGaveBack(t *testing.T) {
	m, _, _, _ := reclaimTestStorage(t, 200*mebibyte, volumeStatus(t, volumeOf(11, 130, 130, true)))
	var logs bytes.Buffer
	m.logger = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo}))

	m.reclaimSpace(context.Background())
	if strings.Contains(logs.String(), "gave back") {
		t.Fatalf("a pass that freed nothing logged: %s", logs.String())
	}

	free := uint64(200 * mebibyte)
	m.statFilesystem = func(path string, stat *unix.Statfs_t) error {
		stat.Bsize, stat.Blocks, stat.Bavail = 1, 8*gibibyte, free
		if path == m.root {
			stat.Blocks, stat.Bavail = 64*gibibyte, 32*gibibyte
		}
		return nil
	}
	exec := m.execEngine
	m.execEngine = func(ctx context.Context, container string, command []string, stdin string) ([]byte, error) {
		if command[0] != "curl" {
			free += 130 * mebibyte
		}
		return exec(ctx, container, command, stdin)
	}
	m.reclaimSpace(context.Background())
	if !strings.Contains(logs.String(), "gave back the space of deleted objects") || !strings.Contains(logs.String(), "freedBytes=136314880") {
		t.Fatalf("a pass that freed 130 MiB logged: %s", logs.String())
	}
}

// A storage whose disk went read-only is not compacted (the disk watch
// repairs it first).
func TestReclaimSkipsAReadOnlyDisk(t *testing.T) {
	m, id, calls, _ := reclaimTestStorage(t, 200*mebibyte, volumeStatus(t, volumeOf(11, 130, 130, true)))
	record, _ := m.loadRecord(id)
	loops := newFakeLoops(t)
	loops.mounts = []mountEntry{{MountPoint: canonicalLoopPath(record.MountPath), Number: "7:7", FSType: "ext4", Options: "rw,noatime", SuperOptions: "rw,emergency_ro"}}
	m.loops = loops.host()
	m.reclaimSpace(context.Background())
	if len(*calls) != 0 {
		t.Fatalf("engine commands on a read-only disk: %+v", *calls)
	}
}
