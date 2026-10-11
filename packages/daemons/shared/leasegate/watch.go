package leasegate

import (
	"context"
	"math/rand/v2"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

// Watch reconnect backoff: doubling from WatchRetryInitial to WatchRetryMax,
// each wait drawn from the upper half of its step, so the daemons of a site do
// not all re-subscribe to a relay that comes back in the same instant.
const (
	WatchRetryInitial = 500 * time.Millisecond
	WatchRetryMax     = 10 * time.Second
)

// WatchClient is the part of relayv1.TunnelBrokerClient Watch needs.
type WatchClient interface {
	WatchLeaseGates(ctx context.Context, in *relayv1.LeaseGateWatchRequest, opts ...grpc.CallOption) (relayv1.TunnelBroker_WatchLeaseGatesClient, error)
}

// WatchOptions tunes Watch; the zero value is usable.
type WatchOptions struct {
	// OnSnapshot runs after every applied snapshot (outside the tracker lock).
	OnSnapshot func()
	// OnError reports a failed or broken stream and the wait before the retry.
	OnError func(err error, retryIn time.Duration)
	// Random returns a value in [0, 1) for the backoff jitter; nil uses math/rand.
	Random func() float64
}

// RetryDelay is the wait before reconnect number attempt (from 1).
func RetryDelay(attempt int, random func() float64) time.Duration {
	if random == nil {
		random = rand.Float64
	}
	step := WatchRetryInitial
	for i := 1; i < attempt && step < WatchRetryMax; i++ {
		step *= 2
	}
	step = min(step, WatchRetryMax)
	return step/2 + time.Duration(random()*float64(step/2))
}

// Watch subscribes to one relay's lease gate views for the life of ctx and
// applies every snapshot to tracker under relayID. A broken stream is retried
// with jittered exponential backoff; a stream that delivered at least one
// snapshot resets the backoff. Views of a relay whose stream is gone are never
// extended: they age out by their own TTL in the tracker.
func Watch(ctx context.Context, client WatchClient, relayID string, tracker *Tracker, options WatchOptions) {
	failures := 0
	for ctx.Err() == nil {
		received := false
		stream, err := client.WatchLeaseGates(ctx, &relayv1.LeaseGateWatchRequest{})
		if err == nil {
			for {
				snapshot, recvErr := stream.Recv()
				if recvErr != nil {
					err = recvErr
					break
				}
				received = true
				tracker.Apply(relayID, snapshot, time.Now())
				if options.OnSnapshot != nil {
					options.OnSnapshot()
				}
			}
		}
		if ctx.Err() != nil {
			return
		}
		if received {
			failures = 0
		}
		failures++
		delay := RetryDelay(failures, options.Random)
		if options.OnError != nil {
			options.OnError(err, delay)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
