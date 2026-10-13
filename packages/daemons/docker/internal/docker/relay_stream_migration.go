package docker

import (
	"context"
	"errors"
	"net"
	"sort"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

// Resumable relay streams (RSv1): a relayed stream of a route Opfield flagged
// resumable runs as a relayresume session between this daemon and the other
// endpoint, and moves to another relay (or the same relay, restarted) when
// its relay drains, stops or fails, without the local connections noticing.
// Routes without the flag, and peers without the capability, keep raw
// tunnels exactly as before.

type relayStreamSides struct {
	sources *relayresume.Manager
	targets *relayresume.TargetTable
}

// relayStreams is the daemon's RSv1 state, made on first use.
func (p *DockerPlugin) relayStreams() *relayStreamSides {
	p.resumableMu.Lock()
	defer p.resumableMu.Unlock()
	if p.resumable != nil {
		return p.resumable
	}
	budget := relayresume.NewWindowBudget(0)
	sides := &relayStreamSides{sources: relayresume.NewManager(budget), targets: relayresume.NewTargetTable(budget)}
	sides.sources.OnMigration = func(event relayresume.MigrationEvent) {
		tag, _ := event.Session.Tag().(relaySourceTag)
		if event.Trigger == relayresume.TriggerLane {
			// Moves off a replaced lane connection are housekeeping (relay_lanes.go).
			p.logger.Debug("relay stream moved to the lane's new connection", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID,
				"ok", event.OK, "stall", event.Stall.Round(time.Millisecond).String(), "error", event.Err)
			return
		}
		if event.OK {
			p.logger.Info("relay stream moved", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID, "trigger", string(event.Trigger),
				"from_relay", event.From, "to_relay", event.To, "stall", event.Stall.Round(time.Millisecond).String())
			return
		}
		p.logger.Debug("relay stream migration attempt failed", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID,
			"trigger", string(event.Trigger), "from_relay", event.From, "error", event.Err)
	}
	sides.sources.OnEnd = func(session *relayresume.Session, err error) {
		if err == nil || !relayStreamCut(err) {
			return
		}
		tag, _ := session.Tag().(relaySourceTag)
		p.logger.Warn("relay stream cut", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID, "error", err)
	}
	sides.sources.MigrateRequestDeadline = func(relayID string, tag any) time.Time {
		source, _ := tag.(relaySourceTag)
		return p.relayDrainDeadline(source, relayID)
	}
	p.resumable = sides
	returner := &relayresume.Returner{Manager: sides.sources, Interval: relayStreamReturnInterval,
		Nearer: p.relayStreamNearer, Prepare: p.observeRelayStability}
	go returner.Run(context.Background())
	return sides
}

// relayStreamReturnInterval spaces the passes that move streams back to the nearest relay (relayresume.Returner).
var relayStreamReturnInterval = relayresume.DefaultReturnInterval

// relayStreamsIfAny is the RSv1 state when any stream used it.
func (p *DockerPlugin) relayStreamsIfAny() *relayStreamSides {
	p.resumableMu.Lock()
	defer p.resumableMu.Unlock()
	return p.resumable
}

// relayStreamCut reports a stream that ended because it could not move (not a
// local or peer socket decision).
func relayStreamCut(err error) bool {
	var reset *relayresume.ResetError
	if !errors.As(err, &reset) || reset.Remote {
		return false
	}
	return reset.Reject != 0 || errors.Is(err, relayresume.ErrSuspendTimeout) || errors.Is(err, relayresume.ErrNotResumable) ||
		errors.Is(err, relayresume.ErrRevoked)
}

// relaySourceTag names the connect assignment a source stream belongs to.
type relaySourceTag struct {
	ownerKind string
	ownerID   string
	routeID   string
}

// relayTargetTag names the endpoint assignment a target stream belongs to.
type relayTargetTag struct {
	ownerKind string
	ownerID   string
	routeID   string
}

// streamResumeKey is the connect assignment's resume key when its streams
// are resumable.
func streamResumeKey(assignment *pb.RelayGrantAssignment) (string, []byte, bool) {
	resume := assignment.GetStreamResume()
	if resume == nil || resume.GetVersion() != relayresume.Version || len(resume.GetKeyId()) == 0 ||
		len(resume.GetKeyId()) > relayresume.MaxKeyIDLen || len(resume.GetKey()) != relayresume.KeyLen {
		return "", nil, false
	}
	return resume.GetKeyId(), append([]byte(nil), resume.GetKey()...), true
}

// makeResumable turns a freshly admitted source tunnel of assignment into a
// resumable stream when the route is flagged resumable and its target was not
// found to be a raw (pre-RSv1) endpoint lately.
func (p *DockerPlugin) makeResumable(tunnel *relaySourceTunnel, assignment *pb.RelayGrantAssignment) {
	if tunnel == nil || assignment == nil || assignment.GetRole() != "connect" || assignment.GetRouteId() == "" {
		return
	}
	if _, _, ok := streamResumeKey(assignment); !ok {
		return
	}
	sides := p.relayStreams()
	if sides.sources.Legacy(assignment.GetRouteId()) {
		return
	}
	tag := relaySourceTag{ownerKind: assignment.GetOwnerKind(), ownerID: assignment.GetOwnerId(), routeID: assignment.GetRouteId()}
	session, err := sides.sources.NewSource(p.relaySourceConfig(tag, assignment), relayresume.OpenedPath{Stream: tunnel.stream,
		Cancel: tunnel.cancel, CloseSend: tunnel.closeSend, RelayID: tunnel.router.targetID, MaxFrame: tunnel.maxFrame, Generation: tunnel.generation,
		Lane: tunnel.lane})
	if err != nil {
		p.logger.Warn("relay stream could not be made resumable", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID, "error", err)
		return
	}
	tunnel.session = session
}

// relaySourceConfig is the configuration of a resumable source stream of tag.
func (p *DockerPlugin) relaySourceConfig(tag relaySourceTag, assignment *pb.RelayGrantAssignment) relayresume.SourceConfig {
	return relayresume.SourceConfig{
		RouteID: tag.routeID,
		Key: func() (string, []byte, bool) {
			current := p.relayGrants.lookup("connect", tag.ownerKind, tag.ownerID)
			if current == nil || current.GetRouteId() != tag.routeID {
				return "", nil, false
			}
			return streamResumeKey(current)
		},
		HalfCloseTimeout: time.Duration(assignment.GetStreamResume().GetHalfCloseTimeoutMs()) * time.Millisecond,
		Dial:             p.relaySourceDialer(tag),
		Wake:             p.relayPathWake.Wait,
		Tag:              tag,
	}
}

// relaySourceDialer opens a new tunnel for a resumable source stream on the
// route's current connect assignment, in tunnel order (distance first), each
// candidate within relayresume.OpenTimeout. Active candidates come before
// staging ones, and a relay the stream has to leave (request.Avoid: it failed,
// stops or leaves the assignment) comes last. A relay that stays in the
// assignment is not avoided: a stream whose grant generation drains re-paths
// onto it under the new grant. When the best path is the one the stream is on,
// the dialer answers relayresume.ErrStay. A route Opfield no longer assigns
// opens nothing: its streams end.
func (p *DockerPlugin) relaySourceDialer(tag relaySourceTag) relayresume.Dialer {
	return func(ctx context.Context, request relayresume.DialRequest) (relayresume.OpenedPath, error) {
		current := p.relayGrants.lookup("connect", tag.ownerKind, tag.ownerID)
		if current == nil || current.GetRouteId() != tag.routeID {
			return relayresume.OpenedPath{}, errors.New("relay route is no longer assigned")
		}
		// Active candidates first; a staging one (registered on both ends,
		// admitted by its relay) when no active one takes the stream: a
		// stream whose only active relay drains or was force-disconnected
		// moves there instead of being cut.
		candidates := relaybridge.PoolCandidates(current, true)
		if len(candidates) == 0 {
			candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: current.GetGrant()}}
		}
		route := relayRouteKey(tag.ownerKind, tag.ownerID)
		ordered := p.orderRelayCandidates(route, candidates, request.FromRelay)
		rank := func(candidate *pb.RelayDataCandidate) int {
			switch {
			case request.Avoid != "" && candidate.GetRelayInstanceId() == request.Avoid:
				return 2
			case candidate.GetAssignmentState() == "staging":
				return 1
			}
			return 0
		}
		sort.SliceStable(ordered, func(i, j int) bool { return rank(ordered[i]) < rank(ordered[j]) })
		err := errRelayLaneUnavailable
		for _, candidate := range ordered {
			if ctx.Err() != nil {
				return relayresume.OpenedPath{}, ctx.Err()
			}
			router := p.relayRouter(candidate.GetRelayInstanceId())
			if router == nil || !router.connected() {
				continue
			}
			if !request.NewPath && request.Avoid == "" && request.FromGeneration != 0 && candidate.GetRelayInstanceId() == request.FromRelay &&
				candidate.GetAssignmentGeneration() == request.FromGeneration {
				return relayresume.OpenedPath{}, relayresume.ErrStay
			}
			// A relay demoted for its admission pressure takes what it refused only at a paced rate: every moving
			// stream's attempts would otherwise reach it (a policy change re-paths all of them at once).
			if held := p.relayPenalties.HoldDemoted(router.targetID, route); held != nil {
				err = held
				continue
			}
			tunnel, openErr := router.openSourceWithin(candidate.GetGrant(), relayresume.OpenTimeout)
			p.recordRelayOpen(router.targetID, route, openErr)
			if openErr != nil {
				err = openErr
				continue
			}
			return relayresume.OpenedPath{Stream: tunnel.stream, Cancel: tunnel.cancel, CloseSend: tunnel.closeSend,
				RelayID: router.targetID, MaxFrame: tunnel.maxFrame, Generation: candidate.GetAssignmentGeneration(), Lane: tunnel.lane}, nil
		}
		return relayresume.OpenedPath{}, err
	}
}

