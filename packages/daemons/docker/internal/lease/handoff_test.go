package lease

import (
	"errors"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

func handoffRequest(w *world, successor string) Handoff {
	return Handoff{PolicyID: testPolicy, SuccessorID: successor, OperationID: "op-1", ManifestVersion: w.manifestV}
}

func TestHandoffReleasesOnlyAfterEndpointAndCgroupAreGone(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	start := w.clock.now
	w.waitServing("d2", 15*time.Second)
	w.requireClean()
	deregistered := w.lastIndexOf("d1 endpoints serving=false")
	stopped := w.lastIndexOf("d1 docker stop")
	empty := w.lastIndexOf("d1 cgroup empty")
	started := w.lastIndexOf("d2 docker start")
	if !(deregistered >= 0 && deregistered < stopped && stopped < empty && empty < started) {
		t.Fatalf("handoff order must be deregister < stop < cgroup empty < successor start (A6)\n%s", w.dump())
	}
	if took := w.clock.now - start; took > 10*time.Second {
		t.Fatalf("designated successor took %s", took)
	}
	report := d1.runtime.Report()
	found := false
	for _, event := range report.Events {
		if event.Kind == string(availabilitylease.EventHandoff) && event.Successor == "d2" {
			found = true
		}
	}
	if !found {
		t.Fatalf("handoff event missing from the report: %+v", report.Events)
	}
}

func TestHandoffWithFailedStopAbandonsWithoutRelease(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.engine.stopFails = true
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	w.run(time.Second)
	status := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy})
	if status.Role != availabilitylease.RoleAbandoned {
		t.Fatalf("a failed stop must abandon the key, role %s\n%s", status.Role, w.dump())
	}
	for _, event := range d1.runtime.Report().Events {
		if event.Kind == string(availabilitylease.EventHandoff) || event.Kind == string(availabilitylease.EventReleased) {
			t.Fatalf("no release may be sent while the container may run: %+v", event)
		}
	}
	// The watchdog fences at the deadline; only then may the successor run.
	w.waitServing("d2", 45*time.Second)
	w.requireClean()
	killed := w.indexOf("d1 watchdog killed")
	if killed < 0 || killed > w.lastIndexOf("d2 docker start") {
		t.Fatalf("successor started before the watchdog fenced the holder\n%s", w.dump())
	}
}

func TestHandoffRefusedWithoutLeaseOrNewerManifest(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	if err := w.daemon("d2").runtime.Handoff(handoffRequest(w, "d1")); !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("non-holder accepted a handoff: %v", err)
	}
	request := handoffRequest(w, "d2")
	request.ManifestVersion++
	if err := w.daemon("d1").runtime.Handoff(request); err == nil {
		t.Fatal("holder accepted a handoff planned against a manifest it has not adopted")
	}
	if err := w.daemon("d1").runtime.Handoff(handoffRequest(w, "stranger")); err == nil {
		t.Fatal("holder accepted a successor outside the manifest")
	}
}

// A standby prepared again just before it takes the slot: the view the holder started from lists the container
// that was replaced. It starts the copy the node has now instead of serving, and later releasing, a container that
// no longer exists.
func TestHolderStartsTheContainerThatReplacedTheListedOne(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	var listed *Container
	for _, c := range d2.engine.containers {
		listed = c
	}
	var replacement *Container
	d2.engine.beforeStart = func(id string) {
		if id != listed.ID || replacement != nil {
			return
		}
		delete(d2.engine.containers, listed.ID)
		replacement = d2.addContainer(testPolicy, false)
		replacement.RestartPolicy = "no"
	}
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	w.waitServing("d2", 20*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if replacement == nil || !replacement.Running {
		t.Fatalf("the replacing container must run\n%s", w.dump())
	}
	if holder := w.holderOf(); holder != "d2" {
		t.Fatalf("d2 must keep the slot, holder %q\n%s", holder, w.dump())
	}
}
