package broker

import (
	"context"
	"errors"
	"fmt"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/admission"
	"github.com/wiolett-industries/gateway/relay/internal/config"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// TunnelPolicyHold is how long a tunnel whose grant is ahead of this relay's
// policy waits for it (F9). Shorter than RegistrationPolicyHold: the opener
// gives up within a few seconds anyway, and a held open costs a session.
var TunnelPolicyHold = 2 * time.Second

func (b *Broker) OpenTunnel(stream relayv1.TunnelBroker_OpenTunnelServer) (resultErr error) {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	first, err := recvFirst(stream.Context(), stream.Recv)
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return status.Error(codes.InvalidArgument, "first tunnel frame must open")
	}
	claims, err := b.verifyGrant(stream.Context(), open.Grant, "connect", client, TunnelPolicyHold)
	if err != nil {
		b.refusals.note("source", client.SubjectID, grantRefusalReason(err), err)
		return err
	}
	sessionID, err := randomToken()
	if err != nil {
		return status.Error(codes.Internal, "could not create session id")
	}
	token, err := randomToken()
	if err != nil {
		return status.Error(codes.Internal, "could not create accept token")
	}
	// Taken before mu: a lease gate read waits for the lease node's disk
	// writes, which must not hold up every other admission (F4).
	verdicts := b.tunnelLeaseVerdicts(claims)
	b.mu.Lock()
	snapshot, err := b.awaitPolicyLocked(stream.Context(), claims, "connect", TunnelPolicyHold)
	if err != nil {
		b.mu.Unlock()
		b.refusals.note("route", claims.RouteID, refusalPolicy, err)
		return err
	}
	route := snapshot.Route(claims.RouteID, claims.AssignmentGeneration)
	if route == nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, "connect grant route was revoked")
	}
	endpoint := snapshot.Endpoint(route.TargetEndpointId, claims.AssignmentGeneration)
	if endpoint == nil {
		b.mu.Unlock()
		err := status.Error(codes.PermissionDenied, "connect grant endpoint was revoked")
		b.refusals.note("route", route.RouteId, refusalPolicy, err)
		return err
	}
	// Decided under the lock: a forced drain disconnects the sessions it finds
	// under this lock, so a tunnel admitted after it must not slip in.
	if b.draining.Load() && drainRefuses(endpoint) {
		b.mu.Unlock()
		err := status.Error(codes.Unavailable, "relay is draining")
		b.refusals.note("route", route.RouteId, refusalDraining, err)
		return err
	}
	frameLimit := minNonZero(DefaultMaxFrameBytes, int(route.MaxFrameBytes), int(claims.MaxFrameBytes))
	trafficClass := routeTrafficClass(route)
	metrics := b.routeMetricsLocked(route.RouteId)
	startedAt := time.Now()
	// failOpen and throttle refuse with mu held and release it.
	failOpen := func(reason string, err error) error {
		metrics.opened.Add(1)
		metrics.touch()
		b.mu.Unlock()
		metrics.recordFailedOpen(time.Since(startedAt))
		b.refusals.note("route", route.RouteId, reason, err)
		return err
	}
	throttle := func(reason string, err error) error {
		metrics.throttled.Add(1)
		metrics.touch()
		b.mu.Unlock()
		b.refusals.note("route", route.RouteId, reason, err)
		return err
	}
	admit := func(grantLimit uint32) error {
		if err := b.sessionCapacityErrorLocked(route, endpoint, claims.MaxConcurrentSessions, grantLimit); err != nil {
			return throttle(refusalSessionCap, err)
		}
		if err := b.admission.Admit(trafficClass, route.RouteId, b.usageLocked()); err != nil {
			reason := refusalAdmission
			if rejected := (*admission.Rejected)(nil); errors.As(err, &rejected) {
				reason += ":" + rejected.State
			}
			return throttle(reason, status.Error(codes.ResourceExhausted, err.Error()))
		}
		return nil
	}
	if err := b.tunnelLeaseErrorWithLocked(verdicts, route, endpoint); err != nil {
		return failOpen(refusalLeaseGate, err)
	}
	if endpoint.SubjectKind == localServiceSubjectKind {
		if snapshot.Mode != relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED {
			// Only the local relay next to the Gateway serves built-in local
			// services. A remote relay would dial the service's fixed name on
			// its own host's network, which no policy may make it do.
			return failOpen(refusalLocalService, status.Error(codes.PermissionDenied, "built-in local services are served only by the local relay"))
		}
		target, targetErr := config.BuiltinLocalServiceTarget(endpoint.SubjectId)
		if targetErr != nil {
			return failOpen(refusalLocalService, status.Error(codes.PermissionDenied, targetErr.Error()))
		}
		if err := admit(endpoint.MaxConcurrentSessions); err != nil {
			return err
		}
		metrics.opened.Add(1)
		metrics.touch()
		session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, assignmentGeneration: claims.AssignmentGeneration, trafficClass: trafficClass, metrics: metrics, admittedSeq: b.nextAdmissionLocked(), stop: make(chan struct{})}
		metrics.active.Add(1)
		b.active[sessionID] = session
		b.trackSessionLocked(session, 1)
		b.mu.Unlock()
		defer func() {
			b.mu.Lock()
			if current := b.active[sessionID]; current != nil {
				b.trackSessionLocked(current, -1)
				delete(b.active, sessionID)
			}
			b.mu.Unlock()
			metrics.recordCompletion(time.Since(startedAt), resultErr)
			b.pruneRouteMetrics(session.routeID, metrics)
			session.close()
		}()
		connection, dialErr := b.dialLocalService(stream.Context(), target.Target)
		if dialErr != nil {
			err := status.Error(codes.Unavailable, "built-in local service is unavailable")
			b.refusals.note("route", route.RouteId, refusalLocalService, fmt.Errorf("%w: %v", err, dialErr))
			return err
		}
		defer connection.Close()
		if err := stream.Send(readyFrame(frameLimit)); err != nil {
			return err
		}
		resultErr = session.bridgeResult(bridge(stream, &connectionTunnelStream{connection: connection, maxFrame: frameLimit}, frameLimit, session.stop, route.DisableIdleTimeout, false, metrics))
		return resultErr
	}
	registration := b.endpoints[policyAssignmentKey(endpoint.EndpointId, claims.AssignmentGeneration)]
	if registration == nil || time.Now().Unix() > registration.expiresAt.Load() {
		return failOpen(refusalNotRegistered, status.Error(codes.Unavailable, "target endpoint is not registered"))
	}
	if registration.restartingSince.Load() != 0 {
		// Its daemon restarts (B-13): the opener retries until the next
		// process registered, instead of treating the endpoint as gone. Past
		// the grace a registration still restarting is about to be closed.
		return failOpen(refusalRestarting, status.Error(codes.Unavailable, errEndpointRestarting))
	}
	if registration.dormant() {
		// A standby, or a holder whose workload is not ready yet (D6, D7).
		return failOpen(refusalDormant, status.Error(codes.Unavailable, "target endpoint is dormant"))
	}
	if err := admit(registration.maxSessions.Load()); err != nil {
		return err
	}
	metrics.opened.Add(1)
	metrics.touch()
	session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, assignmentGeneration: claims.AssignmentGeneration, trafficClass: trafficClass, metrics: metrics, registration: registration, admittedSeq: b.nextAdmissionLocked(), stop: make(chan struct{})}
	pending := &pendingTunnel{endpoint: endpoint, session: session, accepted: make(chan acceptedConnection, 1)}
	// The restart signal of this registration as of now: a restart called
	// off later replaces it, and a closed one must not refuse the tunnels
	// admitted after that (F3).
	restarting := registration.restarting
	metrics.active.Add(1)
	b.pending[token] = pending
	b.active[sessionID] = session
	b.trackSessionLocked(session, 1)
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, token)
		if current := b.active[sessionID]; current != nil {
			b.trackSessionLocked(current, -1)
			delete(b.active, sessionID)
		}
		b.mu.Unlock()
		metrics.recordCompletion(time.Since(startedAt), resultErr)
		b.pruneRouteMetrics(session.routeID, metrics)
		session.close()
	}()
	deadline := time.Now().Add(AcceptTimeout)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	incoming := incomingTunnel(sessionID, token, deadline, session)
	select {
	case registration.incoming <- incoming:
	case <-registration.stop:
		return status.Error(codes.Unavailable, "target endpoint was revoked")
	case <-session.stop:
		return session.stopError()
	case <-timer.C:
		err := status.Error(codes.DeadlineExceeded, "target endpoint did not accept tunnel")
		b.refusals.note("route", route.RouteId, refusalAcceptTimeout, err)
		return err
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	// The registration's own end needs no case here: every path that ends a
	// registration with its daemon gone closes its tunnels with a reason
	// (session.stop), and a registration a newer generation replaced may
	// still have its old connection accept what it was sent.
	var accepted acceptedConnection
	select {
	case accepted = <-pending.accepted:
	case <-restarting:
		// The daemon began restarting before it accepted this tunnel.
		return status.Error(codes.Unavailable, errEndpointRestarting)
	case <-timer.C:
		err := status.Error(codes.DeadlineExceeded, "target endpoint did not accept tunnel")
		b.refusals.note("route", route.RouteId, refusalAcceptTimeout, err)
		return err
	case <-session.stop:
		return session.stopError()
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	b.hintLane(stream)
	if err := stream.Send(readyFrame(frameLimit)); err != nil {
		accepted.result <- err
		return err
	}
	b.hintLane(accepted.stream)
	if err := accepted.stream.Send(readyFrame(frameLimit)); err != nil {
		accepted.result <- err
		return err
	}
	metrics.recordSetup(time.Since(startedAt))
	bridgeErr := session.bridgeResult(bridge(stream, accepted.stream, frameLimit, session.stop, route.DisableIdleTimeout, trafficClass == admission.TrafficClassProxy, metrics))
	accepted.result <- bridgeErr
	return bridgeErr
}

// bridgeResult gives a bridge that ended because the tunnel was closed the
// status the tunnel was closed with.
func (t *activeTunnel) bridgeResult(err error) error {
	if errors.Is(err, errTunnelRevoked) && channelClosed(t.stop) {
		return t.stopError()
	}
	return err
}

// errEndpointRestarting answers tunnels to an endpoint whose daemon restarts.
// Openers treat it as transient and retry; nginx daemons hold the connection
// (B-13).
const errEndpointRestarting = "target endpoint is restarting"

// incomingTunnel names the route the tunnel was admitted for, so an endpoint
// can refuse a route Gateway revoked while this relay missed that policy.
func incomingTunnel(sessionID, token string, deadline time.Time, session *activeTunnel) *relayv1.IncomingTunnel {
	return &relayv1.IncomingTunnel{
		SessionId: sessionID, AcceptToken: token, AcceptExpiresAtUnix: deadline.Unix(),
		Route: &relayv1.IncomingTunnelRoute{
			RouteId: session.routeID, RouteGeneration: session.routeGeneration, SourceKind: session.sourceKind,
			SourceId: session.sourceID, AssignmentGeneration: session.assignmentGeneration,
		},
	}
}

func routeTrafficClass(route *relayv1.RoutePolicy) string {
	if route.TrafficClass == admission.TrafficClassRegistry {
		return admission.TrafficClassRegistry
	}
	if route.TrafficClass == admission.TrafficClassDatabase {
		return admission.TrafficClassDatabase
	}
	if route.TrafficClass == admission.TrafficClassProxy || route.SourceKind == "nginx" {
		return admission.TrafficClassProxy
	}
	return admission.TrafficClassDatabase
}

func (b *Broker) usageLocked() admission.Usage {
	return admission.Usage{ActiveProxy: b.activeProxy, ActiveDatabase: b.activeDatabase, ActiveRegistry: b.activeRegistry, ProxyByRoute: b.proxyByRoute, RegistryByRoute: b.registryByRoute}
}

func (b *Broker) sessionCapacityErrorLocked(route *relayv1.RoutePolicy, endpoint *relayv1.EndpointPolicy, routeGrantLimit, endpointGrantLimit uint32) error {
	if limit := minSessionLimit(route.MaxConcurrentSessions, routeGrantLimit); limit > 0 && b.activeByRoute[route.RouteId] >= uint64(limit) {
		return status.Error(codes.ResourceExhausted, "relay route session capacity reached")
	}
	if limit := minSessionLimit(endpoint.MaxConcurrentSessions, endpointGrantLimit); limit > 0 && b.activeByTarget[endpoint.EndpointId] >= uint64(limit) {
		return status.Error(codes.ResourceExhausted, "relay endpoint session capacity reached")
	}
	return nil
}

func minSessionLimit(policyLimit, grantLimit uint32) uint32 {
	if policyLimit == 0 {
		return grantLimit
	}
	if grantLimit == 0 || policyLimit < grantLimit {
		return policyLimit
	}
	return grantLimit
}

func (b *Broker) trackSessionLocked(tunnel *activeTunnel, delta int) {
	adjustSessionCount(b.activeByRoute, tunnel.routeID, delta)
	adjustSessionCount(b.activeByTarget, tunnel.endpointID, delta)
	if tunnel.trafficClass == admission.TrafficClassProxy {
		if delta > 0 {
			b.activeProxy++
			b.proxyByRoute[tunnel.routeID]++
			return
		}
		b.activeProxy--
		if b.proxyByRoute[tunnel.routeID] <= 1 {
			delete(b.proxyByRoute, tunnel.routeID)
		} else {
			b.proxyByRoute[tunnel.routeID]--
		}
		return
	}
	if tunnel.trafficClass == admission.TrafficClassRegistry {
		if delta > 0 {
			b.activeRegistry++
			b.registryByRoute[tunnel.routeID]++
			return
		}
		b.activeRegistry--
		if b.registryByRoute[tunnel.routeID] <= 1 {
			delete(b.registryByRoute, tunnel.routeID)
		} else {
			b.registryByRoute[tunnel.routeID]--
		}
		return
	}
	if delta > 0 {
		b.activeDatabase++
	} else {
		b.activeDatabase--
	}
}

func adjustSessionCount(counts map[string]uint64, id string, delta int) {
	if delta > 0 {
		counts[id]++
		return
	}
	if counts[id] <= 1 {
		delete(counts, id)
		return
	}
	counts[id]--
}

// FirstFrameTimeout bounds how long a tunnel or registration stream may stay
// open before its first frame (F7): daemons send it right after opening.
var FirstFrameTimeout = 10 * time.Second

// recvFirst receives a stream's first frame within FirstFrameTimeout. On a
// timeout the handler returns, which ends the stream and the receive.
func recvFirst[T any](ctx context.Context, recv func() (T, error)) (T, error) {
	type result struct {
		frame T
		err   error
	}
	done := make(chan result, 1)
	go func() {
		frame, err := recv()
		done <- result{frame: frame, err: err}
	}()
	timer := time.NewTimer(FirstFrameTimeout)
	defer timer.Stop()
	var zero T
	select {
	case received := <-done:
		return received.frame, received.err
	case <-timer.C:
		return zero, status.Error(codes.DeadlineExceeded, "first frame was not received in time")
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