// relayStreamNearer reports a source stream on relayID whose route has a
// clearly nearer relay that has been connected and stable for
// relaybridge.ReturnStableFor (relaybridge.ReturnTarget).
func (p *DockerPlugin) relayStreamNearer(session *relayresume.Session, relayID string) bool {
	tag, _ := session.Tag().(relaySourceTag)
	assignment := p.relayGrants.lookup("connect", tag.ownerKind, tag.ownerID)
	if assignment == nil || assignment.GetRouteId() != tag.routeID {
		return false
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	transports := relaybridge.StableTransports(p.relayTransportLoads(relayRouteKey(tag.ownerKind, tag.ownerID)), &p.relayStability, relayID)
	_, ok := relaybridge.ReturnTarget(candidates, transports, p.relayRTTFunc(), relayID)
	return ok
}

// observeRelayStability samples whether each relay's transport is up, before a return pass.
func (p *DockerPlugin) observeRelayStability() {
	p.relayTunnelMu.Lock()
	connected := make(map[string]bool, len(p.relayTunnels))
	for id, router := range p.relayTunnels {
		connected[id] = router.connected()
	}
	p.relayTunnelMu.Unlock()
	for id, up := range connected {
		p.relayStability.Observe(id, up)
	}
	p.relayStability.Forget(func(id string) bool { _, ok := connected[id]; return ok })
}

// relayDrainDeadline is when a source stream of tag must have left relayID:
// the candidate's drain deadline, or a short spread for a relay this daemon
// does not see draining (yet).
func (p *DockerPlugin) relayDrainDeadline(tag relaySourceTag, relayID string) time.Time {
	deadline := time.Now().Add(10 * time.Second)
	p.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		assignment := findRelayAssignment(bundle, "connect", tag.ownerKind, tag.ownerID)
		for _, candidate := range assignment.GetCandidates() {
			if candidate.GetRelayInstanceId() == relayID && candidate.GetAssignmentState() == "draining" {
				deadline = time.UnixMilli(candidate.GetDrainDeadlineUnixMs())
			}
		}
	})
	return deadline
}

