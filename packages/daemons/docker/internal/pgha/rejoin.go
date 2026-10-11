package pgha

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// RejoinNeeded: a stopped member that must not start before a rejoin: no
// data yet (seed) or a data directory a part-way rewind left behind (H3).
func (e *Engine) RejoinNeeded() bool {
	e.mu.Lock()
	needsRebuild := e.state.NeedsRebuild
	e.mu.Unlock()
	return needsRebuild || !e.pg.DataInitialized()
}

// Rejoin makes the stopped member a copy of the current primary again
// (M9): a seed or a pending rebuild runs pg_basebackup; otherwise a clean
// shutdown and pg_rewind, falling back to a rebuild when the rewind is
// impossible or failed part-way (that directory is never started).
func (e *Engine) Rejoin(ctx context.Context) error {
	e.mu.Lock()
	config := e.cfg.StandbyConfig()
	divergence, detail := e.standby.divergence, e.standby.divergenceDetail
	needsRebuild := e.state.NeedsRebuild
	e.mu.Unlock()
	switch {
	case !e.pg.DataInitialized():
		return e.rebuild(ctx, config, "seed")
	case needsRebuild:
		return e.rebuild(ctx, config, "a rewind failed part-way")
	case divergence == divergenceWALGone:
		return e.rebuild(ctx, config, "the primary removed the WAL this member needs: "+detail)
	}
	if err := e.cleanShutdown(ctx, config); err != nil {
		return err
	}
	// pg_rewind is not restartable: the directory is marked before the
	// rewind runs, so a daemon restart in the middle rebuilds it (H3). A dry
	// run that fails rewrote nothing and clears the mark again.
	e.mu.Lock()
	e.state.NeedsRebuild = true
	markErr := e.saveLocked()
	e.mu.Unlock()
	if markErr != nil {
		return markErr
	}
	result, err := e.pg.Rewind(ctx, config)
	switch {
	case err == nil && result.NeedsRebuild:
		e.mu.Lock()
		e.eventLocked(memberha.Event{Kind: EventRewindFailed, Reason: result.Detail})
		e.mu.Unlock()
		return e.rebuild(ctx, config, "rewind impossible: "+result.Detail)
	case err != nil && result.Started:
		// H3: the real pg_rewind began and failed part-way (source lost, disk
		// full, timeout): the directory mixes source and target pages. It
		// stays marked (a daemon restart rebuilds too) and is replaced, never
		// started.
		e.mu.Lock()
		e.eventLocked(memberha.Event{Kind: EventRewindFailed, Reason: "rewind failed part-way: " + err.Error()})
		e.mu.Unlock()
		return e.rebuild(ctx, config, "rewind failed part-way: "+err.Error())
	case err != nil:
		// Nothing was rewritten (the dry run failed).
		e.mu.Lock()
		e.state.NeedsRebuild = false
		saveErr := e.saveLocked()
		e.mu.Unlock()
		return errors.Join(fmt.Errorf("rewind: %w", err), saveErr)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.state.NeedsRebuild = false
	if !result.NotNeeded {
		e.state.DataEpoch++
	}
	if err := e.saveLocked(); err != nil {
		return err
	}
	e.standby.divergence, e.standby.divergenceDetail, e.standby.notStreamingSince = "", "", 0
	reason := "rewound"
	if result.NotNeeded {
		reason = "no rewind required"
	}
	e.eventLocked(memberha.Event{Kind: EventRewound, Reason: reason, Detail: map[string]string{
		"timeline": fmt.Sprint(result.Timeline), "divergedAt": result.DivergedAt.String(), "targetEnd": result.TargetEnd.String(),
		"divergedWalKeptAt": result.KeptAt}})
	return nil
}

// cleanShutdown leaves the data directory cleanly shut down, as pg_rewind
// requires: a killed primary cannot run single-user crash recovery with
// standby.signal present (M9), so it starts as a standby and stops fast.
func (e *Engine) cleanShutdown(ctx context.Context, config StandbyConfig) error {
	if err := e.pg.StopClean(ctx, 30*time.Second); err != nil {
		return err
	}
	state, err := e.pg.ShutdownState(ctx)
	if err != nil {
		return err
	}
	if cleanState(state) {
		return nil
	}
	if err := e.pg.PrepareStandby(ctx, config); err != nil {
		return err
	}
	if err := e.pg.Start(ctx); err != nil {
		return err
	}
	for attempt := 0; attempt < 120; attempt++ {
		status, statusErr := e.pg.Status(ctx)
		if statusErr == nil && status.Answering {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	if err := e.pg.StopClean(ctx, 30*time.Second); err != nil {
		return err
	}
	state, err = e.pg.ShutdownState(ctx)
	if err != nil {
		return err
	}
	if !cleanState(state) {
		return fmt.Errorf("the data directory is not cleanly shut down: %s", state)
	}
	return nil
}

func cleanState(state string) bool { return state == "shut down" || state == "shut down in recovery" }

// rebuild replaces the data directory with a pg_basebackup of the primary
// (the old one kept until the new one streams when the disk allows).
func (e *Engine) rebuild(ctx context.Context, config StandbyConfig, reason string) error {
	if err := e.pg.StopClean(ctx, 30*time.Second); err != nil {
		return err
	}
	result, err := e.pg.Rebuild(ctx, config)
	if err != nil {
		return fmt.Errorf("rebuild: %w", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.state.DataEpoch++
	e.state.NeedsRebuild = false
	e.state.RebuildKept = result.PreviousKept
	if err := e.saveLocked(); err != nil {
		return err
	}
	e.standby.divergence, e.standby.divergenceDetail, e.standby.notStreamingSince = "", "", 0
	e.eventLocked(memberha.Event{Kind: EventRebuilt, Reason: reason, Detail: map[string]string{
		"previousKept": fmt.Sprint(result.PreviousKept), "divergedWalKeptAt": result.DivergedWALKeptAt, "detail": result.Detail}})
	return nil
}

// CopyWork is the upkeep of a streaming copy: drop the data directory a
// rebuild kept once the new one streams, advance the members' slots.
func (e *Engine) CopyWork(status memberha.EngineStatus, now time.Duration) (string, func(context.Context) error, bool) {
	if !status.Streaming {
		return "", nil, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state.RebuildKept {
		return "commit_rebuild", func(ctx context.Context) error {
			if err := e.pg.CommitRebuild(ctx); err != nil {
				return err
			}
			e.mu.Lock()
			defer e.mu.Unlock()
			e.state.RebuildKept = false
			return e.saveLocked()
		}, true
	}
	if now-e.standby.slotsAt < slotsInterval {
		return "", nil, false
	}
	e.standby.slotsAt = now
	keep := slotNames(e.cfg.ActiveOthers())
	return "slots", func(ctx context.Context) error { return e.pg.SyncSlots(ctx, keep) }, true
}

// RequestRebuild marks a copy for a rebuild (an operator's explicit rebuild):
// the runtime stops it and rebuilds it from the primary; it is not eligible
// meanwhile. The primary is refused.
func (e *Engine) RequestRebuild() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.obs.status.Answering && !e.obs.status.InRecovery {
		return errors.New("the primary cannot be rebuilt; switch over first")
	}
	if e.state.NeedsRebuild {
		return nil
	}
	e.state.NeedsRebuild = true
	return e.saveLocked()
}
