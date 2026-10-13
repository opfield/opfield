package docker

import (
	"context"
	"errors"
	"math/rand/v2"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasegate"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Relay paths of database and storage availability sets (member mesh).
//
// A connection to a set's resource (a link, a backup run) has one route per
// member, each to that member's endpoint; Gateway sends them as one connect
// assignment with the group (lease_group). This daemon opens the route of the
// member the relays' lease gate views name the holder first, then the others
// by rank: while the set's lease runs the relays admit only the holder, so a
// refusal costs one round trip. A manual pair has no lease: only its
// primary's endpoint serves, so its group has that one route.
//
// Engine-to-engine traffic (replication) uses peer routes: one per member
// pair and port. A primary port (pg-repl, kv-repl, sw-master) is reached as
// "primary-<port>" (the holder's route first, as above); every other port as
// "member-<member id>-<port>".
const (
	managedAvailabilityRoutesCapability = "managed_availability_routes_v1"
	setClientEndpointKind               = "managed_availability_member"
	setPeerEndpointKind                 = "managed_availability_peer"
	setPeerRouteKind                    = "managed_member_peer"
	setWitnessRouteKind                 = "managed_witness_peer"
	setLeaseGateWatchPoll               = 2 * time.Second
	setLeaseGroupRetryInitial           = 250 * time.Millisecond
	setLeaseGroupRetryMax               = 2 * time.Second
	setLeaseGroupWakeSpread             = 200 * time.Millisecond
)

var errSetMemberNotServing = errors.New("availability set member endpoint is not serving")

// SetMemberRuntime is this node's availability set member runtime (the member
// runtime of each engine). It must be cheap and must not block: it runs on
// every registration reconcile and every incoming tunnel.
type SetMemberRuntime interface {
	// MemberServing reports whether this node's member of setID serves client
	// traffic now (it holds the lease, or it is a manual pair's primary, and its
	// engine takes connections). known is false when no member runtime runs for
	// the set on this node: the resource's single-node serving applies.
	MemberServing(setID, memberID string) (serving bool, known bool)
	// PeerServing reports whether the member's engine port takes peer traffic.
	PeerServing(setID, memberID, port string) bool
	// DialPeer connects an incoming peer tunnel to the member's engine port.
	DialPeer(ctx context.Context, setID, memberID, port string) (net.Conn, error)
}

// setLeaseGates is what this daemon knows about relay lease gates for its set
// routes. The zero value is ready to use.
type setLeaseGates struct {
	once    sync.Once
	gates   *leasegate.Tracker
	mu      sync.Mutex
	runtime SetMemberRuntime
	// wait bounds how long a connection waits for a member route to admit it.
	wait time.Duration
	// peers re-registers the members' peer endpoints when they change state.
	peers setPeerStates
}

func (s *setLeaseGates) tracker() *leasegate.Tracker {
	s.once.Do(func() { s.gates = leasegate.NewTracker() })
	return s.gates
}

func (s *setLeaseGates) memberRuntime() SetMemberRuntime {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runtime
}

func (s *setLeaseGates) waitTime() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wait > 0 {
		return s.wait
	}
	return relaySourceOpenBudget
}

// SetSetMemberRuntime installs the availability set member runtime (nil: no
// member runtime, set endpoints follow the single-node rules).
func (p *DockerPlugin) SetSetMemberRuntime(runtime SetMemberRuntime) {
	p.setGates.mu.Lock()
	p.setGates.runtime = runtime
	p.setGates.mu.Unlock()
	if runtime != nil {
		p.setGates.peers.start(p)
	}
}

// SetMemberServingChanged renews every set endpoint registration with the
// state the member runtime reports now. A member that stops serving is
// re-registered DORMANT on every relay, which ends every session the relay
// admitted to it, and this node ends the tunnels it accepted for it at once.
// The returned channels close once those tunnels have ended.
func (p *DockerPlugin) SetMemberServingChanged() []chan struct{} {
	dormant := map[string]bool{}
	for _, assignment := range p.relayGrants.filter(func(a *pb.RelayGrantAssignment) bool {
		return a.GetRole() == "endpoint" && a.GetLeaseTarget() != nil && a.GetEndpointId() != ""
	}) {
		if p.setEndpointState(assignment) == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
			dormant[assignment.GetEndpointId()] = true
		}
	}
	closed := p.closeMemberTunnels(dormant)
	p.reconcileRelayRegistrations()
	return closed
}

