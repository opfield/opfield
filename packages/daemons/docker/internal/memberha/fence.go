package memberha

import (
	"context"
	"errors"
	"time"
)

// fenceLocked ends a primary that may no longer be one (renewal timeout,
// another holder's commit, a freeze, a lost watchdog, abandoned renewals, or a
// primary running without the lease): serving closed and tunnels ended, kill,
// cgroup confirmed empty, standby at rest written, and only then the deadline
// record deleted and the fence completed. A stop that cannot be confirmed
// abandons the key: the watchdog kills at the deadline and the fence retries.
func (m *Manager) fenceLocked(mem *member, status HolderStatus, now time.Duration, reason string) {
	m.closeServingLocked(mem)
	if mem.busy {
		return
	}
	key := mem.cfg.Key()
	held := status.Role == RoleFencing || status.Role == RoleAbandoned || status.Role == RoleHolding ||
		status.Role == RoleRecovering
	containerID := mem.obs.container.ID
	m.launch(mem, opFence, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, true)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil && containerID != "" {
			err = m.deleteRecord(containerID)
		}
		if err != nil {
			if held {
				m.deps.Lease.Abandon(key)
			}
			return func() { m.setErrorLocked(mem, "fence not confirmed: "+err.Error()) }
		}
		if held {
			m.deps.Lease.FenceComplete(key)
		}
		return func() {
			mem.holder = holderRuntime{}
			kind := EventFenced
			if !held {
				kind = EventUnownedPrimary
			}
			m.eventLocked(mem, Event{Kind: kind, Reason: reason})
		}
	})
}

// deleteRecord removes a deadline record; a missing one is fine.
func (m *Manager) deleteRecord(containerID string) error {
	records, err := m.deps.Watchdog.Records()
	if err != nil {
		return err
	}
	if _, ok := records[containerID]; !ok {
		return nil
	}
	return m.deps.Watchdog.DeleteRecord(containerID)
}

// stopConfirmed stops the container (kill, or a clean stop that falls back to
// a kill) and waits until its cgroup is empty.
func (m *Manager) stopConfirmed(ctx context.Context, mem *member, kill bool) error {
	var err error
	if kill {
		err = mem.engine.Kill(ctx)
	} else if err = mem.engine.StopClean(ctx, 30*time.Second); err != nil {
		err = mem.engine.Kill(ctx)
	}
	if err != nil {
		return err
	}
	deadline := time.Now().Add(m.confirmWait)
	for {
		empty, emptyErr := mem.engine.CgroupEmpty(ctx)
		if emptyErr == nil && empty {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			if emptyErr != nil {
				return emptyErr
			}
			return errors.New("the container's processes did not exit")
		}
		select {
		case <-ctx.Done():
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// releaseLocked gives the lease up (health release or planned switchover) in
// the A6 order: serving closed and tunnels ended, the engine stopped and its
// cgroup confirmed empty, standby at rest written, record deleted, then the
// release with the designated successor (its lease identity: its node).
func (m *Manager) releaseLocked(mem *member, successorNode, operationID, eventKind, reason string, kill bool) {
	if mem.busy {
		return
	}
	key := mem.cfg.Key()
	containerID := mem.obs.container.ID
	m.closeServingLocked(mem)
	m.launch(mem, opRelease, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, kill)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil && containerID != "" {
			err = m.deleteRecord(containerID)
		}
		if err != nil {
			m.deps.Lease.Abandon(key)
			return func() { m.setErrorLocked(mem, "release not confirmed: "+err.Error()) }
		}
		releaseErr := m.deps.Lease.Release(key, successorNode)
		return func() {
			mem.holder = holderRuntime{}
			if releaseErr != nil {
				m.setErrorLocked(mem, "release refused: "+releaseErr.Error())
			}
			m.eventLocked(mem, Event{Kind: eventKind, Reason: reason, OperationID: operationID,
				Detail: map[string]string{"successorNodeId": successorNode}})
		}
	})
}

// Switchover is a planned handoff (AS11) Gateway asks of this node's holder:
// the engine stops writes and lets the successor catch up, then the holder
// releases to it in the A6 order. It returns once the release was started.
func (m *Manager) Switchover(setID, successorMemberID, operationID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return errors.New("the set has no member on this node")
	}
	successor, ok := mem.cfg.Peer(successorMemberID)
	if !ok || successor.MemberID == mem.cfg.MemberID {
		return errors.New("the successor is no other member of the set")
	}
	status := m.deps.Lease.HolderStatus(mem.cfg.Key())
	if status.Role != RoleHolding {
		return errors.New("this member does not hold the primary role")
	}
	if prep, ok := mem.engine.(SwitchoverPreparer); ok {
		// The engine prepares the handoff on the lease loop first (the
		// successor becomes the certified sync member); the holder path
		// runs the release once SwitchoverReady says so.
		return m.stageSwitchoverLocked(mem, prep, successor, operationID)
	}
	if mem.busy {
		return errors.New("this member is busy")
	}
	m.runSwitchoverLocked(mem, successor, operationID)
	return nil
}

