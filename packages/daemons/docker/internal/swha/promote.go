package swha

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"
)

// Promote makes this member the primary: master started, own volume server
// and filer restarted onto it, the volume-id gate passed, then the master
// opens to the other members (see the package documentation). It runs with
// the watchdog deadline record of the master container armed.
func (e *Engine) Promote(ctx context.Context, certified []byte) error {
	cfg, self := e.self()
	e.stopWorker()
	e.mu.Lock()
	e.gateOpen, e.masterLocal = false, false
	target := e.st.KnownMaxVolumeID
	margin := uint32(0)
	e.mu.Unlock()
	// keepFiler: a certified state of a set that was not degraded (a planned
	// switchover, or a failover of a healthy pair) names every volume, and this
	// member holds a copy of each: the volume-id gate has nothing to raise, so
	// the filer keeps serving S3 while the master moves (it reconnects to the
	// new master through the primary alias). It is stopped below only if the
	// registered topology turns out lower than the gate target after all.
	keepFiler := false
	if value, err := decodeValue(certified); err == nil {
		target = max(target, value.MaxVolumeID)
		if value.DegradedSince != 0 {
			margin = degradedBumpMargin
		} else {
			keepFiler = true
		}
	} else {
		// No certified state (a manual pair): volumes the old primary grew
		// with one copy after this member last saw the topology are unknown.
		margin = degradedBumpMargin
	}
	if target > 0 {
		target += margin
	}
	master, err := e.host.Container(ctx, RoleMaster)
	if err != nil {
		return err
	}
	if master.Running {
		// A master that started without passing the gate (or one being
		// restarted to drop a lost volume server) starts again.
		if err := e.host.Kill(ctx, RoleMaster); err != nil {
			return err
		}
		if err := e.waitCgroupEmpty(ctx); err != nil {
			return err
		}
	}
	if err := e.host.EnsureNoRestart(ctx, RoleMaster); err != nil {
		return err
	}
	if err := e.host.Start(ctx, RoleMaster); err != nil {
		return err
	}
	e.mu.Lock()
	e.masterLocal = true
	e.mu.Unlock()
	// The member's own volume server and filer leave the previous primary's
	// master now instead of when their stream times out (P0-T01, step 5b).
	// The filer stays down until the volume-id gate passed: it is the only
	// component that makes the master grow volumes (S3 writes, its own
	// metadata log), and a volume grown before the gate could take an id the
	// lost primary already used.
	if !keepFiler {
		if err := e.host.Stop(ctx, RoleFiler, componentStop); err != nil {
			return fmt.Errorf("stop the filer: %w", err)
		}
	}
	if err := e.host.Stop(ctx, RoleVolume, componentStop); err != nil {
		return fmt.Errorf("restart the volume server: %w", err)
	}
	if err := e.host.Start(ctx, RoleVolume); err != nil {
		return fmt.Errorf("restart the volume server: %w", err)
	}
	masterDial := e.local(RoleMaster, MasterHTTPPort)
	selfURL := VolumeURL(cfg.MemberID, self.MemberIndex)
	topology, err := e.waitTopology(ctx, masterDial, selfURL)
	if err != nil {
		return err
	}
	// Throw-away volumes an interrupted promotion left go first.
	if raw, err := getOK(ctx, masterDial, "/vol/status"); err == nil {
		if leftover, perr := collectionVolumes(raw, selfURL, bumpCollection); perr == nil && len(leftover) > 0 {
			if _, err := e.shell(ctx, deleteVolumesScript(selfURL, leftover)); err != nil {
				return fmt.Errorf("delete the throw-away volumes %v: %w", leftover, err)
			}
		}
	}
	if topology.MaxVolumeID < target {
		if keepFiler {
			if err := e.host.Stop(ctx, RoleFiler, componentStop); err != nil {
				return fmt.Errorf("stop the filer: %w", err)
			}
		}
		if err := e.raiseVolumeIDs(ctx, masterDial, selfURL, topology.MaxVolumeID, target); err != nil {
			return fmt.Errorf("volume id gate: %w", err)
		}
	}
	if err := e.host.Start(ctx, RoleFiler); err != nil {
		return fmt.Errorf("start the filer: %w", err)
	}
	// The member serves once the promotion returns: its S3 port must answer
	// by then, or the first client requests after the switch are refused.
	e.waitFilerServes(ctx, self.MemberIndex)
	started, err := e.host.Container(ctx, RoleMaster)
	if err != nil {
		return err
	}
	if !started.Running {
		return errors.New("the master stopped during the promotion")
	}
	e.mu.Lock()
	e.st.MasterStartedAt = started.StartedAt.UnixNano()
	e.st.KnownMaxVolumeID = max(e.st.KnownMaxVolumeID, topology.MaxVolumeID, target)
	e.topologyMax = max(e.topologyMax, topology.MaxVolumeID)
	e.restartWanted = false
	e.registeredAt = time.Now()
	err = e.saveLocked()
	if err == nil {
		e.gateOpen = true
	}
	e.mu.Unlock()
	if err != nil {
		return fmt.Errorf("persist the promotion: %w", err)
	}
	e.log.Info("SeaweedFS master promoted", "max_volume_id", topology.MaxVolumeID, "gate_target", target)
	return nil
}

