package lease

import (
	"errors"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
)

func TestBeforeStartGatesEveryStartAndArmsTheRecordFirst(t *testing.T) {
	w := twoCandidateWorld(t)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	late := d1.addContainer(testPolicy, false)
	if err := d1.runtime.BeforeStart(late.ID, testPolicy, ""); !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("a start before any lease must be refused: %v", err)
	}
	w.waitServing("d1", 45*time.Second)
	standby := d2.addContainer(testPolicy, false)
	if err := d2.runtime.BeforeStart(standby.ID, testPolicy, ""); !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("a non-holder start must be refused: %v", err)
	}
	if err := d1.runtime.BeforeStart(late.ID, testPolicy, ""); err != nil {
		t.Fatalf("the holder's gated start was refused: %v", err)
	}
	status := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy})
	record, ok := d1.fence.records[late.ID]
	if !ok || record.Deadline() <= w.clock.now || record.Deadline() > status.Deadline {
		t.Fatalf("the record must be written with the holder's deadline before the start returns: %+v ok=%v", record, ok)
	}
	late.Running = true // the backend start completes
	w.run(3 * time.Second)
	if rec := d1.fence.records[late.ID]; rec.DeadlineNs == 0 {
		t.Fatal("a running container of the holder must never be lowered to a stale record")
	}
	d1.fence.lag = leasefence.HeartbeatMaxAge + time.Second
	if err := d1.runtime.BeforeStart(late.ID, testPolicy, ""); err == nil {
		t.Fatal("a start without a fresh watchdog heartbeat must be refused")
	}
	d1.fence.lag = 0
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	if err := d1.runtime.BeforeStart(late.ID, testPolicy, ""); err == nil {
		t.Fatal("a start while the holder releases must be refused")
	}
	if err := d1.runtime.BeforeStart(late.ID, "legacy-policy", ""); err != nil {
		t.Fatalf("a policy outside lease mode keeps legacy starts: %v", err)
	}
}

func TestStopOpCatchesAContainerStartedAfterTheSnapshot(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	// A gated backend start (rollout slot) finished after the last snapshot:
	// only the stop op's re-list can see it.
	extra := d1.addContainer(testPolicy, true)
	w.waitServing("d2", 20*time.Second)
	w.requireClean()
	stopped := w.indexOf("d1 docker stop " + shortID(extra.ID))
	if extra.Running || stopped < 0 || stopped > w.lastIndexOf("d2 docker start") {
		t.Fatalf("the container started after the snapshot must be stopped before the release\n%s", w.dump())
	}
}

func TestStopWithFailedRelistNeverReleases(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.engine.listFails = true
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	w.run(time.Second)
	if role := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role; role != availabilitylease.RoleAbandoned {
		t.Fatalf("an unconfirmed stop must abandon, role %s\n%s", role, w.dump())
	}
	for _, event := range d1.runtime.Report().Events {
		if event.Kind == string(availabilitylease.EventHandoff) || event.Kind == string(availabilitylease.EventReleased) {
			t.Fatalf("no release may leave while the workload list is unknown: %+v", event)
		}
	}
}
