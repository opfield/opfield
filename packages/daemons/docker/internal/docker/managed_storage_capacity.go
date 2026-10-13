package docker

import (
	"encoding/json"
	"sync"
	"time"
)

// A SeaweedFS storage stops taking new objects before its disk is completely
// full ("No writable volumes and no free volumes left"): below
// -volume.minFreeSpace its volume server reports every volume read-only and
// creates none, and the master creates no volume once every volume slot is
// used. Its health checks and ListBuckets keep answering, so Opfield showed
// such a storage online while every upload failed.
//
// The storage's detail says whether it takes writes, without writing
// anything: storageWritable is false while the disk is below the guard, the
// master has no free volume slot, or every volume is read-only;
// storageNearlyFull is set once less than two volumes of room are left above
// the guard or 85 % of the disk is used. The volume figures come from the
// master's /vol/status, which the space reclaim pass reads every 30 s anyway;
// the free space is read when the detail is. A flag clears only with a margin
// past where it was set, so a disk at the edge does not flap.
const (
	seaweedfsNearlyFullPercent      = 85
	seaweedfsNearlyFullClearPercent = 80
	// The reclaim pass reads the volumes every 30 s; an older reading is not used.
	seaweedfsVolumeReadingMaxAge = 2 * time.Minute

	// Why a storage takes no writes (storageFullReason).
	seaweedfsFullDiskBelowGuard  = "disk_below_guard"
	seaweedfsFullNoFreeVolumes   = "no_free_volumes"
	seaweedfsFullVolumesReadOnly = "volumes_read_only"
)

// seaweedfsVolumeReading is what the master said of a storage's volumes.
type seaweedfsVolumeReading struct {
	ContainerID string
	At          time.Time
	Volumes     []seaweedfsVolume
	// FreeSlots is the number of volumes the master can still create; known
	// only once a volume server registered (Max > 0).
	FreeSlots      int64
	FreeSlotsKnown bool
}

// blockReason is why the master takes no new objects, or "".
func (r seaweedfsVolumeReading) blockReason() string {
	if r.FreeSlotsKnown && r.FreeSlots <= 0 {
		return seaweedfsFullNoFreeVolumes
	}
	if len(r.Volumes) == 0 {
		return ""
	}
	for _, volume := range r.Volumes {
		if !volume.ReadOnly {
			return ""
		}
	}
	return seaweedfsFullVolumesReadOnly
}

// parseSeaweedFSFreeVolumeSlots reads the free volume slots of the master's
// /vol/status answer; ok is false while no volume server is registered.
func parseSeaweedFSFreeVolumeSlots(raw []byte) (free int64, ok bool) {
	var status struct {
		Volumes struct {
			Free *int64 `json:"Free"`
			Max  *int64 `json:"Max"`
		} `json:"Volumes"`
	}
	if json.Unmarshal(raw, &status) != nil || status.Volumes.Free == nil || status.Volumes.Max == nil || *status.Volumes.Max <= 0 {
		return 0, false
	}
	return *status.Volumes.Free, true
}

// seaweedfsCapacity is whether a storage takes writes and has room left.
type seaweedfsCapacity struct {
	Writable   bool
	NearlyFull bool
	// Reason is why it takes no writes (one of seaweedfsFull*).
	Reason string
}

// evaluateSeaweedFSCapacity is the storage's write state from its free space
// and its latest volume reading (nil when there is none), after the state it
// was in before (nil at first).
func evaluateSeaweedFSCapacity(previous *seaweedfsCapacity, space storageSpace, sizing seaweedfsSizing, reading *seaweedfsVolumeReading) seaweedfsCapacity {
	guard := sizing.MinFreeSpaceMiB * mebibyte
	volume := sizing.VolumeSizeLimitMB * mebibyte
	usedPercent := 0.0
	if space.Total > 0 {
		usedPercent = float64(space.Total-space.Free) * 100 / float64(space.Total)
	}
	blocked := ""
	if reading != nil {
		blocked = reading.blockReason()
	}
	next := seaweedfsCapacity{Writable: true}
	switch {
	case space.Free < guard:
		next.Writable, next.Reason = false, seaweedfsFullDiskBelowGuard
	case blocked != "":
		next.Writable, next.Reason = false, blocked
	case previous != nil && !previous.Writable && space.Free < guard+volume:
		// Writable again only with a volume's worth of room past the guard.
		next.Writable, next.Reason = false, previous.Reason
	}
	nearlyFull := space.Free < guard+2*volume || usedPercent >= seaweedfsNearlyFullPercent
	if !nearlyFull && previous != nil && previous.NearlyFull {
		nearlyFull = space.Free < guard+3*volume || usedPercent >= seaweedfsNearlyFullClearPercent
	}
	next.NearlyFull = nearlyFull || !next.Writable
	return next
}

// seaweedfsCapacityTracker keeps each storage's latest volume reading and
// write state (for the margins); it has its own lock, as the reclaim pass
// runs without the manager's.
type seaweedfsCapacityTracker struct {
	mu       sync.Mutex
	readings map[string]seaweedfsVolumeReading
	states   map[string]seaweedfsCapacity
}

func (t *seaweedfsCapacityTracker) observe(id string, reading seaweedfsVolumeReading) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readings == nil {
		t.readings = map[string]seaweedfsVolumeReading{}
	}
	t.readings[id] = reading
}

// evaluate updates and returns the write state of a serving storage. A volume
// reading of another container (the engine was recreated since) or an old one
// is not used; set members have none (their master runs on the primary).
func (t *seaweedfsCapacityTracker) evaluate(record managedStorageRecord, space storageSpace, now time.Time) seaweedfsCapacity {
	t.mu.Lock()
	defer t.mu.Unlock()
	var reading *seaweedfsVolumeReading
	if current, ok := t.readings[record.ID]; ok && record.Set == nil && current.ContainerID == record.ContainerID &&
		now.Sub(current.At) <= seaweedfsVolumeReadingMaxAge {
		reading = &current
	}
	var previous *seaweedfsCapacity
	if state, ok := t.states[record.ID]; ok {
		previous = &state
	}
	next := evaluateSeaweedFSCapacity(previous, space, seaweedfsSizingFor(record.StorageBytes), reading)
	if t.states == nil {
		t.states = map[string]seaweedfsCapacity{}
	}
	t.states[record.ID] = next
	return next
}

// retain forgets the storages that are gone.
func (t *seaweedfsCapacityTracker) retain(ids map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id := range t.readings {
		if !ids[id] {
			delete(t.readings, id)
		}
	}
	for id := range t.states {
		if !ids[id] {
			delete(t.states, id)
		}
	}
}

// seaweedfsCapacity is the write state of a serving SeaweedFS storage; ok is
// false when its disk cannot be read.
func (m *managedStorageManager) seaweedfsCapacity(record managedStorageRecord) (seaweedfsCapacity, bool) {
	space, err := m.storageSpace(record)
	if err != nil {
		return seaweedfsCapacity{}, false
	}
	return m.capacity.evaluate(record, space, time.Now()), true
}
