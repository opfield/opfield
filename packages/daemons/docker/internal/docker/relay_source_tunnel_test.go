package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testStorageBindingID = "5b0c3b52-5d0f-4c1c-9a59-3f8f0f4c2a11"

// fakeTunnelBroker is a relay whose OpenTunnel answers with open.
type fakeTunnelBroker struct {
	relayv1.TunnelBrokerClient
	open func() *fakeSourceStream
}

func (f *fakeTunnelBroker) OpenTunnel(context.Context, ...grpc.CallOption) (grpc.BidiStreamingClient[relayv1.TunnelFrame, relayv1.TunnelFrame], error) {
	return f.open(), nil
}

// fakeSourceStream answers the open frame with first (after admit closes, when set), then, once hold closes (when
// set), with replies and ends the tunnel.
type fakeSourceStream struct {
	grpc.ClientStream
	admit   chan struct{}
	hold    chan struct{}
	first   *relayv1.TunnelFrame
	replies []*relayv1.TunnelFrame
	refusal error
	sent    chan *relayv1.TunnelFrame
	recvs   int
}

func (s *fakeSourceStream) Send(frame *relayv1.TunnelFrame) error {
	select {
	case s.sent <- frame:
	default:
	}
	return nil
}

func (s *fakeSourceStream) Recv() (*relayv1.TunnelFrame, error) {
	s.recvs++
	if s.recvs > 1 {
		if s.hold != nil {
			<-s.hold
		}
		if s.recvs-2 < len(s.replies) {
			return s.replies[s.recvs-2], nil
		}
		return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, nil
	}
	if s.admit != nil {
		<-s.admit
	}
	if s.refusal != nil {
		return nil, s.refusal
	}
	return s.first, nil
}

func readyFrame() *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 16 * 1024}}}
}

