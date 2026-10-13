package relayresume

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// memStream is one end of an in-memory relay tunnel: ordered, reliable,
// and ended for both ends at once when the relay drops it.
type memStream struct {
	in     chan *relayv1.TunnelFrame
	out    chan *relayv1.TunnelFrame
	tunnel *memTunnel
	target bool
	// cancelled closes when the target cancels its own end.
	cancelled  chan struct{}
	cancelOnce sync.Once
}

type memTunnel struct {
	relay *memRelay
	dead  chan struct{}
	once  sync.Once
	err   error
	// stall: the relay stops reading what the target sends (its sends block
	// until the tunnel ends, as gRPC flow control does).
	stall atomic.Bool
}

func (t *memTunnel) kill(err error) {
	t.once.Do(func() {
		t.err = err
		close(t.dead)
	})
}

func (m *memStream) Send(frame *relayv1.TunnelFrame) error {
	select {
	case <-m.tunnel.dead:
		return m.tunnel.err
	default:
	}
	if m.target && m.tunnel.stall.Load() {
		// Like gRPC's write quota: only the sender's own cancel ends the wait.
		<-m.cancelled
		return status.Error(codes.Canceled, "context canceled")
	}
	// The transport copies a frame (gRPC marshals it): senders reuse buffers.
	if data := frame.GetData(); data != nil {
		frame = &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), data.Data...)}}}
	}
	select {
	case m.out <- frame:
		return nil
	case <-m.tunnel.dead:
		return m.tunnel.err
	}
}

func (m *memStream) Recv() (*relayv1.TunnelFrame, error) {
	select {
	case frame := <-m.in:
		return frame, nil
	case <-m.tunnel.dead:
		// Frames the relay already forwarded arrive first.
		select {
		case frame := <-m.in:
			return frame, nil
		default:
		}
		return nil, m.tunnel.err
	}
}

type memRelay struct {
	id       string
	maxFrame int
	mu       sync.Mutex
	tunnels  []*memTunnel
	down     atomic.Bool
}

func (r *memRelay) open() (*memStream, *memStream, *memTunnel) {
	tunnel := &memTunnel{relay: r, dead: make(chan struct{})}
	a, b := make(chan *relayv1.TunnelFrame, 64), make(chan *relayv1.TunnelFrame, 64)
	r.mu.Lock()
	r.tunnels = append(r.tunnels, tunnel)
	r.mu.Unlock()
	return &memStream{in: b, out: a, tunnel: tunnel}, &memStream{in: a, out: b, tunnel: tunnel, target: true, cancelled: make(chan struct{})}, tunnel
}

// live counts the relay's tunnels nobody ended yet.
func (r *memRelay) live() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, tunnel := range r.tunnels {
		select {
		case <-tunnel.dead:
		default:
			n++
		}
	}
	return n
}

// cut drops every tunnel of the relay (a killed relay process).
func (r *memRelay) cut() {
	r.mu.Lock()
	tunnels := r.tunnels
	r.tunnels = nil
	r.mu.Unlock()
	for _, tunnel := range tunnels {
		tunnel.kill(status.Error(codes.Unavailable, "transport is closing"))
	}
}

// harness joins a source manager and a target table through memory relays;
// the target serves an echo backend over TCP.
type harness struct {
	t       *testing.T
	mgr     *Manager
	table   *TargetTable
	relays  []*memRelay
	key     []byte
	revoked atomic.Bool
	legacy  atomic.Bool // the target is a pre-RSv1 daemon
	// helloDelay holds the target's first read (its HELLO_ACK comes late).
	helloDelay atomic.Int64
	backend    net.Listener
	wg         sync.WaitGroup
	// wake is the sources' SourceConfig.Wake (nil: none).
	wake func() <-chan struct{}
}

func newHarness(t *testing.T, relays ...string) *harness {
	h := &harness{t: t, mgr: NewManager(nil), table: NewTargetTable(nil), key: bytes.Repeat([]byte{3}, KeyLen)}
	for _, id := range relays {
		h.relays = append(h.relays, &memRelay{id: id, maxFrame: MaxFrameBytes})
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.backend = listener
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
				_ = conn.(*net.TCPConn).CloseWrite()
			}()
		}
	}()
	t.Cleanup(func() { listener.Close() })
	return h
}