// targetResumeRequest describes an incoming tunnel of a route this endpoint
// serves resumable streams for; ok=false: the tunnel is raw.
func (p *DockerPlugin) targetResumeRequest(assignment *pb.RelayGrantAssignment, incoming *relayv1.IncomingTunnel, targetID string) (relayresume.AcceptRequest, bool) {
	route := incoming.GetRoute()
	if route == nil || route.GetRouteId() == "" || route.GetSourceKind() == "" || route.GetSourceId() == "" {
		return relayresume.AcceptRequest{}, false
	}
	owner := relayTargetTag{ownerKind: assignment.GetOwnerKind(), ownerID: assignment.GetOwnerId(), routeID: route.GetRouteId()}
	if p.targetRouteResume(owner) == nil {
		return relayresume.AcceptRequest{}, false
	}
	return relayresume.AcceptRequest{
		RouteID:    route.GetRouteId(),
		SourceKind: route.GetSourceKind(),
		SourceID:   route.GetSourceId(),
		RelayID:    assignmentRelayInstanceID(assignment, targetID),
		Keys: func(keyID string) []byte {
			resume := p.targetRouteResume(owner)
			switch {
			case resume == nil:
				return nil
			case resume.GetKeyId() == keyID && len(resume.GetKey()) == relayresume.KeyLen:
				return resume.GetKey()
			case resume.GetPrevKeyId() != "" && resume.GetPrevKeyId() == keyID && len(resume.GetPrevKey()) == relayresume.KeyLen:
				return resume.GetPrevKey()
			}
			return nil
		},
		// Rechecked on every resume: the endpoint is still assigned here and
		// still lists the route (the relay's admission and the revocation
		// fences already ran for the tunnel).
		Authorize: func() error {
			if p.targetRouteResume(owner) == nil {
				return errors.New("route is no longer resumable on this endpoint")
			}
			return nil
		},
	}, true
}