// isSetEndpointKind reports the endpoint kinds only availability sets have.
func isSetEndpointKind(ownerKind string) bool {
	return ownerKind == setClientEndpointKind || ownerKind == setPeerEndpointKind || ownerKind == setWitnessEndpointKind
}

// setEndpointState is the state a set endpoint registers with on every relay.
// A client endpoint (the member's own, or the resource endpoint on the origin
// member's node) serves only while the member runtime says the member serves;
// without a member runtime for the set the resource endpoint serves as a
// single-node one, any other set endpoint stays DORMANT. A peer endpoint
// serves while the member's engine port takes peer traffic.
func (p *DockerPlugin) setEndpointState(assignment *pb.RelayGrantAssignment) relayv1.EndpointServingState {
	if assignment.GetOwnerKind() == setWitnessEndpointKind {
		// A ClickHouse Keeper witness container on this (non-member) node.
		return p.witnessEndpointState(assignment)
	}
	target := assignment.GetLeaseTarget()
	if target == nil {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
	}
	runtime := p.setGates.memberRuntime()
	if assignment.GetOwnerKind() == setPeerEndpointKind {
		if runtime != nil && runtime.PeerServing(target.GetSetId(), target.GetMemberId(), target.GetPortName()) {
			return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
		}
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	if runtime != nil {
		if serving, known := runtime.MemberServing(target.GetSetId(), target.GetMemberId()); known {
			if serving {
				return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
			}
			return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
		}
	}
	if assignment.GetOwnerKind() == setClientEndpointKind {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
}

// setMemberServes is the second fence behind the relay's dormant check and
// lease gate: an incoming client tunnel reaches the engine only while the
// member serves (or the set has no member runtime here and the resource
// endpoint serves as a single-node one).
func (p *DockerPlugin) setMemberServes(assignment *pb.RelayGrantAssignment) bool {
	return p.setEndpointState(assignment) != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

// dialSetEndpoint connects an incoming tunnel of a set endpoint: a member's
// client endpoint to the resource's engine on this node, a peer endpoint to
// the member's engine port.
func (r *relayTunnelRouter) dialSetEndpoint(ctx context.Context, assignment *pb.RelayGrantAssignment) (dialedEndpoint, error) {
	if assignment.GetOwnerKind() == setWitnessEndpointKind {
		connection, err := r.plugin.dialWitness(ctx, assignment)
		return dialedEndpoint{conn: connection}, err
	}
	target := assignment.GetLeaseTarget()
	if target == nil {
		return dialedEndpoint{}, errEndpointNotServed
	}
	if assignment.GetOwnerKind() == setPeerEndpointKind {
		runtime := r.plugin.setGates.memberRuntime()
		if runtime == nil || !runtime.PeerServing(target.GetSetId(), target.GetMemberId(), target.GetPortName()) {
			return dialedEndpoint{}, errSetMemberNotServing
		}
		connection, err := runtime.DialPeer(ctx, target.GetSetId(), target.GetMemberId(), target.GetPortName())
		return dialedEndpoint{conn: connection}, err
	}
	if !r.plugin.setMemberServes(assignment) {
		return dialedEndpoint{}, errSetMemberNotServing
	}
	switch target.GetOwnerKind() {
	case "managed_database":
		if r.plugin.databaseManager == nil {
			return dialedEndpoint{}, errEndpointNotServed
		}
		connection, record, err := r.plugin.databaseManager.dialRecord(ctx, target.GetOwnerId())
		if err != nil {
			return dialedEndpoint{}, err
		}
		dialed := dialedEndpoint{conn: connection}
		if managedDatabaseLinkNeedsPostgresTLS(record) {
			dialed.postgres = &record
		}
		return dialed, nil
	case "managed_storage":
		if r.plugin.storageManager == nil {
			return dialedEndpoint{}, errEndpointNotServed
		}
		connection, err := r.plugin.storageManager.dial(ctx, target.GetOwnerId())
		return dialedEndpoint{conn: connection}, err
	}
	return dialedEndpoint{}, errEndpointNotServed
}

// needsSetLeaseGates reports whether any route of this daemon's bundle needs
// relay gate views: a lease group or a primary peer route of a set whose
// lease runs.
func (p *DockerPlugin) needsSetLeaseGates() bool {
	return len(p.relayGrants.filter(func(a *pb.RelayGrantAssignment) bool {
		if a.GetRole() != "connect" {
			return false
		}
		for _, member := range a.GetLeaseGroup() {
			if member.GetTarget().GetLeasePolicyId() != "" {
				return true
			}
		}
		return a.GetOwnerKind() == setPeerRouteKind && a.GetLeaseTarget().GetPrimaryPort() && a.GetLeaseTarget().GetLeasePolicyId() != ""
	})) > 0
}

// watchSetLeaseGates keeps the gate views of one relay current while this
// daemon has set routes that need them, for the life of ctx.
func (p *DockerPlugin) watchSetLeaseGates(ctx context.Context, client leasegate.WatchClient, relayID string) {
	tracker := p.setGates.tracker()
	for ctx.Err() == nil {
		if !p.needsSetLeaseGates() {
			if !sleepContext(ctx, setLeaseGateWatchPoll) {
				return
			}
			continue
		}
		watchCtx, cancel := context.WithCancel(ctx)
		go func() {
			for sleepContext(watchCtx, setLeaseGateWatchPoll) {
				if !p.needsSetLeaseGates() {
					cancel()
					return
				}
			}
		}()
		leasegate.Watch(watchCtx, client, relayID, tracker, leasegate.WatchOptions{
			OnError: func(err error, retryIn time.Duration) {
				if p.logger != nil {
					p.logger.Debug("availability set lease gate watch failed", "relay_instance_id", relayID, "error", err, "retry_in", retryIn.String())
				}
			},
		})
		cancel()
	}
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

// leaseGroupMemberAssignment is the connect assignment of one member route of
// a group: the group's owner (so penalties, labels and limits stay per link),
// the member's route and grants.
func leaseGroupMemberAssignment(group *pb.RelayGrantAssignment, member *pb.RelayLeaseGroupRoute) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: group.GetOwnerKind(), OwnerId: group.GetOwnerId(), RouteId: member.GetRouteId(),
		TargetEndpointId: member.GetTargetEndpointId(), Grant: member.GetGrant(), Candidates: member.GetCandidates(),
		SchemaVersion: member.GetSchemaVersion(), StreamResume: member.GetStreamResume(), LeaseTarget: member.GetTarget(),
	}
}

// orderSetRoutes puts the route of the member the gate views name the holder
// first and the others by rank (then member id).
func orderSetRoutes(routes []*pb.RelayGrantAssignment, holderID string) []*pb.RelayGrantAssignment {
	result := append([]*pb.RelayGrantAssignment(nil), routes...)
	sort.SliceStable(result, func(i, j int) bool {
		left, right := result[i].GetLeaseTarget(), result[j].GetLeaseTarget()
		leftHolder := holderID != "" && left.GetCandidateId() == holderID
		rightHolder := holderID != "" && right.GetCandidateId() == holderID
		if leftHolder != rightHolder {
			return leftHolder
		}
		if left.GetRank() != right.GetRank() {
			return left.GetRank() < right.GetRank()
		}
		return left.GetMemberId() < right.GetMemberId()
	})
	return result
}

// setLeaseRetryDelay is the wait before retry number attempt (from 1):
// doubling from 250 ms to 2 s, drawn from the upper half of each step, so the
// clients of a set that lost its primary together do not retry in lockstep.
func setLeaseRetryDelay(attempt int, random func() float64) time.Duration {
	step := setLeaseGroupRetryInitial
	for i := 1; i < attempt && step < setLeaseGroupRetryMax; i++ {
		step *= 2
	}
	step = min(step, setLeaseGroupRetryMax)
	return step/2 + time.Duration(random()*float64(step/2))
}

// openSetRoutes opens a source tunnel on the first route that admits it:
// each attempt asks routes() for the current routes (the newest bundle),
// tries the holder's route (from relay gate views) and then the others in
// rank order. When every route refuses (a takeover in progress), it waits
// with jittered backoff, or until the gate views change, within the wait
// time.
func (p *DockerPlugin) openSetRoutes(routes func() []*pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	tracker := p.setGates.tracker()
	deadline := time.Now().Add(p.setGates.waitTime())
	var lastErr error = errRelayLaneUnavailable
	for attempt := 1; ; attempt++ {
		changed := tracker.Changed()
		current := routes()
		if len(current) == 0 {
			return nil, errRelayLaneUnavailable
		}
		holderID := tracker.Holder(current[0].GetLeaseTarget().GetLeasePolicyId(), time.Now()).HolderID
		for _, route := range orderSetRoutes(current, holderID) {
			budget := min(time.Until(deadline), relaySourceOpenBudget)
			if budget <= 0 {
				break
			}
			tunnel, err := p.openRelaySourceOnce(route, time.Now().Add(budget))
			if err == nil {
				return tunnel, nil
			}
			lastErr = err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, lastErr
		}
		delay := min(setLeaseRetryDelay(attempt, rand.Float64), remaining)
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-changed:
			timer.Stop()
			// Every waiting connection wakes on the same view change: spread
			// them so the new holder is not hit by all of them at once.
			time.Sleep(time.Duration(rand.Float64() * float64(setLeaseGroupWakeSpread)))
		}
	}
}

// openLeaseGroupSource opens a source tunnel for a group assignment, the
// holder's member route first. Each attempt reads the group from the newest
// bundle, so a member added or removed meanwhile is followed.
func (p *DockerPlugin) openLeaseGroupSource(group *pb.RelayGrantAssignment) (*relaySourceTunnel, error) {
	return p.openSetRoutes(func() []*pb.RelayGrantAssignment {
		current := p.relayGrants.lookup(group.GetRole(), group.GetOwnerKind(), group.GetOwnerId())
		if current == nil || len(current.GetLeaseGroup()) == 0 {
			current = group
		}
		members := make([]*pb.RelayGrantAssignment, 0, len(current.GetLeaseGroup()))
		for _, member := range current.GetLeaseGroup() {
			members = append(members, leaseGroupMemberAssignment(current, member))
		}
		return members
	})
}

// setPeerAlias is one engine-to-engine destination of a member.
type setPeerAlias struct {
	// primary: "primary-<port>", the lease holder's port.
	primary bool
	// memberID: "member-<member id>-<port>"; witnessID: "witness-<witness id>-<port>" (a Keeper witness on a relay).
	memberID  string
	witnessID string
	port      string
}

// parseSetPeerAlias splits "primary-<port>", "member-<member id>-<port>" or
// "witness-<witness id>-<port>" (ids are UUIDs: 36 characters with dashes).
func parseSetPeerAlias(alias string) (setPeerAlias, bool) {
	if rest, found := strings.CutPrefix(alias, "primary-"); found {
		return setPeerAlias{primary: true, port: rest}, rest != ""
	}
	for _, prefix := range []string{"member-", "witness-"} {
		rest, found := strings.CutPrefix(alias, prefix)
		if !found {
			continue
		}
		if len(rest) < 38 || rest[36] != '-' || rest[37:] == "" {
			return setPeerAlias{}, false
		}
		if prefix == "member-" {
			return setPeerAlias{memberID: rest[:36], port: rest[37:]}, true
		}
		return setPeerAlias{witnessID: rest[:36], port: rest[37:]}, true
	}
	return setPeerAlias{}, false
}

// setPeerRoutes are the peer routes of this node to setID for alias.
func (p *DockerPlugin) setPeerRoutes(setID, alias string) []*pb.RelayGrantAssignment {
	parsed, ok := parseSetPeerAlias(alias)
	if !ok {
		return nil
	}
	return p.relayGrants.filter(func(a *pb.RelayGrantAssignment) bool {
		target := a.GetLeaseTarget()
		if a.GetRole() != "connect" || target.GetSetId() != setID || target.GetPortName() != parsed.port {
			return false
		}
		switch {
		case parsed.witnessID != "":
			return a.GetOwnerKind() == setWitnessRouteKind && target.GetWitnessId() == parsed.witnessID
		case parsed.primary:
			return a.GetOwnerKind() == setPeerRouteKind && target.GetPrimaryPort()
		default:
			return a.GetOwnerKind() == setPeerRouteKind && target.GetMemberId() == parsed.memberID
		}
	})
}

// BridgeSetPeer carries one engine connection of this node's member of setID
// to alias ("primary-<port>", "member-<member id>-<port>" or
// "witness-<witness id>-<port>") through the peer routes, and returns once it
// ended. The member runtime accepts these
// connections on the set's private bridge.
func (p *DockerPlugin) BridgeSetPeer(connection net.Conn, setID, alias string) error {
	setup := p.handover.Setup()
	defer setup()
	tunnel, err := p.openSetRoutes(func() []*pb.RelayGrantAssignment { return p.setPeerRoutes(setID, alias) })
	if err != nil {
		_ = connection.Close()
		return err
	}
	tunnel.started = setup
	tunnel.bridge(connection)
	return nil
}
