package connector

import (
	"testing"
	"time"
)

// A node retries a relay or Gateway that stays down at most every 15 s (10 s cap, jittered by up to half), so it is
// back within that long once its peer is: with the former 60 s cap nodes came back up to 70 s after the local relay.
func TestRetryBackoffCapsAtTenSecondsWithJitter(t *testing.T) {
	backoff := InitialBackoff
	var steps []time.Duration
	for range 10 {
		steps = append(steps, backoff)
		backoff = NextBackoff(backoff)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 10 * time.Second}
	for index, step := range want {
		if steps[index] != step {
			t.Fatalf("backoff steps %v, want %v first", steps, want)
		}
	}
	if steps[len(steps)-1] != 10*time.Second {
		t.Fatalf("backoff grew past its cap: %v", steps)
	}
	if low, high := Jitter(MaxBackoff, func() float64 { return 0 }), Jitter(MaxBackoff, func() float64 { return 0.999999 }); low != 5*time.Second || high > 15*time.Second || high < 14*time.Second {
		t.Fatalf("jittered cap spans %v..%v, want 5s..15s", low, high)
	}
}

func TestConnectorAddressChangeIsSignalled(t *testing.T) {
	c := NewConnector("old.example:9443", nil, nil)
	changed := c.AddressChanged()
	if c.SetAddress("old.example:9443") {
		t.Fatal("setting the same address reported a change")
	}
	select {
	case <-changed:
		t.Fatal("signalled without a change")
	default:
	}
	if !c.SetAddress("new.example:9443") || c.Address() != "new.example:9443" {
		t.Fatalf("address = %q", c.Address())
	}
	select {
	case <-changed:
	default:
		t.Fatal("change not signalled")
	}
	select {
	case <-c.AddressChanged():
		t.Fatal("the next change is already signalled")
	default:
	}
}
