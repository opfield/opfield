package docker

import (
	"errors"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
)

var (
	// relaySourceOpenTimeout bounds one relay's answer to a source tunnel open. The relay admits the tunnel once the
	// target daemon accepted it; a relay that took the open and gets no answer (the target daemon wedged, a lane half
	// dead, a registration of a host that went away) held it for its own accept timeout of 30 s, one candidate after
	// the other.
	relaySourceOpenTimeout = relayresume.OpenTimeout
	// relaySourceOpenBudget bounds the opens of one connection across all its relays. It stays below the
	// connector's dial timeout (10 s): a connection the connector already gave up on no longer holds its link slot
	// and a relay session.
	relaySourceOpenBudget = 8 * time.Second
	// relaySourceTransientWait is how long a new connection waits for a relay lane or its target's registration to
	// come back, as the nginx daemon's Secure Link sources do (secureLinkTransientWait): a relay update or a target
	// daemon restart leaves the candidates without a lane or the target unregistered for a second or two. A target
	// that announced its restart is waited for within the whole budget.
	relaySourceTransientWait  = 3 * time.Second
	relaySourceTransientRetry = 150 * time.Millisecond
)

// openRelaySource opens a source tunnel for assignment on the first of its relay candidates (in load and latency
// order) that accepts it within relaySourceOpenBudget. When none does, the error is a capacity refusal if any relay
// gave one (the relay's own reason), else the last refusal. Right after this process started, a connection that
// finds no relay lane waits for the first lanes (relayLaneStartupWait): the link sockets the previous process handed
// over are served before the lanes are up. Later, a relay or target that is restarting is held for
// relaySourceTransientWait.
func (p *DockerPlugin) openRelaySource(assignment *pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	started := time.Now()
	budget, hold := started.Add(relaySourceOpenBudget), started.Add(relaySourceTransientWait)
	for {
		tunnel, err := p.openRelaySourceOnce(assignment, budget)
		if err == nil {
			return tunnel, nil
		}
		if errors.Is(err, errRelayLaneUnavailable) && p.waitForRelayLanes() {
			continue
		}
		if !errors.Is(err, errRelayLaneUnavailable) && !relaybridge.RetryableOpenError(err) {
			return nil, err
		}
		if relaybridge.TargetRestarting(err) {
			hold = budget
		}
		if !time.Now().Add(relaySourceTransientRetry).Before(hold) {
			return nil, err
		}
		time.Sleep(relaySourceTransientRetry)
	}
}

// openRelaySourceOnce tries every candidate once, each within relaySourceOpenTimeout and all before deadline.
func (p *DockerPlugin) openRelaySourceOnce(assignment *pb.RelayGrantAssignment, deadline time.Time) (*relaySourceTunnel, error) {
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.GetGrant()}}
	}
	route := relayRouteKey(assignment.GetOwnerKind(), assignment.GetOwnerId())
	refusal := errRelayLaneUnavailable
	for _, candidate := range p.orderRelayCandidates(route, candidates, "") {
		router := p.relayRouter(candidate.GetRelayInstanceId())
		if router == nil {
			continue
		}
		timeout := min(relaySourceOpenTimeout, time.Until(deadline))
		if timeout <= 0 {
			break
		}
		tunnel, err := router.openSourceWithin(candidate.GetGrant(), timeout)
		p.recordRelayOpen(candidate.GetRelayInstanceId(), route, err)
		if err == nil {
			tunnel.generation = candidate.GetAssignmentGeneration()
			tunnel.idle = relaySourceIdleLimit(assignment.GetOwnerKind())
			p.makeResumable(tunnel, assignment)
			return tunnel, nil
		}
		if relayRefusalReason(refusal) != linkRejectedRelayCapacity {
			refusal = err
		}
	}
	return nil, refusal
}

// relayRouteKey names a route for the relay penalties: one source owner's connect assignment.
func relayRouteKey(ownerKind, ownerID string) string {
	return ownerKind + "/" + ownerID
}

// recordRelayOpen remembers how relayID answered an open of route (relaybridge.RelayPenalties): a relay that refused
// for its admission pressure is tried after the others for a while, for every route.
func (p *DockerPlugin) recordRelayOpen(relayID, route string, err error) {
	p.relayPenalties.Opened(p.logger, relayID, route, err)
}

// orderRelayCandidates orders the candidates of route (relayRouteKey) for a new source tunnel. staying is the relay a
// stream's planned move leaves ("" for a new connection; relaybridge.KeepStaying).
func (p *DockerPlugin) orderRelayCandidates(route string, candidates []*pb.RelayDataCandidate, staying string) []*pb.RelayDataCandidate {
	if len(candidates) < 2 {
		return append([]*pb.RelayDataCandidate(nil), candidates...)
	}
	transports := relaybridge.KeepStaying(p.relayTransportLoads(route), staying)
	p.relayTunnelMu.Lock()
	rotation := p.relaySelection
	p.relaySelection++
	p.relayTunnelMu.Unlock()
	return relaybridge.OrderCandidates(candidates, transports, rotation, p.relayRTTFunc())
}

// relayTransportLoads is what this daemon knows about its transport to each relay, for route.
func (p *DockerPlugin) relayTransportLoads(route string) map[string]relaybridge.TransportLoad {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	transports := make(map[string]relaybridge.TransportLoad, len(p.relayTunnels))
	for targetID, router := range p.relayTunnels {
		transports[targetID] = relaybridge.TransportLoad{Available: router.connected(), Active: router.active.Load(),
			Penalized: p.relayPenalties.Penalized(targetID, route), Demoted: p.relayPenalties.Demoted(targetID)}
	}
	return transports
}

// relayRTTFunc is this node's measured round trip to a relay (relaybridge.Latency; replaced in tests).
func (p *DockerPlugin) relayRTTFunc() func(string) (time.Duration, bool) {
	if p.relayRTT != nil {
		return p.relayRTT
	}
	return relaybridge.Latency.RTT
}

func (p *DockerPlugin) relayRouter(targetID string) *relayTunnelRouter {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	return p.relayTunnels[targetID]
}