func (h *harness) relay(id string) *memRelay {
	for _, r := range h.relays {
		if r.id == id {
			return r
		}
	}
	return nil
}

func (h *harness) keys(keyID string) []byte {
	if keyID == "v1" {
		return h.key
	}
	return nil
}

// dialer is the sessions' Dialer: dial with the request's relay to avoid.
func (h *harness) dialer(ctx context.Context, request DialRequest) (OpenedPath, error) {
	return h.dial(ctx, request.Avoid)
}

// dial opens a tunnel on the first live relay other than avoid (or avoid
// itself when it is the only one) and serves its target end.
func (h *harness) dial(_ context.Context, avoid string) (OpenedPath, error) {
	var pick *memRelay
	for _, r := range h.relays {
		if r.down.Load() {
			continue
		}
		if pick == nil || (pick.id == avoid && r.id != avoid) {
			pick = r
		}
	}
	if pick == nil {
		return OpenedPath{}, errors.New("no relay")
	}
	src, tgt, tunnel := pick.open()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		h.serveTarget(OpenedPath{Stream: tgt, Cancel: func() {
			tgt.cancelOnce.Do(func() { close(tgt.cancelled) })
			tunnel.kill(status.Error(codes.Canceled, "context canceled"))
		},
			CloseSend: func() error {
				// The relay passes the end of one direction on as HalfClose.
				select {
				case tgt.out <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}:
				case <-tunnel.dead:
				}
				return nil
			}, RelayID: pick.id, MaxFrame: pick.maxFrame})
	}()
	return OpenedPath{Stream: src, Cancel: func() { tunnel.kill(status.Error(codes.Canceled, "context canceled")) }, RelayID: pick.id, MaxFrame: pick.maxFrame}, nil
}

func (h *harness) serveTarget(op OpenedPath) {
	defer op.Cancel()
	bridge := func(stream relaybridge.FrameStream, maxFrame int, cancel func()) {
		conn, err := net.Dial("tcp", h.backend.Addr().String())
		if err != nil {
			return
		}
		ctx, stop := context.WithCancel(context.Background())
		defer stop()
		_ = relaybridge.BridgeWithChunk(ctx, conn, stream, maxFrame, 32*1024, cancel)
	}
	if h.legacy.Load() {
		bridge(op.Stream, op.MaxFrame, op.Cancel)
		return
	}
	time.Sleep(time.Duration(h.helloDelay.Swap(0)))
	accepted := h.table.Accept(op, AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1", RelayID: op.RelayID,
		Keys: h.keys, Authorize: func() error {
			if h.revoked.Load() {
				return errors.New("revoked")
			}
			return nil
		}})
	switch accepted.Kind {
	case AcceptLegacy:
		bridge(accepted.Stream, op.MaxFrame, op.Cancel)
	case AcceptHello:
		session, err := accepted.Establish()
		if err != nil {
			return
		}
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			bridge(session, session.MaxFrame(), session.Cancel)
		}()
		<-accepted.PathDone
	default:
		<-accepted.PathDone
	}
}

// stream opens a resumable source stream and returns the application's end.
func (h *harness) stream() (net.Conn, *Session) {
	first, err := h.dial(context.Background(), "")
	if err != nil {
		h.t.Fatal(err)
	}
	session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Dial: h.dialer, Wake: h.wake,
		Key: func() (string, []byte, bool) { return "v1", h.key, true }}, first)
	if err != nil {
		h.t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		h.t.Fatal(err)
	}
	defer listener.Close()
	app, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	local, err := listener.Accept()
	if err != nil {
		h.t.Fatal(err)
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		_ = relaybridge.BridgeWithChunk(context.Background(), local, session, session.MaxFrame(), 32*1024, session.Cancel)
	}()
	return app, session
}

