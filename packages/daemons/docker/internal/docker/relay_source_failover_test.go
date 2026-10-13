package docker

import (
	"context"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// A relay whose transport dropped comes after the connected ones: a source
// tunnel opened on it waits for the reconnect, against a relay that stopped
// answering until the connect timeout.
func TestRelaySourceTunnelSkipsRelayWhoseTransportDropped(t *testing.T) {
	dropped, err := grpc.NewClient("127.0.0.1:1", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dropped.Close() })
	stalled := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{admit: make(chan struct{}), first: readyFrame(), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	answering := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{first: readyFrame(), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	candidate := func(relayID, role string) *pb.RelayDataCandidate {
		return &pb.RelayDataCandidate{
			RelayInstanceId: relayID, AssignmentGeneration: 1, AssignmentState: "active",
			Capabilities: []string{relaybridge.PoolCapability},
			Grant:        &pb.RelaySignedGrant{KeyId: "key-1", Payload: []byte("{}"), Signature: []byte("signature")},
			Topology:     &pb.RelayCandidateTopology{Role: role},
		}
	}
	assignment := &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: linkKindManagedDatabaseBinding, OwnerId: testListenerBindingA, SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{candidate("relay-near", relaybridge.RolePrimary), candidate("relay-far", relaybridge.RoleStandby)},
	}
	plugin, _ := newRelayTestPlugin(t, answering, assignment)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	plugin.relayTunnels = map[string]*relayTunnelRouter{
		"relay-near": {plugin: plugin, ctx: ctx, conn: dropped, client: stalled, targetID: "relay-near", registrations: map[string]*relayEndpointRegistration{}},
		"relay-far":  {plugin: plugin, ctx: ctx, client: answering, targetID: "relay-far", registrations: map[string]*relayEndpointRegistration{}},
	}

	opened := make(chan *relaySourceTunnel, 1)
	go func() {
		if tunnel, err := plugin.openRelaySource(assignment); err == nil {
			opened <- tunnel
		}
	}()
	select {
	case tunnel := <-opened:
		defer tunnel.close()
		if tunnel.router.targetID != "relay-far" {
			t.Fatalf("source tunnel opened on %s, want the relay with a connected transport", tunnel.router.targetID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("source tunnel waited on the relay whose transport dropped")
	}
}
