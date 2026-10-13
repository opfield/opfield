package broker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// F1: a tunnel waiting for its target to accept when the target's connection
// is lost ends Unavailable, which openers retry and fail over on, not
// PermissionDenied (a revocation they treat as final).
func TestTunnelOfALostEndpointEndsRetryable(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, disconnect := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	opened := f.openProxyTunnel(t, f.ctx)
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("got %v instead of an incoming tunnel", message)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no incoming tunnel")
	}
	disconnect()
	waitOpenError(t, opened, codes.Unavailable, "target endpoint disconnected")
}

// F1: a forced drain ends tunnels "relay is draining", which nginx treats as a
// relay failure and fails over on.
func TestForcedDrainEndsTunnelsRetryable(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	active := &activeTunnel{stop: make(chan struct{})}
	b.active["existing"] = active
	b.SetDraining(true)
	b.ForceDisconnect()
	if err := active.stopError(); status.Code(err) != codes.Unavailable || err.Error() != status.Error(codes.Unavailable, "relay is draining").Error() {
		t.Fatalf("drained tunnel status = %v", err)
	}
	if err := active.bridgeResult(errTunnelRevoked); status.Code(err) != codes.Unavailable {
		t.Fatalf("drained bridge status = %v", err)
	}
	revoked := &activeTunnel{stop: make(chan struct{})}
	revoked.close()
	if err := revoked.bridgeResult(errTunnelRevoked); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("revoked bridge status = %v", err)
	}
}

// F2: while an endpoint's certificate rotates, the previous registration
// serves on its connection's old certificate and its daemon accepts with it;
// the policy already names the new one. An accept with neither certificate
// is refused before the token is used and fails the opener at once.
func TestAcceptMatchesTheRegistrationCertificate(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	ctx := authenticatedContext("node-target", []byte("old-certificate"))
	identity, _ := grpcpeer.FromContext(ctx)
	oldFingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0].Raw))
	registration := &endpointRegistration{endpointID: "endpoint-1", clientSubjectID: "node-target", clientCertificate: oldFingerprint, stop: make(chan struct{})}
	rotated := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", SubjectId: "node-target", CertificateSha256: "sha256:new-certificate"}
	pending := &pendingTunnel{endpoint: rotated, session: &activeTunnel{registration: registration, stop: make(chan struct{})}, accepted: make(chan acceptedConnection, 1)}
	b.pending["token-1"] = pending
	done := make(chan error, 1)
	go func() { done <- b.AcceptTunnel(&acceptStream{ctx: ctx, first: acceptFrame("token-1")}) }()
	select {
	case connection := <-pending.accepted:
		connection.result <- nil
	case err := <-done:
		t.Fatalf("accept over the registration's certificate refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("accept over the registration's certificate did not reach the opener")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	stranger := &pendingTunnel{endpoint: rotated, session: &activeTunnel{registration: registration, stop: make(chan struct{})}, accepted: make(chan acceptedConnection, 1)}
	b.pending["token-2"] = stranger
	other := authenticatedContext("node-target", []byte("another-certificate"))
	if code := status.Code(b.AcceptTunnel(&acceptStream{ctx: other, first: acceptFrame("token-2")})); code != codes.PermissionDenied {
		t.Fatalf("accept with another certificate status = %v", code)
	}
	if b.pending["token-2"] == nil {
		t.Fatal("a refused accept used the token")
	}
	select {
	case <-stranger.session.stop:
	default:
		t.Fatal("the opener was not told about the refused accept")
	}
	if code := status.Code(stranger.session.stopError()); code != codes.Unavailable {
		t.Fatalf("opener status after a refused accept = %v", code)
	}
}

// F3: a restart called off by a renewal leaves the registration serving: a
// tunnel admitted afterwards waits for its accept instead of failing at once
// on the closed restart signal.
func TestCalledOffRestartServesNewTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	f.announceRestart(t, stream, result)
	f.renew(t, stream, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	openCtx, cancelOpen := context.WithCancel(f.ctx)
	defer cancelOpen()
	opened := f.openProxyTunnel(t, openCtx)
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("got %v instead of an incoming tunnel", message)
		}
	case err := <-opened:
		t.Fatalf("tunnel after the restart was called off ended: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no incoming tunnel")
	}
	select {
	case err := <-opened:
		t.Fatalf("tunnel waiting for its accept ended: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
}
