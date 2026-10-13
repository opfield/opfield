package docker

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// The free volume slots come from the master's /vol/status; a master without
// a registered volume server (Max 0) says nothing about them.
func TestParseSeaweedFSFreeVolumeSlots(t *testing.T) {
	if free, ok := parseSeaweedFSFreeVolumeSlots([]byte(seaweedfsVolumeStatusSample)); !ok || free != 310 {
		t.Fatalf("free slots %d %v, want 310", free, ok)
	}
	for _, raw := range []string{`{"Volumes":{"Free":0,"Max":0}}`, `{"Volumes":{}}`, `<html>`} {
		if _, ok := parseSeaweedFSFreeVolumeSlots([]byte(raw)); ok {
			t.Fatalf("%s: free slots known", raw)
		}
	}
}

// A storage takes no writes below the guard, without a free volume slot or
// with every volume read-only; it is writable again only a volume past the
// guard, and nearly full until it has three volumes of room and under 80 %.
func TestSeaweedFSCapacityFlagsWithMargins(t *testing.T) {
	sizing := seaweedfsSizingFor(8 * gibibyte) // 128 MiB volumes, 409 MiB guard
	guard := sizing.MinFreeSpaceMiB * mebibyte
	volume := sizing.VolumeSizeLimitMB * mebibyte

	var state *seaweedfsCapacity
	step := func(free, total int64, reading *seaweedfsVolumeReading, writable, nearlyFull bool, reason string) {
		t.Helper()
		next := evaluateSeaweedFSCapacity(state, storageSpace{Free: free, Total: total}, sizing, reading)
		if next.Writable != writable || next.NearlyFull != nearlyFull || next.Reason != reason {
			t.Fatalf("free %d of %d MiB: %+v, want writable %v nearlyFull %v reason %q",
				free/mebibyte, total/mebibyte, next, writable, nearlyFull, reason)
		}
		state = &next
	}

	// The room above the guard (on a disk where the used share stays low).
	small := int64(2 * gibibyte)
	step(1500*mebibyte, small, nil, true, false, "")
	step(guard+2*volume-1, small, nil, true, true, "")
	step(guard-1, small, nil, false, true, seaweedfsFullDiskBelowGuard)
	// Just past the guard: still not writable, so a disk at the edge does not flap.
	step(guard+volume/2, small, nil, false, true, seaweedfsFullDiskBelowGuard)
	step(guard+volume, small, nil, true, true, "")
	// Past two volumes of room but under three: still nearly full.
	step(guard+2*volume+volume/2, small, nil, true, true, "")
	step(guard+3*volume, small, nil, true, false, "")

	// The used share: nearly full from 85 %, cleared under 80 %.
	total := int64(8 * gibibyte)
	step(total*16/100, total, nil, true, false, "")
	step(total*14/100, total, nil, true, true, "")
	step(total*16/100, total, nil, true, true, "")
	step(total*21/100, total, nil, true, false, "")

	// The master's own state, whatever the disk says.
	state = nil
	noSlots := &seaweedfsVolumeReading{Volumes: []seaweedfsVolume{volumeOf(1, 30, 0, false)}, FreeSlots: 0, FreeSlotsKnown: true}
	step(4*gibibyte, total, noSlots, false, true, seaweedfsFullNoFreeVolumes)
	readOnly := &seaweedfsVolumeReading{Volumes: []seaweedfsVolume{volumeOf(1, 30, 0, true), volumeOf(2, 30, 0, true)}, FreeSlots: 5, FreeSlotsKnown: true}
	step(4*gibibyte, total, readOnly, false, true, seaweedfsFullVolumesReadOnly)
	// Writable again once the master creates volumes and one volume is writable.
	healthy := &seaweedfsVolumeReading{Volumes: []seaweedfsVolume{volumeOf(1, 30, 0, true), volumeOf(2, 30, 0, false)}, FreeSlots: 5, FreeSlotsKnown: true}
	step(4*gibibyte, total, healthy, true, false, "")
	// Full-size volumes that are not read-only are not a block: the master
	// grows a new volume on the next write while slots are free.
	full := &seaweedfsVolumeReading{Volumes: []seaweedfsVolume{volumeOf(1, 128, 0, false)}, FreeSlots: 5, FreeSlotsKnown: true}
	step(4*gibibyte, total, full, true, false, "")
	// No volumes yet and unknown slots (a master before its volume server registered).
	step(4*gibibyte, total, &seaweedfsVolumeReading{}, true, false, "")
}

// The volume reading of the reclaim pass reaches the detail: a storage whose
// master has no free volume slot is not writable though its disk has room. A
// reading of an engine container recreated since is not used.
func TestInspectReportsAStorageWithoutFreeVolumes(t *testing.T) {
	status := `{"Volumes":{"DataCenters":{"DefaultDataCenter":{"DefaultRack":{"127.0.0.1:8080":[
{"Id":1,"Size":134217728,"Collection":"files","FileCount":10,"ReadOnly":false}]}}},"Free":0,"Max":288}}`
	m, id, _, docker := reclaimTestStorage(t, 6*gibibyte, status)
	m.probeReady = func(context.Context, managedStorageRecord) error { return nil }
	docker.running["s1"] = true
	m.reclaimSpace(context.Background())

	inspect := func() map[string]any {
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
	got := inspect()
	if got["status"] != "ready" || got["storageWritable"] != false || got["storageFull"] != true ||
		got["storageFullReason"] != seaweedfsFullNoFreeVolumes || got["storageNearlyFull"] != true {
		t.Fatalf("detail %v, want a ready storage that takes no writes for want of volumes", got)
	}

	record, _ := m.loadRecord(id)
	m.capacity.observe(id, seaweedfsVolumeReading{ContainerID: "old", At: time.Now(), FreeSlotsKnown: true})
	m.capacity.mu.Lock()
	delete(m.capacity.states, id)
	m.capacity.mu.Unlock()
	if record.ContainerID == "old" {
		t.Fatal("test container id clash")
	}
	got = inspect()
	if got["storageWritable"] != true || got["storageFull"] != nil || got["storageNearlyFull"] != nil {
		t.Fatalf("detail %v, want a writable storage without the reading of another container", got)
	}
}
