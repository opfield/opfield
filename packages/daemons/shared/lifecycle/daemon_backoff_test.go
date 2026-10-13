package lifecycle

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Control sessions that keep failing back off to at most 15 s (10 s jittered by up to half), and an accepted session
// reconnects after about a second; every delay is jittered so the nodes of one Opfield do not reconnect in step.
func TestControlSessionBackoffCapsWithJitter(t *testing.T) {
	draw := 0.999999
	backoff := controlSessionBackoff{random: func() float64 { return draw }}
	var delay time.Duration
	for range 12 {
		delay = backoff.next(false, time.Second)
	}
	if delay > 15*time.Second || delay < 14*time.Second {
		t.Fatalf("failing sessions back off %v, want just under 15s", delay)
	}
	draw = 0
	if delay = backoff.next(false, time.Second); delay != 5*time.Second {
		t.Fatalf("lowest jitter at the cap %v, want 5s", delay)
	}
	if delay = backoff.next(true, time.Second); delay != 500*time.Millisecond {
		t.Fatalf("accepted session reconnects after %v, want 0.5s with the lowest jitter", delay)
	}
	draw = 0.5
	if delay = backoff.next(false, time.Second); delay != time.Second {
		t.Fatalf("first failure after an accepted session waits %v, want 1s", delay)
	}
}

func TestSessionEndExpected(t *testing.T) {
	refused := status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 172.18.0.4:9443: connect: connection refused\"")
	for _, tc := range []struct {
		name       string
		err        error
		failingFor time.Duration
		expected   bool
	}{
		{"planned end", status.Error(codes.Canceled, "grpc: the client connection is closing"), time.Hour, true},
		// The monitoring daemon and the relay supervisor while Opfield restarted (stand rc.13 O-d).
		{"refused while Gateway restarts", refused, 2 * time.Second, true},
		{"refused for over a minute", refused, connector.RestartQuiet, false},
		{"other failure", status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 10.0.0.1:9443: i/o timeout\""), time.Second, false},
	} {
		if got := sessionEndExpected(tc.err, tc.failingFor); got != tc.expected {
			t.Errorf("%s: expected %v, want %v", tc.name, got, tc.expected)
		}
	}
}
