package relaybridge

import (
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	RolePrimary = "primary"
	RoleStandby = "standby"

	// Relays of one role whose path cost is within this band of the nearest
	// one count as equally near and share connections by load. It only orders
	// tunnels; Gateway decides the roles with its own, hysteretic band.
	costBandRatio = 1.2
	costBandFloor = 3 * time.Millisecond
)

// TransportLoad is what the daemon knows about its transport to one relay.
type TransportLoad struct {
	// Available is a transport that is connected now. A relay whose lanes
	// lost their connection comes after every connected one, whatever its
	// role or distance: a tunnel opened on it waits for the reconnect.
	Available bool
	Active    int64
	// Penalized is a relay that failed this route's tunnel recently
	// (RelayPenalties): it comes after the others of its role.
	Penalized bool
	// Demoted is a relay that refused a tunnel for its admission pressure
	// recently (RelayPenalties.Demoted): it comes after every other connected
	// relay, whatever its role or distance, and is still tried after them.
	Demoted bool
}

// OrderCandidates orders the relays to try for a new source tunnel: relays
// with a connected transport first, then relays not demoted for their
// admission pressure, then Gateway's primaries before its
// standbys, then relays that did not fail the route recently, then the nearer
// path (this node's own measured round trip plus the relay's round trip to
// the endpoint), then fewer active tunnels, then round-robin from rotation.
//
// Distance decides before load: a relay whose distance is unknown comes after
// every measured relay of its role, and an empty relay never beats a nearer
// one. Active tunnels only share load between relays in one cost tier (within
// the band of the nearest), and among relays whose distance is unknown.
func OrderCandidates(
	candidates []*pb.RelayDataCandidate,
	transports map[string]TransportLoad,
	rotation uint64,
	rtt func(relayInstanceID string) (time.Duration, bool),
) []*pb.RelayDataCandidate {
	ordered := append([]*pb.RelayDataCandidate(nil), candidates...)
	if len(ordered) < 2 {
		return ordered
	}
	start := int(rotation % uint64(len(ordered)))
	rank := make(map[string]int, len(ordered))
	for offset := range ordered {
		rank[ordered[(start+offset)%len(ordered)].GetRelayInstanceId()] = offset
	}
	places := placeCandidates(ordered, transports, rtt)
	sort.SliceStable(ordered, func(i, j int) bool {
		leftID, rightID := ordered[i].GetRelayInstanceId(), ordered[j].GetRelayInstanceId()
		left, right := places[leftID], places[rightID]
		if left.available != right.available {
			return left.available
		}
		if transports[leftID].Demoted != transports[rightID].Demoted {
			return !transports[leftID].Demoted
		}
		if left.role != right.role {
			return left.role < right.role
		}
		if transports[leftID].Penalized != transports[rightID].Penalized {
			return !transports[leftID].Penalized
		}
		if left.tier != right.tier {
			return left.tier < right.tier
		}
		if left.tier == tierFar && left.cost != right.cost {
			return left.cost < right.cost
		}
		if transports[leftID].Active != transports[rightID].Active {
			return transports[leftID].Active < transports[rightID].Active
		}
		return rank[leftID] < rank[rightID]
	})
	return ordered
}

const (
	tierNear = iota
	tierFar
	tierUnknown
)

// candidatePlace is where one relay stands for a route: whether its transport
// is up, Gateway's role for it, and its measured distance.
type candidatePlace struct {
	available bool
	role      int
	tier      int
	cost      time.Duration
	known     bool
}

// placeCandidates places every candidate. The cost is the full path cost
// (pathCost) where Gateway reported the endpoint side; when it reported it for
// no candidate at all (an endpoint Gateway has no latency data for), this
// node's own round trip orders the relays instead, so the route still prefers
// the nearer relay over the emptier one.
func placeCandidates(candidates []*pb.RelayDataCandidate, transports map[string]TransportLoad, rtt func(string) (time.Duration, bool)) map[string]candidatePlace {
	costs := make(map[string]time.Duration, len(candidates))
	for _, candidate := range candidates {
		if cost, ok := pathCost(candidate, rtt); ok {
			costs[candidate.GetRelayInstanceId()] = cost
		}
	}
	if len(costs) == 0 && rtt != nil {
		for _, candidate := range candidates {
			if own, ok := rtt(candidate.GetRelayInstanceId()); ok {
				costs[candidate.GetRelayInstanceId()] = own
			}
		}
	}
	tiers := costTiers(candidates, transports, costs)
	places := make(map[string]candidatePlace, len(candidates))
	for _, candidate := range candidates {
		id := candidate.GetRelayInstanceId()
		cost, known := costs[id]
		places[id] = candidatePlace{available: transports[id].Available, role: roleRank(candidate), tier: tiers[id], cost: cost, known: known}
	}
	return places
}

// costTiers puts every relay of a role whose cost is within the band of the
// nearest available relay of that role in one tier, so equally near relays
// share load, and the rest after it by cost. A relay without a known cost
// comes last; with no cost known at all every relay is in one tier.
func costTiers(candidates []*pb.RelayDataCandidate, transports map[string]TransportLoad, costs map[string]time.Duration) map[string]int {
	best := map[int]time.Duration{}
	for _, candidate := range candidates {
		id := candidate.GetRelayInstanceId()
		cost, ok := costs[id]
		if !ok || !transports[id].Available {
			continue
		}
		role := roleRank(candidate)
		if current, seen := best[role]; !seen || cost < current {
			best[role] = cost
		}
	}
	tiers := make(map[string]int, len(candidates))
	for _, candidate := range candidates {
		id := candidate.GetRelayInstanceId()
		cost, ok := costs[id]
		nearest, seen := best[roleRank(candidate)]
		switch {
		case !ok:
			tiers[id] = tierUnknown
		case !seen || cost <= costBand(nearest):
			tiers[id] = tierNear
		default:
			tiers[id] = tierFar
		}
	}
	return tiers
}

func costBand(nearest time.Duration) time.Duration {
	band := time.Duration(float64(nearest) * costBandRatio)
	if floor := nearest + costBandFloor; floor > band {
		return floor
	}
	return band
}

// pathCost is this node's round trip to the relay plus the relay's round trip
// to the endpoint. It is known only when Gateway reported the endpoint side
// and this node measured its side.
func pathCost(candidate *pb.RelayDataCandidate, rtt func(string) (time.Duration, bool)) (time.Duration, bool) {
	endpoint := candidate.GetTopology().GetEndpointRttMicros()
	if endpoint == 0 || rtt == nil {
		return 0, false
	}
	own, ok := rtt(candidate.GetRelayInstanceId())
	if !ok {
		return 0, false
	}
	return own + time.Duration(endpoint)*time.Microsecond, true
}

// roleRank puts primaries (and candidates Gateway gave no role) before standbys.
func roleRank(candidate *pb.RelayDataCandidate) int {
	if candidate.GetTopology().GetRole() == RoleStandby {
		return 1
	}
	return 0
}

// KeepStaying lifts the admission demotion of the relay a stream's planned
// move leaves (staying; "" for a new connection): the stream already runs
// there, so the move still answers that it stays rather than moving it off.
// Other relays keep theirs.
func KeepStaying(transports map[string]TransportLoad, staying string) map[string]TransportLoad {
	if load, ok := transports[staying]; ok && load.Demoted {
		load.Demoted = false
		transports[staying] = load
	}
	return transports
}