// echo writes size random bytes and checks they come back exactly while
// during() runs.
func echo(t *testing.T, app net.Conn, size int, during func()) {
	t.Helper()
	data := make([]byte, size)
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range data {
		data[i] = byte(rng.Uint32())
	}
	got := make(chan []byte, 1)
	go func() {
		received, _ := io.ReadAll(app)
		got <- received
	}()
	go func() {
		for off := 0; off < len(data); {
			n := min(len(data)-off, 1+rng.IntN(64*1024))
			if _, err := app.Write(data[off : off+n]); err != nil {
				return
			}
			off += n
			if off > len(data)/3 && during != nil {
				during()
				during = nil
			}
		}
		_ = app.(*net.TCPConn).CloseWrite()
	}()
	select {
	case received := <-got:
		if sha256.Sum256(received) != sha256.Sum256(data) {
			t.Fatalf("echo differs: %d of %d bytes", len(received), len(data))
		}
	case <-time.After(60 * time.Second):
		t.Fatal("echo timed out")
	}
}

// waitMoved waits until s left relay (reported with Errorf: it runs on the
// echo writer's goroutine).
func waitMoved(t *testing.T, s *Session, relay string) bool {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if current := s.RelayID(); current != "" && current != relay {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("stream did not leave %s", relay)
	return false
}

// waitOpen waits for the handshake: a path lost before it is a cut by design.
func waitOpen(t *testing.T, s *Session) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for s.State() == StateHandshake && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if state := s.State(); state != StateOpen {
		t.Fatalf("stream did not open: %s (%v)", state, s.Err())
	}
}

func waitDone(t *testing.T, s *Session) {
	t.Helper()
	select {
	case <-s.Done():
	case <-time.After(20 * time.Second):
		t.Fatalf("session did not end: %s", s.State())
	}
}

func TestSessionEcho(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	app, session := h.stream()
	echo(t, app, 3<<20, nil)
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
}

func TestSessionPlannedDrain(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	app, session := h.stream()
	waitOpen(t, session)
	echo(t, app, 6<<20, func() {
		h.relay("relay-a").down.Store(true)
		h.mgr.DrainRelay("relay-a", time.Time{})
		deadline := time.Now().Add(5 * time.Second)
		for session.RelayID() != "relay-b" && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if session.RelayID() != "relay-b" {
			t.Errorf("stream did not move: %q", session.RelayID())
		}
		// The drained relay holds no tunnel of the stream any more.
		for time.Now().Before(deadline) && h.relay("relay-a").live() > 0 {
			time.Sleep(10 * time.Millisecond)
		}
		if live := h.relay("relay-a").live(); live > 0 {
			t.Errorf("drained relay still holds %d tunnels", live)
		}
	})
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
	if h.mgr.Stats().MigrationsOK == 0 {
		t.Fatal("no migration counted")
	}
}

func TestSessionRelayKilled(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	app, session := h.stream()
	waitOpen(t, session)
	echo(t, app, 6<<20, func() {
		h.relay("relay-a").down.Store(true)
		h.relay("relay-a").cut()
	})
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
}

func TestSessionSameRelayComesBack(t *testing.T) {
	h := newHarness(t, "relay-a")
	app, session := h.stream()
	waitOpen(t, session)
	echo(t, app, 2<<20, func() {
		relay := h.relay("relay-a")
		relay.down.Store(true)
		relay.cut()
		time.Sleep(700 * time.Millisecond)
		relay.down.Store(false)
	})
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
}

// A stream whose move fails because no relay path is up retries as soon as its
// source says one may be (SourceConfig.Wake), not after the rest of its backoff
// (stand rc.10 O-6: streams a daemon took over waited 1.0-1.2 s for relay
// connections that were up after 0.5 s).
func TestUnplannedMoveRetriesWhenWoken(t *testing.T) {
	h := newHarness(t, "relay-a")
	var wake Signal
	h.wake = wake.Wait
	moved := make(chan time.Time, 8)
	h.mgr.OnMigration = func(event MigrationEvent) {
		if event.OK {
			moved <- time.Now()
		}
	}
	app, session := h.stream()
	waitOpen(t, session)
	echo(t, app, 2<<20, func() {
		relay := h.relay("relay-a")
		relay.down.Store(true)
		relay.cut()
		// Attempts at 0, ~0.28 and ~0.85 s fail; the next would come at ~2 s.
		time.Sleep(1100 * time.Millisecond)
		relay.down.Store(false)
		woken := time.Now()
		wake.Fire()
		select {
		case at := <-moved:
			if took := at.Sub(woken); took > 300*time.Millisecond {
				t.Errorf("moved %v after the wake", took)
			}
		case <-time.After(5 * time.Second):
			t.Error("not moved")
		}
	})
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
}

