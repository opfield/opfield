package docker

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/handover"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/logepisode"
	"github.com/wiolett-industries/gateway/daemon-shared/netaccept"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const databaseTunnelMaxChunkBytes = 1024 * 1024

// writeDatabaseTunnelBytes writes all of data.
func writeDatabaseTunnelBytes(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

var _ lifecycle.RelayPoolTunnelPlugin = (*DockerPlugin)(nil)

type relayTunnelRouter struct {
	plugin        *DockerPlugin
	ctx           context.Context
	conn          *grpc.ClientConn
	client        relayv1.TunnelBrokerClient
	targetID      string
	mu            sync.Mutex
	registrations map[string]*relayEndpointRegistration
	accepted      map[*acceptedRelayTunnel]struct{}
	listener      net.Listener
	active        atomic.Int64
	// transportReady closes (and is replaced) whenever the relay transport
	// connects again, so registrations waiting out their backoff retry at once.
	transportReady chan struct{}
	// The relay's lanes for source tunnels (relay_lanes.go): conn, which also
	// carries the registrations, and the other lanes the pool opened.
	lanesMu     sync.Mutex
	primaryLane *relaySourceLane
	extraLanes  []*relaySourceLane
	// Lane rotation (relay_lanes.go), under lanesMu: lanes replaced and still carrying tunnels, when each pool lane's
	// slot was last rotated, and whether a rotation of this relay's lanes runs.
	retiringLanes []*relaySourceLane
	laneRotatedAt map[*relaySourceLane]time.Time
	rotating      bool
	lastRotation  time.Time
}

type relayEndpointRegistration struct {
	cancel context.CancelFunc
	renew  chan relayRegistrationUpdate
	ready  atomic.Bool
	// done closes when the registration stream and its tunnels have ended.
	done chan struct{}
	// The assignment and serving state last handed to the registration. An identical pair is not
	// renewed again: Gateway resends unchanged bundles, and each renewal is a relay round trip.
	latest *pb.RelayGrantAssignment
	state  relayv1.EndpointServingState
	// restartAck closes once the relay confirmed a RESTARTING renewal (B-13);
	// guarded by the router's mu.
	restartAck chan struct{}
}

// relayRegistrationUpdate is what one registration sends the relay: its grant and whether the
// endpoint takes traffic (D6, D7).
type relayRegistrationUpdate struct {
	assignment *pb.RelayGrantAssignment
	state      relayv1.EndpointServingState
}

// BackupRelayRoute is a daemon-local TCP entrypoint for one signed, per-run
// relay connect grant. It accepts concurrent helper connections until Close;
// it neither opens a host port nor accepts an upstream endpoint supplied by
// Gateway.
type BackupRelayRoute struct {
	Address  string
	listener net.Listener
	cancel   context.CancelFunc
	done     chan struct{}
	once     sync.Once
	active   sync.WaitGroup
}

func (r *BackupRelayRoute) Close() {
	if r == nil {
		return
	}
	r.once.Do(func() {
		r.cancel()
		_ = r.listener.Close()
		<-r.done
	})
}

func (p *DockerPlugin) RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, _ string) {
	p.RunRelayTargetTunnels(ctx, conn, "", relaybridge.LegacyTargetID)
}

func (p *DockerPlugin) RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, _ string, relayInstanceID string) {
	p.relayTunnelMu.Lock()
	if p.relayTunnels == nil {
		p.relayTunnels = map[string]*relayTunnelRouter{}
	}
	if existing := p.relayTunnels[relayInstanceID]; existing != nil && existing.ctx.Err() == nil {
		// Another lane of the relay's pool: it carries source tunnels, the
		// first lane keeps the endpoint registrations.
		lane := existing.addLane(conn)
		p.relayTunnelMu.Unlock()
		<-ctx.Done()
		existing.removeLane(lane)
		return
	}
	// A router whose lanes ended is replaced; its own cleanup leaves the new one in place.
	router := &relayTunnelRouter{plugin: p, ctx: ctx, conn: conn, client: relayv1.NewTunnelBrokerClient(conn), targetID: relayInstanceID, registrations: map[string]*relayEndpointRegistration{}, transportReady: make(chan struct{})}
	p.relayTunnels[relayInstanceID] = router
	p.relayTunnelMu.Unlock()
	go router.watchTransport(ctx, conn)
	go router.rotateLanes(ctx)
	defer func() {
		router.stop()
		p.relayTunnelMu.Lock()
		if p.relayTunnels[relayInstanceID] == router {
			delete(p.relayTunnels, relayInstanceID)
		}
		p.relayTunnelMu.Unlock()
	}()
	router.reconcileRegistrations()
	router.reconcileAfterRestoreHold(ctx)
	p.lease.attachRelay(ctx, conn, relayInstanceID)
	<-ctx.Done()
}

func (p *DockerPlugin) RelayTunnelTargets() []lifecycle.RelayTunnelTarget {
	targets := relaybridge.RequiredTargets(p.relayGrants.get())
	result := make([]lifecycle.RelayTunnelTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, lifecycle.RelayTunnelTarget{
			ID: target.ID, Addresses: relaybridge.TargetAddresses(target), CertificateIdentity: target.CertificateIdentity,
			CertificateFingerprint: target.CertificateFingerprint,
		})
	}
	return result
}

func (p *DockerPlugin) RelayTunnelLaneCount() int {
	lanes := int(p.relayGrants.get().GetDataLanes())
	if lanes < 1 {
		return 4
	}
	return lanes
}

func (p *DockerPlugin) RelayTunnelRuntimeChanged() <-chan struct{} {
	return p.relayGrants.changed
}

