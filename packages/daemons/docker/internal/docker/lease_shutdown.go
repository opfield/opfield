package docker

import (
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// leaseShutdownWait bounds how long the exiting process waits for the lease runtime: a Docker call it has in flight
// may take up to its operation timeout, and the next process starts only after this one exited.
var leaseShutdownWait = 3 * time.Second

var _ lifecycle.ShutdownPlugin = (*DockerPlugin)(nil)

// Shutdown implements lifecycle.ShutdownPlugin. The lifecycle calls it once Run returned: on a restart that is after
// AnnounceRestart renewed the registrations RESTARTING on the relays and drained the tunnels (B-13), so the relays
// hold the traffic first and the lease stops second. It stops the availability lease so no relay lane or lease
// operation still writes the state directory while the process exits.
func (p *DockerPlugin) Shutdown() {
	p.stopAvailabilityLease(leaseShutdownWait)
	p.leaveStreamTotals()
}

// stopAvailabilityLease stops the lease integration, waiting at most limit. It reports whether it stopped in time;
// otherwise the process exits with the rest in flight. Every state file is replaced atomically, so what it did not
// finish is the previous state, never a partial file.
func (p *DockerPlugin) stopAvailabilityLease(limit time.Duration) bool {
	if p.lease == nil {
		return true
	}
	started := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.lease.stop()
	}()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-done:
		p.logger.Debug("availability lease stopped", "took", time.Since(started).Round(time.Millisecond).String())
		return true
	case <-timer.C:
		p.logger.Warn("availability lease did not stop in time; exiting with its work in flight", "waited", limit.String())
		return false
	}
}