// targetRouteResume is the route's entry in the current endpoint assignment
// of owner (a copy), nil when the endpoint or the route is gone.
func (p *DockerPlugin) targetRouteResume(owner relayTargetTag) *pb.RelayRouteResume {
	var found *pb.RelayRouteResume
	p.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		assignment := findRelayAssignment(bundle, "endpoint", owner.ownerKind, owner.ownerID)
		for _, resume := range assignment.GetResumeRoutes() {
			if resume.GetRouteId() == owner.routeID && resume.GetVersion() == relayresume.Version {
				found = &pb.RelayRouteResume{RouteId: resume.GetRouteId(), Version: resume.GetVersion(), KeyId: resume.GetKeyId(),
					Key: append([]byte(nil), resume.GetKey()...), PrevKeyId: resume.GetPrevKeyId(), PrevKey: append([]byte(nil), resume.GetPrevKey()...)}
			}
		}
	})
	return found
}

// serveResumableTunnel serves a new resumable stream: dial the backend as for
// a raw tunnel, answer HELLO_ACK, and bridge the backend over the session on
// its own goroutine. The session outlives this tunnel (and the registration
// it came through); the tunnel lives until the session gives it up.
func (r *relayTunnelRouter) serveResumableTunnel(ctx context.Context, assignment *pb.RelayGrantAssignment, accepted *relayresume.Accepted, stream relayv1.TunnelBroker_AcceptTunnelClient, setup func()) {
	dialed, err := r.dialEndpoint(ctx, assignment)
	if err != nil {
		if !errors.Is(err, errEndpointNotServed) {
			r.tunnelFailed(assignment, "dial", err)
			_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "endpoint_unavailable", Message: "Endpoint is unavailable"}}})
		}
		return
	}
	tag := relayTargetTag{ownerKind: assignment.GetOwnerKind(), ownerID: assignment.GetOwnerId()}
	session, err := accepted.EstablishTagged(tag)
	if err != nil {
		_ = dialed.conn.Close()
		r.tunnelFailed(assignment, "resume", err)
		return
	}
	r.plugin.relayTunnelOutcomes.Succeeded(r.plugin.logger, relayTunnelOutcome(assignment))
	go r.plugin.bridgeTargetSession(assignment, session, dialed, setup)
	<-accepted.PathDone
}

