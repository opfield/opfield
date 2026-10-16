package pgha

import (
	"context"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

func keptPrevious(h *harness) {
	h.engine.mu.Lock()
	h.engine.state.RebuildKept, h.engine.state.RebuildKeptAtUnix = true, h.clock.Wall().Unix()
	h.engine.mu.Unlock()
}

// A rebuilt copy that never streams keeps the previous data directory for a
// day, then drops it; before that it is kept.
func TestPreviousDataDirectoryIsDroppedAfterADayWithoutStreaming(t *testing.T) {
	h := newHarness(t)
	keptPrevious(h)
	h.clock.advance(previousKeptFor - time.Minute)
	if name, _, ok := h.engine.CopyWork(memberha.EngineStatus{}, h.clock.Now()); ok {
		t.Fatalf("a copy kept for less than a day must keep its previous directory, got work %q", name)
	}
	if !h.engine.State().RebuildKept {
		t.Fatal("the previous directory must stay kept")
	}
	h.clock.advance(2 * time.Minute)
	name, work, ok := h.engine.CopyWork(memberha.EngineStatus{}, h.clock.Now())
	if !ok || name != "commit_rebuild" {
		t.Fatalf("a copy kept for a day drops its previous directory, got %q %v", name, ok)
	}
	if err := work(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := h.engine.State(); state.RebuildKept || state.RebuildKeptAtUnix != 0 {
		t.Fatalf("state after the drop = %+v", state)
	}
	if len(filter(h.logSnapshot(), "pg:commit_rebuild")) != 1 {
		t.Fatal("the previous directory must be dropped once")
	}
}

// The serving primary does not need the directory its rebuild replaced.
func TestPrimaryDropsThePreviousDataDirectory(t *testing.T) {
	h := newHarness(t)
	keptPrevious(h)
	h.engine.mu.Lock()
	if identities := h.engine.cfg.Engine.Identities; identities != nil {
		h.engine.holder.identities = identities.Hash()
	}
	name, work, ok := h.engine.manualUpkeepLocked(h.clock.Now())
	h.engine.mu.Unlock()
	if !ok || name != "commit_rebuild" {
		t.Fatalf("the primary drops the previous directory first, got %q", name)
	}
	if err := work(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.engine.State().RebuildKept {
		t.Fatal("the previous directory is still marked kept")
	}
	h.engine.mu.Lock()
	name, _, _ = h.engine.manualUpkeepLocked(h.clock.Now())
	h.engine.mu.Unlock()
	if name == "commit_rebuild" {
		t.Fatal("nothing is left to drop")
	}
}

// A failed drop does not block the rest of the upkeep: it is tried again
// after commitRetry.
func TestFailedPreviousDropIsSpaced(t *testing.T) {
	h := newHarness(t)
	keptPrevious(h)
	h.engine.mu.Lock()
	defer h.engine.mu.Unlock()
	if identities := h.engine.cfg.Engine.Identities; identities != nil {
		h.engine.holder.identities = identities.Hash()
	}
	now := h.clock.Now()
	if name, _, _ := h.engine.manualUpkeepLocked(now); name != "commit_rebuild" {
		t.Fatalf("first attempt = %q", name)
	}
	if name, _, _ := h.engine.manualUpkeepLocked(now + time.Second); name == "commit_rebuild" {
		t.Fatal("a second attempt must wait")
	}
	if name, _, _ := h.engine.manualUpkeepLocked(now + commitRetry); name != "commit_rebuild" {
		t.Fatalf("attempt after the retry interval = %q", name)
	}
}

// A directory kept by an older release (no time) gets its day from now.
func TestLegacyKeptPreviousGetsAClock(t *testing.T) {
	h := newHarness(t)
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(h.config.SetID, State{RebuildKept: true, DataEpoch: 2}); err != nil {
		t.Fatal(err)
	}
	engine, err := New(h.config, h.pg, store, h.clock, nil)
	if err != nil {
		t.Fatal(err)
	}
	if state := engine.State(); !state.RebuildKept || state.RebuildKeptAtUnix != h.clock.Wall().Unix() {
		t.Fatalf("legacy state = %+v", state)
	}
	saved, err := store.Load(h.config.SetID)
	if err != nil || saved.RebuildKeptAtUnix != h.clock.Wall().Unix() {
		t.Fatalf("saved legacy state = %+v %v", saved, err)
	}
	engine.mu.Lock()
	expired := engine.previousExpiredLocked()
	engine.mu.Unlock()
	if expired {
		t.Fatal("a legacy kept directory is not expired at once")
	}
}