// filerServeWait bounds the wait for the promoted member's filer and S3.
const filerServeWait = 30 * time.Second

// waitFilerServes waits until the filer answers and its S3 port takes
// connections (bounded; the promotion goes on either way).
func (e *Engine) waitFilerServes(ctx context.Context, index uint32) {
	httpPort, _ := FilerPorts(index)
	deadline := time.Now().Add(filerServeWait)
	for {
		if _, err := getOK(ctx, e.local(RoleFiler, httpPort), "/healthz"); err == nil {
			if conn, err := e.host.DialContainer(ctx, RoleFiler, S3Port); err == nil {
				_ = conn.Close()
				return
			}
		}
		if time.Now().After(deadline) {
			e.log.Warn("the promoted member's filer did not answer in time; it serves once it does")
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (e *Engine) waitCgroupEmpty(ctx context.Context) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		empty, err := e.host.CgroupEmpty(ctx, RoleMaster)
		if err == nil && empty {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("the previous master's processes did not exit")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// waitTopology waits until the master answers and the member's own volume
// server registered with it.
func (e *Engine) waitTopology(ctx context.Context, master dialFunc, selfURL string) (Topology, error) {
	deadline := time.Now().Add(registerWait)
	answered := false
	var lastErr error
	for {
		raw, err := getOK(ctx, master, "/dir/status")
		if err == nil {
			answered = true
			topology, perr := ParseTopology(raw)
			if perr == nil && topology.Registered(selfURL) {
				return topology, nil
			}
			lastErr = perr
			if lastErr == nil {
				lastErr = errors.New("the member's volume server has not registered")
			}
		} else {
			lastErr = err
			if !answered && time.Until(deadline) < registerWait-masterReadyWait {
				return Topology{}, fmt.Errorf("the master did not answer: %w", err)
			}
		}
		if time.Now().After(deadline) {
			return Topology{}, lastErr
		}
		select {
		case <-ctx.Done():
			return Topology{}, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// raiseVolumeIDs grows throw-away volumes on the member's own volume server
// until the master's id counter passed target, deleting them again at once:
// no other volume server can register meanwhile (the master is closed to the
// other members), so the ids they hold are never handed out again and the
// throw-away volumes never meet them (P0-T01 step 6b).
func (e *Engine) raiseVolumeIDs(ctx context.Context, master dialFunc, selfURL string, seen, target uint32) error {
	for seen < target {
		count := min(target-seen, bumpBatch)
		if err := growVolumes(ctx, master, selfURL, count); err != nil {
			return err
		}
		grown, err := e.waitGrown(ctx, master, selfURL, seen)
		if err != nil {
			return err
		}
		out, err := e.shell(ctx, deleteVolumesScript(selfURL, grown))
		if err != nil {
			return fmt.Errorf("delete the throw-away volumes %v: %w", grown, err)
		}
		e.log.Debug("volume-id gate: throw-away volumes grown and deleted", "ids", grown, "shell", out)
		next := grown[len(grown)-1]
		if next <= seen {
			return errors.New("the master did not raise its volume ids")
		}
		seen = next
	}
	return nil
}

// waitGrown returns the throw-away volume ids above seen on the member's own
// server (only those: the filer may grow a volume of its own meanwhile).
func (e *Engine) waitGrown(ctx context.Context, master dialFunc, selfURL string, seen uint32) ([]uint32, error) {
	deadline := time.Now().Add(20 * time.Second)
	for {
		raw, err := getOK(ctx, master, "/vol/status")
		if err == nil {
			if ids, perr := collectionVolumes(raw, selfURL, bumpCollection); perr == nil {
				var grown []uint32
				for _, id := range ids {
					if id > seen {
						grown = append(grown, id)
					}
				}
				if len(grown) > 0 {
					sort.Slice(grown, func(i, j int) bool { return grown[i] < grown[j] })
					return grown, nil
				}
			}
		}
		if time.Now().After(deadline) {
			return nil, errors.New("the throw-away volumes did not appear")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