// A drain notice that arrives while the stream is still in its handshake is
// kept and carried out once the stream can move.
func TestSessionDrainDuringHandshake(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	h.helloDelay.Store(int64(300 * time.Millisecond))
	app, session := h.stream()
	first := session.RelayID()
	if session.State() != StateHandshake {
		t.Fatalf("state %s", session.State())
	}
	h.mgr.DrainRelay(first, time.Now().Add(50*time.Millisecond))
	echo(t, app, 1<<20, nil)
	waitDone(t, session)
	if session.State() != StateFinished || h.mgr.Stats().MigrationsOK != 1 {
		t.Fatalf("state %s, migrations %d", session.State(), h.mgr.Stats().MigrationsOK)
	}
}

// A target whose old path stopped taking its sends (a relay that no longer
// reads it) still answers the RESUME on the new path: a send stuck on a
// given-up path never holds back another path.
func TestSessionResumeWhileOldPathSendIsStuck(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	app, session := h.stream()
	waitOpen(t, session)
	relay := h.relay("relay-a")
	started := time.Now()
	echo(t, app, 2<<20, func() {
		relay.mu.Lock()
		for _, tunnel := range relay.tunnels {
			tunnel.stall.Store(true)
		}
		relay.mu.Unlock()
		time.Sleep(100 * time.Millisecond) // the target's sends pile up on relay-a
		relay.down.Store(true)
		h.mgr.DrainRelay("relay-a", time.Now().Add(10*time.Millisecond))
		// The relay drops the tunnel; the target's stuck send does not notice.
		relay.cut()
	})
	waitDone(t, session)
	if session.State() != StateFinished {
		t.Fatalf("state %s err %v", session.State(), session.Err())
	}
	// The first RESUME was answered (no RESUME_ACK timeout and retry).
	if stats := h.mgr.Stats(); stats.MigrationsFailed != 0 || time.Since(started) > ResumeAckTimeout {
		t.Fatalf("migrations failed %d, took %s", stats.MigrationsFailed, time.Since(started))
	}
}

func TestSessionGoAwayAndTargetHint(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b", "relay-c")
	app, session := h.stream()
	waitOpen(t, session)
	echo(t, app, 4<<20, func() {
		first := session.RelayID()
		h.mgr.RelayLost(first)
		if !waitMoved(t, session, first) {
			return
		}
		second := session.RelayID()
		h.table.RequestMigrate(second, MigrateGoAway)
		waitMoved(t, session, second)
	})
	waitDone(t, session)
	if session.State() != StateFinished || h.mgr.Stats().MigrationsOK < 2 {
		t.Fatalf("state %s, migrations %d", session.State(), h.mgr.Stats().MigrationsOK)
	}
}

func TestSessionRevokedWhileSuspended(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	app, session := h.stream()
	waitOpen(t, session)
	if _, err := app.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(app, buf); err != nil {
		t.Fatal(err)
	}
	h.revoked.Store(true)
	h.relay(session.RelayID()).cut()
	waitDone(t, session)
	var reset *ResetError
	if !errors.As(session.Err(), &reset) || reset.Reject != RejectUnauthorized {
		t.Fatalf("err %v", session.Err())
	}
	if _, err := app.Read(buf); err == nil {
		t.Fatal("application socket still open")
	}
}

// A source that only sends (its bridge not receiving yet) still reads the
// handshake answer and the acks: the background reader takes the stream.
func TestSessionWithoutRecv(t *testing.T) {
	h := newHarness(t, "relay-a")
	first, err := h.dial(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Dial: h.dialer,
		Key: func() (string, []byte, bool) { return "v1", h.key, true }}, first)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 64; i++ {
		if err := session.Write(make([]byte, 16*1024)); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for session.State() == StateHandshake && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if state := session.State(); state != StateOpen {
		t.Fatalf("state %s err %v", state, session.Err())
	}
	session.Abort(RstAborted, "done")
}

