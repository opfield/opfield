package swha

import (
	"context"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Worker timings (variables for tests; an engine reads them when it opens).
var (
	workerTick     = time.Second
	peerProbeEvery = 2 * time.Second
	// peerLostAfter: a volume server that did not answer for this long is
	// lost (decision 13: 10 s).
	peerLostAfter = 10 * time.Second
	// workerGrace: no member counts as lost in the first seconds of a
	// holding period (the members are still reconnecting).
	workerGrace = 10 * time.Second
	repairAfter = 10 * time.Second
	repairRetry = time.Minute
)

const (
	workerOpTimeout = 5 * time.Minute
	// repairTimeout bounds a repair, which copies every volume that has one
	// copy (a converted single node copies all of its data).
	repairTimeout = 12 * time.Hour
)

// startWorker runs the primary's background work while its master is writable.
func (e *Engine) startWorker() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workerStop != nil {
		return
	}
	stop := make(chan struct{})
	e.workerStop, e.workerSince = stop, time.Now()
	e.peersOK = map[string]time.Time{}
	e.heartbeats = nil
	go e.work(stop)
}

func (e *Engine) stopWorker() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workerStop != nil {
		close(e.workerStop)
		e.workerStop = nil
	}
}

func (e *Engine) work(stop chan struct{}) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-stop
		cancel()
	}()
	ticker := time.NewTicker(e.timings.tick)
	defer ticker.Stop()
	var lastProbe, nextRepair time.Time
	allBackSince := time.Time{}
	repairing := false
	repairDone := make(chan error, 1)
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-repairDone:
			repairing = false
			if err != nil {
				nextRepair = time.Now().Add(e.timings.repairRetry)
				if ctx.Err() == nil {
					e.log.Warn("SeaweedFS replication repair failed; retrying", "error", err)
				}
			}
			continue
		case <-ticker.C:
		}
		cfg, self := e.self()
		fh, _ := FilerPorts(self.MemberIndex)
		if _, err := e.writeHeartbeat(ctx, e.local(RoleFiler, fh)); err != nil && ctx.Err() == nil {
			e.log.Debug("SeaweedFS metadata heartbeat not written", "error", err)
		}
		var topology *Topology
		if raw, err := getOK(ctx, e.local(RoleMaster, MasterHTTPPort), "/dir/status"); err == nil {
			if parsed, perr := ParseTopology(raw); perr == nil {
				topology = &parsed
				e.mu.Lock()
				e.topologyMax = max(e.topologyMax, parsed.MaxVolumeID)
				e.mu.Unlock()
			}
		}
		now := time.Now()
		if now.Sub(lastProbe) >= e.timings.probe {
			lastProbe = now
			for _, peer := range cfg.Others() {
				if peer.Removing {
					continue
				}
				if _, err := getOK(ctx, e.mesh("member-"+peer.MemberID+"-"+PortVolume), "/status"); err == nil {
					e.mu.Lock()
					e.peersOK[peer.MemberID] = time.Now()
					e.mu.Unlock()
				}
			}
		}
		lost, alive := e.lostPeers(cfg.Others(), now)
		e.mu.Lock()
		degraded := e.st.DegradedSince != 0
		started := e.workerSince
		e.mu.Unlock()
		if len(lost) > 0 {
			allBackSince = time.Time{}
			if !degraded && now.Sub(started) >= e.timings.grace {
				e.degrade(ctx, lost, alive)
			}
			continue
		}
		if !degraded {
			continue
		}
		registered := topology != nil
		if registered {
			for _, peer := range cfg.Others() {
				if !peer.Removing && !topology.Registered(VolumeURL(peer.MemberID, peer.MemberIndex)) {
					registered = false
				}
			}
		}
		if !registered {
			allBackSince = time.Time{}
			continue
		}
		if allBackSince.IsZero() {
			allBackSince = now
		}
		if now.Sub(allBackSince) >= e.timings.repairAfter && now.After(nextRepair) && !repairing {
			repairing = true
			go func() {
				err := e.repair(ctx)
				repairDone <- err
			}()
		}
	}
}