// reconcileRegistrations returns the done channels of the registrations it
// cancelled, so a lease release can wait until they are gone (A6).
func (r *relayTunnelRouter) reconcileRegistrations() []chan struct{} {
	if r.plugin.restartAnnounced.Load() {
		// The relays hold these registrations for the next process (B-13).
		return nil
	}
	bundle := r.plugin.relayGrants.get()
	r.enforceRevocationFences(bundle)
	if r.plugin.relayGrants.registrationHold(time.Now()) > 0 {
		// Grants restored from disk may predate the relay's policy and no
		// registration exists yet: wait for Gateway's bundle (relayGrantRestoreHold).
		return nil
	}
	desired := map[string]relayRegistrationUpdate{}
	if r.plugin.cfg.Docker.IsStorageProfile() {
		for _, assignment := range bundle.Grants {
			if assignment.Role == "endpoint" && (isManagedStorageRelayOwnerKind(assignment.OwnerKind) || isManagedDatabaseRelayOwnerKind(assignment.OwnerKind)) && assignment.EndpointId != "" {
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = relayRegistrationUpdate{assignment: projected}
				}
			}
		}
	} else {
		for _, assignment := range bundle.Grants {
			// A container link's target is an ingress binding of the shared connector, like a proxy secure link's.
			if assignment.Role == "endpoint" && isConnectorIngressOwnerKind(assignment.OwnerKind) && assignment.EndpointId != "" {
				// Availability members register on every assigned relay, dormant
				// until they serve and their workload is ready (D6, D7).
				state := r.plugin.memberEndpointState(assignment.OwnerId)
				for _, projected := range assignmentsForRelayTarget(assignment, r.targetID) {
					desired[relayRegistrationKey(projected)] = relayRegistrationUpdate{assignment: projected, state: state}
				}
			}
		}
	}
	var cancelled []chan struct{}
	r.mu.Lock()
	removed, renewed := 0, 0
	for id, registration := range r.registrations {
		update, ok := desired[id]
		if !ok {
			registration.cancel()
			cancelled = append(cancelled, registration.done)
			delete(r.registrations, id)
			removed++
			continue
		}
		if !proto.Equal(registration.latest, update.assignment) || registration.state != update.state {
			registration.latest, registration.state = update.assignment, update.state
			queueLatestRelayGrant(registration.renew, update)
			renewed++
		}
		delete(desired, id)
	}
	for id, update := range desired {
		ctx, cancel := context.WithCancel(r.ctx)
		registration := &relayEndpointRegistration{cancel: cancel, renew: make(chan relayRegistrationUpdate, 1), done: make(chan struct{}), latest: update.assignment, state: update.state}
		r.registrations[id] = registration
		go func() {
			defer close(registration.done)
			r.runRegistration(ctx, update, registration.renew)
		}()
	}
	log := r.plugin.logger.Debug
	if removed > 0 || len(desired) > 0 {
		log = r.plugin.logger.Info
	}
	log("relay endpoint registrations reconciled", "relay_instance_id", r.targetID, "registrations", len(r.registrations),
		"added", len(desired), "removed", removed, "renewed", renewed)
	r.mu.Unlock()
	return cancelled
}

func (p *DockerPlugin) reconcileRelayRegistrations() []chan struct{} {
	p.relayTunnelMu.Lock()
	routers := make([]*relayTunnelRouter, 0, len(p.relayTunnels))
	for _, router := range p.relayTunnels {
		if router != nil {
			routers = append(routers, router)
		}
	}
	p.relayTunnelMu.Unlock()
	var cancelled []chan struct{}
	for _, router := range routers {
		cancelled = append(cancelled, router.reconcileRegistrations()...)
	}
	return cancelled
}

func assignmentsForRelayTarget(assignment *pb.RelayGrantAssignment, targetID string) []*pb.RelayGrantAssignment {
	candidates := relaybridge.PreparedCandidates(assignment)
	if len(candidates) == 0 {
		if targetID != relaybridge.LegacyTargetID {
			return nil
		}
		return []*pb.RelayGrantAssignment{proto.Clone(assignment).(*pb.RelayGrantAssignment)}
	}
	result := make([]*pb.RelayGrantAssignment, 0, len(candidates))
	for _, candidate := range candidates {
		matchesLegacyLocal := targetID == relaybridge.LegacyTargetID && len(candidate.GetAddresses()) == 0
		if candidate.GetRelayInstanceId() != targetID && !matchesLegacyLocal {
			continue
		}
		projected := proto.Clone(assignment).(*pb.RelayGrantAssignment)
		projected.Grant = proto.Clone(candidate.GetGrant()).(*pb.RelaySignedGrant)
		projected.Candidates = []*pb.RelayDataCandidate{proto.Clone(candidate).(*pb.RelayDataCandidate)}
		result = append(result, projected)
	}
	return result
}

func relayRegistrationKey(assignment *pb.RelayGrantAssignment) string {
	generation := uint64(0)
	if len(assignment.GetCandidates()) == 1 {
		generation = assignment.GetCandidates()[0].GetAssignmentGeneration()
	}
	return fmt.Sprintf("%s:%d", assignment.GetEndpointId(), generation)
}

func queueLatestRelayGrant(target chan relayRegistrationUpdate, update relayRegistrationUpdate) {
	select {
	case target <- update:
		return
	default:
	}
	select {
	case <-target:
	default:
	}
	select {
	case target <- update:
	default:
	}
}

// watchTransport wakes registrations that wait out a retry backoff whenever the
// relay transport becomes ready again: a relay coming back is registered with
// at once, while a relay that stays down or keeps refusing is retried slowly.
func (r *relayTunnelRouter) watchTransport(ctx context.Context, conn *grpc.ClientConn) {
	if conn == nil {
		return
	}
	state := conn.GetState()
	if state == connectivity.Ready {
		r.plugin.relayPathWake.Fire()
	}
	for conn.WaitForStateChange(ctx, state) {
		state = conn.GetState()
		if state != connectivity.Ready {
			continue
		}
		r.mu.Lock()
		close(r.transportReady)
		r.transportReady = make(chan struct{})
		r.mu.Unlock()
		r.plugin.relayPathWake.Fire()
	}
}

