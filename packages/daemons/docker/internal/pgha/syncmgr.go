package pgha

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Sync manager of the promoted holder (synchronous durability, AS4, AS5, M5;
// asynchronous progress floor, AS7). Engine work (names, barrier, slots,
// principals) runs in HolderWork; certified changes are NextValue proposals,
// one at a time.
//
// Invariant: synchronous_standby_names requires an acknowledgement from every
// member of the SyncSet of the certified state AND of any proposed but
// unresolved state (names ⊇ certified ∪ pending). HolderWork restores it
// before anything else, also right after a promotion or a daemon restart.
//
//   - Add X: names ∪= {X}, the walsender of X runs with the new names
//     (sync_state sync or quorum), CHECKPOINT barrier, sample L = flush, wait
//     until X's flush ≥ L (matched by application_name and usename), then
//     certify SyncSet ∪ {X}.
//   - Switch B→C: names = FIRST 2 ("B","C"), barrier and catch-up for C,
//     certify {C}, then names = FIRST 1 ("C").
//   - Drop B (stall): certify SyncSet \ {B} first; only once certified clear
//     B from the names.
//   - Stall = the oldest SyncRep waiter is older than syncDegradeAfter, or a
//     member's flush does not advance while its sent position does (M5),
//     never connectivity alone.
//   - Cancelled or terminated waits certify the eligibility floor = current
//     flush (AS4).

const (
	addTimeoutMin = 30 * time.Second
	dropCooldown  = 15 * time.Second
	floorInterval = time.Second
)

type addPhase int

const (
	addNames addPhase = iota
	addBarrier
	addCatchup
	addCertify
)

type syncRuntime struct {
	names      []string
	namesKnown bool
	adding     *syncAdd
	cooldown   map[string]time.Duration
	flush      map[string]flushSample
	// want asks for a specific sync member (switchover successor).
	want string
}

type syncAdd struct {
	member    string
	goal      []string
	phase     addPhase
	barrier   LSN
	startedAt time.Duration
}

type flushSample struct {
	flush LSN
	sent  LSN
	since time.Duration
}

// Event kinds of the Postgres engine (next to the runtime's).
const (
	EventSyncDegraded  = "sync_degraded"
	EventSyncRestored  = "sync_restored"
	EventSyncMember    = "sync_member_changed"
	EventCancelledWait = "cancelled_wait"
	EventRewound       = "rewound"
	EventRebuilt       = "rebuilt"
	EventRewindFailed  = "rewind_failed"
)

// syncNames renders synchronous_standby_names requiring every member.
func syncNames(members []string) string {
	members = normalizeSet(members)
	if len(members) == 0 {
		return ""
	}
	quoted := make([]string, len(members))
	for i, member := range members {
		quoted[i] = `"` + strings.ReplaceAll(member, `"`, `""`) + `"`
	}
	return fmt.Sprintf("FIRST %d (%s)", len(members), strings.Join(quoted, ", "))
}

func isSuperset(have, want []string) bool {
	for _, item := range want {
		if !slices.Contains(have, item) {
			return false
		}
	}
	return true
}

// desiredNamesLocked is what the names must be now: certified ∪ pending,
// plus a member being added.
func (e *Engine) desiredNamesLocked(value Value, pending []byte) []string {
	desired := e.requiredSync(value, pending)
	if e.sync.adding != nil {
		desired = normalizeSet(append(desired, e.sync.adding.member))
	}
	return desired
}

// HolderWork is the engine work of the promoted, serving holder: the names
// invariant first, then principals, slot upkeep and an addition's barrier.
func (e *Engine) HolderWork(view memberha.HolderView) (string, func(context.Context) error, bool) {
	if len(view.Certified) == 0 {
		// A manual pair's primary: nothing is certified.
		return e.manualHolderWork(view)
	}
	value, err := DecodeValue(view.Certified)
	if err != nil {
		return "", nil, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := view.Now
	e.addTimeoutLocked(now)
	desired := e.desiredNamesLocked(value, view.Pending)
	if !e.sync.namesKnown || !slices.Equal(normalizeSet(e.sync.names), desired) {
		names := syncNames(desired)
		return "sync_names", func(ctx context.Context) error {
			err := e.pg.SetSyncNames(ctx, names)
			e.mu.Lock()
			defer e.mu.Unlock()
			if err != nil {
				e.sync.namesKnown = false
				return fmt.Errorf("set synchronous_standby_names: %w", err)
			}
			e.sync.names, e.sync.namesKnown = desired, true
			return nil
		}, true
	}
	e.trackDegradedLocked(value)
	if identities := e.cfg.Engine.Identities; identities != nil && identities.Hash() != e.holder.identities {
		copied, hash := *identities, identities.Hash()
		return "principals", func(ctx context.Context) error {
			if err := e.pg.EnsureIdentities(ctx, copied); err != nil {
				return fmt.Errorf("converge the replication principals: %w", err)
			}
			e.mu.Lock()
			e.holder.identities = hash
			e.mu.Unlock()
			return nil
		}, true
	}
	if now-e.holder.slotsAt >= slotsInterval {
		// Slots of members added since the promotion, and none of removed
		// ones (their WAL retention ends).
		e.holder.slotsAt = now
		keep := slotNames(e.cfg.ActiveOthers())
		return "slots", func(ctx context.Context) error { return e.pg.SyncSlots(ctx, keep) }, true
	}
	add := e.sync.adding
	if add == nil {
		return "", nil, false
	}
	if add.phase == addNames {
		// The names that include the member are applied (checked above).
		add.phase = addBarrier
	}
	if add.phase != addBarrier {
		return "", nil, false
	}
	peer, _ := e.cfg.Peer(add.member)
	return "sync_barrier", func(ctx context.Context) error {
		// L2: the barrier counts only once the member's walsender runs with
		// the names that include it (a reload reaches walsenders
		// asynchronously): Postgres reports it sync or quorum only then.
		rows, err := e.pg.Replication(ctx)
		if err != nil {
			return err
		}
		row, found := findPeer(rows, peer)
		if !found || (row.SyncState != "sync" && row.SyncState != "quorum") {
			return nil
		}
		if err := e.pg.Checkpoint(ctx); err != nil {
			return err
		}
		lsn, err := e.pg.CurrentFlushLSN(ctx)
		if err != nil {
			return err
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.sync.adding == add {
			add.barrier, add.phase = lsn, addCatchup
		}
		return nil
	}, true
}

func (e *Engine) addTimeoutLocked(now time.Duration) {
	add := e.sync.adding
	if add == nil || add.phase == addCertify {
		return
	}
	if now-add.startedAt > max(3*e.cfg.SyncDegradeAfter(), addTimeoutMin) {
		e.logger.Warn("sync member did not catch up in time; abandoning its addition", "set_id", e.cfg.SetID, "member_id", add.member)
		e.sync.adding = nil
		e.coolDownLocked(add.member, now)
	}
}

func (e *Engine) coolDownLocked(member string, now time.Duration) {
	if e.sync.cooldown == nil {
		e.sync.cooldown = map[string]time.Duration{}
	}
	e.sync.cooldown[member] = now + dropCooldown
}

// NextValue is the holder's next certified change, one at a time (it runs
// only while no transition is in flight).
func (e *Engine) NextValue(certified []byte, _ memberha.EngineStatus, now time.Duration) ([]byte, string, bool, error) {
	value, err := DecodeValue(certified)
	if err != nil {
		return nil, "", false, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	next, kind, ok := e.nextValueLocked(value, now)
	if !ok {
		return nil, "", false, nil
	}
	data, err := next.Encode()
	if err != nil {
		return nil, "", false, err
	}
	if kind == "sync_add" {
		e.sync.adding.phase = addCertify
	}
	return data, kind, true, nil
}

func (e *Engine) nextValueLocked(value Value, now time.Duration) (Value, string, bool) {
	s := &e.sync
	self := e.cfg.MemberID
	if add := s.adding; add != nil && add.phase == addCertify {
		// Certified (or refused): the goal is in the value or the add retries.
		if isSuperset(value.SyncSet, add.goal) && isSuperset(add.goal, without(value.SyncSet, self)) {
			e.eventLocked(memberha.Event{Kind: EventSyncMember, Detail: map[string]string{"syncSet": strings.Join(value.SyncSet, ",")}})
		}
		s.adding = nil
		return Value{}, "", false
	}
	desired := e.desiredNamesLocked(value, nil)
	if !s.namesKnown || !slices.Equal(normalizeSet(s.names), desired) {
		// HolderWork restores the names first.
		return Value{}, "", false
	}
	others := len(e.cfg.ActiveOthers()) > 0
	if value.Synchronous() {
		if culprit := e.stallLocked(desired, now); culprit != "" {
			if s.adding != nil && s.adding.member == culprit {
				e.logger.Warn("sync member candidate stalls commits; abandoning its addition", "set_id", e.cfg.SetID, "member_id", culprit)
				s.adding = nil
				e.coolDownLocked(culprit, now)
				return Value{}, "", false
			}
			if value.InSyncSet(culprit) {
				next := value.WithSyncSet(without(value.SyncSet, culprit))
				next.Degraded = len(next.SyncSet) == 0 && others
				e.logger.Warn("sync member stalls commits; certifying the reduced sync set before releasing them",
					"set_id", e.cfg.SetID, "member_id", culprit)
				e.coolDownLocked(culprit, now)
				return next, "sync_drop", true
			}
		}
	}
	st := e.obs.status
	if e.holder.cancelledWaits > 0 {
		waits := e.holder.cancelledWaits
		e.holder.cancelledWaits = 0
		if value.Synchronous() && st.FlushLSN > value.EligibilityFloor {
			next := value.Clone()
			next.EligibilityFloor = st.FlushLSN
			e.eventLocked(memberha.Event{Kind: EventCancelledWait, Reason: fmt.Sprintf("%d synchronous commit waits were cancelled or terminated", waits),
				Detail: map[string]string{"floor": next.EligibilityFloor.String()}})
			return next, "floor", true
		}
	}
	if e.cfg.Durability != value.Durability {
		next := value.Clone()
		next.Durability = e.cfg.Durability
		next.SyncSet = nil
		if next.Synchronous() {
			next.Degraded = others
			next.EligibilityFloor = maxLSN(value.EligibilityFloor, st.FlushLSN)
		} else {
			next.Degraded = false
			next.ProgressFloor = maxLSN(value.ProgressFloor, st.FlushLSN)
		}
		return next, "durability", true
	}
	// Members no longer active leave the SyncSet (certified first).
	for _, member := range value.SyncSet {
		if peer, ok := e.cfg.Peer(member); !ok || peer.Removing {
			next := value.WithSyncSet(without(value.SyncSet, member))
			next.Degraded = value.Synchronous() && len(next.SyncSet) == 0 && others
			return next, "sync_remove", true
		}
	}
	if !value.Synchronous() {
		return e.asyncStepLocked(value, now)
	}
	return e.syncMemberStepLocked(value, now)
}

// asyncStepLocked certifies the coarse progress floor (AS7): when the
// primary's flush advanced by at least maxLag/4, at most once a second (M2).
func (e *Engine) asyncStepLocked(value Value, now time.Duration) (Value, string, bool) {
	if len(value.SyncSet) > 0 || value.Degraded {
		next := value.WithSyncSet(nil)
		next.Degraded = false
		return next, "sync_clear", true
	}
	flush := e.obs.status.FlushLSN
	if flush <= value.ProgressFloor || flush-value.ProgressFloor < asyncFloorStep(e.cfg) || now-e.holder.lastPFAt < floorInterval {
		return Value{}, "", false
	}
	next := value.Clone()
	next.ProgressFloor = flush
	e.holder.lastPFAt = now
	return next, "progress", true
}

// syncMemberStepLocked keeps exactly one certified sync member when one
// streams: add, switch to the wanted member, or reduce a leftover pair.
func (e *Engine) syncMemberStepLocked(value Value, now time.Duration) (Value, string, bool) {
	s := &e.sync
	if add := s.adding; add != nil {
		if add.phase != addCatchup {
			return Value{}, "", false
		}
		peer, _ := e.cfg.Peer(add.member)
		row, ok := findPeer(e.obs.peers, peer)
		if !ok || row.FlushLSN < add.barrier {
			return Value{}, "", false
		}
		next := value.WithSyncSet(add.goal)
		next.Degraded = false
		return next, "sync_add", true
	}
	current := without(value.SyncSet, e.cfg.MemberID)
	if s.want != "" {
		if !slices.Equal(current, []string{s.want}) && e.streamingLocked(s.want) {
			e.startAddLocked(s.want, []string{s.want}, now)
		}
		return Value{}, "", false
	}
	switch {
	case len(current) == 0:
		if best := e.bestCandidateLocked(now); best != "" {
			e.startAddLocked(best, []string{best}, now)
		}
	case len(current) > 1:
		keep := current[0]
		for _, peer := range e.cfg.ActiveOthers() {
			if slices.Contains(current, peer.MemberID) {
				keep = peer.MemberID
				break
			}
		}
		return value.WithSyncSet([]string{keep}), "sync_reduce", true
	}
	return Value{}, "", false
}

func (e *Engine) streamingLocked(memberID string) bool {
	peer, ok := e.cfg.Peer(memberID)
	if !ok || peer.Removing {
		return false
	}
	row, found := findPeer(e.obs.peers, peer)
	return found && row.State == "streaming" && row.ReplyAge <= staleReplyAge
}

// bestCandidateLocked returns the preferred streaming member not cooling down.
func (e *Engine) bestCandidateLocked(now time.Duration) string {
	for _, peer := range e.cfg.ActiveOthers() {
		if until, ok := e.sync.cooldown[peer.MemberID]; ok && now < until {
			continue
		}
		if e.streamingLocked(peer.MemberID) {
			return peer.MemberID
		}
	}
	return ""
}

func (e *Engine) startAddLocked(member string, goal []string, now time.Duration) {
	e.sync.adding = &syncAdd{member: member, goal: normalizeSet(goal), phase: addNames, startedAt: now}
	e.logger.Info("adding a sync member", "set_id", e.cfg.SetID, "member_id", member)
}

// stallLocked returns the member that stalls commits, or "".
func (e *Engine) stallLocked(names []string, now time.Duration) string {
	obs := e.obs
	s := &e.sync
	degradeAfter := e.cfg.SyncDegradeAfter()
	if s.flush == nil {
		s.flush = map[string]flushSample{}
	}
	stalledFlush := ""
	for _, member := range names {
		peer, ok := e.cfg.Peer(member)
		if !ok {
			continue
		}
		row, found := findPeer(obs.peers, peer)
		if !found {
			delete(s.flush, member)
			continue
		}
		sample, seen := s.flush[member]
		if !seen || row.FlushLSN != sample.flush || row.SentLSN == sample.sent {
			s.flush[member] = flushSample{flush: row.FlushLSN, sent: row.SentLSN, since: now}
			continue
		}
		s.flush[member] = flushSample{flush: sample.flush, sent: row.SentLSN, since: sample.since}
		if now-sample.since >= degradeAfter {
			stalledFlush = member
		}
	}
	if !obs.waitersOK || obs.waiters.Count == 0 {
		return ""
	}
	if obs.waiters.OldestAge < degradeAfter && stalledFlush == "" {
		return ""
	}
	if stalledFlush != "" {
		return stalledFlush
	}
	// The culprit: a named member that does not stream, else the one with the
	// lowest flush.
	culprit, lowest := "", LSN(0)
	for _, member := range names {
		peer, ok := e.cfg.Peer(member)
		if !ok {
			return member
		}
		row, found := findPeer(obs.peers, peer)
		if !found || row.State != "streaming" {
			return member
		}
		if culprit == "" || row.FlushLSN < lowest {
			culprit, lowest = member, row.FlushLSN
		}
	}
	return culprit
}

// trackDegradedLocked reports degrade and restore of the certified state.
func (e *Engine) trackDegradedLocked(value Value) {
	degraded := value.Synchronous() && value.Degraded
	previous := e.holder.degraded
	if previous != nil && *previous == degraded {
		return
	}
	e.holder.degraded = &degraded
	if previous == nil {
		// The first certified state of this holding period: the promotion
		// event and the report carry it.
		return
	}
	if degraded {
		e.eventLocked(memberha.Event{Kind: EventSyncDegraded, Reason: "no member acknowledges commits synchronously"})
	} else {
		e.eventLocked(memberha.Event{Kind: EventSyncRestored, Detail: map[string]string{"syncSet": strings.Join(value.SyncSet, ",")}})
	}
}
