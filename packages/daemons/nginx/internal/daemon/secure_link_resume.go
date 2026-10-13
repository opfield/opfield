package daemon

import (
	"context"
	"errors"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/logepisode"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

// Resumable Secure Link streams (RSv1). A connect assignment that carries
// stream_resume makes the stream of every new connection resumable: it moves
// to another relay (or to the same relay after its restart) on a drain
// notice, a lane GOAWAY, a path failure or a hint from the target, without
// nginx or the upstream seeing the connection break. Assignments without it,
// and routes whose target turned out not to be resume-aware, keep raw
// streams exactly as before.

// relayStreamTag names the link a resumable stream belongs to.
type relayStreamTag struct {
	ownerKind string
	linkID    string
}

func newRelayStreamManager(plugin *NginxPlugin) *relayresume.Manager {
	manager := relayresume.NewManager(nil)
	manager.OnMigration = plugin.relayStreamMigrated
	manager.OnEnd = plugin.relayStreamEnded
	return manager
}

func relayStreamSubject(tag any) (logepisode.Subject, bool) {
	link, ok := tag.(relayStreamTag)
	if !ok {
		return logepisode.Subject{}, false
	}
	name := "proxy secure-link streams"
	if link.ownerKind == registrySecureLinkOwnerKind {
		name = "registry ingress streams"
	}
	return logepisode.Subject{Name: name, IDAttr: "link_id", ID: link.linkID}, true
}

// relayStreamMoveUnplanned is a move forced by a broken path. The others (a new generation, the return to the
// nearest relay, a drain, a relay's GOAWAY, a target's hint) are planned and say nothing about the path's health.
func relayStreamMoveUnplanned(trigger relayresume.Trigger) bool {
	return trigger == relayresume.TriggerPathFailure
}

// relayStreamMigrated logs moves per link and state change: a stream moved off a
// broken path was served, but its relay path was not healthy. Planned moves log at
// debug only.
func (p *NginxPlugin) relayStreamMigrated(event relayresume.MigrationEvent) {
	subject, ok := relayStreamSubject(event.Session.Tag())
	if !ok || p.logger == nil {
		return
	}
	if !event.OK {
		p.logger.Debug("relay stream did not move", "link_id", subject.ID, "trigger", string(event.Trigger),
			"relay_instance_id", event.From, "error", errorText(event.Err))
		return
	}
	if !relayStreamMoveUnplanned(event.Trigger) {
		p.logger.Debug("relay stream moved", "link_id", subject.ID, "trigger", string(event.Trigger),
			"from_relay", event.From, "to_relay", event.To, "paused", event.Stall.Round(time.Millisecond).String())
		return
	}
	p.relayStreamOutcomes.Retried(p.logger, subject, "trigger", string(event.Trigger), "from_relay", event.From,
		"to_relay", event.To, "paused", event.Stall.Round(time.Millisecond).String())
}

// relayStreamEnded logs a resumable stream that ended because it could not
// move (no relay came back, the target refused the resume).
func (p *NginxPlugin) relayStreamEnded(session *relayresume.Session, err error) {
	if err == nil || p.logger == nil {
		return
	}
	var reset *relayresume.ResetError
	if !errors.As(err, &reset) || reset.Remote || !relayStreamCut(err, reset) {
		return
	}
	subject, ok := relayStreamSubject(session.Tag())
	if !ok {
		return
	}
	if reset.Reject == relayresume.RejectUnknown {
		// The target no longer knows the stream: its daemon restarted without taking it over (an update from or onto
		// a daemon without live handover, or a service restart). The cut is the target's, expected, and its node's
		// last update reports it; nothing is wrong with this daemon's path.
		p.relayStreamTargetCuts.Noted(p.logger, subject, "cut by their target",
			"reason", "the target daemon restarted without taking the stream over", "error", err.Error())
		return
	}
	p.relayStreamOutcomes.Failed(p.logger, subject, "stage", "resume", "error", err.Error())
}

func relayStreamCut(err error, reset *relayresume.ResetError) bool {
	return reset.Reject != 0 || errors.Is(err, relayresume.ErrSuspendTimeout) || errors.Is(err, relayresume.ErrNotResumable) ||
		errors.Is(err, relayresume.ErrRevoked)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// resumeConfig returns the source configuration of a link's new streams, or
// false when they stay raw.
func (p *NginxPlugin) resumeConfig(ownerKind, linkID string, assignment *pb.RelayGrantAssignment) (relayresume.SourceConfig, bool) {
	resume := assignment.GetStreamResume()
	routeID := assignment.GetRouteId()
	if p.relayStreams == nil || !usableStreamResume(resume) || routeID == "" || p.relayStreams.Legacy(routeID) {
		return relayresume.SourceConfig{}, false
	}
	return relayresume.SourceConfig{
		RouteID: routeID,
		// The latest bundle's key signs every RESUME (rotation); a link whose
		// route lost resumability cannot move any more.
		Key: func() (string, []byte, bool) {
			current := p.relayGrants.lookup("connect", ownerKind, linkID)
			resume := current.GetStreamResume()
			if current == nil || current.GetRouteId() != routeID || !usableStreamResume(resume) {
				return "", nil, false
			}
			return resume.GetKeyId(), resume.GetKey(), true
		},
		HalfCloseTimeout: time.Duration(resume.GetHalfCloseTimeoutMs()) * time.Millisecond,
		Dial: func(ctx context.Context, request relayresume.DialRequest) (relayresume.OpenedPath, error) {
			return p.dialRelayStreamPath(ctx, ownerKind, linkID, request)
		},
		Wake: p.relayPathWake.Wait,
		Tag:  relayStreamTag{ownerKind: ownerKind, linkID: linkID},
	}, true
}

func usableStreamResume(resume *pb.RelayStreamResume) bool {
	return resume != nil && resume.GetVersion() == relayresume.Version && resume.GetKeyId() != "" &&
		len(resume.GetKeyId()) <= relayresume.MaxKeyIDLen && len(resume.GetKey()) == relayresume.KeyLen
}

// dialRelayStreamPath opens a fresh tunnel for a moving stream on the link's
// current assignment, in tunnel order (distance first): active candidates
// first, then staging ones (registered on both ends: when the only active
// relay drains or was force-disconnected the stream moves there instead of
// being cut), a relay the stream has to leave (request.Avoid) last. A relay
// that stays in the assignment is not avoided: a stream whose grant
// generation drains re-paths onto it under the new grant. When the best path
// is the one the stream is on, it answers relayresume.ErrStay.
func (p *NginxPlugin) dialRelayStreamPath(ctx context.Context, ownerKind, linkID string, request relayresume.DialRequest) (relayresume.OpenedPath, error) {
	assignment := p.relayGrants.lookup("connect", ownerKind, linkID)
	if assignment == nil {
		return relayresume.OpenedPath{}, errors.New("the link has no relay grant")
	}
	candidates := relaybridge.PoolCandidates(assignment, true)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	route := secureLinkRouteKey(ownerKind, linkID)
	ordered := relayStreamDialOrder(p.orderRelayCandidates(route, candidates, request.FromRelay), request.Avoid, p.relayLaneConnected)
	lastErr := errors.New("no relay lane is ready")
	for _, candidate := range ordered {
		if ctx.Err() != nil {
			return relayresume.OpenedPath{}, ctx.Err()
		}
		if !request.NewPath && request.Avoid == "" && request.FromGeneration != 0 && candidate.GetRelayInstanceId() == request.FromRelay &&
			candidate.GetAssignmentGeneration() == request.FromGeneration && p.relayLaneConnected(request.FromRelay) {
			return relayresume.OpenedPath{}, relayresume.ErrStay
		}
		// A relay demoted for its admission pressure takes what it refused only at a paced rate: every moving
		// stream's attempts would otherwise reach it (a policy change re-paths all of them at once).
		if err := p.relayPenalties.HoldDemoted(candidate.GetRelayInstanceId(), route); err != nil {
			lastErr = err
			continue
		}
		tunnel := p.selectRelayTunnel(candidate.GetRelayInstanceId())
		if tunnel == nil {
			continue
		}
		grant := relaybridge.GrantForCandidate(candidate)
		if grant == nil {
			tunnel.active.Add(-1)
			continue
		}
		path, err := openRelayStreamPath(ctx, tunnel, grant)
		if err == nil {
			p.relayPenalties.Opened(p.logger, tunnel.targetID, route, nil)
			path.Generation = candidate.GetAssignmentGeneration()
			return path, nil
		}
		if ctx.Err() == nil {
			p.relayPenalties.Opened(p.logger, tunnel.targetID, route, err)
		}
		lastErr = err
	}
	return relayresume.OpenedPath{}, lastErr
}

// relayStreamDialOrder keeps the usual order within each rank: relays with a
// connected lane before the others (a dead lane costs a whole open timeout),
// active before staging, the relay being left last.
func relayStreamDialOrder(ordered []*pb.RelayDataCandidate, avoidRelayID string, connected func(string) bool) []*pb.RelayDataCandidate {
	rank := func(candidate *pb.RelayDataCandidate) int {
		rank := 0
		if avoidRelayID != "" && candidate.GetRelayInstanceId() == avoidRelayID {
			rank += 4
		}
		if !connected(candidate.GetRelayInstanceId()) {
			rank += 2
		}
		if candidate.GetAssignmentState() == "staging" {
			rank++
		}
		return rank
	}
	sort.SliceStable(ordered, func(i, j int) bool { return rank(ordered[i]) < rank(ordered[j]) })
	return ordered
}

// relayLaneConnected reports a relay with at least one connected lane.
func (p *NginxPlugin) relayLaneConnected(relayID string) bool {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	for _, tunnel := range p.relayTunnels {
		if tunnel.targetID == relayID && tunnel.connected() {
			return true
		}
	}
	return false
}

// openRelayStreamPath opens one tunnel on a lane the caller selected (its
// active count already taken) within OpenTimeout. The stream lives on the
// lane, not on the dial: the path's Cancel ends it and gives the lane back.
func openRelayStreamPath(ctx context.Context, tunnel *nginxRelayTunnel, grant *pb.RelaySignedGrant) (relayresume.OpenedPath, error) {
	streamCtx, cancel := context.WithCancel(tunnel.ctx)
	release := relayStreamPathRelease(tunnel, cancel)
	setup := time.AfterFunc(relayresume.OpenTimeout, cancel)
	stopDial := context.AfterFunc(ctx, cancel)
	fail := func(err error) (relayresume.OpenedPath, error) {
		setup.Stop()
		stopDial()
		release()
		return relayresume.OpenedPath{}, err
	}
	stream, err := tunnel.client.OpenTunnel(streamCtx)
	if err != nil {
		return fail(err)
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}}); err != nil {
		return fail(err)
	}
	first, err := stream.Recv()
	if err != nil {
		return fail(err)
	}
	if tunnel.socket != nil {
		if header, headerErr := stream.Header(); headerErr == nil {
			tunnel.trigger.NoteHeader(header)
		}
	}
	if first.GetReady() == nil {
		code := "unexpected_frame"
		if relayError := first.GetError(); relayError != nil {
			code = relayError.GetCode()
		}
		return fail(errors.New("relay refused the tunnel: " + code))
	}
	if !setup.Stop() || !stopDial() {
		return fail(errors.New("relay tunnel setup timed out"))
	}
	return relayresume.OpenedPath{
		Stream: stream, Cancel: release, CloseSend: stream.CloseSend,
		RelayID: tunnel.targetID, MaxFrame: int(first.GetReady().GetMaxFrameBytes()), Lane: tunnel,
	}, nil
}

