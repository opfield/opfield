package memberha

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

const (
	// Health release (decision 17): the engine down, or not answering on two
	// samples at least healthWindow apart.
	healthWindow = 10 * time.Second
	// Without an eligible copy the holder restarts locally up to
	// maxLocalRestarts times per localRestartWindow, then alerts and keeps
	// retrying slowly.
	maxLocalRestarts   = 3
	localRestartWindow = 10 * time.Minute
	localRestartRetry  = 5 * time.Second
	slowRestartRetry   = time.Minute
	promoteRetry       = 2 * time.Second
	diskAlertInterval  = 10 * time.Minute
)

type holderRuntime struct {
	recordDeadline time.Duration
	recordID       string

	// pending is the transition this holder proposed and waits for.
	pending *proposal
	// announced: the current holding period's promotion was reported.
	announced     bool
	nextPromoteAt time.Duration

	unhealthySince  time.Duration
	restarts        int
	restartWindowAt time.Duration
	nextRestartAt   time.Duration
	alerted         bool
	diskAlertedAt   time.Duration
}

type proposal struct {
	id    string
	kind  string
	value []byte
}

// armRecordLocked writes the container's watchdog deadline record: before any
// start or promotion, and whenever the holder's deadline moves (A12.1).
func (m *Manager) armRecordLocked(mem *member, deadline time.Duration) bool {
	c := mem.obs.container
	if !leasefence.ValidContainerID(c.ID) || deadline <= 0 {
		return false
	}
	h := &mem.holder
	if h.recordID == c.ID {
		delta := deadline - h.recordDeadline
		if delta >= 0 && delta < time.Second {
			return h.recordDeadline > m.deps.Clock.Now()
		}
	}
	record := leasefence.Record{
		ContainerID: c.ID, CgroupPath: c.CgroupPath, PolicyID: mem.cfg.LeasePolicyID, Slot: 0,
		DeadlineNs: int64(deadline), WrittenNs: int64(m.deps.Clock.Now()),
	}
	if err := m.deps.Watchdog.WriteRecord(record); err != nil {
		m.setErrorLocked(mem, "could not write the primary's deadline record: "+err.Error())
		return false
	}
	h.recordID, h.recordDeadline = c.ID, deadline
	return true
}

func (m *Manager) recordArmedLocked(mem *member, deadline time.Duration) bool {
	h := &mem.holder
	return h.recordID != "" && h.recordID == mem.obs.container.ID && h.recordDeadline > m.deps.Clock.Now() &&
		h.recordDeadline <= deadline
}

// holderStepLocked runs while this node holds (or recovers) the primary role.
func (m *Manager) holderStepLocked(mem *member, status HolderStatus, now time.Duration) {
	key := mem.cfg.Key()
	if m.watchdog.lost {
		// A12.4: without the watchdog a hung daemon could not be fenced.
		m.logger.Warn("availability primary stops renewing: the lease watchdog is gone", "set_id", mem.cfg.SetID)
		m.closeServingLocked(mem)
		m.deps.Lease.Abandon(key)
		return
	}
	if mem.obs.container.Running || (mem.cfg.Stopped && mem.obs.container.Exists) {
		// A paused primary keeps the record of its stopped container armed:
		// it keeps the role, and the record covers its start when the pause
		// ends.
		m.armRecordLocked(mem, status.Deadline)
	}
	if status.Role == RoleRecovering {
		// Unconfirmed after a restart: the primary keeps running on its
		// recorded budget; nothing opens until a renewal succeeds.
		m.closeServingLocked(mem)
		return
	}
	if status.FenceNow {
		m.fenceLocked(mem, status, now, firstReason(string(status.FenceReason), "renewal_timeout"))
		return
	}
	if mem.busy || !mem.fresh(now) {
		return
	}
	if mem.cfg.Stopped {
		m.pausedHolderStepLocked(mem)
		return
	}
	cert, ok := m.deps.Lease.CommittedState(key)
	if !ok {
		return
	}
	free := m.resolvePendingLocked(mem, key)
	obs := mem.obs
	if !obs.container.Running && mem.resumeStart {
		m.resumeHolderLocked(mem, status)
		return
	}
	mem.resumeStart = mem.resumeStart && !obs.container.Running
	if !obs.container.Running || !obs.status.Answering {
		// Down on two samples at least healthWindow apart: a container that
		// only restarts (it comes back read-only and is promoted again) is no
		// release reason yet.
		m.closeServingLocked(mem)
		if mem.holder.unhealthySince == 0 {
			mem.holder.unhealthySince = obs.at
		}
		if obs.at-mem.holder.unhealthySince >= healthWindow {
			reason := "the engine does not answer"
			if !obs.container.Running {
				reason = "the primary's container is not running"
			}
			m.holderDownLocked(mem, status, cert, now, reason)
		}
		return
	}
	mem.holder.unhealthySince = 0
	if obs.status.DiskFull && (mem.holder.diskAlertedAt == 0 || now-mem.holder.diskAlertedAt >= diskAlertInterval) {
		// A full disk is never a release reason (it would repeat on the
		// successor); it alerts.
		mem.holder.diskAlertedAt = now
		m.eventLocked(mem, Event{Kind: EventDiskAlert, Reason: obs.status.Detail})
	}
	if !obs.status.Writable {
		// Acquisition (pending promotion), or the holder's engine came back
		// from a restart read-only: promote again while holding.
		m.promoteLocked(mem, status, cert, now)
		return
	}
	mem.holder.alerted = false
	if cert.State.PendingPromotion || cert.State.Holder != mem.cfg.NodeID || !m.certifiedCurrentLocked(mem, cert) {
		m.closeServingLocked(mem)
		if free {
			m.certifyPromotionLocked(mem, cert)
		}
		return
	}
	if !mem.holder.announced {
		mem.holder.announced = true
		mem.state.Held = true
		m.eventLocked(mem, Event{Kind: EventPromoted, Detail: map[string]string{"ballot": status.Ballot.String()}})
	}
	m.openServingLocked(mem)
	if m.holderExtrasLocked(mem, status, cert, free, now) {
		return
	}
	if free {
		value, kind, changed, err := mem.engine.NextValue(cert.State.Value, obs.status, now)
		if err != nil {
			m.setErrorLocked(mem, "could not compute the next certified state: "+err.Error())
			return
		}
		if changed {
			m.proposeLocked(mem, kind, value, false)
		}
	}
}

