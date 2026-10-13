package leasegate

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

func gateView(policyID, holder string, round uint64, endpoint relayv1.LeaseHolderEndpoint) *relayv1.LeaseGateView {
	return &relayv1.LeaseGateView{
		PolicyId: policyID, Slot: 0, LeaseMode: true, Open: true, HolderId: holder, RemainingMs: 20000,
		HolderEndpoint: endpoint, Ballot: &relayv1.LeaseBallot{Round: round, Incarnation: 1, ProposerId: holder},
	}
}

func TestHolderNamesTheAdmittedCandidate(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	if view := tracker.Holder("db-policy", now); view.HolderID != "" || view.Legacy {
		t.Fatalf("no views must name no holder, got %+v", view)
	}
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-a", 3, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
		gateView("other-policy", "node-b", 9, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
	}}, now)
	view := tracker.Holder("db-policy", now)
	if view.HolderID != "node-a" || !view.Ready || view.Legacy {
		t.Fatalf("holder = %+v, want node-a ready", view)
	}
	if view := tracker.Holder("db-policy", now.Add(MaxTTL)); view.HolderID != "" {
		t.Fatalf("a stale view must not name a holder, got %+v", view)
	}
}

func TestHolderPrefersTheHighestBallotWhileRelaysDisagree(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	// relay-1 has not seen the takeover yet; relay-2 already gates the new holder.
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-a", 3, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
	}}, now)
	tracker.Apply("relay-2", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-b", 4, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN),
	}}, now)
	if view := tracker.Holder("db-policy", now); view.HolderID != "node-b" || view.Ready {
		t.Fatalf("holder = %+v, want node-b (higher ballot)", view)
	}
}

func TestHolderSkipsAHolderEveryRelaySaysIsNotReady(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-a", 5, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY),
	}}, now)
	tracker.Apply("relay-old", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-a", 5, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN),
	}}, now)
	if view := tracker.Holder("db-policy", now); view.HolderID != "" {
		t.Fatalf("a holder that is not ready yet must not be named, got %+v", view)
	}
}

func TestHolderReportsLegacyAdmission(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		{PolicyId: "db-policy", Slot: 0, LeaseMode: false},
	}}, now)
	if view := tracker.Holder("db-policy", now); !view.Legacy || view.HolderID != "" {
		t.Fatalf("holder = %+v, want legacy admission without a holder", view)
	}
}

func TestChangedClosesOnlyWhenAViewChanges(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	snapshot := &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-a", 3, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
	}}
	first := tracker.Changed()
	tracker.Apply("relay-1", snapshot, now)
	select {
	case <-first:
	default:
		t.Fatal("a first view must signal a change")
	}
	second := tracker.Changed()
	tracker.Apply("relay-1", snapshot, now.Add(time.Second))
	select {
	case <-second:
		t.Fatal("a refresh of the same view must not signal a change")
	default:
	}
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		gateView("db-policy", "node-b", 4, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
	}}, now.Add(2*time.Second))
	select {
	case <-second:
	default:
		t.Fatal("a new holder must signal a change")
	}
}

func TestRetryDelayIsJitteredAndCapped(t *testing.T) {
	low, high := func() float64 { return 0 }, func() float64 { return 0.999999 }
	if got := RetryDelay(1, low); got != WatchRetryInitial/2 {
		t.Fatalf("first retry lower bound = %s", got)
	}
	if got := RetryDelay(1, high); got >= WatchRetryInitial || got < WatchRetryInitial/2 {
		t.Fatalf("first retry upper bound = %s", got)
	}
	if got := RetryDelay(50, high); got > WatchRetryMax {
		t.Fatalf("retry delay %s exceeds the cap", got)
	}
	if got := RetryDelay(50, low); got != WatchRetryMax/2 {
		t.Fatalf("capped retry lower bound = %s", got)
	}
}

type fakeWatchStream struct {
	grpc.ClientStream
	snapshots []*relayv1.LeaseGateSnapshot
	err       error
}

func (s *fakeWatchStream) Recv() (*relayv1.LeaseGateSnapshot, error) {
	if len(s.snapshots) == 0 {
		return nil, s.err
	}
	next := s.snapshots[0]
	s.snapshots = s.snapshots[1:]
	return next, nil
}
func (s *fakeWatchStream) Header() (metadata.MD, error) { return nil, nil }
func (s *fakeWatchStream) Trailer() metadata.MD         { return nil }
func (s *fakeWatchStream) CloseSend() error             { return nil }
func (s *fakeWatchStream) Context() context.Context     { return context.Background() }

type fakeWatchClient struct {
	mu      sync.Mutex
	calls   int
	streams []func() (relayv1.TunnelBroker_WatchLeaseGatesClient, error)
}

func (c *fakeWatchClient) WatchLeaseGates(context.Context, *relayv1.LeaseGateWatchRequest, ...grpc.CallOption) (relayv1.TunnelBroker_WatchLeaseGatesClient, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if len(c.streams) == 0 {
		return nil, errors.New("relay unavailable")
	}
	next := c.streams[0]
	c.streams = c.streams[1:]
	return next()
}

func TestWatchAppliesSnapshotsAndRetriesABrokenStream(t *testing.T) {
	tracker := NewTracker()
	client := &fakeWatchClient{streams: []func() (relayv1.TunnelBroker_WatchLeaseGatesClient, error){
		func() (relayv1.TunnelBroker_WatchLeaseGatesClient, error) { return nil, errors.New("refused") },
		func() (relayv1.TunnelBroker_WatchLeaseGatesClient, error) {
			return &fakeWatchStream{err: io.EOF, snapshots: []*relayv1.LeaseGateSnapshot{{Gates: []*relayv1.LeaseGateView{
				gateView("db-policy", "node-a", 1, relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY),
			}}}}, nil
		},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applied := make(chan struct{}, 4)
	var errorsSeen []error
	var mu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		Watch(ctx, client, "relay-1", tracker, WatchOptions{
			Random:     func() float64 { return 0 },
			OnSnapshot: func() { applied <- struct{}{} },
			OnError: func(err error, _ time.Duration) {
				mu.Lock()
				errorsSeen = append(errorsSeen, err)
				mu.Unlock()
			},
		})
	}()
	select {
	case <-applied:
	case <-time.After(5 * time.Second):
		t.Fatal("the snapshot of the second stream was never applied")
	}
	if view := tracker.Holder("db-policy", time.Now()); view.HolderID != "node-a" {
		t.Fatalf("holder = %+v", view)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(errorsSeen) == 0 {
		t.Fatal("a refused watch must be reported")
	}
}