// relayStreamPathRelease ends a path's stream and gives its lane slot back,
// once.
func relayStreamPathRelease(tunnel *nginxRelayTunnel, cancel context.CancelFunc) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			tunnel.active.Add(-1)
		})
	}
}

// bridgeRelayStream serves a connection over a resumable stream whose first
// path is the tunnel just opened. It reports false when the link's streams
// stay raw (the caller bridges the tunnel itself).
func (p *NginxPlugin) bridgeRelayStream(ownerKind, linkID string, connection net.Conn, tunnel *nginxRelayTunnel, stream relayv1.TunnelBroker_OpenTunnelClient, cancel context.CancelFunc, maxFrame, readChunk int, generation uint64, carried func()) bool {
	assignment := p.relayGrants.lookup("connect", ownerKind, linkID)
	config, ok := p.resumeConfig(ownerKind, linkID, assignment)
	if !ok {
		return false
	}
	first := relayresume.OpenedPath{
		Stream: stream, Cancel: relayStreamPathRelease(tunnel, cancel), CloseSend: stream.CloseSend,
		RelayID: tunnel.targetID, MaxFrame: maxFrame, Generation: generation, Lane: tunnel,
	}
	session, err := p.relayStreams.NewSource(config, first)
	if err != nil {
		p.logger.Debug("relay stream stays raw", "link_id", linkID, "error", err)
		return false
	}
	cutClass := ""
	if ownerKind == registrySecureLinkOwnerKind {
		// Its pull or push ends at a docker node's registry proxy, whose TLS
		// session an update of that node cuts anyway: it stays here.
		cutClass = cutRegistry
	}
	if tracked, ok := connection.(*trackedConn); ok && cutClass == "" {
		tracked.resumable.Store(true)
	}
	// The stream outlives this lane: only the connection and the session end it, or an update hands both to the
	// next process (live_handover.go).
	_ = p.handover.Bridge(connection, session, handover.BridgeConfig{ReadChunk: relayresume.ReadChunk(readChunk),
		Labels: handover.Labels{handoverOwnerKind: ownerKind, handoverLinkID: linkID}, CutClass: cutClass, Started: carried})
	session.Cancel()
	return true
}