// bridgeTargetSession carries a resumable target stream until it ends. setup
// ends its setup for a handover once the bridge is registered.
func (p *DockerPlugin) bridgeTargetSession(assignment *pb.RelayGrantAssignment, session *relayresume.Session, dialed dialedEndpoint, setup func()) {
	defer setup()
	connection := dialed.conn
	if dialed.postgres != nil {
		linked, err := p.databaseManager.prepareLinkConnection(context.Background(), connection, *dialed.postgres, session, session.Cancel)
		if err != nil {
			p.logger.Debug("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId, "stage", "postgres", "error", err)
			session.Abort(relayresume.RstLocal, "PostgreSQL link negotiation failed")
			return
		}
		connection = linked
	}
	p.bridgeTargetConnection(assignment.GetOwnerKind(), assignment.GetOwnerId(), session, connection, dialed.ingress, setup)
}

// bridgeTargetConnection carries the backend connection of a resumable target
// stream of an endpoint of ownerKind until the stream ends or the daemon hands
// it to its next process. started, if set, is called once the bridge is
// registered (handover.BridgeConfig.Started).
func (p *DockerPlugin) bridgeTargetConnection(ownerKind, ownerID string, session *relayresume.Session, connection net.Conn, ingress bool, started func()) {
	labels := handover.Labels{handoverRole: handoverRoleTarget, handoverOwnerKind: ownerKind, handoverOwnerID: ownerID,
		handoverConnector: connectionConnector(connection)}
	cutClass := linkCutClass(connection)
	if ingress {
		// Tracked so a restart finishes the request in flight and closes the
		// stream once it is idle (B-13).
		tracked := newDrainConn(connection)
		connection = tracked
		if ownerKind == containerLinkOwnerKind {
			defer p.proxyTunnels.addHeld(tracked, session.Cancel)()
		} else {
			defer p.proxyTunnels.add(tracked, session.Cancel)()
		}
	} else {
		keepLocalAlive(connection)
	}
	defer connection.Close()
	// No idle limit of its own, as acceptIncoming: the relay ends the idle tunnels of a route that has one.
	_ = p.handover.Bridge(connection, session, handover.BridgeConfig{ReadChunk: p.relayReadChunkFor(ownerKind, session), Labels: labels,
		CutClass: cutClass, Started: started})
	session.Cancel()
}

// relayStreamsOnBundle applies a new grant bundle to the resumable streams.
// A source whose relay stays in the assignment stays on it and on its path
// while the generation its grant belongs to drains; once that generation is
// gone it re-paths onto the same relay under the new grant
// (relaybridge.PlaceStream), spread over a few seconds.
// Sources whose relay leaves the assignment or drains as a whole move (paced
// to the drain deadline), sources and targets whose route or endpoint Opfield
// no longer assigns end, and targets ask their sources to move off relays
// that leave.
func (p *DockerPlugin) relayStreamsOnBundle() {
	sides := p.relayStreams()
	bundle := p.relayGrants.get()
	// A route Opfield turned on again (a new key) is tried resumable again
	// even if its target answered raw before (the legacy latch).
	routes := map[string]bool{}
	for _, assignment := range bundle.GetGrants() {
		if assignment.GetRole() != "connect" || assignment.GetRouteId() == "" {
			continue
		}
		keyID, _, _ := streamResumeKey(assignment)
		routes[assignment.GetRouteId()] = true
		sides.sources.NoteRouteKey(assignment.GetRouteId(), keyID)
	}
	sides.sources.ForgetRoutes(func(routeID string) bool { return routes[routeID] })
	for _, session := range sides.sources.Sessions() {
		tag, _ := session.Tag().(relaySourceTag)
		assignment := findRelayAssignment(bundle, "connect", tag.ownerKind, tag.ownerID)
		if assignment == nil || assignment.GetRouteId() != tag.routeID {
			session.Abort(relayresume.RstRevoked, "route is no longer assigned")
			continue
		}
		relayID, generation, ok := session.CurrentPath()
		if !ok {
			// Suspended: the unplanned loop picks a relay of the new bundle anyway.
			continue
		}
		action, deadline := relaybridge.PlaceStream(assignment, relayID, generation)
		switch action {
		case relaybridge.StreamRegrants:
			sides.sources.Repath(session, relayresume.TriggerRegrant, relaybridge.RegrantAt(deadline))
		case relaybridge.StreamLeaves:
			if !p.otherRelayServes(assignment, relayID) {
				// Nowhere to go yet: the stream stays; a later bundle, the
				// relay's GOAWAY or its loss moves it.
				continue
			}
			sides.sources.Migrate(session, relayresume.TriggerDrain, deadline)
		}
	}
	sides.targets.Prune(func(_ relayresume.TargetKey, session *relayresume.Session) bool {
		tag, _ := session.Tag().(relayTargetTag)
		return findRelayAssignment(bundle, "endpoint", tag.ownerKind, tag.ownerID) != nil
	})
	for _, session := range sides.targets.Sessions() {
		tag, _ := session.Tag().(relayTargetTag)
		relayID := session.RelayID()
		assignment := findRelayAssignment(bundle, "endpoint", tag.ownerKind, tag.ownerID)
		// A relay that stays in the endpoint's assignment keeps its streams:
		// the sources re-path under their own new grant.
		if relayID == "" || relaybridge.RelayStays(assignment, relayID) {
			continue
		}
		for _, candidate := range assignment.GetCandidates() {
			if candidate.GetRelayInstanceId() == relayID && candidate.GetAssignmentState() == "draining" {
				session.RequestMigrate(relayresume.MigrateDrain)
				break
			}
		}
	}
}

// otherRelayServes reports another active or staging relay of assignment with a transport that is up: a stream
// leaving relayID has somewhere to go. A staging relay serves too: better than staying until the drain is forced.
func (p *DockerPlugin) otherRelayServes(assignment *pb.RelayGrantAssignment, relayID string) bool {
	for _, candidate := range relaybridge.PreparedCandidates(assignment) {
		if candidate.GetRelayInstanceId() == relayID {
			continue
		}
		if state := candidate.GetAssignmentState(); state != "active" && state != "staging" {
			continue
		}
		if router := p.relayRouter(candidate.GetRelayInstanceId()); router != nil && router.connected() {
			return true
		}
	}
	return false
}

var _ lifecycle.RelayLaneStatePlugin = (*DockerPlugin)(nil)

// RelayLaneLeftReady moves the resumable streams off a relay whose tunnel
// lane left the connected state: a stopping relay's GOAWAY keeps existing
// streams for seconds only. Sources move themselves; targets ask theirs.
func (p *DockerPlugin) RelayLaneLeftReady(relayInstanceID string, conn *grpc.ClientConn) {
	router := p.relayRouter(relayInstanceID)
	if router != nil && router.conn == conn {
		// A relay whose lane dropped takes no returning stream until it was stable again for a while.
		p.relayStability.Broke(relayInstanceID)
	}
	sides := p.relayStreamsIfAny()
	if router == nil || router.conn != conn || sides == nil {
		return
	}
	sides.sources.RelayLost(relayInstanceID)
	sides.targets.RequestMigrate(relayInstanceID, relayresume.MigrateGoAway)
}

// relayStreamStats is the node's RSv1 report: sources count each stream once
// (by relay, resumable or raw); targets add what only they see.
func (p *DockerPlugin) relayStreamStats() *pb.RelayStreamStats {
	sides := p.relayStreamsIfAny()
	if sides == nil {
		return nil
	}
	source, target := sides.sources.Stats(), sides.targets.Stats()
	stats := &pb.RelayStreamStats{
		ResumableSessions:       source.Resumable,
		LegacySessions:          source.Legacy,
		SuspendedSessions:       source.Suspended + target.Suspended,
		MigrationsOkTotal:       source.MigrationsOK,
		MigrationsFailedTotal:   source.MigrationsFailed,
		CutTotal:                source.Cut,
		RetransmittedBytesTotal: source.Retransmitted,
		UnackedBytes:            source.Unacked,
		MigrationStallP50Ms:     uint32(source.StallP50.Milliseconds()),
		MigrationStallP95Ms:     uint32(source.StallP95.Milliseconds()),
		ResumeRefusedTotal:      target.Refused,
		LaneRotationsTotal:      relaylane.Rotations.Load(),
		LaneMovesTotal:          source.LaneMoves,
	}
	relays := make([]string, 0, len(source.ByRelay))
	for relay := range source.ByRelay {
		relays = append(relays, relay)
	}
	sort.Strings(relays)
	for _, relay := range relays {
		counts := source.ByRelay[relay]
		stats.ByRelay = append(stats.ByRelay, &pb.RelayStreamRelaySessions{RelayInstanceId: relay, Resumable: counts[0], Legacy: counts[1]})
	}
	return stats
}