// lostPeers are the members whose volume server did not answer for
// peerLostAfter; alive counts the volume servers that do, this one included.
func (e *Engine) lostPeers(peers []memberha.Peer, now time.Time) ([]string, int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var lost []string
	alive := 1
	for _, peer := range peers {
		if peer.Removing {
			continue
		}
		at, ok := e.peersOK[peer.MemberID]
		if !ok {
			at = e.workerSince
		}
		if now.Sub(at) > e.timings.lost {
			lost = append(lost, peer.MemberID)
		} else if ok {
			alive++
		}
	}
	return lost, alive
}

// degrade keeps writes going without the lost volume servers: with fewer than
// two volume servers left new bucket objects get one copy, and the master
// restarts (through a new promotion) so it drops the silent servers, which it
// would keep registered for as long as their stream hangs (P0-T01 step 4).
func (e *Engine) degrade(ctx context.Context, lost []string, alive int) {
	opCtx, cancel := context.WithTimeout(ctx, workerOpTimeout)
	defer cancel()
	if alive < 2 {
		if _, err := e.shell(opCtx, singleCopyScript()); err != nil {
			e.log.Warn("SeaweedFS could not switch new objects to one copy; retrying", "lost", lost, "error", err)
			return
		}
	}
	// The master restarts only to drop a lost volume server it still keeps
	// registered. One that never registered with this master (the old
	// primary's, cut off before this member was promoted) needs no restart:
	// a restart would take S3 down a second time right after a failover
	// (stand rc.9: the failover took 58.7 s instead of about 35 s).
	restart := e.lostStillRegistered(opCtx, lost)
	e.mu.Lock()
	e.st.DegradedSince = time.Now().UnixMilli()
	e.restartWanted = restart
	if err := e.saveLocked(); err != nil {
		e.log.Warn("could not persist the SeaweedFS member state", "error", err)
	}
	e.mu.Unlock()
	e.log.Warn("SeaweedFS volume servers lost: new objects are written without them until they return",
		"lost", lost, "single_copy", alive < 2)
}

// lostStillRegistered reports whether the master keeps any of the lost
// members' volume servers registered (true when it cannot tell).
func (e *Engine) lostStillRegistered(ctx context.Context, lost []string) bool {
	raw, err := getOK(ctx, e.local(RoleMaster, MasterHTTPPort), "/dir/status")
	if err != nil {
		return true
	}
	topology, err := ParseTopology(raw)
	if err != nil {
		return true
	}
	cfg, _ := e.self()
	for _, id := range lost {
		peer, ok := cfg.Peer(id)
		if !ok || topology.Registered(VolumeURL(id, peer.MemberIndex)) {
			return true
		}
	}
	return false
}

// repair gives the objects written with one copy their second copy and new
// objects their replication back.
func (e *Engine) repair(ctx context.Context) error {
	opCtx, cancel := context.WithTimeout(ctx, repairTimeout)
	defer cancel()
	raw, err := getOK(opCtx, e.local(RoleMaster, MasterHTTPPort), "/vol/status")
	if err != nil {
		return err
	}
	single, err := singleCopyVolumes(raw)
	if err != nil {
		return err
	}
	if _, err := e.shell(opCtx, repairScript(single)); err != nil {
		return err
	}
	e.mu.Lock()
	e.st.DegradedSince = 0
	err = e.saveLocked()
	e.mu.Unlock()
	e.log.Info("SeaweedFS replication repaired", "single_copy_volumes", len(single))
	return err
}

type workerTimings struct {
	tick, probe, lost, grace, repairAfter, repairRetry time.Duration
}

func currentWorkerTimings() workerTimings {
	return workerTimings{tick: workerTick, probe: peerProbeEvery, lost: peerLostAfter, grace: workerGrace,
		repairAfter: repairAfter, repairRetry: repairRetry}
}