// resolvePendingLocked follows this holder's proposal; it reports whether a
// new transition may be proposed (none in flight).
func (m *Manager) resolvePendingLocked(mem *member, key Key) bool {
	p := mem.holder.pending
	if p == nil {
		// A transition restored by the library after a restart (or queued
		// by an earlier incarnation) resolves before anything new.
		return !m.libraryPendingLocked(key)
	}
	outcome, reason := m.deps.Lease.TransitionStatus(key, p.id)
	switch outcome {
	case TransitionQueued, TransitionSent:
		return false
	case TransitionCertified:
		mem.holder.pending = nil
		return true
	default:
		mem.holder.pending = nil
		m.logger.Info("availability state transition not certified; recomputing", "set_id", mem.cfg.SetID,
			"transition", p.id, "kind", p.kind, "reason", reason)
		return true
	}
}

// proposeLocked queues one transition on top of the certified value.
func (m *Manager) proposeLocked(mem *member, kind string, value []byte, promoted bool) bool {
	id := fmt.Sprintf("%s-%d", kind, m.deps.Clock.Wall().UnixNano())
	if err := m.deps.Lease.ProposeTransition(mem.cfg.Key(), Transition{ID: id, Value: value, Promoted: promoted}); err != nil {
		m.logger.Info("availability state transition not queued", "set_id", mem.cfg.SetID, "kind", kind, "error", err)
		return false
	}
	mem.holder.pending = &proposal{id: id, kind: kind, value: value}
	return true
}

// promoteLocked makes the holder's engine writable: the deadline record is
// armed first, Promote runs only while the lease allows a start, then the
// standby-at-rest configuration is written back for the next start.
func (m *Manager) promoteLocked(mem *member, status HolderStatus, cert CertifiedState, now time.Duration) {
	m.closeServingLocked(mem)
	if now < mem.holder.nextPromoteAt || !m.watchdog.fresh || !m.recordArmedLocked(mem, status.Deadline) {
		return
	}
	key := mem.cfg.Key()
	certified := cert.State.Value
	pending := m.pendingValueLocked(mem, key)
	m.launch(mem, opPromote, opTimeout, func(ctx context.Context) func() {
		if st := m.deps.Lease.HolderStatus(key); !st.MayStart {
			return nil
		}
		err := m.promoteEngine(ctx, mem, certified, pending)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		return func() {
			if err != nil {
				mem.holder.nextPromoteAt = m.deps.Clock.Now() + promoteRetry
				m.setErrorLocked(mem, "promotion failed: "+err.Error())
				return
			}
			mem.lastError = ""
		}
	})
}

// certifyPromotionLocked certifies this holder's promotion (clears the pending
// promotion in the lease) before it serves (M3).
func (m *Manager) certifyPromotionLocked(mem *member, cert CertifiedState) {
	value, err := mem.engine.PromotedValue(cert.State.Value, mem.obs.status)
	if err != nil {
		m.setErrorLocked(mem, "could not compute the promoted state: "+err.Error())
		return
	}
	m.proposeLocked(mem, "promoted", value, true)
}