// A stream the target ended for a revocation answers a later resume with
// RESUME_REJ unauthorized (its tombstone keeps the reason).
func TestTombstoneKeepsRevocation(t *testing.T) {
	h := newHarness(t, "relay-a")
	// Held until the end: a connection nothing refers to is closed by its finalizer, which can end the stream before
	// it opens (about 1 run in 20 under GOGC=1).
	app, session := h.stream()
	defer app.Close()
	waitOpen(t, session)
	target := h.table.Sessions()[0]
	key := TargetKey{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1", SessionID: target.core.SessionID()}
	h.table.Prune(func(TargetKey, *Session) bool { return false })
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.table.mu.Lock()
		tomb, ok := h.table.tombs[key]
		h.table.mu.Unlock()
		if ok {
			if tomb.reject != RejectUnauthorized {
				t.Fatalf("tombstone answers %d", tomb.reject)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no tombstone")
}

func TestSessionPruneResetsSource(t *testing.T) {
	h := newHarness(t, "relay-a")
	app, session := h.stream()
	if _, err := app.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(app, make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	h.table.Prune(func(TargetKey, *Session) bool { return false })
	waitDone(t, session)
	var reset *ResetError
	if !errors.As(session.Err(), &reset) || !reset.Remote || reset.Code != RstRevoked {
		t.Fatalf("err %v", session.Err())
	}
}

func TestSessionLegacyTargetLatches(t *testing.T) {
	h := newHarness(t, "relay-a")
	h.legacy.Store(true)
	app, session := h.stream()
	_, _ = app.Write([]byte("SELECT 1"))
	waitDone(t, session)
	if !errors.Is(session.Err(), ErrLegacyPeer) {
		t.Fatalf("err %v", session.Err())
	}
	deadline := time.Now().Add(2 * time.Second)
	for !h.mgr.Legacy("route-1") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !h.mgr.Legacy("route-1") {
		t.Fatal("route not latched legacy")
	}
}

// The first-record rule on the target: raw client-first and server-first
// sources, a crafted HELLO and an unknown RESUME.
func TestTargetFirstRecordRule(t *testing.T) {
	h := newHarness(t, "relay-a")
	relay := h.relay("relay-a")
	accept := func(first []byte) (*Accepted, *memStream, time.Duration) {
		src, tgt, tunnel := relay.open()
		if first != nil {
			_ = src.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: first}}})
		}
		start := time.Now()
		accepted := h.table.Accept(OpenedPath{Stream: tgt, Cancel: func() { tunnel.kill(errors.New("cancelled")) }, RelayID: "relay-a", MaxFrame: MaxFrameBytes},
			AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1", RelayID: "relay-a", Keys: h.keys})
		return accepted, src, time.Since(start)
	}
	// Raw client-first: legacy, and the bytes are replayed.
	accepted, _, _ := accept([]byte("GET / HTTP/1.1\r\n"))
	if accepted.Kind != AcceptLegacy {
		t.Fatalf("raw client: %v", accepted.Kind)
	}
	frame, err := accepted.Stream.Recv()
	if err != nil || string(frame.GetData().GetData()) != "GET / HTTP/1.1\r\n" {
		t.Fatalf("replay %v %v", frame, err)
	}
	// Raw server-first: legacy after the first-record wait.
	accepted, src, waited := accept(nil)
	if accepted.Kind != AcceptLegacy || waited < FirstRecordTimeout {
		t.Fatalf("raw server-first: %v after %s", accepted.Kind, waited)
	}
	_ = src.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("late")}}})
	if frame, err := accepted.Stream.Recv(); err != nil || string(frame.GetData().GetData()) != "late" {
		t.Fatalf("late frame %v %v", frame, err)
	}
	// A HELLO-shaped first packet without the key: legacy.
	crafted := mustRecord(&Record{Type: TypeHello, KeyID: "v1", Wnd: InitialWindow})
	if accepted, _, _ := accept(crafted); accepted.Kind != AcceptLegacy {
		t.Fatalf("crafted hello: %v", accepted.Kind)
	}
	// A RESUME nobody owns: RESUME_REJ unknown.
	resume := mustRecord(&Record{Type: TypeResume, KeyID: "v1", Epoch: 1, SessionID: [16]byte{4}})
	accepted, src, _ = accept(resume)
	if accepted.Kind != AcceptRefused || accepted.Reject != RejectUnknown {
		t.Fatalf("unknown resume: %v %d", accepted.Kind, accepted.Reject)
	}
	frame, err = src.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if record, _, _ := ParseRecord(frame.GetData().GetData()); record.Type != TypeResumeRej || record.Code != RejectUnknown {
		t.Fatalf("answer %+v", record)
	}
}

