package memberha

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// rc.3 F-A2: turning availability off closes the lease with the primary as the
// retained holder. Its deadline record is no longer renewed, so it must go on
// the first step that sees the role, even while an operation of the member
// runs (the principals of the configuration that removed the other members):
// waiting for the member to be idle let the watchdog kill the kept primary.
func TestRetainedPrimaryIsDisarmedWhileAnOperationRuns(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.holding(h.clock.now + 24*time.Second)
	h.step(4, time.Second)
	if _, armed := h.watchdog.records[testCID]; !armed {
		t.Fatal("the holder must have armed its deadline record")
	}

	h.manager.mu.Lock()
	mem := h.manager.members[testSet]
	mem.busy, mem.op = true, "principals"
	h.manager.mu.Unlock()

	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleRetained, Retained: true}
	h.clock.now += time.Second
	h.manager.Step()
	if _, armed := h.watchdog.records[testCID]; armed {
		t.Fatal("the retained primary's deadline record must be deleted although an operation runs")
	}
	found := false
	for _, kind := range h.events() {
		found = found || kind == EventRetainedOnClose
	}
	if !found {
		t.Fatal("the retained close must be an event")
	}
}

// A daemon that starts after the close never armed the record in this process:
// the record of the observed container is removed once.
func TestRetainedPrimaryRemovesARecordItDidNotArm(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.step(2, time.Second)
	h.watchdog.records[testCID] = leasefence.Record{ContainerID: testCID, PolicyID: testPolicy, DeadlineNs: int64(h.clock.now + 10*time.Second)}
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleRetained, Retained: true}
	h.step(2, time.Second)
	if _, armed := h.watchdog.records[testCID]; armed {
		t.Fatal("a retained primary's leftover deadline record must be deleted")
	}
}
