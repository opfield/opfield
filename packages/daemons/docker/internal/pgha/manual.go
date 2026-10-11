package pgha

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Manual pairs (decision 6): no lease, no certified value. The assigned
// primary keeps synchronous_standby_names on its peer while the peer confirms
// (synchronous durability) and relaxes it once the peer stalls commits for
// syncDegradeAfter, so writes continue (a lossy "Make this copy primary"
// states the window). A copy that is assigned the primary first waits until
// the old primary stopped streaming to it (a stepping-down primary stops
// cleanly and sends its last WAL), bounded by manualPromoteWait, then
// promotes.

// manualPromoteWait bounds how long an assigned copy waits for the old
// primary's stream to end before it promotes.
var manualPromoteWait = 60 * time.Second

// manualPoll is how often the wait reads the walreceiver.
var manualPoll = 250 * time.Millisecond

// manualHolderWork keeps the manual primary's names.
func (e *Engine) manualHolderWork(view memberha.HolderView) (string, func(context.Context) error, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := view.Now
	var desired []string
	if e.cfg.Durability == DurabilitySynchronous {
		for _, peer := range e.cfg.ActiveOthers() {
			if until, cooling := e.sync.cooldown[peer.MemberID]; cooling && now < until {
				continue
			}
			if e.streamingLocked(peer.MemberID) {
				desired = []string{peer.MemberID}
				break
			}
		}
		if len(desired) > 0 && e.namesKnownEqual(desired) {
			if culprit := e.stallLocked(desired, now); culprit != "" {
				// The peer stalls commits: release them (manual pairs certify
				// nothing; the lossy switch reports the window).
				e.coolDownLocked(culprit, now)
				desired = nil
				e.eventLocked(memberha.Event{Kind: EventSyncDegraded, Reason: "the copy stopped confirming commits"})
			}
		}
	}
	if e.namesKnownEqual(desired) {
		return "", nil, false
	}
	names := syncNames(desired)
	return "sync_names", func(ctx context.Context) error {
		err := e.pg.SetSyncNames(ctx, names)
		e.mu.Lock()
		defer e.mu.Unlock()
		if err != nil {
			e.sync.namesKnown = false
			return fmt.Errorf("set synchronous_standby_names: %w", err)
		}
		e.sync.names, e.sync.namesKnown = normalizeSet(desired), true
		return nil
	}, true
}

func (e *Engine) namesKnownEqual(desired []string) bool {
	return e.sync.namesKnown && slices.Equal(normalizeSet(e.sync.names), normalizeSet(desired))
}

// manualPromote promotes the assigned copy of a manual pair once the old
// primary's stream ended (or the wait ran out: the old primary is gone).
func (e *Engine) manualPromote(ctx context.Context) error {
	deadline := time.Now().Add(manualPromoteWait)
	for time.Now().Before(deadline) {
		status, err := e.pg.Status(ctx)
		if err == nil && status.Answering && status.InRecovery && status.ReceiverStatus != "streaming" {
			break
		}
		if err == nil && status.Answering && !status.InRecovery {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(manualPoll):
		}
	}
	if err := e.pg.SetSyncNames(ctx, ""); err != nil {
		return err
	}
	if err := e.pg.Promote(ctx); err != nil {
		return err
	}
	if err := e.pg.MarkStandbyAtRest(ctx); err != nil {
		return err
	}
	e.mu.Lock()
	e.sync.names, e.sync.namesKnown = nil, true
	others := slotNames(e.cfg.ActiveOthers())
	e.mu.Unlock()
	if err := e.pg.SyncSlots(ctx, others); err != nil {
		e.logger.Warn("could not reset replication slots after promotion", "set_id", e.cfg.SetID, "error", err)
	}
	return nil
}