// An unplanned resume tries the relay whose path just failed last: its lane
// may still look up while it refuses, and an open there waits OpenTimeout.
func TestUnplannedResumeTriesTheFailedRelayLast(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	var mu sync.Mutex
	var avoided []string
	first, err := h.dial(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1",
		Key: func() (string, []byte, bool) { return "v1", h.key, true },
		Dial: func(ctx context.Context, request DialRequest) (OpenedPath, error) {
			mu.Lock()
			avoided = append(avoided, request.Avoid)
			mu.Unlock()
			return h.dial(ctx, request.Avoid)
		}}, first)
	if err != nil {
		t.Fatal(err)
	}
	waitOpen(t, session)
	h.relay("relay-a").cut() // the relay stays "up" for the dialer
	deadline := time.Now().Add(10 * time.Second)
	for session.RelayID() != "relay-b" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if session.RelayID() != "relay-b" || len(avoided) == 0 || avoided[0] != "relay-a" {
		t.Fatalf("resumed on %q, dial avoided %v", session.RelayID(), avoided)
	}
	session.Abort(RstAborted, "done")
}

// delayFrames forwards what arrives on from to to after d, in order (a far
// relay), until dead closes.
func delayFrames(from, to chan *relayv1.TunnelFrame, d time.Duration, dead chan struct{}) {
	type timed struct {
		frame *relayv1.TunnelFrame
		at    time.Time
	}
	queue := make(chan timed, 1024)
	go func() {
		for {
			select {
			case frame := <-from:
				queue <- timed{frame, time.Now().Add(d)}
			case <-dead:
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case item := <-queue:
				// What the transport has not delivered when a side cancels is lost.
				select {
				case <-time.After(time.Until(item.at)):
				case <-dead:
					return
				}
				select {
				case to <- item.frame:
				case <-dead:
					return
				}
			case <-dead:
				return
			}
		}
	}()
}

// farRelayHarness is a harness whose target backend answers once and resets
// the connection (as a database does when its client leaves), with a far
// relay whose frames take 30 ms each way (a transport that drops what it has
// not delivered when a side cancels) and a near one. Its dial opens on the far
// relay unless told to avoid it.
func farRelayHarness(t *testing.T) (*harness, func(context.Context, string) (OpenedPath, error)) {
	h := newHarness(t, "relay-far", "relay-near")
	h.backend.Close()
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	h.backend = backend
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				buffer := make([]byte, 64)
				n, _ := conn.Read(buffer)
				_, _ = conn.Write(buffer[:n])
				time.Sleep(time.Millisecond)
				_ = conn.(*net.TCPConn).SetLinger(0)
				_ = conn.Close()
			}()
		}
	}()
	dial := func(_ context.Context, avoid string) (OpenedPath, error) {
		relay := h.relay("relay-far")
		if avoid == relay.id {
			relay = h.relay("relay-near")
		}
		src, tgt, tunnel := relay.open()
		if relay.id == "relay-far" {
			toTarget, toSource := src.out, tgt.out
			src.out, tgt.out = make(chan *relayv1.TunnelFrame, 64), make(chan *relayv1.TunnelFrame, 64)
			delayFrames(src.out, toTarget, 30*time.Millisecond, tunnel.dead)
			delayFrames(tgt.out, toSource, 30*time.Millisecond, tunnel.dead)
		}
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			h.serveTarget(OpenedPath{Stream: tgt, Cancel: func() {
				tgt.cancelOnce.Do(func() { close(tgt.cancelled) })
				tunnel.kill(status.Error(codes.Canceled, "context canceled"))
			}, CloseSend: func() error {
				select {
				case tgt.out <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}:
				case <-tunnel.dead:
				}
				return nil
			}, RelayID: relay.id, MaxFrame: relay.maxFrame})
		}()
		return OpenedPath{Stream: src, Cancel: func() { tunnel.kill(status.Error(codes.Canceled, "context canceled")) },
			RelayID: relay.id, MaxFrame: relay.maxFrame}, nil
	}
	return h, dial
}