// moveRelayStreams answers a grant bundle change: a resumable stream whose
// relay stays in the link's assignment stays on it (and on its path while its
// generation drains), re-pathing under the new grant once that generation is
// gone (relaybridge.PlaceStream); a stream whose relay leaves the assignment or
// drains as a whole moves, paced to the drain deadline Opfield set.
func (p *NginxPlugin) moveRelayStreams() {
	if p.relayStreams == nil || p.relayGrants == nil {
		return
	}
	// A route Opfield turned on again (a new key) is tried resumable again
	// even if its target answered raw before (the legacy latch).
	bundle := p.relayGrants.get()
	routes := map[string]bool{}
	for _, assignment := range bundle.GetGrants() {
		if assignment.GetRole() != "connect" || assignment.GetRouteId() == "" {
			continue
		}
		keyID := ""
		if resume := assignment.GetStreamResume(); usableStreamResume(resume) {
			keyID = resume.GetKeyId()
		}
		routes[assignment.GetRouteId()] = true
		p.relayStreams.NoteRouteKey(assignment.GetRouteId(), keyID)
	}
	p.relayStreams.ForgetRoutes(func(routeID string) bool { return routes[routeID] })
	for _, session := range p.relayStreams.Sessions() {
		link, ok := session.Tag().(relayStreamTag)
		if !ok {
			continue
		}
		relayID, generation, ok := session.CurrentPath()
		if !ok {
			continue
		}
		assignment := p.relayGrants.lookup("connect", link.ownerKind, link.linkID)
		if assignment == nil {
			// The link is gone: closeActive ends its connections.
			continue
		}
		if len(assignment.GetCandidates()) == 0 {
			if relayID != relaybridge.LegacyTargetID {
				// The link went back to its legacy grant, which only the local relay serves.
				p.relayStreams.Migrate(session, relayresume.TriggerDrain, time.Time{})
			}
			continue
		}
		action, deadline := relaybridge.PlaceStream(assignment, relayID, generation)
		switch action {
		case relaybridge.StreamRegrants:
			p.relayStreams.Repath(session, relayresume.TriggerRegrant, relaybridge.RegrantAt(deadline))
		case relaybridge.StreamLeaves:
			// A planned move that finds no other relay keeps the stream where it is.
			p.relayStreams.Migrate(session, relayresume.TriggerDrain, deadline)
		}
	}
}

