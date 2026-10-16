package swha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Space reclaim and housekeeping of a set (the primary's worker runs them).
//
// SeaweedFS's master compacts volumes by itself only about every 15 minutes
// and skips read-only volumes; a volume server whose disk is below its
// -minFreeSpace guard reports every volume read-only, so a set that filled
// up stayed full after its objects were deleted. The primary compacts the
// volumes with enough garbage itself, through weed shell volume.vacuum
// against its own master (which, unlike the master's sweep, compacts
// read-only volumes too). A compaction runs on every copy of a volume and
// needs room for the whole volume there, so the plan counts the free space of
// the fullest member disk.
//
// Once a day it also removes multipart uploads that were started more than
// uploadsMaxAge ago and never completed, and the filer's metadata change log
// (/topics/.system/log) older than metaLogKeepDays: the filer never expires
// it, and the primary's heartbeat writes one entry a second into it.
//
// Nothing of this runs while the set is not whole: a lost or removed member,
// a member not registered with the master, or objects with one copy
// (degraded). Each volume is compacted by its own shell run (the shell's
// cluster lock is held for one volume at a time, so a failover's switch to
// one copy, which takes the same lock, waits for at most one compaction), and
// the set is checked again before each.
var (
	reclaimEvery        = 30 * time.Second
	housekeepEvery      = 24 * time.Hour
	housekeepFirstAfter = 5 * time.Minute
)

const (
	reclaimTimeout   = 10 * time.Minute
	housekeepTimeout = 10 * time.Minute
	// uploadsMaxAge: a multipart upload older than this is abandoned. Kept
	// above the longest Opfield operation that uploads into a storage (a
	// storage copy may run for 7 days) and S3's usual lifecycle default.
	uploadsMaxAge = 7 * 24 * time.Hour
	// metaLogKeepDays: days of filer metadata log kept. Copies catch up from
	// their last offset, so the log is only pruned while every copy's filer
	// is within metaCaughtUpWithin of the primary's.
	metaLogKeepDays    = 7
	metaCaughtUpWithin = time.Minute
)

// DiskSpace is a member's data disk as its volume server reports it.
type DiskSpace struct {
	Free  uint64
	Total uint64
}

// ReclaimPlan is the volumes to compact, in order, and the garbage threshold
// the master checks each of them against again.
type ReclaimPlan struct {
	Threshold float64
	VolumeIDs []uint32
}

// volumeDiskSpace reads a volume server's /status answer: the disk of its
// data directory (the one with the least free space when it has several).
func volumeDiskSpace(raw []byte) (DiskSpace, error) {
	var status struct {
		DiskStatuses []struct {
			All  uint64 `json:"all"`
			Free uint64 `json:"free"`
		} `json:"DiskStatuses"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return DiskSpace{}, fmt.Errorf("decode volume server status: %w", err)
	}
	var out DiskSpace
	found := false
	for _, disk := range status.DiskStatuses {
		if disk.All == 0 {
			continue
		}
		if !found || disk.Free < out.Free {
			out, found = DiskSpace{Free: disk.Free, Total: disk.All}, true
		}
	}
	if !found {
		return DiskSpace{}, errors.New("the volume server reports no disk")
	}
	return out, nil
}

// vacuumScript compacts one volume.
func vacuumScript(threshold float64, id uint32) string {
	return lockedScript("volume.vacuum -garbageThreshold=" + strconv.FormatFloat(threshold, 'f', -1, 64) +
		" -volumeId=" + strconv.FormatUint(uint64(id), 10))
}

// housekeepScript removes abandoned multipart uploads and, when purgeMetaLog,
// the metadata log older than metaLogKeepDays (both need no cluster lock).
func housekeepScript(purgeMetaLog bool) string {
	lines := []string{"s3.clean.uploads -timeAgo=" + strconv.Itoa(int(uploadsMaxAge.Hours())) + "h"}
	if purgeMetaLog {
		lines = append(lines, "fs.log.purge -daysAgo="+strconv.Itoa(metaLogKeepDays))
	}
	return strings.Join(lines, "\n") + "\n"
}

// setWhole reports whether every member of the set takes part: none is
// removed or lost, every volume server is registered with this master and
// answered the primary's probe recently, and no object has one copy.
func (e *Engine) setWhole(topology *Topology, now time.Time) bool {
	if topology == nil {
		return false
	}
	cfg, self := e.self()
	if !topology.Registered(VolumeURL(cfg.MemberID, self.MemberIndex)) {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.st.DegradedSince != 0 || e.restartWanted || now.Sub(e.workerSince) < e.timings.grace {
		return false
	}
	for _, peer := range cfg.Others() {
		if peer.Removing || !topology.Registered(VolumeURL(peer.MemberID, peer.MemberIndex)) {
			return false
		}
		// Answered within two probe intervals: a member that just went
		// silent stops the next compaction before it is counted lost.
		if at, ok := e.peersOK[peer.MemberID]; !ok || now.Sub(at) > 2*e.timings.probe+e.timings.tick {
			return false
		}
	}
	return true
}

// currentTopology is the local master's topology (nil when it does not answer).
func (e *Engine) currentTopology(ctx context.Context) *Topology {
	raw, err := getOK(ctx, e.local(RoleMaster, MasterHTTPPort), "/dir/status")
	if err != nil {
		return nil
	}
	topology, err := ParseTopology(raw)
	if err != nil {
		return nil
	}
	return &topology
}

// fullestDisk reads every member's data disk from its volume server; the
// fullest one decides what a compaction may use.
func (e *Engine) fullestDisk(ctx context.Context) (DiskSpace, error) {
	cfg, self := e.self()
	vh, _ := VolumePorts(self.MemberIndex)
	raw, err := getOK(ctx, e.local(RoleVolume, vh), "/status")
	if err != nil {
		return DiskSpace{}, fmt.Errorf("own volume server: %w", err)
	}
	fullest, err := volumeDiskSpace(raw)
	if err != nil {
		return DiskSpace{}, err
	}
	for _, peer := range cfg.Others() {
		raw, err := getOK(ctx, e.mesh("member-"+peer.MemberID+"-"+PortVolume), "/status")
		if err != nil {
			return DiskSpace{}, fmt.Errorf("volume server of member %s: %w", peer.MemberID, err)
		}
		disk, err := volumeDiskSpace(raw)
		if err != nil {
			return DiskSpace{}, fmt.Errorf("volume server of member %s: %w", peer.MemberID, err)
		}
		if disk.Free < fullest.Free {
			fullest = disk
		}
	}
	return fullest, nil
}

// reclaim compacts the volumes worth it, one shell run per volume, while the
// set stays whole.
func (e *Engine) reclaim(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, reclaimTimeout)
	defer cancel()
	raw, err := getOK(ctx, e.local(RoleMaster, MasterHTTPPort), "/vol/status")
	if err != nil {
		return fmt.Errorf("read volume status: %w", err)
	}
	disk, err := e.fullestDisk(ctx)
	if err != nil {
		return err
	}
	plan, err := e.host.PlanReclaim(raw, disk)
	if err != nil {
		return err
	}
	for i, id := range plan.VolumeIDs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !e.setWhole(e.currentTopology(ctx), time.Now()) {
			return fmt.Errorf("the set is not whole; %d of %d volumes left for the next pass", len(plan.VolumeIDs)-i, len(plan.VolumeIDs))
		}
		if _, err := e.shell(ctx, vacuumScript(plan.Threshold, id)); err != nil {
			return fmt.Errorf("compact volume %d: %w", id, err)
		}
	}
	if len(plan.VolumeIDs) > 0 {
		e.log.Info("SeaweedFS set compacted volumes with deleted objects", "volumes", len(plan.VolumeIDs),
			"fullest_disk_free_bytes", disk.Free)
	}
	return nil
}

// copiesCaughtUp reports whether every other member's filer holds a metadata
// heartbeat this primary wrote within metaCaughtUpWithin: each copy then
// follows the primary's metadata log from a recent offset.
func (e *Engine) copiesCaughtUp(ctx context.Context) bool {
	e.mu.Lock()
	newest := e.heartbeat
	e.mu.Unlock()
	if newest == 0 {
		return false
	}
	cfg, _ := e.self()
	for _, peer := range cfg.Others() {
		got, err := readHeartbeat(ctx, e.mesh("member-"+peer.MemberID+"-"+PortFiler))
		if err != nil || got < newest-int64(metaCaughtUpWithin) {
			return false
		}
	}
	return true
}

// housekeep removes abandoned multipart uploads and the old metadata log.
func (e *Engine) housekeep(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, housekeepTimeout)
	defer cancel()
	if !e.setWhole(e.currentTopology(ctx), time.Now()) {
		return errors.New("the set is not whole")
	}
	purge := e.copiesCaughtUp(ctx)
	if _, err := e.shell(ctx, housekeepScript(purge)); err != nil {
		return err
	}
	e.log.Debug("SeaweedFS set housekeeping done", "metadata_log_pruned", purge)
	return nil
}
