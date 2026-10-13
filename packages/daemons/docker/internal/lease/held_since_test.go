package lease

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

func heldView(t *testing.T, report Report) Held {
	t.Helper()
	for _, held := range report.Held {
		if held.Key.PolicyID == testPolicy {
			return held
		}
	}
	t.Fatalf("no held view for %s: %+v", testPolicy, report.Held)
	return Held{}
}

// B-14: the holder reports when it acquired the key with every report, not
// only in the acquired event. Reports built while Gateway is away drain that
// event, and the next voter to report after a restart only knows when it
// first saw the holder.
func TestHolderReportsItsAcquisitionTimeUntilItStopsHolding(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")

	first := d1.runtime.Report()
	var acquiredAt int64
	for _, event := range first.Events {
		if event.Kind == string(availabilitylease.EventAcquired) && event.Key.PolicyID == testPolicy {
			acquiredAt = event.AtUnixMs
		}
	}
	if acquiredAt == 0 {
		t.Fatalf("acquired event missing: %+v", first.Events)
	}
	if held := heldView(t, first); held.SinceUnixMs != acquiredAt {
		t.Fatalf("held since %d, want the acquisition %d", held.SinceUnixMs, acquiredAt)
	}

	// Renewals do not move it, and it outlives the drained event.
	w.run(40 * time.Second)
	later := d1.runtime.Report()
	if len(later.Events) != 0 {
		t.Fatalf("no transition expected while renewing: %+v", later.Events)
	}
	if held := heldView(t, later); held.SinceUnixMs != acquiredAt || held.Ballot.Round <= heldView(t, first).Ballot.Round {
		t.Fatalf("after renewals held since %d (round %d), want %d with a later round", held.SinceUnixMs, held.Ballot.Round, acquiredAt)
	}

	// A handoff ends d1's holding; d2 reports its own acquisition.
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	w.waitServing("d2", 15*time.Second)
	w.run(time.Second)
	for _, held := range d1.runtime.Report().Held {
		if held.Key.PolicyID == testPolicy && held.SinceUnixMs != 0 {
			t.Fatalf("a node that handed the key off reports no holding time: %+v", held)
		}
	}
	successor := heldView(t, d2.runtime.Report())
	if successor.SinceUnixMs <= acquiredAt || successor.SinceUnixMs > d2.runtime.opts.Wall().UnixMilli() {
		t.Fatalf("successor held since %d, want its own acquisition after %d", successor.SinceUnixMs, acquiredAt)
	}
}

// N-15: Gateway measures a daemon's clock offset from ReportedAtUnixMs and
// moves the report's times by it, so every time in one report is on the wall
// clock of that moment, also a transition collected before the wall clock was
// stepped (a VM resumed from suspend runs behind until NTP steps it).
func TestReportTimesShareTheReportsWallClock(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")

	w.wallJump += 101 * time.Second
	report := d1.runtime.Report()
	if report.ReportedAtUnixMs != w.wall().UnixMilli() {
		t.Fatalf("reported at %d, want the report's wall clock %d", report.ReportedAtUnixMs, w.wall().UnixMilli())
	}
	var acquiredAt int64
	for _, event := range report.Events {
		if event.Kind == string(availabilitylease.EventAcquired) && event.Key.PolicyID == testPolicy {
			acquiredAt = event.AtUnixMs
		}
	}
	if acquiredAt == 0 {
		t.Fatalf("acquired event missing: %+v", report.Events)
	}
	if age := report.ReportedAtUnixMs - acquiredAt; age < 0 || age > (45*time.Second).Milliseconds() {
		t.Fatalf("acquisition %d ms before the report, want it on the report's wall clock (within the 45 s it took)", age)
	}
	if held := heldView(t, report); held.SinceUnixMs != acquiredAt {
		t.Fatalf("held since %d, want the acquisition %d", held.SinceUnixMs, acquiredAt)
	}
}

// M-5: a copy that kept running through a daemon restart continues its
// holding. Its renewal is reported as recovered, without a start time, so
// Gateway neither resets holderSince nor audits a re-acquisition. A key the
// node acquires anew reports its start (TestHolderReportsItsAcquisitionTime...).
func TestRecoveredKeyContinuesTheHoldingWithoutAStartTime(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.daemon("d1").runtime.Report()
	w.run(3 * time.Second)
	d1 := w.restartDaemon("d1")
	w.waitServing("d1", 10*time.Second)
	w.run(2 * time.Second)

	report := d1.runtime.Report()
	var kinds []string
	for _, event := range report.Events {
		if event.Key.PolicyID == testPolicy {
			kinds = append(kinds, event.Kind)
		}
	}
	if len(kinds) != 1 || kinds[0] != EventRecovered {
		t.Fatalf("events after the restart %v, want one %q\n%s", kinds, EventRecovered, w.dump())
	}
	if held := heldView(t, report); held.SinceUnixMs != 0 || held.Role != availabilitylease.RoleHolding.String() {
		t.Fatalf("recovered key held %+v, want holding without a start time", held)
	}
}
