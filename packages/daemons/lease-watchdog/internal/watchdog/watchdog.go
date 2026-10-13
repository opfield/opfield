// Package watchdog enforces lease deadline records without the docker daemon
// and without dockerd (A2.2, A12). It shares no locks with the daemon: the
// only contract is the leasefence directory on tmpfs.
package watchdog

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// PassInterval bounds how long a stale container, or a docker start that
// completes after its deadline, can run before it is killed.
const PassInterval = 250 * time.Millisecond

// Killer kills every process of one cgroup directory.
type Killer interface {
	// Kill returns how many processes the cgroup held before the kill.
	Kill(path string) (int, error)
}

type Config struct {
	Dir        leasefence.Dir
	CgroupRoot string
	// Now is CLOCK_BOOTTIME (leasefence.Now); injectable for tests.
	Now    func() time.Duration
	Killer Killer
	Logger *slog.Logger
	// Build is reported in the heartbeat for diagnostics.
	Build string
	// Owner is the docker daemon's user, given the records on every pass (owner.go); nil leaves them as they are.
	Owner Owner
}

type Watchdog struct {
	cfg           Config
	lastHeartbeat time.Duration
	problems      map[string]bool
	orphansLogged bool
}

func New(cfg Config) *Watchdog {
	if cfg.CgroupRoot == "" {
		cfg.CgroupRoot = leasefence.DefaultCgroupRoot
	}
	if cfg.Now == nil {
		cfg.Now = leasefence.Now
	}
	if cfg.Killer == nil {
		cfg.Killer = CgroupKiller{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Watchdog{cfg: cfg, problems: map[string]bool{}}
}

// PassResult summarizes one enforcement pass.
type PassResult struct {
	Records int
	Stale   int
	// Killed counts processes that were found in stale cgroups and killed.
	Killed int
	// Healthy is false when the records directory could not be read or a
	// kill failed; the heartbeat is then withheld so the daemon stops
	// renewing and fences on its own (A12.4).
	Healthy bool
	// Orphans counts records removed because no lease-aware docker daemon
	// was seen for leasefence.DaemonGoneAfter.
	Orphans int
}

// Pass reads every record and kills the cgroup of each stale one. It never
// deletes records while a lease-aware docker daemon is around: only the
// daemon does, after the lease is released and the cgroup is confirmed empty
// (A12.3). With no sign of one (its daemon-heartbeat, or any record write)
// for leasefence.DaemonGoneAfter, the node was rolled back to a daemon
// without the lease: the records are orphans and are removed, so containers
// that daemon starts are not killed until the next reboot. A lease-aware
// daemon that returns kills unfenced lease-mode containers at its start and
// writes their records again.
func (w *Watchdog) Pass() PassResult {
	result := PassResult{Healthy: true}
	w.alignOwner()
	records, problems, err := w.cfg.Dir.ReadRecords()
	if err != nil {
		w.cfg.Logger.Error("lease watchdog cannot read deadline records", "error", err)
		result.Healthy = false
		return result
	}
	for _, problem := range problems {
		if !w.problems[problem] {
			w.problems[problem] = true
			w.cfg.Logger.Warn("lease watchdog ignored a malformed deadline record", "record", problem)
		}
	}
	now := w.cfg.Now()
	result.Records = len(records)
	if len(records) > 0 && w.orphaned(records, now) {
		for _, record := range records {
			if err := w.cfg.Dir.DeleteRecord(record.ContainerID); err != nil {
				w.cfg.Logger.Error("lease watchdog cannot remove an orphaned deadline record", "container_id", record.ContainerID, "error", err)
				continue
			}
			result.Orphans++
		}
		if !w.orphansLogged {
			w.orphansLogged = true
			w.cfg.Logger.Warn("no lease-aware docker daemon for a long time; removed its orphaned deadline records",
				"after", leasefence.DaemonGoneAfter, "records", result.Orphans)
		}
		return result
	}
	w.orphansLogged = false
	for _, record := range records {
		if !record.Stale(now) {
			continue
		}
		result.Stale++
		for _, path := range leasefence.CgroupCandidates(w.cfg.CgroupRoot, record.ContainerID, record.CgroupPath) {
			if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
				continue
			}
			killed, killErr := w.cfg.Killer.Kill(path)
			if killErr != nil {
				result.Healthy = false
				w.cfg.Logger.Error("lease watchdog failed to kill a stale cgroup", "container_id", record.ContainerID, "cgroup", path, "error", killErr)
			}
			if killed > 0 {
				result.Killed += killed
				w.cfg.Logger.Warn("lease watchdog killed a container past its lease deadline",
					"container_id", record.ContainerID, "policy_id", record.PolicyID, "slot", record.Slot,
					"cgroup", path, "processes", killed, "overdue", now-record.Deadline())
			}
		}
	}
	return result
}

// orphaned reports whether no lease-aware docker daemon showed life for
// leasefence.DaemonGoneAfter: no daemon-heartbeat and no record written in
// that time (daemons before availability_lease_v2 write no heartbeat, but do
// write records while they hold or create lease-mode containers).
func (w *Watchdog) orphaned(records []leasefence.Record, now time.Duration) bool {
	var last time.Duration
	sign := func(at int64) {
		if at > 0 && time.Duration(at) <= now+leasefence.HeartbeatMaxAge && time.Duration(at) > last {
			last = time.Duration(at)
		}
	}
	if heartbeat, err := w.cfg.Dir.ReadDaemonHeartbeat(); err == nil {
		sign(heartbeat.NowNs)
	}
	for _, record := range records {
		sign(record.WrittenNs)
	}
	return now-last >= leasefence.DaemonGoneAfter
}

// Heartbeat writes the liveness proof when due and the last pass was healthy.
func (w *Watchdog) Heartbeat(healthy bool) {
	now := w.cfg.Now()
	if !healthy || (w.lastHeartbeat != 0 && now-w.lastHeartbeat < leasefence.HeartbeatInterval) {
		return
	}
	if err := w.cfg.Dir.WriteHeartbeat(leasefence.Heartbeat{NowNs: int64(now), PID: os.Getpid(), Build: w.cfg.Build}); err != nil {
		w.cfg.Logger.Error("lease watchdog cannot write its heartbeat", "error", err)
		return
	}
	w.lastHeartbeat = now
}

// Run enforces records until ctx ends. The heartbeat is written from the
// same loop, so it proves the kill loop itself is alive.
func (w *Watchdog) Run(ctx context.Context) {
	ticker := time.NewTicker(PassInterval)
	defer ticker.Stop()
	for {
		result := w.Pass()
		w.Heartbeat(result.Healthy)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