// connected reports a relay with a transport that is up (any of its lanes). A
// source tunnel opened on a relay whose connections dropped waits for the
// reconnect, which against a relay that stopped answering ends only with the
// connect timeout.
func (r *relayTunnelRouter) connected() bool {
	return r.conn == nil || r.conn.GetState() == connectivity.Ready || r.extraLaneConnected()
}

func (r *relayTunnelRouter) transportReadySignal() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.transportReady == nil {
		r.transportReady = make(chan struct{})
	}
	return r.transportReady
}

// Endpoint registration retries back off exponentially with jitter (N-7): a
// refusing or unreachable relay is otherwise asked once a second per endpoint.
// Lease lanes (lease.Transport) keep their own short retry.
const (
	relayRegistrationRetryInitial = time.Second
	relayRegistrationRetryMax     = 15 * time.Second
	// A registration refused because its grant and the relay's policy do not
	// match yet is retried every relayPolicyCatchUpRetry (jittered) for
	// relayPolicyCatchUpWindow: Gateway pushes the policy to the relays and
	// the grants to the daemons at once, and the slower of the two follows
	// within seconds. Longer than that, the regular backoff applies.
	relayPolicyCatchUpRetry  = 400 * time.Millisecond
	relayPolicyCatchUpWindow = 10 * time.Second
)

// relayRegistrationRetryDelay is the wait before retry number attempt (from 1):
// doubling from one second up to the cap, each drawn uniformly from the upper
// half of the step so endpoints and daemons do not retry in lockstep.
func relayRegistrationRetryDelay(attempt int, random func() float64) time.Duration {
	step := relayRegistrationRetryInitial
	for i := 1; i < attempt && step < relayRegistrationRetryMax; i++ {
		step *= 2
	}
	step = min(step, relayRegistrationRetryMax)
	return step/2 + time.Duration(random()*float64(step/2))
}

// relayPolicyCatchingUp reports a registration the relay refused because the
// grant and its policy do not match yet.
func relayPolicyCatchingUp(err error) bool {
	current, ok := status.FromError(err)
	return ok && current.Code() == codes.PermissionDenied && strings.Contains(current.Message(), "does not match policy")
}

// relayRegistrationPlannedEnd reports a registration that ended on purpose:
// the relay stopped gracefully, or it closed the registration because the
// endpoint's policy moved on (a newer assignment or registration replaces it,
// "endpoint policy was revoked" without another reason).
func relayRegistrationPlannedEnd(err error) bool {
	if connector.PlannedServerStop(err) {
		return true
	}
	current, ok := status.FromError(err)
	return ok && current.Code() == codes.Aborted && current.Message() == "endpoint policy was revoked"
}

// nextRegistrationRetry is the delay before the next registration attempt.
// mismatchFor is how long consecutive attempts have been refused for a
// policy mismatch.
func nextRegistrationRetry(err error, failures int, mismatchFor time.Duration, random func() float64) time.Duration {
	if relayPolicyCatchingUp(err) && mismatchFor < relayPolicyCatchUpWindow {
		return relayPolicyCatchUpRetry/2 + time.Duration(random()*float64(relayPolicyCatchUpRetry/2))
	}
	return relayRegistrationRetryDelay(failures, random)
}

func (r *relayTunnelRouter) runRegistration(ctx context.Context, update relayRegistrationUpdate, renew <-chan relayRegistrationUpdate) {
	current, state := update.assignment, update.state
	failures := 0
	var mismatchSince time.Time
	for ctx.Err() == nil {
		registered := false
		attemptCtx, cancelAttempt := context.WithCancel(ctx)
		stream, err := r.client.RegisterEndpoint(attemptCtx)
		if err == nil {
			err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{Grant: relayGrant(current.Grant), State: state}}})
		}
		if err == nil {
			received := make(chan *relayv1.EndpointControl)
			receiveErr := make(chan error, 1)
			go func() {
				for {
					message, recvErr := stream.Recv()
					if recvErr != nil {
						receiveErr <- recvErr
						return
					}
					select {
					case received <- message:
					case <-attemptCtx.Done():
						return
					}
				}
			}()
			for err == nil {
				select {
				case <-ctx.Done():
					err = ctx.Err()
				case next := <-renew:
					current, state = next.assignment, next.state
					err = stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{Grant: relayGrant(current.Grant), State: state}}})
				case message := <-received:
					if message.GetRegistered() != nil {
						// The relay confirms every renewal the same way; only the first is news.
						log := r.plugin.logger.Debug
						if !registered {
							log = r.plugin.logger.Info
						}
						registered, failures, mismatchSince = true, 0, time.Time{}
						log("relay endpoint registered", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId, "state", state.String())
						r.mu.Lock()
						if registration := r.registrations[relayRegistrationKey(current)]; registration != nil {
							registration.ready.Store(true)
							if state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING && registration.restartAck != nil {
								close(registration.restartAck)
								registration.restartAck = nil
							}
						}
						r.mu.Unlock()
						continue
					}
					if incoming := message.GetIncoming(); incoming != nil {
						// Bind accepted streams to the endpoint registration, not the
						// process. Revoking the assignment therefore cancels existing
						// streams without disturbing unrelated node links.
						// Its setup counts from here, before a restart announcement this loop confirms
						// later: a handover waits for it (handover.Registry.Setup).
						go r.acceptIncoming(ctx, current, incoming, r.plugin.handover.Setup())
					}
				case err = <-receiveErr:
				}
			}
		}
		cancelAttempt()
		if ctx.Err() != nil {
			return
		}
		failures++
		mismatchFor := time.Duration(0)
		if relayPolicyCatchingUp(err) {
			if mismatchSince.IsZero() {
				mismatchSince = time.Now()
			}
			mismatchFor = time.Since(mismatchSince)
		} else {
			mismatchSince = time.Time{}
		}
		delay := nextRegistrationRetry(err, failures, mismatchFor, rand.Float64)
		log := r.plugin.logger.Warn
		switch {
		case failures > 1:
			// The first failure is news; the retries of a relay that stays
			// down or keeps refusing are not (838 lines in 2 min, stand run c).
			log = r.plugin.logger.Debug
		case relayRegistrationPlannedEnd(err):
			// A relay that stops for its update, or a registration Gateway's
			// policy moved (an update of this daemon or a Relay Pool update
			// moving the endpoint to another generation), registers again at
			// once: no failure (rc.10 upgrade run F-4, stand rc.10 O-2).
			log = r.plugin.logger.Info
		}
		log("relay endpoint registration disconnected", "relay_instance_id", r.targetID, "endpoint_id", current.EndpointId, "error", err, "retry_in", delay.Round(time.Millisecond).String(), "failures", failures)
		wake := r.transportReadySignal()
		retry := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			retry.Stop()
			return
		case next := <-renew:
			retry.Stop()
			current, state = next.assignment, next.state
		case <-wake:
			retry.Stop()
		case <-retry.C:
		}
	}
}