// startRelayStreamReturner moves resumable streams back to the nearest relay
// of their link once it has been stable for a while (relayresume.Returner).
func (p *NginxPlugin) startRelayStreamReturner(ctx context.Context) {
	if p.relayStreams == nil {
		return
	}
	returner := &relayresume.Returner{Manager: p.relayStreams, Nearer: p.relayStreamNearer, Prepare: p.observeRelayStability}
	go returner.Run(ctx)
}

// relayStreamNearer reports a stream on relayID whose link has a clearly
// nearer relay that has been stable for relaybridge.ReturnStableFor
// (relaybridge.ReturnTarget).
func (p *NginxPlugin) relayStreamNearer(session *relayresume.Session, relayID string) bool {
	link, ok := session.Tag().(relayStreamTag)
	if !ok {
		return false
	}
	assignment := p.relayGrants.lookup("connect", link.ownerKind, link.linkID)
	if assignment == nil {
		return false
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	transports := relaybridge.StableTransports(p.relayTransportLoads(secureLinkRouteKey(link.ownerKind, link.linkID)), &p.relayStability, relayID)
	_, nearer := relaybridge.ReturnTarget(candidates, transports, p.relayRTTFunc(), relayID)
	return nearer
}

// observeRelayStability samples whether each relay has a connected lane, before a return pass.
func (p *NginxPlugin) observeRelayStability() {
	p.relayTunnelMu.Lock()
	connected := map[string]bool{}
	for _, tunnel := range p.relayTunnels {
		connected[tunnel.targetID] = connected[tunnel.targetID] || tunnel.connected()
	}
	p.relayTunnelMu.Unlock()
	for id, up := range connected {
		p.relayStability.Observe(id, up)
	}
	p.relayStability.Forget(func(id string) bool { _, ok := connected[id]; return ok })
}

var _ lifecycle.RelayLaneStatePlugin = (*NginxPlugin)(nil)

// RelayLaneLeftReady moves the streams on a relay at once when a pool lane to
// it stops being ready: GOAWAY from a stopping relay (its open streams live a
// few seconds more), or a lane that broke. Every lane to a relay goes through
// it, so the whole relay is left; a planned move that finds no other relay
// keeps the stream where it is.
func (p *NginxPlugin) RelayLaneLeftReady(relayInstanceID string, _ *grpc.ClientConn) {
	// A relay whose lane dropped takes no returning stream until it was stable again for a while.
	p.relayStability.Broke(relayInstanceID)
	if p.relayStreams != nil {
		p.relayStreams.RelayLost(relayInstanceID)
	}
}

// watchRelayLane does what RelayLaneLeftReady does for the pre-pool lane,
// which the lifecycle does not report.
func (p *NginxPlugin) watchRelayLane(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	if conn == nil || p.relayStreams == nil {
		return
	}
	state := conn.GetState()
	for conn.WaitForStateChange(ctx, state) {
		next := conn.GetState()
		if state == connectivity.Ready && next != connectivity.Ready {
			p.relayStability.Broke(relayID)
			p.relayStreams.RelayLost(relayID)
		}
		state = next
	}
}

// relayStreamStatsReport is the health report's view of the stream sessions.
func relayStreamStatsReport(stats relayresume.SourceStats) *pb.RelayStreamStats {
	report := &pb.RelayStreamStats{
		ResumableSessions:       stats.Resumable,
		LegacySessions:          stats.Legacy,
		SuspendedSessions:       stats.Suspended,
		MigrationsOkTotal:       stats.MigrationsOK,
		MigrationsFailedTotal:   stats.MigrationsFailed,
		CutTotal:                stats.Cut,
		RetransmittedBytesTotal: stats.Retransmitted,
		UnackedBytes:            stats.Unacked,
		MigrationStallP50Ms:     uint32(stats.StallP50.Milliseconds()),
		MigrationStallP95Ms:     uint32(stats.StallP95.Milliseconds()),
		LaneRotationsTotal:      relaylane.Rotations.Load(),
		LaneMovesTotal:          stats.LaneMoves,
	}
	for relayID, counts := range stats.ByRelay {
		report.ByRelay = append(report.ByRelay, &pb.RelayStreamRelaySessions{RelayInstanceId: relayID, Resumable: counts[0], Legacy: counts[1]})
	}
	return report
}
