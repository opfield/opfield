package pgha

import (
	"context"
	"errors"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

var errNotObserved = errors.New("the member has not been observed yet")

// BootstrapValue is the first certified value, from the named bootstrap
// holder (the origin, running as the single-node primary it was).
func (e *Engine) BootstrapValue(memberha.EngineStatus) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := e.obs.status
	if !st.Answering {
		return nil, errNotObserved
	}
	parent, switchLSN := parentOf(e.obs.history)
	value := Value{Timeline: st.Timeline, ParentTimeline: parent, SwitchLSN: switchLSN, Durability: e.cfg.Durability, SystemID: st.SystemID}
	if value.Synchronous() {
		value.Degraded = len(e.cfg.ActiveOthers()) > 0
	} else {
		value.ProgressFloor = maxLSN(st.FlushLSN, st.Position())
	}
	// The bootstrap holder holds its own data (AS6).
	if e.state.HeldDataEpoch != e.state.DataEpoch {
		e.state.HeldDataEpoch = e.state.DataEpoch
		if err := e.saveLocked(); err != nil {
			return nil, err
		}
	}
	return value.Encode()
}

// requiredSync is certified ∪ pending SyncSet without this member.
func (e *Engine) requiredSync(certified Value, pending []byte) []string {
	set := append([]string(nil), certified.SyncSet...)
	if len(pending) > 0 {
		if value, err := DecodeValue(pending); err == nil {
			set = append(set, value.SyncSet...)
		}
	}
	return without(set, e.cfg.MemberID)
}

// Promote makes the holder's copy the primary (no pending transition), or a
// manual pair's assigned copy (no certified value).
func (e *Engine) Promote(ctx context.Context, certified []byte) error {
	return e.PromoteWithPending(ctx, certified, nil)
}

// PromoteWithPending promotes the holder's Postgres: synchronous names to
// what the certified and pending states require first (M4: ” for an
// acquirer whose inherited set is only itself), then pg_promote, then
// standby.signal at once and the slots of the other members.
func (e *Engine) PromoteWithPending(ctx context.Context, certified, pending []byte) error {
	if len(certified) == 0 {
		// A manual pair's assigned primary.
		return e.manualPromote(ctx)
	}
	value, err := DecodeValue(certified)
	if err != nil {
		return err
	}
	e.mu.Lock()
	setID := e.cfg.SetID
	names := e.requiredSync(value, pending)
	others := slotNames(e.cfg.ActiveOthers())
	if e.state.HeldDataEpoch != e.state.DataEpoch {
		// This member took the primary role with its data as it is now (AS6).
		e.state.HeldDataEpoch = e.state.DataEpoch
		if err := e.saveLocked(); err != nil {
			e.mu.Unlock()
			return err
		}
	}
	e.mu.Unlock()
	if err := e.pg.SetSyncNames(ctx, syncNames(names)); err != nil {
		return err
	}
	if err := e.pg.Promote(ctx); err != nil {
		return err
	}
	if err := e.pg.MarkStandbyAtRest(ctx); err != nil {
		return err
	}
	if err := e.pg.SyncSlots(ctx, others); err != nil {
		e.logger.Warn("could not reset replication slots after promotion", "set_id", setID, "error", err)
	}
	e.mu.Lock()
	e.sync.names, e.sync.namesKnown = names, true
	e.holder.identities = ""
	e.holder.degraded = nil
	e.mu.Unlock()
	return nil
}

// PromotedValue certifies the promoted holder's timeline (M3) before it
// serves; the holder leaves the SyncSet and a switchover marker ends.
func (e *Engine) PromotedValue(certified []byte, _ memberha.EngineStatus) ([]byte, error) {
	value, err := DecodeValue(certified)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	st := e.obs.status
	if !st.Answering || st.InRecovery {
		return nil, errors.New("the promoted primary has not been observed yet")
	}
	if !e.obs.historyOK && st.Timeline > 1 {
		return nil, errors.New("the promoted primary's timeline history is not known yet")
	}
	parent, switchLSN := parentOf(e.obs.history)
	next := value.Clone()
	next.Timeline, next.ParentTimeline, next.SwitchLSN = st.Timeline, parent, switchLSN
	next.SyncSet = without(value.SyncSet, e.cfg.MemberID)
	next.Final = nil
	if next.SystemID == "" {
		next.SystemID = st.SystemID
	}
	if next.Synchronous() {
		next.Degraded = len(next.SyncSet) == 0 && len(e.cfg.ActiveOthers()) > 0
	} else {
		next.ProgressFloor = maxLSN(value.ProgressFloor, st.FlushLSN)
	}
	if next.Forced != nil && !next.Forced.Promoted {
		// The forced acquisition's record names the timeline it promoted to
		// and where it forked off.
		next.Forced.Timeline, next.Forced.ForkLSN, next.Forced.Promoted = st.Timeline, switchLSN, true
	}
	return next.Encode()
}

// CertifiedCurrent: the certified timeline is the one the primary writes.
func (e *Engine) CertifiedCurrent(certified []byte, status memberha.EngineStatus) bool {
	if !status.Writable {
		return true
	}
	value, err := DecodeValue(certified)
	if err != nil {
		return true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.obs.status.Timeline == 0 || e.obs.status.Timeline == value.Timeline
}

// ReleaseTarget names a member the holder's latest replication sample shows
// eligible under the certified value, best first; none while the disk is
// full (it would repeat on the successor).
func (e *Engine) ReleaseTarget(certified []byte) (string, bool) {
	value, err := DecodeValue(certified)
	if err != nil {
		return "", false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.clock.Now()
	h := &e.holder
	if e.diskFullLocked(now) || h.lastPeersAt == 0 || now-h.lastPeersAt > successorEvidenceAge {
		return "", false
	}
	flush := e.obs.status.FlushLSN
	for _, peer := range e.cfg.ActiveOthers() {
		row, ok := findPeer(h.lastPeers, peer)
		if !ok || row.State != "streaming" {
			continue
		}
		if value.Synchronous() {
			if value.InSyncSet(peer.MemberID) && row.FlushLSN >= value.EligibilityFloor {
				return peer.MemberID, true
			}
			continue
		}
		if row.FlushLSN+e.cfg.MaxLag() >= maxLSN(value.ProgressFloor, flush) {
			return peer.MemberID, true
		}
	}
	return "", false
}

// ForcedValue is the value a forced promotion certifies (AS10): the member's
// timeline and fork position, the forced record, the durability's floors.
func (e *Engine) ForcedValue(operationID string, _ memberha.EngineStatus) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	st := e.obs.status
	if !st.Answering || !st.InRecovery {
		return nil, errors.New("this member does not run as a copy")
	}
	if e.state.NeedsRebuild {
		return nil, errors.New("this member's data directory must be rebuilt")
	}
	parent, switchLSN := parentOf(e.obs.history)
	fork := st.Position()
	value := Value{
		Timeline: st.Timeline, ParentTimeline: parent, SwitchLSN: switchLSN, Durability: e.cfg.Durability,
		Forced: &Forced{Operation: operationID, Timeline: st.Timeline, ForkLSN: fork, AtUnixMs: e.clock.Wall().UnixMilli()},
	}
	if value.Synchronous() {
		value.Degraded = len(e.cfg.ActiveOthers()) > 0
	} else {
		value.ProgressFloor = fork
	}
	return value.Encode()
}