// setup ends the tunnel's setup for a handover (handover.Registry.Setup): once a
// resumable stream's bridge is registered, or as soon as the tunnel turns out
// to be anything else.
func (r *relayTunnelRouter) acceptIncoming(ctx context.Context, assignment *pb.RelayGrantAssignment, incoming *relayv1.IncomingTunnel, setup func()) {
	defer setup()
	// Accepted on the least busy lane of the relay, like source tunnels: the
	// relay matches the accept by certificate, not by connection, and every
	// download from this node rode the primary lane (one TCP connection, one
	// HTTP/2 writer) next to the endpoint registration.
	lane := r.sourceLane()
	tunnelCtx, cancel := lane.tunnelContext(ctx)
	defer cancel()
	// Refused tunnels are never accepted: the relay times the opener out.
	release, refusal := r.admitIncoming(assignment, incoming, cancel)
	if refusal != "" {
		return
	}
	defer release()
	stream, err := lane.client.AcceptTunnel(tunnelCtx)
	if err != nil {
		r.tunnelFailed(assignment, "accept", err)
		return
	}
	if err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: incoming.AcceptToken}}}); err != nil {
		r.tunnelFailed(assignment, "authorize", err)
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		if err == nil {
			err = errors.New("relay sent no ready frame")
		}
		r.tunnelFailed(assignment, "ready", err)
		return
	}
	if lane.socket != nil {
		if header, headerErr := stream.Header(); headerErr == nil {
			r.noteLaneHint(lane, header)
		}
	}
	var tunnel relayFrameStream = stream
	if request, ok := r.plugin.targetResumeRequest(assignment, incoming, r.targetID); ok {
		accepted := r.plugin.relayStreams().targets.Accept(relayresume.OpenedPath{Stream: stream, Cancel: cancel, CloseSend: stream.CloseSend,
			RelayID: request.RelayID, MaxFrame: int(first.GetReady().MaxFrameBytes), Lane: lane}, request)
		switch accepted.Kind {
		case relayresume.AcceptLegacy:
			// A raw source during version skew: served exactly as before.
			tunnel = accepted.Stream
		case relayresume.AcceptHello:
			r.serveResumableTunnel(ctx, assignment, accepted, stream, setup)
			return
		default:
			// A stream that moved onto this tunnel (no dial), or a refused
			// resume: the tunnel lives until the session gives it up.
			setup()
			<-accepted.PathDone
			return
		}
	}
	// A raw stream lives in this process: a handover does not take it.
	setup()
	dialed, err := r.dialEndpoint(ctx, assignment)
	if err == nil && dialed.postgres != nil {
		// Links and the Gateway's database tools: TLS-enabled PostgreSQL gets
		// TLS from this daemon unless the client negotiates it itself.
		dialed.conn, err = r.plugin.databaseManager.prepareLinkConnection(ctx, dialed.conn, *dialed.postgres, tunnel, cancel)
	}
	if err != nil {
		if errors.Is(err, errRelayClientLeftEarly) {
			// The client gave up before the tunnel opened (a relay that took long to take it): not this
			// endpoint's failure, and nobody is left to answer.
			r.plugin.logger.Debug("relay endpoint tunnel ended by its client before any data", "owner_kind", assignment.OwnerKind,
				"owner_id", assignment.OwnerId, "relay_instance_id", r.targetID)
			return
		}
		if !errors.Is(err, errEndpointNotServed) {
			r.tunnelFailed(assignment, "dial", err)
			_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "endpoint_unavailable", Message: "Endpoint is unavailable"}}})
		}
		return
	}
	connection := dialed.conn
	// A raw stream (a source without RSv1, or a route Gateway did not make resumable) lives in this process.
	rawClass := cutRawStream
	if _, terminated := connection.(*tls.Conn); terminated {
		rawClass = cutPostgresTLS
	}
	defer r.plugin.liveCuts.track(rawClass)()
	if dialed.ingress {
		// Tracked so a restart finishes the request in flight and closes
		// the tunnel once it is idle (B-13).
		tracked := newDrainConn(connection)
		connection = tracked
		if assignment.OwnerKind == containerLinkOwnerKind {
			// A container link session survives a connector replacement until it ends.
			defer r.plugin.proxyTunnels.addHeld(tracked, cancel)()
		} else {
			defer r.plugin.proxyTunnels.add(tracked, cancel)()
		}
	}
	defer connection.Close()
	r.plugin.relayTunnelOutcomes.Succeeded(r.plugin.logger, relayTunnelOutcome(assignment))
	if isConnectorIngressOwnerKind(assignment.OwnerKind) {
		readChunk := int(r.plugin.relayGrants.readChunkBytes())
		if readChunk == 0 {
			readChunk = relaybridge.DefaultChunkBytes
		}
		_ = relaybridge.BridgeWithChunk(tunnelCtx, connection, tunnel, int(first.GetReady().MaxFrameBytes), readChunk, cancel)
		return
	}
	// No idle limit of its own: the endpoint serves link routes, whose pooled connections stay open while idle, and
	// Gateway's own and backup routes, whose idle tunnels the relay ends by their route policy. Only the relay knows
	// which route a tunnel is for.
	_ = bridgeRelayConnection(connection, tunnel, int(first.GetReady().MaxFrameBytes), r.plugin.relayReadChunk(), 0, cancel)
}