func newRelayTestPlugin(t *testing.T, broker *fakeTunnelBroker, assignments ...*pb.RelayGrantAssignment) (*DockerPlugin, *lockedLog) {
	t.Helper()
	logger, output := newTestLogger()
	plugin := &DockerPlugin{logger: logger, relayGrants: &relayGrantStore{current: &pb.SyncRelayGrantsCommand{Grants: assignments}, changed: make(chan struct{}, 1)}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	plugin.relayTunnels = map[string]*relayTunnelRouter{
		relaybridge.LegacyTargetID: {plugin: plugin, ctx: ctx, client: broker, targetID: relaybridge.LegacyTargetID, registrations: map[string]*relayEndpointRegistration{}},
	}
	return plugin, output
}

func connectAssignment(ownerKind, ownerID string) *pb.RelayGrantAssignment {
	return connectAssignmentWithSessions(ownerKind, ownerID, 64)
}

func connectAssignmentWithSessions(ownerKind, ownerID string, sessions uint32) *pb.RelayGrantAssignment {
	payload, _ := json.Marshal(map[string]any{"kind": "connect", "maxConcurrentSessions": sessions})
	return &pb.RelayGrantAssignment{Role: "connect", OwnerKind: ownerKind, OwnerId: ownerID,
		Grant: &pb.RelaySignedGrant{KeyId: "key-1", Payload: payload, Signature: []byte("signature")}}
}

// A binding at its relay session limit: the relay refuses the tunnel, and the daemon says which binding and why
// instead of closing the client's connection silently.
func TestManagedDatabaseBindingLogsTheRelayRefusal(t *testing.T) {
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{refusal: status.Error(codes.ResourceExhausted, "relay route session capacity reached"), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, output := newRelayTestPlugin(t, broker, connectAssignment("managed_database_binding", testListenerBindingA))
	for range 3 {
		client, daemonSide := net.Pipe()
		plugin.openManagedDatabaseBinding(daemonSide, testListenerBindingA, 0, listenerPeer{}, false)
		_ = daemonSide.Close()
		_ = client.Close()
	}
	lines := output.lines("level=WARN", "managed link connection rejected", "binding_id="+testListenerBindingA,
		"reason="+linkRejectedRelayCapacity, `error="relay route session capacity reached"`)
	if len(lines) != 1 || len(output.lines("connection rejected")) != 1 {
		t.Fatalf("relay refusal logged %q", output.lines("rejected"))
	}
}

// The storage connector hears "ready" only once the relay admitted the tunnel; a capacity refusal reaches it as an
// error it can report.
func TestStorageConnectorRelayAnswersOnceTheTunnelIsOpen(t *testing.T) {
	admit := make(chan struct{})
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{admit: admit, first: readyFrame(), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, _ := newRelayTestPlugin(t, broker, connectAssignment(storageBindingOwnerKind, testStorageBindingID))
	connector, daemonSide := net.Pipe()
	defer connector.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.handleStorageConnectorRelay(daemonSide)
	}()
	if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: testStorageBindingID}); err != nil {
		t.Fatal(err)
	}
	answered := make(chan securelink.RelayResponse, 1)
	go func() {
		var response securelink.RelayResponse
		if err := securelink.ReadJSON(connector, &response); err == nil {
			answered <- response
		}
	}()
	select {
	case response := <-answered:
		t.Fatalf("connector answered before the relay admitted the tunnel: %+v", response)
	case <-time.After(150 * time.Millisecond):
	}
	close(admit)
	select {
	case response := <-answered:
		if response.Error != "" {
			t.Fatalf("admitted tunnel answered with %q", response.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("connector not answered after the relay admitted the tunnel")
	}
	// The relay ends the tunnel; the daemon closes the connector's connection.
	_, _ = io.Copy(io.Discard, connector)
	<-done
}

func TestStorageConnectorRelayReportsTheCapacityRefusal(t *testing.T) {
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{refusal: status.Error(codes.ResourceExhausted, "relay route session capacity reached"), sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, output := newRelayTestPlugin(t, broker, connectAssignment(storageBindingOwnerKind, testStorageBindingID))
	connector, daemonSide := net.Pipe()
	defer connector.Close()
	go plugin.handleStorageConnectorRelay(daemonSide)
	if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: testStorageBindingID}); err != nil {
		t.Fatal(err)
	}
	var response securelink.RelayResponse
	if err := securelink.ReadJSON(connector, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "storage link session capacity reached: relay route session capacity reached" {
		t.Fatalf("refusal answered with %q", response.Error)
	}
	if lines := output.lines("level=WARN", "binding_id="+testStorageBindingID, "reason="+linkRejectedRelayCapacity); len(lines) != 1 {
		t.Fatalf("storage refusal logged %q", output.lines("rejected"))
	}
	if !strings.Contains(output.lines("rejected")[0], "owner_kind="+storageBindingOwnerKind) {
		t.Fatalf("storage refusal without its owner kind: %q", output.lines("rejected"))
	}
}

// Every connection of a storage link passes the daemon's connector socket: the link is held at its grant's limit
// whichever relay of the pool would carry the next connection, and the refusal reaches the connector, the log and the
// link's runtime.
func TestStorageConnectorRelayHoldsTheLinkAtItsGrantLimit(t *testing.T) {
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{first: readyFrame(), hold: hold, sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	plugin, output := newRelayTestPlugin(t, broker, connectAssignmentWithSessions(storageBindingOwnerKind, testStorageBindingID, 2))
	open := func() securelink.RelayResponse {
		t.Helper()
		connector, daemonSide := net.Pipe()
		t.Cleanup(func() { connector.Close() })
		go plugin.handleStorageConnectorRelay(daemonSide)
		if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: storageBindingOwnerKind, BindingID: testStorageBindingID}); err != nil {
			t.Fatal(err)
		}
		var response securelink.RelayResponse
		if err := securelink.ReadJSON(connector, &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	for range 2 {
		if response := open(); response.Error != "" {
			t.Fatalf("connection within the link limit refused: %q", response.Error)
		}
	}
	if response := open(); response.Error != "storage link session capacity reached: the link carries its 2 concurrent connections" {
		t.Fatalf("connection over the link limit answered with %q", response.Error)
	}
	if lines := output.lines("level=WARN", "owner_kind="+storageBindingOwnerKind, "binding_id="+testStorageBindingID, "reason="+linkRejectedLinkLimit, "limit=2"); len(lines) != 1 {
		t.Fatalf("storage link limit logged %q", output.lines("rejected"))
	}
	reports := plugin.managedLinkRuntime()
	if len(reports) != 1 {
		t.Fatalf("link reports %+v", reports)
	}
	report := reports[0]
	if report.GetOwnerKind() != storageBindingOwnerKind || report.GetOwnerId() != testStorageBindingID ||
		report.GetActiveConnections() != 2 || report.GetConnectionLimit() != 2 || report.GetRejectedTotal() != 1 ||
		report.GetLastRejectionReason() != linkRejectedLinkLimit || report.GetLastRejectedAtUnixMs() == 0 {
		t.Fatalf("storage link report %+v", report)
	}
}

// A database link carries as many connections through the egress socket as its grant allows (the database's
// max_connections): the node's own bound is the host listeners' runaway guard, not the 128 that capped every database
// link of the node together on the rc.1 stand.
func TestEgressCarriesDatabaseLinkConnectionsUpToTheGrantLimit(t *testing.T) {
	const linkID, limit = "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", 300
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream {
		return &fakeSourceStream{first: readyFrame(), hold: hold, sent: make(chan *relayv1.TunnelFrame, 4)}
	}}
	assignment := connectAssignmentWithSessions(linkKindManagedDatabaseBinding, linkID, limit)
	assignment.SecureLinkEgress = &pb.SecureLinkEgress{NetworkName: legacycompat.DatabaseLinkNetworkPrefix + "0123456789abcdef", Alias: "db", ListenPort: 5432}
	plugin, output := newRelayTestPlugin(t, broker, assignment)
	plugin.egressDatabaseSlots = make(chan struct{}, egressDatabaseSessions)
	open := func() securelink.RelayResponse {
		t.Helper()
		connector, daemonSide := net.Pipe()
		t.Cleanup(func() { connector.Close() })
		go plugin.handleSecureLinkEgress(daemonSide)
		if err := securelink.WriteJSON(connector, securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: linkKindManagedDatabaseBinding, BindingID: linkID}); err != nil {
			t.Fatal(err)
		}
		var response securelink.RelayResponse
		if err := securelink.ReadJSON(connector, &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	for opened := range limit {
		if response := open(); response.Error != "" {
			t.Fatalf("connection %d of %d refused: %q", opened+1, limit, response.Error)
		}
	}
	if response := open(); response.Error != fmt.Sprintf("link session capacity reached: the link carries its %d concurrent connections", limit) {
		t.Fatalf("connection over the link limit answered with %q", response.Error)
	}
	if lines := output.lines("reason=" + linkRejectedNodeLimit); len(lines) != 0 {
		t.Fatalf("node limit refused link connections: %q", lines)
	}
}

// A link's sessions and bytes are counted where the node proxies them, so the link runtime has its totals whichever
// relay of the pool carries a session.
func TestManagedLinkTrafficIsCountedOnTheNode(t *testing.T) {
	hold := make(chan struct{})
	stream := &fakeSourceStream{first: readyFrame(), hold: hold, sent: make(chan *relayv1.TunnelFrame, 4),
		replies: []*relayv1.TunnelFrame{{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("pong!")}}}}}
	broker := &fakeTunnelBroker{open: func() *fakeSourceStream { return stream }}
	plugin, _ := newRelayTestPlugin(t, broker, connectAssignment(linkKindManagedDatabaseBinding, testListenerBindingA))
	client, daemonSide := net.Pipe()
	defer client.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.openManagedDatabaseBinding(daemonSide, testListenerBindingA, 0, listenerPeer{}, false)
	}()
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	for sent := range stream.sent {
		if data := sent.GetData(); data != nil {
			if string(data.GetData()) != "ping" {
				t.Fatalf("relay got %q", data.GetData())
			}
			break
		}
	}
	// The session is open: it counts as opened, not as completed.
	if reports := plugin.managedLinkRuntime(); len(reports) != 1 || reports[0].GetOpenedTotal() != 1 || reports[0].GetCompletedTotal() != 0 {
		t.Fatalf("link report of an open session %+v", reports)
	}
	close(hold)
	reply := make([]byte, 5)
	if _, err := io.ReadFull(client, reply); err != nil || string(reply) != "pong!" {
		t.Fatalf("client read %q, %v", reply, err)
	}
	<-done

	reports := plugin.managedLinkRuntime()
	if len(reports) != 1 {
		t.Fatalf("link reports %+v", reports)
	}
	if report := reports[0]; report.GetOpenedTotal() != 1 || report.GetSourceToTargetBytes() != 4 ||
		report.GetTargetToSourceBytes() != 5 || report.GetActiveConnections() != 0 || report.GetCompletedTotal() != 1 {
		t.Fatalf("link report %+v", report)
	}
}
