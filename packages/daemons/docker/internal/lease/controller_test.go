package lease

import (
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
)

// fakeController owns testPolicy (a database HA policy on a storage node).
type fakeController struct {
	steps   int
	freezes []time.Duration
}

func (c *fakeController) Owns(policyID string) bool      { return policyID == testPolicy }
func (c *fakeController) Step()                          { c.steps++ }
func (c *fakeController) ObserveFreeze(at time.Duration) { c.freezes = append(c.freezes, at) }

// A controller-owned policy runs the protocol like any other (the node
// acquires and holds it), but the Availability side never starts, stops or
// records its containers, never flips its candidacy, and never deletes the
// controller's deadline records; the controller steps every iteration.
func TestControllerOwnedPolicyIsLeftToTheController(t *testing.T) {
	controller := &fakeController{}
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1"}, candidates: []string{"d1"}})
	d1 := w.daemon("d1")
	d1.controller = controller
	w.startDaemon(d1)
	w.deliverBlocks(d1)
	c := d1.addContainer(testPolicy, true)
	record := leasefence.Record{ContainerID: c.ID, PolicyID: testPolicy, DeadlineNs: int64(w.clock.now + time.Hour)}
	d1.fence.records[c.ID] = record
	c.Running = false
	// The controller declares readiness itself.
	d1.runtime.Node().SetCandidateReady(testPolicy, true)
	w.run(45 * time.Second)
	status := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy})
	if status.Role != availabilitylease.RoleHolding {
		t.Fatalf("the node does not hold the controller's policy: %s", status.Role)
	}
	if c.Running {
		t.Fatalf("the Availability side started a controller-owned container")
	}
	if _, ok := d1.fence.records[c.ID]; !ok {
		t.Fatalf("the Availability side deleted a controller-owned record")
	}
	if controller.steps == 0 {
		t.Fatalf("the controller never stepped")
	}
	for _, entry := range w.log {
		if entry == "d1 endpoints serving=true" {
			t.Fatalf("the Availability side opened endpoints of a controller-owned policy")
		}
	}
}