// errEndpointNotServed: this daemon does not serve the endpoint kind (no
// manager for it, an unknown kind): the tunnel is dropped without an answer.
var errEndpointNotServed = errors.New("endpoint kind is not served here")

// dialedEndpoint is a backend connection for an incoming tunnel.
type dialedEndpoint struct {
	conn net.Conn
	// postgres: a managed PostgreSQL link whose opening the daemon still
	// negotiates over the tunnel (prepareLinkConnection).
	postgres *managedDatabaseRecord
	// ingress: a connector ingress binding (proxy secure link, container link).
	ingress bool
}

// dialEndpoint connects the backend of an incoming tunnel of assignment.
func (r *relayTunnelRouter) dialEndpoint(ctx context.Context, assignment *pb.RelayGrantAssignment) (dialedEndpoint, error) {
	if r.plugin.endpointDialer != nil {
		return r.plugin.endpointDialer(ctx, assignment)
	}
	switch assignment.OwnerKind {
	case "managed_database":
		if r.plugin.databaseManager == nil {
			return dialedEndpoint{}, errEndpointNotServed
		}
		connection, record, err := r.plugin.databaseManager.dialRecord(ctx, assignment.OwnerId)
		if err != nil {
			return dialedEndpoint{}, err
		}
		dialed := dialedEndpoint{conn: connection}
		if managedDatabaseLinkNeedsPostgresTLS(record) {
			dialed.postgres = &record
		}
		return dialed, nil
	case "database_backup_source", "database_backup_restore":
		if r.plugin.databaseManager == nil || !managedDatabaseIDPattern.MatchString(assignment.GetRouteId()) {
			return dialedEndpoint{}, errEndpointNotServed
		}
		// ownerId is the signed backup-run UUID. routeId is the server-selected
		// managed database UUID, never a client-provided address or port.
		connection, err := r.plugin.databaseManager.dial(ctx, assignment.GetRouteId())
		return dialedEndpoint{conn: connection}, err
	case proxySecureLinkOwnerKind, containerLinkOwnerKind:
		if r.plugin.secureLinks == nil {
			return dialedEndpoint{}, errEndpointNotServed
		}
		if r.plugin.memberEndpointState(assignment.OwnerId) == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
			// A dormant member (standby, released or fenced holder, or a holder
			// whose workload is not ready) takes no traffic even if a relay
			// admitted a tunnel before it heard so (D6, D7). The error reaches
			// the opener at once instead of an accept timeout.
			return dialedEndpoint{}, errMemberEndpointDormant
		}
		connection, err := r.plugin.secureLinks.dial(ctx, assignment.OwnerId)
		return dialedEndpoint{conn: connection, ingress: true}, err
	case "managed_storage", "managed_storage_binding", "managed_storage_gateway":
		if r.plugin.storageManager == nil {
			return dialedEndpoint{}, errEndpointNotServed
		}
		connection, err := r.plugin.storageManager.dial(ctx, assignment.OwnerId)
		return dialedEndpoint{conn: connection}, err
	case "storage_backup_target", "storage_backup_staging":
		if r.plugin.storageManager == nil || !managedStorageIDPattern.MatchString(assignment.GetRouteId()) {
			return dialedEndpoint{}, errEndpointNotServed
		}
		// ownerId is the signed backup-run UUID. routeId is the server-selected
		// managed storage UUID, never an address supplied by the backup runner.
		connection, err := r.plugin.storageManager.dial(ctx, assignment.GetRouteId())
		return dialedEndpoint{conn: connection}, err
	}
	return dialedEndpoint{}, errEndpointNotServed
}

// relayTunnelOutcome keys the outcome log of incoming tunnels by endpoint owner (L-1): while a workload is down,
// or its relay path breaks, every request through it fails here, one WARN line each.
func relayTunnelOutcome(assignment *pb.RelayGrantAssignment) logepisode.Subject {
	return logepisode.Subject{Name: "relay endpoint tunnels", IDAttr: "owner_id", ID: assignment.OwnerId}
}

// tunnelFailed logs a failed incoming tunnel at debug and reports it per owner and state change.
func (r *relayTunnelRouter) tunnelFailed(assignment *pb.RelayGrantAssignment, stage string, err error) {
	r.plugin.logger.Debug("relay endpoint tunnel failed", "owner_kind", assignment.OwnerKind, "owner_id", assignment.OwnerId,
		"relay_instance_id", r.targetID, "stage", stage, "error", err)
	r.plugin.relayTunnelOutcomes.Failed(r.plugin.logger, relayTunnelOutcome(assignment), "owner_kind", assignment.OwnerKind,
		"relay_instance_id", r.targetID, "stage", stage, "error", err.Error())
}

// isConnectorIngressOwnerKind reports the endpoints this node serves through an ingress binding of its shared
// connector: proxy secure links and container links.
func isConnectorIngressOwnerKind(ownerKind string) bool {
	return ownerKind == proxySecureLinkOwnerKind || ownerKind == containerLinkOwnerKind
}

func isManagedStorageRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "managed_storage" || ownerKind == "managed_storage_binding" || ownerKind == "managed_storage_gateway" || ownerKind == "storage_backup_target" || ownerKind == "storage_backup_staging"
}

func isManagedDatabaseRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "managed_database" || ownerKind == "database_backup_source" || ownerKind == "database_backup_restore"
}

func isBackupRelayOwnerKind(ownerKind string) bool {
	return ownerKind == "database_backup_source" || ownerKind == "database_backup_restore" ||
		ownerKind == "storage_backup_target" || ownerKind == "storage_backup_staging"
}

