package docker

import (
	"context"
	"maps"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// setPeerStateInterval is how often the peer endpoints of this node's set
// members are compared with the state they registered with.
const setPeerStateInterval = time.Second

// setPeerStates re-registers this node's set peer endpoints (Keeper,
// interserver, replication ports of its members) when their serving state
// changes. A peer endpoint serves while its member's container runs
// (PeerServing), which no member serving change announces: a copy whose
// container the create command starts registered its peer endpoints DORMANT
// before the container existed and kept them so, every relay refused the
// holder's tunnels to the copy's Keeper ("target endpoint is dormant"), and
// the holder never added the copy (rc.1/rc.3 stand B blocker).
type setPeerStates struct {
	once  sync.Once
	mu    sync.Mutex
	known map[string]relayv1.EndpointServingState
}

func (s *setPeerStates) start(p *DockerPlugin) {
	s.once.Do(func() { go s.run(context.Background(), p) })
}

func (s *setPeerStates) run(ctx context.Context, p *DockerPlugin) {
	ticker := time.NewTicker(setPeerStateInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if s.changed(p) {
			p.reconcileRelayRegistrations()
		}
	}
}

// changed reports whether a set peer endpoint's state differs from the last
// pass (the first pass re-registers once: registrations may predate it).
func (s *setPeerStates) changed(p *DockerPlugin) bool {
	if p.relayGrants == nil {
		return false
	}
	states := map[string]relayv1.EndpointServingState{}
	for _, assignment := range p.relayGrants.filter(func(a *pb.RelayGrantAssignment) bool {
		return a.GetRole() == "endpoint" && a.GetOwnerKind() == setPeerEndpointKind && a.GetEndpointId() != "" && a.GetLeaseTarget() != nil
	}) {
		states[assignment.GetEndpointId()] = p.setEndpointState(assignment)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := s.known == nil || !maps.Equal(states, s.known)
	s.known = states
	return changed
}
