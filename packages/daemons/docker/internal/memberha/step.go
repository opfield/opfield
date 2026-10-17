package memberha

import (
	"time"
)

// Operation names (one at a time per member).
const (
	opStartStandby = "start_standby"
	opStopStandby  = "stop_standby"
	opPromote      = "promote"
	opFence        = "fence"
	opRelease      = "release"
	opRejoin       = "rejoin"
	opLocalRestart = "local_restart"
	// The set is paused (Config.Stopped): the engine stops cleanly; when the
	// pause ends the primary's engine starts again.
	opPauseStop = "pause_stop"
	opResume    = "resume_start"
)

// stepMemberLocked is the decision of one automatic-mode member for this
// iteration; every path acts only on an observation taken after its previous
// operation.
func (m *Manager) stepMemberLocked(mem *member, now time.Duration) {
	key := mem.cfg.Key()
	status := m.deps.Lease.HolderStatus(key)
	manifest, hasManifest := m.deps.Lease.ManifestInfo(key.PolicyID)
	leaseMode := hasManifest && !manifest.Closed
	m.updateReadyLocked(mem, status, leaseMode, now)
	m.switchoverGuardLocked(mem, status, now)
	if mem.obs.at == 0 {
		return
	}
	if !mem.started {
		mem.started = true
		m.startupLocked(mem, status, now)
		return
	}
	if status.Role != RoleNone && status.Role != RoleCandidate && status.Role != RoleAcquiring &&
		status.Role != RoleBootstrapping {
		mem.legacy.Store(false)
	}
	switch status.Role {
	case RoleHolding, RoleRecovering:
		m.holderStepLocked(mem, status, now)
	case RoleRetained:
		// Graceful close (AS9): the copy keeps running as the single primary
		// without a lease; the control plane turns the set off around it.
		m.retainedStepLocked(mem, now)
	case RoleFencing:
		m.fenceLocked(mem, status, now, string(status.FenceReason))
	case RoleAbandoned:
		m.fenceLocked(mem, status, now, "abandoned")
	case RoleReleasing:
		// The release operation stopped the container before releasing;
		// nothing may start until the release completed.
		m.closeServingLocked(mem)
	default:
		bootstrapping := status.Role == RoleBootstrapping || m.deps.Lease.BootstrapPending(key)
		m.nonHolderStepLocked(mem, status, leaseMode, bootstrapping, now)
	}
}

// updateReadyLocked tells the lease node whether this member may take the
// primary role at all; the eligibility callback decides against the
// certified state.
func (m *Manager) updateReadyLocked(mem *member, status HolderStatus, leaseMode bool, now time.Duration) {
	obs := mem.obs
	ready := leaseMode && m.watchdog.fresh && !mem.state.Stopped && !mem.cfg.Stopped && obs.at > 0 && now-obs.at <= 3*observeInterval &&
		obs.container.Running && obs.status.Answering && !mem.dataBusy()
	if status.Role != RoleHolding && status.Role != RoleRecovering && obs.status.Writable &&
		!m.deps.Lease.BootstrapPending(mem.cfg.Key()) {
		// A primary that does not hold is fenced, never a candidate.
		ready = false
	}
	if mem.ready != ready {
		mem.ready = ready
		m.deps.Lease.SetCandidateReady(mem.cfg.LeasePolicyID, ready)
	}
}

// startupLocked handles what runs when the daemon starts (A2.3): a running
// container with a live deadline record of the set's policy was the holder's;
// the node recovers the key with the recorded deadline and must renew or
// fence. A running primary without a live record is unowned and the
// non-holder path fences it. Everything else is a copy.
func (m *Manager) startupLocked(mem *member, status HolderStatus, now time.Duration) {
	// A paused primary keeps its record armed for its stopped container, so it
	// recovers its role after a daemon restart as a running one does.
	pausedDown := mem.cfg.Stopped && mem.obs.container.Exists && !mem.obs.container.Running
	if status.Role == RoleHolding || status.Role == RoleRecovering || (!mem.obs.container.Running && !pausedDown) {
		return
	}
	records, err := m.deps.Watchdog.Records()
	if err != nil {
		m.logger.Warn("lease watchdog records unreadable at start", "set_id", mem.cfg.SetID, "error", err)
		return
	}
	record, ok := records[mem.obs.container.ID]
	if ok && !record.Stale(now) && record.PolicyID == mem.cfg.LeasePolicyID && !m.watchdog.lost {
		m.logger.Info("recovering the availability primary role after a daemon start",
			"set_id", mem.cfg.SetID, "budget", record.Deadline()-now)
		m.deps.Lease.Recover(mem.cfg.Key(), record.Deadline())
		mem.holder.recordID, mem.holder.recordDeadline = record.ContainerID, record.Deadline()
		// The promotion of this holding period was reported before the restart.
		mem.holder.announced = true
	}
}

// retainedStepLocked keeps a retained primary serving (graceful close).
//
// The deadline record goes first, on the first step that sees the role, even
// while an operation of the member runs or its last observation is old: a
// majority of every quorum set confirmed this copy retained, so no other node
// can acquire the key, and the record is no longer renewed. Waiting for the
// member to be idle let the watchdog kill the copy the operator asked to keep
// when an operation (the principals of the configuration that removed the
// other members) outlasted the lease budget (rc.3 F-A2).
func (m *Manager) retainedStepLocked(mem *member, now time.Duration) {
	m.disarmRetainedLocked(mem)
	if mem.busy || !mem.fresh(now) {
		return
	}
	if mem.primaryRunning() {
		m.openServingLocked(mem)
		return
	}
	m.closeServingLocked(mem)
}

// disarmRetainedLocked deletes the watchdog deadline record of a retained
// primary: the one this holder armed, or, when the daemon did not arm it in
// this process (it started after the close), the record of the observed
// container, looked up once.
func (m *Manager) disarmRetainedLocked(mem *member) {
	if mem.holder.recordID != "" {
		if err := m.deps.Watchdog.DeleteRecord(mem.holder.recordID); err != nil {
			m.logger.Warn("could not disarm the lease deadline of the retained primary; retrying", "set_id", mem.cfg.SetID, "error", err)
			return
		}
		mem.holder.recordID, mem.holder.recordDeadline = "", 0
		mem.retainSwept = mem.obs.container.ID
		m.eventLocked(mem, Event{Kind: EventRetainedOnClose})
		return
	}
	containerID := mem.obs.container.ID
	if containerID == "" || mem.retainSwept == containerID {
		return
	}
	if err := m.deleteRecord(containerID); err != nil {
		m.logger.Warn("could not disarm the lease deadline of the retained primary; retrying", "set_id", mem.cfg.SetID, "error", err)
		return
	}
	mem.retainSwept = containerID
}

func firstReason(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