func (p *DockerPlugin) openManagedDatabaseBinding(connection net.Conn, bindingID string, routeGeneration uint64, peer listenerPeer, peerKnown bool) {
	// An update waits for the relay open in flight (handover.Registry.Setup): the stream goes along once open.
	setup := p.handover.Setup()
	defer setup()
	assignment := p.relayGrants.lookup("connect", "managed_database_binding", bindingID)
	if assignment == nil {
		p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedGrantUnavailable)
		return
	}
	if routeGeneration != 0 {
		listener := assignment.GetManagedDatabaseListener()
		if listener == nil || listener.GetRouteGeneration() != routeGeneration {
			p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedRouteChanged)
			return
		}
	}
	tunnel, err := p.openRelaySource(assignment)
	if err != nil {
		p.linkRejections.rejected(p.logger, linkKindManagedDatabaseBinding, bindingID, relayRefusalReason(err),
			"error", relayRefusalMessage(err))
		return
	}
	// Tracked so a restart lets the request in flight finish (link_listener_handover.go).
	flow, done := p.linkFlows.track(connection)
	defer done()
	link := linkKey{kind: linkKindManagedDatabaseBinding, id: bindingID}
	defer p.linkTraffic.completed(link)
	tunnel.labels = hostListenerLabels(sourceLabels(relaySourceTag{ownerKind: assignment.GetOwnerKind(), ownerID: assignment.GetOwnerId()},
		entryHostListener, link), bindingID, routeGeneration, peer, peerKnown)
	tunnel.started = setup
	tunnel.bridge(p.linkTraffic.carry(link, flow))
}

// OpenBackupRelayRoute resolves a signed per-run connect grant. routeID is the
// RelayGrantAssignment.ownerId (the backup run UUID); the matching endpoint
// assignment's routeId selects the owned target runtime server-side.
func (p *DockerPlugin) OpenBackupRelayRoute(ctx context.Context, ownerKind, routeID string) (*BackupRelayRoute, error) {
	if !isBackupRelayOwnerKind(ownerKind) {
		return nil, errors.New("unsupported backup relay route owner kind")
	}
	if !managedStorageIDPattern.MatchString(routeID) {
		return nil, errors.New("backup relay route id must be a UUID")
	}
	assignment := p.relayGrants.lookup("connect", ownerKind, routeID)
	if assignment == nil || (assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0) {
		return nil, errors.New("backup relay route is unavailable")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("open backup relay loopback listener: %w", err)
	}
	routeCtx, cancel := context.WithCancel(ctx)
	route := &BackupRelayRoute{Address: listener.Addr().String(), listener: listener, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(route.done)
		defer listener.Close()
		defer route.active.Wait()
		var backoff netaccept.Backoff
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				if routeCtx.Err() == nil && backoff.Retry(acceptErr, routeCtx.Done()) {
					continue
				}
				return
			}
			backoff.Reset()
			if routeCtx.Err() != nil {
				_ = connection.Close()
				return
			}
			route.active.Add(1)
			go func(connection net.Conn) {
				defer route.active.Done()
				defer connection.Close()
				closeOnCancel := make(chan struct{})
				go func() {
					select {
					case <-routeCtx.Done():
						_ = connection.Close()
					case <-closeOnCancel:
					}
				}()
				defer close(closeOnCancel)
				// A backup can outlive its grants (TTL, generation or key change):
				// use the newest bundle's assignment for each connection.
				current := p.relayGrants.lookup("connect", ownerKind, routeID)
				if current == nil {
					current = assignment
				}
				candidates := relaybridge.PoolCandidates(current, false)
				if len(candidates) == 0 {
					candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: current.GetGrant()}}
				}
				for _, candidate := range p.orderRelayCandidates(relayRouteKey(ownerKind, routeID), candidates, "") {
					router := p.relayRouter(candidate.GetRelayInstanceId())
					if router != nil && router.openSourceTunnel(connection, candidate.GetGrant(), current) {
						return
					}
				}
			}(connection)
		}
	}()
	return route, nil
}

// openSourceTunnel opens a source tunnel with grant and bridges connection over it until either side ends it. It
// reports false, before any data moved, when the relay did not admit the tunnel.
func (r *relayTunnelRouter) openSourceTunnel(connection net.Conn, grant *pb.RelaySignedGrant, assignment *pb.RelayGrantAssignment) bool {
	tunnel, err := r.openSource(grant)
	if err != nil {
		return false
	}
	if assignment == nil {
		// The registry: its streams end at the local relay and are never
		// resumable, so they are not counted as raw streams either.
		tunnel.localService = true
	} else {
		tunnel.idle = relaySourceIdleLimit(assignment.GetOwnerKind())
		r.plugin.makeResumable(tunnel, assignment)
		// A backup run's helper reaches this process on a loopback socket of
		// the run: an update fails the run as before.
		tunnel.cutClass = cutBackup
	}
	tunnel.bridge(connection)
	return true
}

// relaySourceTunnel is a source tunnel the relay admitted, before it carries any data.
type relaySourceTunnel struct {
	router    *relayTunnelRouter
	stream    relayFrameStream
	closeSend func() error
	cancel    context.CancelFunc
	maxFrame  int
	// session carries the stream when its route is resumable (RSv1): it
	// moves to another relay (or the same one, restarted) without the local
	// connection noticing. nil: a raw tunnel, as before.
	session *relayresume.Session
	// localService: a stream to a service of the local relay (the registry).
	localService bool
	// idle ends the tunnel once its connection carried no byte for that long (relaySourceIdleLimit); 0: never.
	idle time.Duration
	// generation is the assignment generation of the candidate grant the tunnel was opened with (0: legacy grant).
	generation uint64
	// labels name the stream's link for a handover; cutClass, when set, keeps it in this process (it is cut by an
	// update) and names the class it is counted under (live_handover.go).
	labels   handover.Labels
	cutClass string
	// lane is the lane the tunnel opened on (lane rotation moves resumable streams off it).
	lane *relaySourceLane
	// started, if set, ends the connection's setup for a handover (handover.Registry.Setup) once bridge carries it.
	started func()
}

