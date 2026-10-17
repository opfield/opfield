package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/config"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A drain moves workload endpoints to other relays. The internal registry is a
// built-in local service only the local relay serves: a draining relay keeps
// admitting new tunnels to it, so image pulls go on during a Relay Pool update.
func TestDrainRefusesWorkloadTunnelsAndKeepsLocalServices(t *testing.T) {
	grantPublic, grantPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	source := []byte("source")
	sourceFingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(source))
	route := func(id, endpointID, class string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: sourceFingerprint, TargetEndpointId: endpointID, TrafficClass: class}
	}
	if _, _, err := store.Apply(&relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "opfield-1",
		PublicKeys: []*relayv1.PublicKey{{KeyId: "key-1", PublicKey: grantPublic}},
		Endpoints: []*relayv1.EndpointPolicy{
			{EndpointId: "endpoint-workload", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target", CertificateSha256: "sha256:target"},
			{EndpointId: "endpoint-registry", Generation: 1, SubjectKind: localServiceSubjectKind, SubjectId: config.RegistryServiceID, CertificateSha256: "local:gateway-internal-registry"},
		},
		Routes: []*relayv1.RoutePolicy{route("route-workload", "endpoint-workload", ""), route("route-registry", "endpoint-registry", "registry")},
	}); err != nil {
		t.Fatal(err)
	}
	b := New(store)
	var registryDials atomic.Int32
	b.SetLocalServiceDialer(func(context.Context, string) (net.Conn, error) {
		registryDials.Add(1)
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	})
	open := func(routeID string) error {
		now := time.Now()
		claims := grant.Claims{SchemaVersion: 1, Audience: grant.Audience, GrantID: "grant-" + routeID, GatewayInstanceID: "opfield-1", Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: sourceFingerprint, RouteID: routeID, RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
		payload, err := json.Marshal(claims)
		if err != nil {
			t.Fatal(err)
		}
		signed := &relayv1.SignedGrant{KeyId: "key-1", Payload: payload, Signature: ed25519.Sign(grantPrivate, payload)}
		return b.OpenTunnel(&openStream{
			ctx:   authenticatedContext("node-source", source),
			first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: signed}}},
		})
	}

	b.SetDraining(true)
	workload := open("route-workload")
	if status.Code(workload) != codes.Unavailable || !strings.Contains(workload.Error(), "relay is draining") {
		t.Fatalf("draining relay admitted a workload tunnel: %v", workload)
	}
	if err := open("route-registry"); err != nil && strings.Contains(err.Error(), "relay is draining") {
		t.Fatalf("draining relay refused an internal registry tunnel: %v", err)
	}
	if registryDials.Load() != 1 {
		t.Fatalf("internal registry dials = %d, want 1", registryDials.Load())
	}

	b.SetDraining(false)
	if err := open("route-workload"); err != nil && strings.Contains(err.Error(), "relay is draining") {
		t.Fatalf("resumed relay still refuses workload tunnels: %v", err)
	}
}

func TestDrainRefusesOnlyWorkloadEndpoints(t *testing.T) {
	if !drainRefuses(&relayv1.EndpointPolicy{SubjectKind: "daemon"}) {
		t.Fatal("a drain admitted a daemon workload endpoint")
	}
	if !drainRefuses(&relayv1.EndpointPolicy{SubjectKind: "gateway"}) {
		t.Fatal("a drain admitted a Gateway-owned workload endpoint")
	}
	if drainRefuses(&relayv1.EndpointPolicy{SubjectKind: localServiceSubjectKind, SubjectId: config.RegistryServiceID}) {
		t.Fatal("a drain refused the built-in internal registry")
	}
}