// shortStream runs one request through a new stream opened on the far relay
// (during() runs meanwhile) and returns the stream once it ended. halfClose
// ends the request with the client's FIN; without it the client waits for the
// answer with its side open.
func shortStream(t *testing.T, h *harness, dial func(context.Context, string) (OpenedPath, error), halfClose bool, during func(*Session)) *Session {
	first, err := dial(context.Background(), "relay-near")
	if err != nil {
		t.Error(err)
		return nil
	}
	session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Key: func() (string, []byte, bool) { return "v1", h.key, true },
		Dial: func(ctx context.Context, request DialRequest) (OpenedPath, error) { return dial(ctx, request.Avoid) }}, first)
	if err != nil {
		t.Error(err)
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Error(err)
		return nil
	}
	app, _ := net.Dial("tcp", listener.Addr().String())
	local, _ := listener.Accept()
	listener.Close()
	if app == nil || local == nil {
		t.Error("no local connection")
		return nil
	}
	defer app.Close()
	go func() {
		_ = relaybridge.BridgeWithChunk(context.Background(), local, session, session.MaxFrame(), 32*1024, session.Cancel)
	}()
	if during != nil {
		go during(session)
	}
	_, _ = app.Write([]byte("SELECT 1"))
	if halfClose {
		_ = app.(*net.TCPConn).CloseWrite()
	}
	_, _ = io.ReadAll(app)
	select {
	case <-session.Done():
	case <-time.After(20 * time.Second):
		t.Errorf("stream did not end: %s", session.State())
		return nil
	}
	return session
}

// A target that resets its stream keeps the tunnel until the source read the
// RST: cancelled at once, a far relay's transport dropped it, the source saw
// its path fail, and its resume was refused as a cut (stand rc.6 O-3).
func TestSessionTargetResetReachesTheSource(t *testing.T) {
	h, dial := farRelayHarness(t)
	for i := 0; i < 20; i++ {
		session := shortStream(t, h, dial, i%2 == 0, nil)
		if session == nil {
			return
		}
		var reset *ResetError
		if !errors.As(session.Err(), &reset) || !reset.Remote {
			t.Fatalf("stream %d ended with %v, not the target's reset", i, session.Err())
		}
	}
	if stats := h.mgr.Stats(); stats.Cut != 0 || stats.MigrationsOK+stats.MigrationsFailed != 0 {
		t.Fatalf("cut %d, migrations %d/%d", stats.Cut, stats.MigrationsOK, stats.MigrationsFailed)
	}
}

// Short streams whose target resets them (their backend left) end as the
// peer's reset also when a move to a nearer relay overlaps their end: the
// refusal of the move arrives before the RST on the far old relay, and is no
// cut (stand rc.6 O-3).
func TestSessionPeerResetWhileMovingIsNotCut(t *testing.T) {
	h, dial := farRelayHarness(t)
	var wg sync.WaitGroup
	for i := 0; i < 150; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			session := shortStream(t, h, dial, true, func(session *Session) {
				time.Sleep(time.Duration(rand.IntN(150)) * time.Millisecond)
				h.mgr.Migrate(session, TriggerReturn, time.Time{})
			})
			if session != nil && isCut(session.Err()) {
				t.Errorf("stream %d counted as cut: %v", i, session.Err())
			}
		}(i)
		if i%25 == 24 {
			time.Sleep(20 * time.Millisecond)
		}
	}
	wg.Wait()
	if stats := h.mgr.Stats(); stats.Cut != 0 {
		t.Fatalf("%d streams counted as cut", stats.Cut)
	}
}
