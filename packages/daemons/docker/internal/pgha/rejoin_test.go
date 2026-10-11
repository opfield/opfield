package pgha

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const divergedLine = "LOG:  new timeline 3 forked off current database system timeline 2 before current recovery point 0/4200000"

// primaryElsewhere: another member holds (a verified commit names it), so a
// rejoin has a source.
func (h *harness) primaryElsewhere() {
	h.lease.mu.Lock()
	h.lease.observed = &CertifiedState{State: HolderState{Holder: nodeB}}
	h.lease.mu.Unlock()
}

// divergedStandby is a returning old primary: running as a standby that the
// primary's walreceiver refuses, with another member holding.
func divergedStandby(h *harness, line string) {
	h.pg.set(func(p *fakePG) { p.receiver = "" })
	h.primaryElsewhere()
	h.pg.logLine(line)
}

func filter(log []string, prefix string) []string {
	var out []string
	for _, entry := range log {
		if strings.HasPrefix(entry, prefix) {
			out = append(out, entry)
		}
	}
	return out
}

// M9: rejoin stops cleanly, runs pg_rewind (which copies the diverged WAL
// aside), writes standby at rest, starts, bumps the data epoch (AS6: no
// previous-holder eligibility after a rewind), reports the discarded range.
func TestRejoinRewindsDivergedMember(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.rewind = RewindResult{DivergedAt: MustLSN("0/4000000"), TargetEnd: MustLSN("0/4200000"), Timeline: 2, KeptAt: "/data/gateway-ha/diverged/1"}
	})
	divergedStandby(h, `FATAL:  could not start WAL streaming: ERROR:  requested starting point 0/4200000 on timeline 2 is not in this server's history`)
	h.settle()
	h.requireOrder("pg:stop_clean", "pg:rewind", "pg:prepare_standby", "pg:start:recovery=true")
	events := h.events(EventRewound)
	if len(events) != 1 || events[0].Detail["divergedAt"] != "0/4000000" || events[0].Detail["targetEnd"] != "0/4200000" || events[0].Detail["divergedWalKeptAt"] == "" {
		t.Fatalf("rewind events = %+v", events)
	}
	if state := h.engine.State(); state.DataEpoch != 1 || state.NeedsRebuild {
		t.Fatalf("data epoch not bumped after a rewind: %+v", state)
	}
	if len(h.events(memberha.EventRejoined)) != 1 {
		t.Fatal("expected the runtime's rejoined event")
	}
	h.pg.requireNoViolations(t)
}

// M9: a killed primary cannot be rewound directly: it starts as a standby,
// stops fast, then rewinds.
func TestRejoinStartsKilledPrimaryAsStandbyBeforeRewind(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.stopUncleanOnce = true })
	divergedStandby(h, divergedLine)
	h.settle()
	h.requireOrder("pg:stop_clean", "pg:prepare_standby", "pg:start:recovery=true", "pg:stop_clean", "pg:rewind")
	h.pg.requireNoViolations(t)
}

// No rejoin without evidence of divergence or without a primary to rejoin.
func TestNoRejoinWithoutPrimaryOrEvidence(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.receiver = "" })
	h.pg.logLine(`FATAL:  could not connect to the primary server: connection refused`)
	h.primaryElsewhere()
	h.run(20, time.Second)
	h.requireNo("pg:rewind")
	h2 := newHarness(t)
	h2.pg.set(func(p *fakePG) { p.receiver = "" })
	h2.pg.logLine(`FATAL:  requested timeline 3 is not a child of this server's history`)
	h2.run(20, time.Second)
	h2.requireNo("pg:rewind")
}

// When the WAL a standby needs is gone it is rebuilt with a base backup into
// a fresh directory; the kept previous directory is dropped only once the
// new one streams.
func TestRebuildWhenWALIsGone(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.rebuild = RebuildResult{PreviousKept: true}; p.startReceiver = "" })
	divergedStandby(h, `FATAL:  could not receive data from WAL stream: ERROR:  requested WAL segment 000000020000000000000004 has already been removed`)
	h.run(12, time.Second)
	h.requireOrder("pg:stop_clean", "pg:rebuild", "pg:start:recovery=true")
	h.requireNo("pg:commit_rebuild")
	h.pg.set(func(p *fakePG) { p.receiver = "streaming" })
	h.settle()
	h.requireOrder("pg:rebuild", "pg:commit_rebuild")
	if state := h.engine.State(); state.RebuildKept || state.DataEpoch != 1 {
		t.Fatalf("rebuild state = %+v", state)
	}
	if len(h.events(EventRebuilt)) != 1 {
		t.Fatalf("expected a rebuild event")
	}
}

// A rewind that is impossible falls back to a rebuild.
func TestImpossibleRewindRebuilds(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.rewind = RewindResult{NeedsRebuild: true, Detail: "could not find previous WAL record"}
	})
	divergedStandby(h, divergedLine)
	h.settle()
	h.requireOrder("pg:rewind", "pg:rebuild", "pg:start:recovery=true")
	if len(h.events(EventRewindFailed)) != 1 || len(h.events(EventRebuilt)) != 1 {
		t.Fatalf("expected rewind_failed and rebuild events")
	}
}

