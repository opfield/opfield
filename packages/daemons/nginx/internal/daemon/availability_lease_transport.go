package daemon

import (
	"context"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// runForTarget watches one relay's lease gate views for the life of ctx, over
// one of the daemon's existing relay transports (the nginx daemon already
// dials every relay target for Secure Link tunnel lanes, and reuses one of
// those connections here instead of opening a new one). nginx daemons are
// observers only (A18-A20): they never vote, so this is the only lease RPC
// they use. Only one lane per relay target actually watches it; extra lanes
// to the same relay no-op.
func (c *availabilityLeaseCoordinator) runForTarget(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	if relayID == "" || !c.claimWatch(relayID) {
		return
	}
	defer c.releaseWatch(relayID)
	client := relayv1.NewTunnelBrokerClient(conn)
	for ctx.Err() == nil {
		stream, err := client.WatchLeaseGates(ctx, &relayv1.LeaseGateWatchRequest{})
		if err != nil {
			c.logWatchError(relayID, err)
			if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
				return
			}
			continue
		}
		for {
			snapshot, recvErr := stream.Recv()
			if recvErr != nil {
				if ctx.Err() == nil {
					c.logWatchError(relayID, recvErr)
				}
				break
			}
			c.gates.Apply(relayID, snapshot, time.Now())
			c.reconcileSockets()
		}
		if ctx.Err() != nil {
			return
		}
		if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
			return
		}
	}
}

// logWatchError reports a WatchLeaseGates failure. PermissionDenied is
// logged loudly (Warn, not Debug): it means the relay currently refuses this
// daemon's gate watch, so every lease-bound Secure Link member on it fails
// closed until the relay is fixed to allow it (B1). Lease-bound bindings
// stay closed throughout: reconcileSockets never opens one without a fresh,
// admitting view.
func (c *availabilityLeaseCoordinator) logWatchError(relayID string, err error) {
	if status.Code(err) == codes.PermissionDenied {
		if c.logger != nil {
			c.logger.Warn("availability lease gate watch denied by relay; lease-bound Secure Link members on it stay closed",
				"relay_instance_id", relayID, "error", err)
		}
		return
	}
	c.logf("availability lease gate watch to relay %s failed: %v", relayID, err)
}

func (c *availabilityLeaseCoordinator) claimWatch(relayID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.watched[relayID] {
		return false
	}
	c.watched[relayID] = true
	return true
}

func (c *availabilityLeaseCoordinator) releaseWatch(relayID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.watched, relayID)
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