// holderDownLocked: the holder's engine failed. With an eligible copy the
// holder releases to it; without one it restarts locally a few times, then
// alerts and keeps retrying slowly.
func (m *Manager) holderDownLocked(mem *member, status HolderStatus, cert CertifiedState, now time.Duration, reason string) {
	if successor, ok := mem.engine.ReleaseTarget(cert.State.Value); ok {
		if peer, known := mem.cfg.Peer(successor); known && peer.MemberID != mem.cfg.MemberID {
			m.releaseLocked(mem, peer.NodeID, "", EventHealthRelease, reason, true)
			return
		}
	}
	h := &mem.holder
	if now < h.nextRestartAt {
		return
	}
	if h.restartWindowAt == 0 || now-h.restartWindowAt >= localRestartWindow {
		h.restartWindowAt, h.restarts = now, 0
	}
	h.restarts++
	if h.restarts > maxLocalRestarts {
		if !h.alerted {
			h.alerted = true
			m.eventLocked(mem, Event{Kind: EventHealthAlert, Reason: reason})
		}
		h.nextRestartAt = now + slowRestartRetry
	} else {
		h.nextRestartAt = now + localRestartRetry
	}
	m.eventLocked(mem, Event{Kind: EventHealthRestart, Reason: reason})
	m.restartHolderLocked(mem, status)
}

// restartHolderLocked restarts the holder's container in place: standby at
// rest first (it comes back read-only), the deadline record armed for the new
// container, then the holder path promotes it again.
func (m *Manager) restartHolderLocked(mem *member, status HolderStatus) {
	key := mem.cfg.Key()
	// The record of a stopped container is not renewed (holderStepLocked arms
	// running containers only), so after a crash loop it names a deadline long
	// past: the watchdog killed every restart at once ("past its lease
	// deadline", then "cannot start a stopped process"), and a disk-full
	// primary never came back after its resize. The holder's current deadline
	// covers the start.
	if mem.obs.container.Exists && !m.armRecordLocked(mem, status.Deadline) {
		m.setErrorLocked(mem, "local restart failed: the primary's deadline record could not be armed")
		return
	}
	m.launch(mem, opLocalRestart, opTimeout, func(ctx context.Context) func() {
		err := m.stopConfirmed(ctx, mem, true)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil {
			if st := m.deps.Lease.HolderStatus(key); !st.MayStart {
				return func() { m.setErrorLocked(mem, "the lease no longer allows a start") }
			}
			err = mem.engine.Start(ctx)
		}
		return func() {
			if err != nil {
				m.setErrorLocked(mem, "local restart failed: "+err.Error())
			}
		}
	})
}

// pausedHolderStepLocked keeps a paused set's holder (Config.Stopped) as the
// primary with its engine down: serving closed, a clean stop, no health
// release and no local restarts; the lease renews on its own and the record
// stays armed, so no other member takes over.
func (m *Manager) pausedHolderStepLocked(mem *member) {
	m.closeServingLocked(mem)
	mem.holder.unhealthySince = 0
	m.pausedRestartLocked(mem)
	if mem.obs.container.Running {
		m.pauseStopLocked(mem)
		return
	}
	mem.resumeStart = true
}

// resumeHolderLocked starts the holder's engine when its set's pause ended:
// the deadline record armed first, standby at rest, a start only while the
// lease allows one; the holder path promotes it again. A start that fails
// leaves the engine to the health rules (release or local restarts).
func (m *Manager) resumeHolderLocked(mem *member, status HolderStatus) {
	if !m.watchdog.fresh || !m.armRecordLocked(mem, status.Deadline) {
		return
	}
	key := mem.cfg.Key()
	m.launch(mem, opResume, opTimeout, func(ctx context.Context) func() {
		err := mem.engine.PrepareStandby(ctx)
		if err == nil {
			if st := m.deps.Lease.HolderStatus(key); !st.MayStart {
				err = errors.New("the lease no longer allows a start")
			} else {
				err = mem.engine.Start(ctx)
			}
		}
		return func() {
			mem.resumeStart = false
			if err != nil {
				m.setErrorLocked(mem, "could not start the primary after the pause: "+err.Error())
			}
		}
	})
}

// pauseStopLocked stops a paused member's engine cleanly (a kill only when the
// clean stop fails) and writes standby at rest for its next start. An engine
// with several containers may need more than one pass (SeaweedFS: the master,
// then the volume server and filer).
func (m *Manager) pauseStopLocked(mem *member) {
	m.closeServingLocked(mem)
	m.launch(mem, opPauseStop, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, false)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		return func() {
			if err != nil {
				m.setErrorLocked(mem, "could not stop the member for the pause: "+err.Error())
			}
		}
	})
}

// pausedRestartLocked completes a restart Opfield asked for while the set is
// paused: the engine is down, and it starts fresh when the pause ends.
func (m *Manager) pausedRestartLocked(mem *member) {
	if r := mem.state.Restart; r != nil {
		mem.state.Restart = nil
		mem.state.RestartDone = r.OperationID
		m.eventLocked(mem, Event{Kind: EventRestarted, OperationID: r.OperationID, Reason: "stopped"})
	}
}