// pg_rewind is not restartable: a daemon restart during a rewind rebuilds
// (the mark was persisted before the rewind ran).
func TestInterruptedRewindRebuildsAfterRestart(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.running = false })
	if err := h.pgStore.Save(setID, State{NeedsRebuild: true}); err != nil {
		t.Fatal(err)
	}
	h.manager = h.newManager()
	h.primaryElsewhere()
	h.settle()
	h.requireOrder("pg:rebuild", "pg:start:recovery=true")
	h.requireNo("pg:rewind")
	h.pg.requireNoViolations(t)
}

// A failed rewind (its dry run: nothing rewritten) backs off and retries;
// nothing starts writable.
func TestRewindFailureBacksOff(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.rewindErr = errors.New("connection to the primary failed")
		p.startReceiver = ""
	})
	divergedStandby(h, divergedLine)
	h.run(14, time.Second)
	if first := len(filter(h.logSnapshot(), "pg:rewind")); first != 1 {
		t.Fatalf("rewinds within the first backoff = %d", first)
	}
	if h.engine.State().NeedsRebuild {
		t.Fatal("a failed dry run rewrote nothing and must not force a rebuild")
	}
	h.pg.logLine(divergedLine)
	h.run(40, time.Second)
	if n := len(filter(h.logSnapshot(), "pg:rewind")); n < 2 || n > 4 {
		t.Fatalf("rewind retries = %d", n)
	}
	h.pg.requireNoViolations(t)
}

// H3: a real pg_rewind that fails after it began rewriting the directory
// leaves a directory that is part source, part target. It is rebuilt and
// never started (the fake flags any start of such a directory).
func TestPartialRewindFailureRebuildsWithoutStarting(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.rewindPartErr = errors.New("could not fetch remote file: connection to server was lost")
	})
	divergedStandby(h, divergedLine)
	h.settle()
	h.requireOrder("pg:stop_clean", "pg:rewind", "pg:rebuild", "pg:start:recovery=true")
	if rewind, start := h.index("pg:rewind", 0), h.index("pg:start", h.index("pg:rewind", 0)); start < h.index("pg:rebuild", rewind) {
		t.Fatalf("started before the rebuild; log:\n%s", strings.Join(h.logSnapshot(), "\n"))
	}
	if len(h.events(EventRewindFailed)) != 1 || len(h.events(EventRebuilt)) != 1 {
		t.Fatalf("expected rewind_failed and rebuild events")
	}
	h.pg.requireNoViolations(t)
}

// H3: while the rebuild of a partly rewound directory cannot run (it fails,
// or the daemon restarts), the directory stays stopped and marked; nothing
// starts it and it is never rewound again.
func TestPartialRewindNeverStartsWhileRebuildFails(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.rewindPartErr = errors.New("pg_rewind: fatal: could not write file: No space left on device")
		p.rebuildErr = errors.New("pg_basebackup: could not connect")
		p.startReceiver = ""
	})
	divergedStandby(h, divergedLine)
	h.run(60, time.Second)
	h.requireOrder("pg:rewind", "pg:rebuild")
	if !h.engine.State().NeedsRebuild {
		t.Fatal("a partly rewound directory must stay marked for a rebuild")
	}
	h.manager = h.newManager()
	h.run(30, time.Second)
	if n := len(filter(h.logSnapshot(), "pg:rewind")); n != 1 {
		t.Fatalf("a partly rewound directory was rewound again (%d rewinds)", n)
	}
	if len(filter(h.logSnapshot(), "pg:rebuild")) < 2 {
		t.Fatal("the rebuild must be retried")
	}
	h.pg.requireNoViolations(t)
}

// An explicit rebuild of a copy; the primary is refused.
func TestExplicitRebuild(t *testing.T) {
	h := newHarness(t)
	h.primaryElsewhere()
	h.run(3, time.Second)
	if err := h.engine.RequestRebuild(); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.requireOrder("pg:stop_clean", "pg:rebuild", "pg:start:recovery=true")
	if h.engine.State().NeedsRebuild {
		t.Fatal("the rebuild mark must be cleared once it ran")
	}
	primary := newHarness(t)
	steadyHolder(t, primary, Value{Durability: DurabilitySynchronous, Degraded: true})
	primary.settle()
	if err := primary.engine.RequestRebuild(); err == nil {
		t.Fatal("rebuilding the primary must be refused")
	}
}

// A new member is seeded by a base backup, never started empty.
func TestSeedNewMember(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.running, p.initialized = false, false })
	h.run(5, time.Second)
	h.requireNo("pg:start")
	h.requireNo("pg:rebuild")
	h.primaryElsewhere()
	h.settle()
	h.requireOrder("pg:rebuild", "pg:start:recovery=true")
	if state := h.engine.State(); state.DataEpoch != 1 {
		t.Fatalf("a seed must count as new data: %+v", state)
	}
	h.pg.requireNoViolations(t)
}
