package pgha

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Planned switchover (AS11). The runtime stages it: PrepareSwitchover names
// the successor and the sync manager makes it the certified sync member
// (synchronous durability); once SwitchoverReady holds, the runtime closes
// serving and calls Switchover (clients end, a checkpoint, the final LSN, the
// successor replays it), then stops Postgres cleanly, writes standby at rest
// and releases to the successor, which is eligible as the certified sync
// member (or within the asynchronous bound) and caught up to the final LSN.
// If the successor does not catch up in time, Switchover fails before the
// stop: the primary serves again on the next step.

// switchoverCatchupTimeout bounds the wait for the successor's replay.
var switchoverCatchupTimeout = 60 * time.Second

// switchoverPoll is how often the successor's replay position is read.
var switchoverPoll = 200 * time.Millisecond

// PrepareSwitchover names the successor ("" cancels).
func (e *Engine) PrepareSwitchover(successorMemberID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sync.want = successorMemberID
	if successorMemberID == "" && e.sync.adding != nil && e.sync.adding.phase != addCertify {
		e.sync.adding = nil
	}
}

// SwitchoverReady: asynchronous durability at once; synchronous once the
// successor is the only certified sync member and the names require exactly
// it.
func (e *Engine) SwitchoverReady(certified []byte, successorMemberID string) bool {
	value, err := DecodeValue(certified)
	if err != nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !value.Synchronous() {
		return true
	}
	certifiedSet := without(value.SyncSet, e.cfg.MemberID)
	return slices.Equal(certifiedSet, []string{successorMemberID}) && e.sync.namesKnown &&
		slices.Equal(normalizeSet(e.sync.names), []string{successorMemberID})
}

// Switchover ends the clients, measures the final LSN after a checkpoint and
// waits until the successor replayed it; serving is closed already.
func (e *Engine) Switchover(ctx context.Context, successorMemberID string) error {
	e.mu.Lock()
	successor, ok := e.cfg.Peer(successorMemberID)
	e.mu.Unlock()
	if !ok {
		return errors.New("the successor is no member of the set")
	}
	defer e.PrepareSwitchover("")
	if err := e.pg.TerminateClients(ctx); err != nil {
		return fmt.Errorf("end the clients: %w", err)
	}
	if err := e.pg.Checkpoint(ctx); err != nil {
		return fmt.Errorf("checkpoint: %w", err)
	}
	final, err := e.pg.CurrentFlushLSN(ctx)
	if err != nil {
		return fmt.Errorf("read the final LSN: %w", err)
	}
	deadline := time.Now().Add(switchoverCatchupTimeout)
	for {
		rows, err := e.pg.Replication(ctx)
		if err == nil {
			if row, found := findPeer(rows, successor); found && row.ReplayLSN >= final {
				e.logger.Info("switchover successor caught up", "set_id", e.cfg.SetID, "successor", successorMemberID, "final_lsn", final.String())
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the successor did not replay the final LSN %s in time", final)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(switchoverPoll):
		}
	}
}
