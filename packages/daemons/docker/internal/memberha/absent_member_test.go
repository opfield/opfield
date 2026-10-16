package memberha

import (
	"testing"
	"time"
)

// F-8: Opfield configures a new copy before its create command made it on the
// node (a create on several servers, make available). Until then the member
// waits: no seed (rejoin), no start, no rejoin_failed event, no error. Once
// the create made its container, the seed runs.
func TestAMemberNotCreatedYetWaitsWithoutARejoinFailure(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	ext.rejoinNeeded = true
	h.engine.container = ContainerState{Absent: true}
	h.lease.observed = &CertifiedState{State: HolderState{Holder: testNodeB}}
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.rejoin") >= 0 || indexOf(log, "engine.start") >= 0 {
		t.Fatalf("a member not created yet must not be seeded or started: %v", log)
	}
	for _, kind := range h.events() {
		if kind == EventRejoinFailed {
			t.Fatalf("a member not created yet is no rejoin failure: %v", h.events())
		}
	}
	h.manager.mu.Lock()
	lastError := h.manager.members[testSet].lastError
	h.manager.mu.Unlock()
	if lastError != "" {
		t.Fatalf("a member not created yet reports no error: %q", lastError)
	}

	// The create command made the container: the copy is seeded, then starts.
	h.engine.container = ContainerState{Exists: true, ID: testCID}
	h.step(3, time.Second)
	log := h.calls.take()
	rejoin, start := indexOf(log, "engine.rejoin"), indexOf(log, "engine.start")
	if rejoin < 0 || start < 0 || start < rejoin {
		t.Fatalf("the created member must be seeded, then started: %v", log)
	}
}
