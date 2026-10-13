package handover

import (
	"maps"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Sessions a replaced Secure Link connector still carried when it was removed, an hour after the update that
// replaced it, join the node's last update report as a new final report, which Gateway takes again (stand rc.7 O-15:
// reported nowhere). Without a report there is nothing to join.
func TestCutAfterJoinsTheLastUpdateReport(t *testing.T) {
	stateDir := t.TempDir()
	if NewTracker(stateDir, "v2").CutAfter("connector_retired", 3) {
		t.Fatal("a cut joined a report that does not exist")
	}
	finished := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	if err := writeReport(stateDir+"/"+lastReportFile, Report{FromVersion: "v1", ToVersion: "v2", HandedOver: 4, Kept: 4,
		FinishedAt: finished}); err != nil {
		t.Fatal(err)
	}
	tracker := NewTracker(stateDir, "v2")
	if !tracker.CutAfter("connector_retired", 35) {
		t.Fatal("the cut did not join the last update's report")
	}
	report := tracker.Last()
	if report.Cut["connector_retired"] != 35 || report.Kept != 4 || !report.FinishedAt.After(finished) {
		t.Fatalf("report %+v", report)
	}
	if again := NewTracker(stateDir, "v2").Last(); again.Cut["connector_retired"] != 35 {
		t.Fatalf("the next process reads %+v", again)
	}
}

// A cut that comes while the update's counts are not final joins them when they are, without counting against the
// streams handed over.
func TestCutAfterWhileSettling(t *testing.T) {
	stateDir := t.TempDir()
	if err := WritePending(stateDir, Report{FromVersion: "v1", StartedAt: time.Now(), Handover: true}); err != nil {
		t.Fatal(err)
	}
	tracker := NewTracker(stateDir, "v2")
	if !tracker.CutAfter("connector_retired", 2) {
		t.Fatal("the cut was not taken while settling")
	}
	tracker.Settle()
	if report := tracker.Last(); report == nil || report.Cut["connector_retired"] != 2 || report.Cut[CutResumeFailed] != 0 {
		t.Fatalf("report %+v", report)
	}
}

// The relay stream counters go on from the previous process's, once.
func TestStreamTotalsAreTakenOnce(t *testing.T) {
	stateDir := t.TempDir()
	if err := WriteStreamTotals(stateDir, StreamTotals{Cut: 7}); err != nil {
		t.Fatal(err)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 7 {
		t.Fatalf("totals %+v", totals)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 0 {
		t.Fatalf("totals taken twice: %+v", totals)
	}
	// Left by a process that stopped long ago: no restart of this one.
	if err := WriteStreamTotals(stateDir, StreamTotals{Cut: 7, WrittenAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 0 {
		t.Fatalf("stale totals taken: %+v", totals)
	}
}

// A report of an older process that handed nothing over counted only what
// its drain left open: the next process reports such an update as having cut
// every connection (CutUncounted), not the lower bound as a count (O-2).
func TestTrackerMarksAnOlderUncountedCutAsAll(t *testing.T) {
	cases := []struct {
		name   string
		report Report
		want   map[string]int
	}{
		{"older service restart", Report{Cut: map[string]int{CutServiceRestart: 1}}, map[string]int{CutUncounted: 1}},
		{"older update without a keeper", Report{Cut: map[string]int{CutNoHandover: 2, "registry": 1}}, map[string]int{CutUncounted: 3}},
		{"counted service restart", Report{Counted: true, Cut: map[string]int{CutServiceRestart: 22}}, map[string]int{CutServiceRestart: 22}},
		{"older handover", Report{Handover: true, Cut: map[string]int{"postgres_tls": 2}}, map[string]int{"postgres_tls": 2}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			tc.report.FromVersion, tc.report.StartedAt = "v1", time.Now()
			if err := WritePending(dir, tc.report); err != nil {
				t.Fatal(err)
			}
			tracker := NewTracker(dir, "v2")
			tracker.Settle()
			last := tracker.Last()
			if last == nil || !maps.Equal(last.Cut, tc.want) {
				t.Fatalf("last report = %+v, want cut %v", last, tc.want)
			}
		})
	}
}

// A stream taken over that its far end ended is that node's cut; a refusal for
// a reset that came once the peer could have given up waiting for this side
// (its suspend timeout) is this update's cut and stays in the record.
func TestEndedByPeerKeepsALateResetRefusalAsThisUpdatesCut(t *testing.T) {
	refused := func(code byte) error {
		return &relayresume.ResetError{Code: relayresume.RstResumeRejected, Reject: code, Err: relayresume.ErrProtocol}
	}
	early, late := 5*time.Second, relayresume.TargetSuspendTimeout
	for _, tc := range []struct {
		name  string
		state relayresume.State
		err   error
		after time.Duration
		peer  bool
	}{
		{"finished", relayresume.StateFinished, nil, late, true},
		{"refused finished", relayresume.StateReset, refused(relayresume.RejectFinished), late, true},
		{"refused reset early", relayresume.StateReset, refused(relayresume.RejectReset), early, true},
		{"refused reset after the peer's suspend timeout", relayresume.StateReset, refused(relayresume.RejectReset), late, false},
		{"refused unknown after the peer's suspend timeout", relayresume.StateReset, refused(relayresume.RejectUnknown), late, false},
		{"refused unauthorized", relayresume.StateReset, refused(relayresume.RejectUnauthorized), early, false},
		{"peer reset", relayresume.StateReset, &relayresume.ResetError{Code: relayresume.RstAborted, Remote: true}, late, true},
		{"peer suspend timeout", relayresume.StateReset, &relayresume.ResetError{Code: relayresume.RstSuspendTimeout, Remote: true}, early, false},
		{"local reset", relayresume.StateReset, &relayresume.ResetError{Code: relayresume.RstAborted}, early, false},
	} {
		if got := endedByPeer(tc.state, tc.err, tc.after); got != tc.peer {
			t.Errorf("%s: endedByPeer = %v, want %v", tc.name, got, tc.peer)
		}
	}
}

// Stand rc.12 F-1: in a mixed batch, storage-1's update cut its TLS-terminated
// DB links (postgres_tls, left out of its handover), and app-node-1 and
// secure-node-1, updated in the same batch, had handed over their ends of those
// streams. Their resumes reached storage-1's new process, which does not know
// the streams and refuses them with code 1 (unknown). That is storage-1's cut,
// counted in its own record, not resume_failed on the nodes that resumed.
func TestEndedByPeerCountsAnUnknownStreamRefusalInABatchAsThePeersCut(t *testing.T) {
	refusedUnknown := &relayresume.ResetError{Code: relayresume.RstResumeRejected, Reject: relayresume.RejectUnknown, Err: relayresume.ErrProtocol}
	if refusedUnknown.Error() != "relayresume: resume rejected (code 1)" {
		t.Fatalf("not the stand's error: %v", refusedUnknown)
	}
	for _, after := range []time.Duration{2 * time.Second, 7 * time.Second, relayresume.TargetSuspendTimeout - time.Second} {
		if !endedByPeer(relayresume.StateReset, refusedUnknown, after) {
			t.Errorf("refused as unknown %v after the update started: counted as this update's cut", after)
		}
	}
	if endedByPeer(relayresume.StateReset, refusedUnknown, relayresume.TargetSuspendTimeout) {
		t.Error("refused as unknown once the peer could have given up waiting: left out of this update's record")
	}
}