// openSource opens a source tunnel with grant and waits until the relay admits it, at most relaySourceOpenTimeout.
// A refusal (the route's or endpoint's session capacity, a revoked or stale grant) is the relay's status error.
func (r *relayTunnelRouter) openSource(grant *pb.RelaySignedGrant) (*relaySourceTunnel, error) {
	return r.openSourceWithin(grant, relaySourceOpenTimeout)
}

// openSourceWithin is openSource giving up after timeout (0: the relay's own accept timeout).
func (r *relayTunnelRouter) openSourceWithin(grant *pb.RelaySignedGrant, timeout time.Duration) (*relaySourceTunnel, error) {
	lane := r.sourceLane()
	tunnelCtx, cancel := lane.tunnelContext(r.ctx)
	finishSetup := func() bool { return true }
	if timeout > 0 {
		// Stopped once the relay answered: a timer that fired already cancelled the tunnel it admitted.
		finishSetup = time.AfterFunc(timeout, cancel).Stop
	}
	stream, err := lane.client.OpenTunnel(tunnelCtx)
	if err == nil {
		err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}})
	}
	var first *relayv1.TunnelFrame
	if err == nil {
		first, err = stream.Recv()
	}
	if err == nil && lane.socket != nil {
		if header, headerErr := stream.Header(); headerErr == nil {
			r.noteLaneHint(lane, header)
		}
	}
	if err == nil && first.GetReady() == nil {
		err = errors.New("relay sent no ready frame")
		if relayErr := first.GetError(); relayErr != nil {
			err = fmt.Errorf("relay tunnel error: %s", relayErr.GetCode())
		}
	}
	if err == nil && !finishSetup() {
		err = status.Error(codes.DeadlineExceeded, "relay tunnel setup timed out")
	}
	if err != nil {
		finishSetup()
		cancel()
		return nil, err
	}
	return &relaySourceTunnel{router: r, stream: stream, closeSend: stream.CloseSend, cancel: cancel, maxFrame: int(first.GetReady().MaxFrameBytes),
		idle: relayTunnelIdleLimit, lane: lane}, nil
}

// bridge carries connection over the tunnel until either side ends it.
func (t *relaySourceTunnel) bridge(connection net.Conn) {
	defer t.cancel()
	t.router.active.Add(1)
	defer t.router.active.Add(-1)
	readChunk := t.router.plugin.relayReadChunk()
	if t.session != nil {
		labels := t.labels
		if labels == nil {
			tag, _ := t.session.Tag().(relaySourceTag)
			labels = sourceLabels(tag, "", linkKey{})
		}
		t.router.plugin.bridgeSourceSession(connection, t.session, t.idle, labels, t.cutClass, t.started)
		return
	}
	// A raw stream lives in this process: a handover does not take it.
	if t.started != nil {
		t.started()
	}
	switch {
	case t.localService:
		defer t.router.plugin.liveCuts.track(cutRegistry)()
	case t.cutClass != "":
		defer t.router.plugin.liveCuts.track(t.cutClass)()
	default:
		// Counted per relay: a relay that still carries raw streams needs the
		// long drain grace.
		defer t.router.plugin.relayStreams().sources.TrackLegacy(t.router.targetID)()
		defer t.router.plugin.liveCuts.track(cutRawStream)()
	}
	_ = bridgeRelayConnection(connection, t.stream, t.maxFrame, readChunk, t.idle, t.cancel)
}

// bridgeSourceSession carries a workload's link connection over its resumable
// source stream until either side ends it or the daemon hands it to its next
// process. idle ends it once it carried no byte for that long (0: never, TCP
// keepalive finds a peer that vanished).
func (p *DockerPlugin) bridgeSourceSession(connection net.Conn, session *relayresume.Session, idle time.Duration, labels handover.Labels, cutClass string, started func()) {
	if idle <= 0 {
		keepLocalAlive(connection)
	}
	if tag, ok := session.Tag().(relaySourceTag); ok {
		labels[handoverOwnerKind], labels[handoverOwnerID] = tag.ownerKind, tag.ownerID
	}
	readChunk := relayresume.ReadChunk(min(p.relayReadChunk(), session.MaxFrame()))
	_ = p.handover.Bridge(connection, session, handover.BridgeConfig{ReadChunk: readChunk, Idle: idle, Labels: labels, CutClass: cutClass,
		Started: started})
	session.Cancel()
}

// close abandons a tunnel that was never bridged.
func (t *relaySourceTunnel) close() {
	if t.session != nil {
		t.session.Abort(relayresume.RstAborted, "local connection gone")
	}
	t.cancel()
}

func (p *DockerPlugin) ProbeRelayCandidate(command *pb.ProbeRelayCandidateCommand) (string, error) {
	if command == nil || command.GetCandidate() == nil ||
		command.GetAssignmentGeneration() != command.GetCandidate().GetAssignmentGeneration() {
		return "", errors.New("invalid relay candidate probe")
	}
	deadline := time.Now().Add(10 * time.Second)
	var lastErr error
	switch command.GetRole() {
	case "target":
		for time.Now().Before(deadline) {
			router := p.relayRouter(command.GetCandidate().GetRelayInstanceId())
			if router != nil {
				key := fmt.Sprintf("%s:%d", command.GetEndpointId(), command.GetAssignmentGeneration())
				router.mu.Lock()
				registration := router.registrations[key]
				ready := registration != nil && registration.ready.Load()
				router.mu.Unlock()
				if ready {
					lastErr = nil
					break
				}
			}
			lastErr = errors.New("relay endpoint registration is not ready")
			time.Sleep(100 * time.Millisecond)
		}
	case "source":
		for time.Now().Before(deadline) {
			router := p.relayRouter(command.GetCandidate().GetRelayInstanceId())
			if router == nil {
				lastErr = errors.New("relay candidate lane is unavailable")
				time.Sleep(100 * time.Millisecond)
				continue
			}
			ctx, cancel := context.WithTimeout(router.ctx, 2*time.Second)
			stream, err := router.client.OpenTunnel(ctx)
			if err == nil {
				err = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(command.GetCandidate().GetGrant())}}})
			}
			if err == nil {
				var first *relayv1.TunnelFrame
				first, err = stream.Recv()
				if err == nil && first.GetReady() == nil {
					err = errors.New("relay candidate did not acknowledge tunnel")
				}
			}
			cancel()
			if err == nil || relaybridge.ProbeReachedGatedEndpoint(err) {
				// A route gated by an Availability lease (a standby source or
				// target) still proves the relay authorizes it (B-17).
				lastErr = nil
				break
			}
			lastErr = err
			time.Sleep(100 * time.Millisecond)
		}
	default:
		return "", errors.New("unsupported relay candidate probe role")
	}
	if lastErr != nil {
		return "", lastErr
	}
	detail, err := json.Marshal(map[string]any{"probeId": command.GetProbeId(), "ready": true})
	return string(detail), err
}

type relayFrameStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

type relayBridgeResult struct {
	local    bool
	terminal bool
	err      error
}

// bridgeRelayConnection carries connection over stream, reading at most readChunk bytes per frame (Gateway's relay
// read chunk; 0: the frame limit): a 1 MiB buffer per connection and 1 MiB frames on a lane shared with small requests
// were the old default. idle ends the tunnel once the connection carried no byte for that long. With 0 an idle
// tunnel stays open, and a peer that is gone still ends it: the relay ends the stream when the other side's lane
// drops, and TCP keepalive (keepLocalAlive) a local peer that vanished.
func bridgeRelayConnection(connection net.Conn, stream relayFrameStream, maxFrame, readChunk int, idle time.Duration, cancel context.CancelFunc) error {
	if maxFrame <= 0 || maxFrame > databaseTunnelMaxChunkBytes {
		maxFrame = databaseTunnelMaxChunkBytes
	}
	if readChunk <= 0 || readChunk > maxFrame {
		readChunk = maxFrame
	}
	// The frame's message stays within the read size: a few bytes over a gRPC
	// buffer tier cost a 1 MiB buffer clear per frame.
	readChunk = relaybridge.DataLimit(readChunk)
	extendIdle := func() {}
	if idle > 0 {
		extendIdle = func() { _ = connection.SetDeadline(time.Now().Add(idle)) }
	} else {
		keepLocalAlive(connection)
	}
	result := make(chan relayBridgeResult, 2)
	go func() {
		buffer := make([]byte, readChunk)
		for {
			n, err := connection.Read(buffer)
			if n > 0 {
				extendIdle()
				if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), buffer[:n]...)}}}); sendErr != nil {
					result <- relayBridgeResult{local: true, terminal: true, err: sendErr}
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}); sendErr != nil {
						result <- relayBridgeResult{local: true, terminal: true, err: sendErr}
						return
					}
					result <- relayBridgeResult{local: true}
					return
				}
				result <- relayBridgeResult{local: true, terminal: true, err: err}
				return
			}
		}
	}()
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				result <- relayBridgeResult{terminal: true, err: err}
				return
			}
			switch {
			case frame.GetData() != nil:
				data := frame.GetData().Data
				if len(data) == 0 || len(data) > maxFrame {
					result <- relayBridgeResult{terminal: true, err: fmt.Errorf("invalid relay frame size")}
					return
				}
				if err := writeDatabaseTunnelBytes(connection, data); err != nil {
					result <- relayBridgeResult{terminal: true, err: err}
					return
				}
				extendIdle()
			case frame.GetHalfClose() != nil:
				// *net.TCPConn, or *tls.Conn for a TLS-enabled PostgreSQL link.
				if half, ok := connection.(interface{ CloseWrite() error }); ok {
					_ = half.CloseWrite()
				}
				result <- relayBridgeResult{}
				return
			case frame.GetClose() != nil:
				result <- relayBridgeResult{terminal: true}
				return
			case frame.GetError() != nil:
				result <- relayBridgeResult{terminal: true, err: fmt.Errorf("relay tunnel error: %s", frame.GetError().Code)}
				return
			default:
				result <- relayBridgeResult{terminal: true, err: fmt.Errorf("unexpected relay tunnel frame")}
				return
			}
		}
	}()
	var localDone, remoteDone, terminated bool
	var bridgeErr error
	for !localDone || !remoteDone {
		completed := <-result
		if completed.local {
			localDone = true
		} else {
			remoteDone = true
		}
		if completed.err != nil && bridgeErr == nil {
			bridgeErr = completed.err
		}
		if (completed.terminal || completed.err != nil) && !terminated {
			terminated = true
			if localDone {
				_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
			}
			cancel()
			_ = connection.Close()
		}
	}
	if !terminated {
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
		// The tail of what this side sent may still wait for HTTP/2 window:
		// cancelling at once dropped it.
		relaybridge.AwaitEnd(stream, relaybridge.CloseFlushTimeout)
		cancel()
		_ = connection.Close()
	}
	return bridgeErr
}

func relayGrant(grant *pb.RelaySignedGrant) *relayv1.SignedGrant {
	if grant == nil {
		return nil
	}
	return &relayv1.SignedGrant{KeyId: grant.KeyId, Payload: grant.Payload, Signature: grant.Signature}
}

func findRelayAssignment(bundle *pb.SyncRelayGrantsCommand, role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	for _, assignment := range bundle.Grants {
		if assignment.Role == role && assignment.OwnerKind == ownerKind && assignment.OwnerId == ownerID {
			return assignment
		}
	}
	return nil
}

func (r *relayTunnelRouter) stop() {
	r.mu.Lock()
	for _, registration := range r.registrations {
		registration.cancel()
	}
	r.registrations = map[string]*relayEndpointRegistration{}
	r.mu.Unlock()
}

func managedDatabaseEnginePort(engine string) (string, error) {
	switch engine {
	case "postgres":
		return "5432", nil
	case "redis":
		return "6379", nil
	case "clickhouse":
		return "8123", nil
	default:
		return "", errors.New("unsupported managed database engine")
	}
}
