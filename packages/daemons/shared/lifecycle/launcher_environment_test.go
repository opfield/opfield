package lifecycle

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// O-5: a daemon that cannot start because dockerd is down exits with its own
// status, which a launcher trial does not count against the staged launcher.
func TestEnvironmentUnavailableExitCode(t *testing.T) {
	err := fmt.Errorf("plugin init: %w", fmt.Errorf("docker ping failed: %w: %w", ErrEnvironmentUnavailable, errors.New("connection refused")))
	if got := DaemonExitCode(err); got != DaemonEnvironmentExitCode {
		t.Fatalf("exit code %d, want %d", got, DaemonEnvironmentExitCode)
	}
	if got := DaemonExitCode(errors.New("broken")); got != 1 {
		t.Fatalf("exit code of another failure %d, want 1", got)
	}
}

// An abandoned launcher refresh is retried after 1 h, 4 h, 16 h, then not again.
func TestAbandonedLauncherRefreshRetries(t *testing.T) {
	at := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	for abandons, want := range map[int]time.Duration{0: time.Hour, 1: time.Hour, 2: 4 * time.Hour, 3: 16 * time.Hour} {
		state := &launcherRefreshState{Phase: launcherRefreshPhaseAbandoned, AbandonedAt: &at, Abandons: abandons}
		retryAt, retry := state.retryAt()
		if !retry || !retryAt.Equal(at.Add(want)) {
			t.Fatalf("abandons %d: retry at %v (%v), want %v", abandons, retryAt, retry, at.Add(want))
		}
	}
	state := &launcherRefreshState{Phase: launcherRefreshPhaseAbandoned, AbandonedAt: &at, Abandons: launcherRefreshAbandonLimit}
	if _, retry := state.retryAt(); retry {
		t.Fatal("a binary abandoned launcherRefreshAbandonLimit times is not retried")
	}
	if launcherRefreshRetryDelay(10) != launcherRefreshRetryMax {
		t.Fatal("the retry delay is capped")
	}
}
