package broker

import (
	"fmt"

	"github.com/wiolett-industries/gateway/daemon-shared/relaylocal"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (b *Broker) AcceptTunnel(stream relayv1.TunnelBroker_AcceptTunnelServer) error {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	first, err := recvFirst(stream.Context(), stream.Recv)
	if err != nil {
		return err
	}
	accept := first.GetAccept()
	if accept == nil || accept.AcceptToken == "" {
		return status.Error(codes.InvalidArgument, "first tunnel frame must accept")
	}
	b.mu.Lock()
	pending := b.pending[accept.AcceptToken]
	if pending != nil && !pending.acceptedBy(client) {
		// Checked before the token is used: it reached the endpoint's daemon,
		// which accepted with a certificate that is neither the
		// registration's nor the policy's. The opener learns it at once, with
		// a status it fails over on, instead of after the accept timeout (F2).
		b.mu.Unlock()
		pending.session.closeWith(codes.Unavailable, "target endpoint accepted with another certificate")
		err := status.Error(codes.PermissionDenied, "accept token does not match client certificate")
		b.refusals.note("route", pending.session.routeID, refusalAcceptIdentity, err)
		return err
	}
	if pending != nil {
		delete(b.pending, accept.AcceptToken)
	}
	b.mu.Unlock()
	if pending == nil {
		return status.Error(codes.NotFound, "accept token is unknown or already used")
	}
	connection := acceptedConnection{stream: stream, result: make(chan error, 1)}
	select {
	case pending.accepted <- connection:
	case <-pending.session.stop:
		return pending.session.stopError()
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	select {
	case result := <-connection.result:
		return result
	case <-pending.session.stop:
		// The opener writes its result before it closes the session. Without a
		// result it left (timeout, cancel or revocation) before the tunnel was
		// bridged, and nothing would ever end this stream.
		select {
		case result := <-connection.result:
			return result
		default:
			return status.Error(codes.Aborted, "tunnel was closed before it was established")
		}
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
}

func policyAssignmentKey(id string, generation uint64) string {
	if generation == 0 {
		return id
	}
	return fmt.Sprintf("%s:%d", id, generation)
}

// closeRegistrationSessionsLocked closes the tunnels bridged through one
// registration whose daemon went away: those of another registration of the
// same endpoint (a newer generation that registered before this one ended)
// keep running. They end Unavailable with message, which openers fail over
// on (F1).
func (b *Broker) closeRegistrationSessionsLocked(registration *endpointRegistration, message string) {
	for _, tunnel := range b.active {
		unbound := tunnel.registration == nil && tunnel.endpointID == registration.endpointID &&
			tunnel.assignmentGeneration == registration.assignmentGeneration
		if tunnel.registration == registration || unbound {
			tunnel.closeWith(codes.Unavailable, message)
		}
	}
}

// closeEndpointSessionsLocked closes the tunnels of an endpoint (of one
// assignment generation when given) with the status code and message.
func (b *Broker) closeEndpointSessionsLocked(code codes.Code, message, endpointID string, assignmentGenerations ...uint64) {
	for _, tunnel := range b.active {
		if tunnel.endpointID != endpointID ||
			(len(assignmentGenerations) > 0 && tunnel.assignmentGeneration != assignmentGenerations[0]) {
			continue
		}
		tunnel.closeWith(code, message)
	}
}

// drainRefuses tells whether a draining relay refuses new tunnels to the
// endpoint. A drain moves workload endpoints to other relays; a built-in local
// service (the Gateway internal registry) is served only by the local relay,
// so it keeps admitting tunnels to it. See DrainKeepsLocalServicesCapability.
func drainRefuses(endpoint *relayv1.EndpointPolicy) bool {
	// A relay-local endpoint (a witness this relay hosts) is served only here too.
	return endpoint.GetSubjectKind() != localServiceSubjectKind && endpoint.GetSubjectKind() != relaylocal.SubjectKind
}
