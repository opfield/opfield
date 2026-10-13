package main

import (
	"errors"
	"testing"

	runtimemanager "github.com/opfield/opfield/docker-daemon/internal/runtime"
)

// `docker-daemon runtime install runsc` that did not install must not exit 0, whatever state it reports.
func TestRuntimeInstallThatFailedNeverExitsZero(t *testing.T) {
	failed := errors.New("runsc installation requires root privileges")
	for _, state := range []runtimemanager.State{
		runtimemanager.StateHealthy, runtimemanager.StateInstallable, runtimemanager.StateUnsupported, runtimemanager.StateFailed,
	} {
		if code := runtimeCommandExitCode(state, failed); code == 0 {
			t.Errorf("state %s with an install error exits 0", state)
		}
	}
	if code := runtimeCommandExitCode(runtimemanager.StateHealthy, nil); code != 0 {
		t.Errorf("a healthy runtime exits %d", code)
	}
}
