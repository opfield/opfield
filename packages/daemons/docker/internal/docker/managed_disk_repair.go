package docker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// A managed instance's filesystem goes read-only when its image cannot be
// written (the node's disk filled up, an I/O error) and ext4 aborts its
// journal. The engine then keeps failing on it, and only a check of the
// filesystem makes it writable again. The daemon does that on its own: it
// stops the engine and keeps the supervisor from starting it, unmounts the
// image, runs `e2fsck -p` (the automatic repair of what is safe to repair),
// mounts it again and starts the engine. A filesystem e2fsck -p cannot repair
// stays unmounted and the instance reports the failed repair; a start or a
// restart from Opfield tries again.
const (
	diskRepairRepairing = "repairing"
	diskRepairRepaired  = "repaired"
	diskRepairFailed    = "failed"

	diskWatchInterval = 30 * time.Second
	diskFsckTimeout   = 30 * time.Minute
	// A repair writes into the image, which may need blocks the node's disk
	// does not have yet; below this much free space it waits.
	diskRepairMinimumFreeBytes = 256 * mebibyte
	// How often the free space of deleted data is given back to the node;
	// every disk watch while the node's disk is below its reserve.
	diskTrimInterval = 10 * time.Minute
)

// managedDiskRepair is the last repair of an instance's disk, kept in its
// record so that a repair the daemon could not finish (it restarted, the disk
// was still full) is resumed and a failed one is not retried in a loop.
type managedDiskRepair struct {
	State string `json:"state"`
	// Reason is what was wrong ("emergency_ro").
	Reason string `json:"reason,omitempty"`
	// Detail is the outcome, or what the repair waits for.
	Detail string    `json:"detail,omitempty"`
	At     time.Time `json:"at"`
}

func (r *managedDiskRepair) pending() bool {
	return r != nil && r.State == diskRepairRepairing
}

func (r *managedDiskRepair) failed() bool {
	return r != nil && r.State == diskRepairFailed
}

// blocksEngine reports a repair that keeps the engine from being started.
func (r *managedDiskRepair) blocksEngine() bool {
	return r.pending() || r.failed()
}

// diskRepairs is the set of repairs running now. A repair releases its
// manager's lock while e2fsck runs; commands for the instance are refused
// meanwhile and the supervisor leaves the engine alone.
type diskRepairs struct {
	mu     sync.Mutex
	active map[string]bool
}

func (r *diskRepairs) begin(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active == nil {
		r.active = map[string]bool{}
	}
	if r.active[id] {
		return false
	}
	r.active[id] = true
	return true
}

func (r *diskRepairs) end(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.active, id)
}

func (r *diskRepairs) running(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active[id]
}

// errDiskBeingRepaired refuses a command while the instance's disk is being
// repaired.
func errDiskBeingRepaired(label string) error {
	return fmt.Errorf("the %s disk is being repaired after it went read-only; try again once the repair has finished", label)
}

// diskRepairTarget is what a repair works on, read under the manager lock.
type diskRepairTarget struct {
	ImagePath   string
	MountPath   string
	ContainerID string
	Repair      *managedDiskRepair
}

// diskRepairJob is one manager's side of a repair. load, persist, stop and
// start run under lock.
type diskRepairJob struct {
	label  string // "managed database"
	id     string
	reason string
	lock   sync.Locker
	loops  *loopHost
	root   string
	statfs func(string, *unix.Statfs_t) error
	fsck   func(ctx context.Context, image string) (int, string, error)
	logger *slog.Logger
	// load returns the instance, and false once it no longer wants its disk
	// (deleted, removed, stopped by Opfield).
	load    func() (diskRepairTarget, bool, error)
	persist func(repair managedDiskRepair) error
	stop    func(ctx context.Context, containerID string) error
	// start mounts the image and starts the engine.
	start func(ctx context.Context) error
	now   func() time.Time
}