// successorCheckTimeout bounds the successor readiness check of a switchover.
const successorCheckTimeout = 5 * time.Second

// runSwitchoverLocked runs the handoff: serving closed, the engine stops
// writes and lets the successor catch up, a clean stop, standby at rest, the
// record deleted, then the release to the successor.
func (m *Manager) runSwitchoverLocked(mem *member, successor Peer, operationID string) {
	successorMemberID := successor.MemberID
	key := mem.cfg.Key()
	containerID := mem.obs.container.ID
	setID := mem.cfg.SetID
	m.launch(mem, opRelease, opTimeout, func(ctx context.Context) func() {
		// The successor must be able to take the lease the holder releases to
		// it; otherwise the holder would step down, cut its clients and take
		// the role back once the handoff lapses (stand rc.6: an async pair
		// whose copy did not take over). A peer from before the readiness
		// report is not checked.
		if m.deps.peerStateWired {
			checkCtx, cancel := context.WithTimeout(ctx, successorCheckTimeout)
			peer, ok := m.deps.PeerState(checkCtx, setID, successorMemberID)
			cancel()
			if !ok {
				return func() {
					m.eventLocked(mem, Event{Kind: EventSwitchoverFail, Reason: "the successor could not be reached; the primary keeps serving", OperationID: operationID})
				}
			}
			if peer.Candidate && !peer.Ready {
				reason := firstReason(peer.Reason, "not_a_candidate")
				return func() {
					m.eventLocked(mem, Event{Kind: EventSwitchoverFail, Reason: "the successor cannot take the primary role now (" + reason + "); the primary keeps serving", OperationID: operationID})
				}
			}
		}
		m.closeServing(mem)
		if err := mem.engine.Switchover(ctx, successorMemberID); err != nil {
			return func() {
				m.eventLocked(mem, Event{Kind: EventSwitchoverFail, Reason: err.Error(), OperationID: operationID})
			}
		}
		err := m.stopConfirmed(ctx, mem, false)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil && containerID != "" {
			err = m.deleteRecord(containerID)
		}
		if err != nil {
			m.deps.Lease.Abandon(key)
			return func() { m.setErrorLocked(mem, "switchover stop not confirmed: "+err.Error()) }
		}
		releaseErr := m.deps.Lease.Release(key, successor.NodeID)
		return func() {
			mem.holder = holderRuntime{}
			if releaseErr != nil {
				m.eventLocked(mem, Event{Kind: EventSwitchoverFail, Reason: releaseErr.Error(), OperationID: operationID})
				return
			}
			m.eventLocked(mem, Event{Kind: EventSwitchover, OperationID: operationID,
				Detail: map[string]string{"successorMemberId": successorMemberID}})
		}
	})
}
