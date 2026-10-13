package lease

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type coordinateStream struct {
	relayv1.TunnelBroker_CoordinateServer
	ctx  context.Context
	in   chan *relayv1.CoordinationFrame
	sent chan *relayv1.CoordinationFrame
}

func newCoordinateStream(ctx context.Context) *coordinateStream {
	return &coordinateStream{ctx: ctx, in: make(chan *relayv1.CoordinationFrame, 8), sent: make(chan *relayv1.CoordinationFrame, 64)}
}

func (s *coordinateStream) Context() context.Context { return s.ctx }
func (s *coordinateStream) Recv() (*relayv1.CoordinationFrame, error) {
	select {
	case frame, ok := <-s.in:
		if !ok {
			return nil, io.EOF
		}
		return frame, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}
func (s *coordinateStream) Send(frame *relayv1.CoordinationFrame) error {
	s.sent <- frame
	return nil
}
func (s *coordinateStream) SetHeader(metadata.MD) error  { return nil }
func (s *coordinateStream) SendHeader(metadata.MD) error { return nil }
func (s *coordinateStream) SetTrailer(metadata.MD)       {}

func clientContext(commonName string) context.Context {
	return clientContextWith(context.Background(), commonName)
}

func clientContextWith(parent context.Context, commonName string) context.Context {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: commonName}, SerialNumber: big.NewInt(1), Raw: []byte(commonName)}
	return grpcpeer.NewContext(parent, &grpcpeer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate}}}}})
}

// serve runs Coordinate for a client and returns its stream and result.
func serve(h *harness, ctx context.Context) (*coordinateStream, chan error) {
	stream := newCoordinateStream(ctx)
	result := make(chan error, 1)
	go func() { result <- h.relay.Coordinate(stream) }()
	return stream, result
}

func (h *harness) frame(from, to string, blocks ...*relayv1.LeaseSignedBlock) *relayv1.CoordinationFrame {
	h.t.Helper()
	batch := &relayv1.LeaseBatch{MessageId: from + "/test/" + to, SenderId: from, SenderIncarnation: 1, DestinationId: to, Blocks: blocks}
	frame, err := availabilitylease.SealFrame(batch, availabilitylease.ECDSASigner{Key: h.keys[from]})
	if err != nil {
		h.t.Fatal(err)
	}
	return frame
}

func waitCode(t *testing.T, result chan error, want codes.Code) {
	t.Helper()
	select {
	case err := <-result:
		if status.Code(err) != want {
			t.Fatalf("Coordinate ended with %v, want %v", err, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Coordinate did not end with %v", want)
	}
}

func waitFrame(t *testing.T, stream *coordinateStream, want *relayv1.CoordinationFrame) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame := <-stream.sent:
			if isBeacon(frame) && !isBeacon(want) {
				continue
			}
			if frame.GetSenderId() != want.GetSenderId() || string(frame.GetPayload()) != string(want.GetPayload()) {
				t.Fatalf("routed frame from %q differs", frame.GetSenderId())
			}
			return
		case <-deadline:
			t.Fatal("frame was not routed")
		}
	}
}

// isBeacon reports a relay clock beacon: an empty batch from the relay that
// carries only its clock (D4).
func isBeacon(frame *relayv1.CoordinationFrame) bool {
	batch := &relayv1.LeaseBatch{}
	return frame.GetSenderId() == relayID && proto.Unmarshal(frame.GetPayload(), batch) == nil &&
		len(batch.GetItems()) == 0 && len(batch.GetBlocks()) == 0 && batch.GetSenderClockMs() > 0
}