// run repairs the disk. It returns once the repair finished, failed, or has to
// wait (for free space, for a busy mount), in which case the record keeps the
// repair pending and the next disk watch resumes it.
func (j diskRepairJob) run(ctx context.Context) {
	now := time.Now
	if j.now != nil {
		now = j.now
	}
	j.lock.Lock()
	target, wanted, err := j.load()
	if err != nil || !wanted {
		j.lock.Unlock()
		return
	}
	// A repair resumed by the watch keeps the time it began and logs what it
	// waits for only when that changes (the watch runs every 30 seconds).
	startedAt, lastDetail := now().UTC(), ""
	if target.Repair.pending() {
		startedAt, lastDetail = target.Repair.At, target.Repair.Detail
	} else {
		j.logger.Warn(j.label+" disk went read-only; stopping the engine and repairing the disk", "id", j.id, "reason", j.reason)
	}
	record := func(state, detail string) {
		at := now().UTC()
		if state == diskRepairRepairing {
			at = startedAt
		}
		repair := managedDiskRepair{State: state, Reason: j.reason, Detail: detail, At: at}
		if err := j.persist(repair); err != nil {
			j.logger.Warn("the state of a "+j.label+" disk repair could not be recorded", "id", j.id, "state", state, "error", err)
		}
	}
	wait := func(detail string, err error) {
		if detail != lastDetail {
			j.logger.Warn(j.label+" disk repair waits; retrying", "id", j.id, "waitingFor", detail, "error", err)
			record(diskRepairRepairing, detail)
		}
	}
	if !target.Repair.pending() {
		record(diskRepairRepairing, "")
	}
	if target.ContainerID != "" {
		if err := j.stop(ctx, target.ContainerID); err != nil {
			wait("waiting for the engine to stop: "+err.Error(), err)
			j.lock.Unlock()
			return
		}
	}
	if err := j.loops.release(ctx, target.ImagePath, target.MountPath); err != nil {
		wait("waiting for the disk to be unmounted: "+err.Error(), err)
		j.lock.Unlock()
		return
	}
	j.lock.Unlock()

	if usage, err := readManagedDiskUsage(j.root, j.statfs); err == nil && usage.Free < diskRepairMinimumFreeBytes {
		j.lock.Lock()
		wait("waiting for free space on the node's disk for managed instances", nil)
		j.lock.Unlock()
		return
	}
	fsckCtx, cancel := context.WithTimeout(ctx, diskFsckTimeout)
	code, output, fsckErr := j.fsck(fsckCtx, target.ImagePath)
	cancel()

	j.lock.Lock()
	defer j.lock.Unlock()
	if _, wanted, err := j.load(); err != nil || !wanted {
		return
	}
	if fsckErr != nil {
		if ctx.Err() != nil {
			return // the daemon stops; the next start resumes the repair
		}
		detail := "the filesystem check could not run: " + fsckErr.Error()
		j.logger.Error(j.label+" disk could not be repaired", "id", j.id, "error", fsckErr)
		record(diskRepairFailed, detail)
		return
	}
	if code&^3 != 0 {
		detail := fmt.Sprintf("e2fsck could not repair the filesystem on its own (exit status %d)", code)
		if line := lastOutputLine(output); line != "" {
			detail += ": " + line
		}
		detail += "; the data needs a manual check or a restore from a backup"
		j.logger.Error(j.label+" disk could not be repaired automatically", "id", j.id, "exitStatus", code, "output", tailOutput(output, 2048))
		record(diskRepairFailed, detail)
		return
	}
	if err := j.start(ctx); err != nil {
		if ctx.Err() != nil {
			return
		}
		j.logger.Error(j.label+" engine did not start after its disk was repaired", "id", j.id, "error", err)
		record(diskRepairFailed, "the disk was checked but the engine could not be started on it: "+err.Error())
		return
	}
	outcome := "the filesystem was clean"
	if code != 0 {
		outcome = "e2fsck repaired the filesystem"
	}
	j.logger.Info(j.label+" disk repaired; the engine runs again", "id", j.id, "exitStatus", code, "output", tailOutput(output, 2048))
	record(diskRepairRepaired, outcome)
}

// runE2fsck checks and repairs an unmounted image with e2fsck -p; the exit
// status says what it did (0 clean, 1 or 2 repaired, 4 and above not
// repaired).
func runE2fsck(ctx context.Context, image string) (int, string, error) {
	output, err := exec.CommandContext(ctx, "e2fsck", "-p", image).CombinedOutput()
	if err == nil {
		return 0, string(output), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && ctx.Err() == nil {
		return exitErr.ExitCode(), string(output), nil
	}
	return 0, string(output), err
}

// lastOutputLine is the last line of e2fsck's output that says something;
// its parenthesised hints ("(i.e., without -a or -p options)") do not.
func lastOutputLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "(") {
			continue
		}
		if len(line) > 300 {
			line = line[:300]
		}
		return line
	}
	return ""
}

func tailOutput(output string, limit int) string {
	output = strings.TrimSpace(output)
	if len(output) > limit {
		return output[len(output)-limit:]
	}
	return output
}

// diskRepairDetail is the repair as inspect reports it.
func diskRepairDetail(repair *managedDiskRepair, running bool) map[string]any {
	if repair == nil && !running {
		return nil
	}
	if repair == nil {
		repair = &managedDiskRepair{State: diskRepairRepairing}
	}
	state := repair.State
	if running {
		state = diskRepairRepairing
	}
	detail := map[string]any{"state": state, "at": repair.At.Format(time.RFC3339)}
	if repair.Reason != "" {
		detail["reason"] = repair.Reason
	}
	if repair.Detail != "" && !(running && repair.State != diskRepairRepairing) {
		detail["detail"] = repair.Detail
	}
	return detail
}
