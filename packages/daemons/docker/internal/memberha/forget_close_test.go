package memberha

import "testing"

// closingEngine is the fake engine with background work of its own.
type closingEngine struct {
	*fakeEngine
	closed int
}

func (e *closingEngine) Close() { e.closed++ }

// N-1: forgetting a member (lift, removal, set deleted) closes its engine, so
// no background work of the member outlives it.
func TestForgetClosesTheEngine(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	engine := &closingEngine{fakeEngine: h.engine}
	h.manager.mu.Lock()
	h.manager.members[testSet].engine = engine
	h.manager.mu.Unlock()
	if err := h.manager.Forget(testSet); err != nil {
		t.Fatal(err)
	}
	if engine.closed != 1 {
		t.Fatalf("the forgotten member's engine was closed %d times, want 1", engine.closed)
	}
	if err := h.manager.Forget(testSet); err != nil || engine.closed != 1 {
		t.Fatalf("a repeated forget = %v, closed %d times", err, engine.closed)
	}
}