// D4: a member that connects gets the relay's clock at once, so a holder
// reconnecting after a freeze learns of it without waiting for any round.
func TestCoordinateBeaconsAMemberOnConnect(t *testing.T) {
	h := newHarness(t, true)
	stream, _ := serve(h, clientContext("d1"))
	select {
	case frame := <-stream.sent:
		if !isBeacon(frame) || frame.GetDestinationId() != "d1" {
			t.Fatalf("first frame on a new stream is not a clock beacon: %v", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no beacon on connect")
	}
}

func TestCoordinateRequiresClientCertificateAndMembership(t *testing.T) {
	h := newHarness(t, true)
	if err := h.relay.Coordinate(newCoordinateStream(context.Background())); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("anonymous Coordinate = %v", err)
	}
	h.keys["stranger"] = h.keys["d1"]
	stranger, result := serve(h, clientContext("stranger"))
	stranger.in <- h.frame("stranger", "d1")
	waitCode(t, result, codes.PermissionDenied)

	// A member may not send frames in another member's name.
	impostor, result := serve(h, clientContext("d2"))
	impostor.in <- h.frame("d1", "d2")
	waitCode(t, result, codes.PermissionDenied)
}

func TestCoordinateRoutesByDestinationAndFollowsSignedBlocks(t *testing.T) {
	h := newHarness(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d1, d1Result := serve(h, clientContext("d1"))
	d2, d2Result := serve(h, clientContext("d2"))
	waitConnected(t, h, "d1", "d2")

	frame := h.frame("d1", "d2")
	d1.in <- frame
	waitFrame(t, d2, frame)

	// d3 is named only by a newer manifest that its first frame carries; the
	// manifest also drops d2, whose stream ends.
	next := h.signManifest([]string{"d1", "d3"}, false)
	d3, d3Result := serve(h, clientContext("d3"))
	announce := h.frame("d3", "d1", next)
	d3.in <- announce
	waitFrame(t, d1, announce)
	waitCode(t, d2Result, codes.PermissionDenied)
	if !h.relay.view.authorized("d3") || h.relay.view.authorized("d2") {
		t.Fatal("member view did not follow the forwarded manifest")
	}
	if version := h.relay.node.ManifestVersion(policyID); version != 2 {
		t.Fatalf("relay node manifest version = %d, want the forwarded 2", version)
	}

	// A forged manifest (bad policy-key signature) authorizes nobody.
	forged := h.signManifest([]string{"d1", "d4"}, false)
	forged.Signature[0] ^= 0xff
	h.keys["d4"] = h.keys["d1"]
	d4, d4Result := serve(h, clientContext("d4"))
	d4.in <- h.frame("d4", "d1", forged)
	waitCode(t, d4Result, codes.PermissionDenied)

	cancel()
	close(d1.in)
	close(d3.in)
	for _, result := range []chan error{d1Result, d3Result} {
		select {
		case <-result:
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
			t.Fatal("stream did not end")
		}
	}
}

// D3: a frame is routed only between peers one policy names together. x is a
// candidate of policy-2 only: its frame to d1 (policy-1 only) is dropped, its
// frame to v1, which votes in both, is routed.
func TestCoordinateRoutesOnlyWithinASharedPolicy(t *testing.T) {
	h := newHarness(t, true)
	h.signPolicy("policy-2", []string{"x"}, []string{"v1", "v2", "v3"}, false)
	h.relay.ApplyPolicy(h.snapshot())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	x, _ := serve(h, clientContextWith(ctx, "x"))
	d1, _ := serve(h, clientContextWith(ctx, "d1"))
	v1, _ := serve(h, clientContextWith(ctx, "v1"))
	waitConnected(t, h, "d1", "v1")

	x.in <- h.frame("x", "d1")
	toV1 := h.frame("x", "v1")
	x.in <- toV1
	waitFrame(t, v1, toV1)
	// d1's stream is first in, first out: a routed frame from x would arrive
	// before this one from v1, and waitFrame fails on any other frame.
	fromV1 := h.frame("v1", "d1")
	v1.in <- fromV1
	waitFrame(t, d1, fromV1)
}

func waitConnected(t *testing.T, h *harness, ids ...string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.relay.mu.Lock()
		connected := 0
		for _, id := range ids {
			// The harness registers its own stream per daemon; a served one
			// makes two.
			if len(h.relay.streams[id]) >= 2 {
				connected++
			}
		}
		h.relay.mu.Unlock()
		if connected == len(ids) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("members %v did not connect", ids)
}

type watchStream struct {
	relayv1.TunnelBroker_WatchLeaseGatesServer
	ctx  context.Context
	sent chan *relayv1.LeaseGateSnapshot
}

func (s *watchStream) Context() context.Context { return s.ctx }
func (s *watchStream) Send(snapshot *relayv1.LeaseGateSnapshot) error {
	s.sent <- snapshot
	return nil
}
func (s *watchStream) SetHeader(metadata.MD) error  { return nil }
func (s *watchStream) SendHeader(metadata.MD) error { return nil }
func (s *watchStream) SetTrailer(metadata.MD)       {}

// nginx daemons are observers (A18): never manifest members or candidates,
// yet they must receive gate views. Only an unauthenticated client is refused.
func TestWatchLeaseGatesStreamsTheGateViewToObservers(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	anonymous := &watchStream{ctx: context.Background(), sent: make(chan *relayv1.LeaseGateSnapshot, 1)}
	if err := h.relay.WatchLeaseGates(&relayv1.LeaseGateWatchRequest{}, anonymous); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("anonymous watch = %v", err)
	}
	if h.relay.view.authorized("nginx-1") {
		t.Fatal("the observer is a manifest member; the test would not cover observers")
	}
	ctx, cancel := context.WithCancel(clientContext("nginx-1"))
	defer cancel()
	stream := &watchStream{ctx: ctx, sent: make(chan *relayv1.LeaseGateSnapshot, 4)}
	result := make(chan error, 1)
	go func() {
		result <- h.relay.WatchLeaseGates(&relayv1.LeaseGateWatchRequest{PolicyIds: []string{policyID}}, stream)
	}()
	select {
	case snapshot := <-stream.sent:
		gates := snapshot.GetGates()
		if snapshot.GetRelayMemberId() != relayID || len(gates) != 1 || !gates[0].GetLeaseMode() || !gates[0].GetOpen() ||
			gates[0].GetHolderId() != "d1" || gates[0].GetRemainingMs() == 0 || gates[0].GetRemainingMs() > 24_000 {
			t.Fatalf("gate snapshot = %v", snapshot)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no gate snapshot")
	}
	cancel()
	<-result
}
