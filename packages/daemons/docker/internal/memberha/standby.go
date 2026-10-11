package memberha

import (
	"context"
	"time"
)

const (
	startRetryMin  = 2 * time.Second
	startRetryMax  = time.Minute
	rejoinRetryMin = 10 * time.Second
	rejoinRetryMax = 5 * time.Minute
)

type standbyRuntime struct {
	startFailures  int
	nextStartAt    time.Duration
	rejoinFailures int
	nextRejoinAt   time.Duration
}

func backoff(failures int, low, high time.Duration) time.Duration {
	wait := low
	for i := 1; i < failures && wait < high; i++ {
		wait *= 2
	}
	return min(wait, high)
}

// nonHolderStepLocked runs while this node does not hold the primary role.
func (m *Manager) nonHolderStepLocked(mem *member, status HolderStatus, leaseMode, bootstrapping bool, now time.Duration) {
	mem.holder.announced = false
	if mem.legacy.Load() && (mem.busy || !mem.fresh(now) || mem.primaryRunning()) && (!leaseMode || bootstrapping) {
		// The member that serves the resource before the set's lease
		// bootstrap committed (no manifest yet, or its reservation pending)
		// keeps serving as the single-node resource it still is.
		return
	}
	if mem.busy || !mem.fresh(now) {
		m.closeServingLocked(mem)
		mem.legacy.Store(false)
		return
	}
	if mem.primaryRunning() {
		if leaseMode && !bootstrapping {
			// A primary without the lease (a returning old primary): kill it
			// and bring it back as a copy.
			mem.legacy.Store(false)
			m.fenceLocked(mem, status, now, "primary_without_lease")
			return
		}
		// Before the set's lease runs, a writable member is the single-node
		// resource it was: it keeps serving until the bootstrap commits.
		mem.legacy.Store(true)
		m.openServingLocked(mem)
		return
	}
	mem.legacy.Store(false)
	m.closeServingLocked(mem)
	m.copyStepLocked(mem, now, m.primaryKnownLocked(mem))
}

// copyStepLocked keeps a member that is not the primary running as a copy:
// stopped when Gateway removes it, started through standby at rest, rejoined
// when it diverged and a primary is known.
func (m *Manager) copyStepLocked(mem *member, now time.Duration, primaryKnown bool) {
	obs := mem.obs
	if mem.state.Stopped {
		if obs.container.Running {
			m.launch(mem, opStopStandby, opTimeout, func(ctx context.Context) func() {
				err := mem.engine.StopClean(ctx, 30*time.Second)
				return func() {
					if err != nil {
						m.setErrorLocked(mem, "could not stop the copy: "+err.Error())
					}
				}
			})
		}
		return
	}
	if !obs.container.Running {
		m.startStandbyLocked(mem, now)
		return
	}
	if obs.status.Answering && obs.status.NeedsRejoin && primaryKnown && now >= mem.standby.nextRejoinAt {
		m.rejoinLocked(mem)
	}
}

// startStandbyLocked brings the member up as a read-only copy: standby at
// rest is written before every start, and a leftover deadline record of the
// stopped container is removed once its cgroup is empty (A12.3).
func (m *Manager) startStandbyLocked(mem *member, now time.Duration) {
	st := &mem.standby
	if now < st.nextStartAt {
		return
	}
	containerID, exists := mem.obs.container.ID, mem.obs.container.Exists
	m.launch(mem, opStartStandby, opTimeout, func(ctx context.Context) func() {
		if !exists {
			return func() { m.setErrorLocked(mem, "the member's container does not exist") }
		}
		err := m.clearStoppedRecord(ctx, mem, containerID)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil {
			err = mem.engine.Start(ctx)
		}
		return func() {
			if err != nil {
				st.startFailures++
				st.nextStartAt = m.deps.Clock.Now() + backoff(st.startFailures, startRetryMin, startRetryMax)
				m.setErrorLocked(mem, "could not start the copy: "+err.Error())
				return
			}
			st.startFailures = 0
		}
	})
}

// clearStoppedRecord deletes a deadline record left for a stopped container (a
// fence or release that did not finish) so the watchdog does not kill the
// copy; never while any process of the container remains.
func (m *Manager) clearStoppedRecord(ctx context.Context, mem *member, containerID string) error {
	if containerID == "" {
		return nil
	}
	records, err := m.deps.Watchdog.Records()
	if err != nil {
		return err
	}
	if _, ok := records[containerID]; !ok {
		return nil
	}
	empty, err := mem.engine.CgroupEmpty(ctx)
	if err != nil || !empty {
		return err
	}
	return m.deps.Watchdog.DeleteRecord(containerID)
}

// rejoinLocked makes a diverged copy follow the primary again (rewind,
// resync, rebuild); it starts through standby at rest afterwards.
func (m *Manager) rejoinLocked(mem *member) {
	st := &mem.standby
	m.launch(mem, opRejoin, longOpTimeout, func(ctx context.Context) func() {
		err := m.stopConfirmed(ctx, mem, false)
		if err == nil {
			err = mem.engine.Rejoin(ctx)
		}
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil {
			err = mem.engine.Start(ctx)
		}
		return func() {
			if err != nil {
				st.rejoinFailures++
				st.nextRejoinAt = m.deps.Clock.Now() + backoff(st.rejoinFailures, rejoinRetryMin, rejoinRetryMax)
				m.eventLocked(mem, Event{Kind: EventRejoinFailed, Reason: err.Error()})
				return
			}
			st.rejoinFailures = 0
			m.eventLocked(mem, Event{Kind: EventRejoined})
		}
	})
}

// primaryKnownLocked: another member holds the primary role (a verified
// commit names it), so a rejoin has a source.
func (m *Manager) primaryKnownLocked(mem *member) bool {
	commit, ok := m.deps.Lease.ObservedCommit(mem.cfg.Key())
	return ok && commit.State.Holder != "" && commit.State.Holder != mem.cfg.NodeID
}
