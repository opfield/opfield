package relayresume

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A live handover reads a stream out of one process (HandoverState) and the
// next process carries it on from exactly that state. Until the old process
// commits and detaches, its paths keep running: the tests below play the
// interleavings in which it told the peer something the next process never
// learnt, and lost or cut the stream.

// countStream counts one path end's reads and sends.
type countStream struct {
	Stream
	mu       sync.Mutex
	entered  int64 // Recv calls started
	returned int64 // frames Recv returned
	lastCall int64 // the call that returned the last frame
	sent     int64 // frames Send passed on
}

func (c *countStream) Recv() (*relayv1.TunnelFrame, error) {
	c.mu.Lock()
	c.entered++
	call := c.entered
	c.mu.Unlock()
	frame, err := c.Stream.Recv()
	if err == nil {
		c.mu.Lock()
		c.returned++
		c.lastCall = call
		c.mu.Unlock()
	}
	return frame, err
}

func (c *countStream) Send(frame *relayv1.TunnelFrame) error {
	err := c.Stream.Send(frame)
	if err == nil {
		c.mu.Lock()
		c.sent++
		c.mu.Unlock()
	}
	return err
}

// handled reports that n frames arrived and the session was done with the
// last of them: its reader came back for the next one.
func (c *countStream) handled(n int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.returned >= n && c.entered > c.lastCall
}

func (c *countStream) counts() (returned, sent int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.returned, c.sent
}

// tunnelEnds are the two ends of one tunnel.
type tunnelEnds struct {
	src, tgt *countStream
	tunnel   *memTunnel
}

// handoverWorld joins a source manager and the target daemon's current
// process (a table) through one memory relay. The test plays the bridges: it
// writes and receives on the sessions itself.
type handoverWorld struct {
	t     *testing.T
	key   []byte
	relay *memRelay
	mgr   *Manager

	mu      sync.Mutex
	table   *TargetTable
	tables  []*TargetTable
	tunnels []tunnelEnds
	closed  bool
	// served gets how each tunnel that was not a new stream was served.
	served  chan *Accepted
	targets chan *Session
}

func newHandoverWorld(t *testing.T) *handoverWorld {
	w := &handoverWorld{t: t, key: bytes.Repeat([]byte{7}, KeyLen), relay: &memRelay{id: "relay-a", maxFrame: MaxFrameBytes},
		mgr: NewManager(nil), served: make(chan *Accepted, 64), targets: make(chan *Session, 4)}
	w.setTable(NewTargetTable(nil))
	t.Cleanup(func() {
		w.mu.Lock()
		w.closed = true
		tables := w.tables
		w.mu.Unlock()
		for _, s := range w.mgr.Sessions() {
			s.Abort(RstAborted, "test over")
		}
		for _, table := range tables {
			for _, s := range table.Sessions() {
				s.Abort(RstAborted, "test over")
			}
		}
		w.relay.cut()
	})
	return w
}

func (w *handoverWorld) keys(keyID string) []byte {
	if keyID == "v1" {
		return w.key
	}
	return nil
}

func (w *handoverWorld) sourceConfig() SourceConfig {
	return SourceConfig{RouteID: "route-1", Dial: w.dial, Key: func() (string, []byte, bool) { return "v1", w.key, true }}
}

// setTable makes table the target daemon's current process.
func (w *handoverWorld) setTable(table *TargetTable) {
	w.mu.Lock()
	w.table = table
	w.tables = append(w.tables, table)
	w.mu.Unlock()
}

func (w *handoverWorld) currentTable() *TargetTable {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.table
}

func (w *handoverWorld) dials() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.tunnels)
}

func (w *handoverWorld) tunnel(i int) tunnelEnds {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.tunnels[i]
}

// dial opens a tunnel to the target daemon's current process.
func (w *handoverWorld) dial(_ context.Context, _ DialRequest) (OpenedPath, error) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return OpenedPath{}, errors.New("test over")
	}
	src, tgt, tunnel := w.relay.open()
	ends := tunnelEnds{src: &countStream{Stream: src}, tgt: &countStream{Stream: tgt}, tunnel: tunnel}
	table := w.table
	w.tunnels = append(w.tunnels, ends)
	w.mu.Unlock()
	target := OpenedPath{Stream: ends.tgt, RelayID: w.relay.id, MaxFrame: MaxFrameBytes,
		Cancel: func() {
			tgt.cancelOnce.Do(func() { close(tgt.cancelled) })
			tunnel.kill(status.Error(codes.Canceled, "context canceled"))
		},
		CloseSend: func() error {
			select {
			case tgt.out <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}:
			case <-tunnel.dead:
			}
			return nil
		}}
	go func() {
		defer target.Cancel()
		accepted := table.Accept(target, AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1", RelayID: w.relay.id, Keys: w.keys})
		if accepted.Kind == AcceptHello {
			session, err := accepted.Establish()
			if err != nil {
				return
			}
			w.targets <- session
		} else {
			select {
			case w.served <- accepted:
			default:
			}
		}
		<-accepted.PathDone
	}()
	return OpenedPath{Stream: ends.src, RelayID: w.relay.id, MaxFrame: MaxFrameBytes,
		Cancel: func() { tunnel.kill(status.Error(codes.Canceled, "context canceled")) }}, nil
}

// open starts a stream and returns its source and target sessions.
func (w *handoverWorld) open() (*Session, *Session) {
	first, err := w.dial(context.Background(), DialRequest{})
	if err != nil {
		w.t.Fatal(err)
	}
	source, err := w.mgr.NewSource(w.sourceConfig(), first)
	if err != nil {
		w.t.Fatal(err)
	}
	select {
	case target := <-w.targets:
		waitOpen(w.t, source)
		return source, target
	case <-time.After(10 * time.Second):
		w.t.Fatal("the target did not accept the stream")
	}
	return nil, nil
}

// waitFor polls cond for up to d.
func waitFor(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(time.Millisecond)
	}
	return true
}

// quiet waits until each end of the tunnel handled everything the other sent.
func (w *handoverWorld) quiet(ends tunnelEnds) {
	w.t.Helper()
	time.Sleep(3 * DelayedAck) // the delayed acks leave
	if !waitFor(10*time.Second, func() bool {
		_, srcSent := ends.src.counts()
		_, tgtSent := ends.tgt.counts()
		return ends.tgt.handled(srcSent) && ends.src.handled(tgtSent)
	}) {
		w.t.Fatal("the tunnel did not settle")
	}
}

// receive plays the bridge's writer: what Recv hands out until n bytes.
func receive(t *testing.T, s *Session, n int) []byte {
	t.Helper()
	timer := time.AfterFunc(20*time.Second, func() { s.Abort(RstAborted, "the test timed out") })
	defer timer.Stop()
	var got []byte
	for len(got) < n {
		frame, err := s.Recv()
		if err != nil {
			t.Fatalf("receive after %d of %d bytes: %v", len(got), n, err)
		}
		data := frame.GetData()
		if data == nil {
			t.Fatalf("receive after %d of %d bytes: %v", len(got), n, frame)
		}
		got = append(got, data.GetData()...)
	}
	return got
}

// finish closes both directions and waits for the CLOSE exchange.
func finish(t *testing.T, source, target *Session) {
	t.Helper()
	for _, s := range []*Session{source, target} {
		if err := s.CloseWrite(); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range []*Session{source, target} {
		timer := time.AfterFunc(20*time.Second, func() { s.Abort(RstAborted, "the test timed out") })
		frame, err := s.Recv()
		timer.Stop()
		if err != nil || frame.GetHalfClose() == nil {
			t.Fatalf("expected the peer's FIN, got %v %v", frame, err)
		}
	}
	for _, s := range []*Session{source, target} {
		waitDone(t, s)
		if s.State() != StateFinished || s.Err() != nil {
			t.Fatalf("stream ended %s: %v", s.State(), s.Err())
		}
	}
}

// The stress test's flake: the target's process read its stream out, then
// data from the source still reached it, then the source's RESUME did (its
// path had failed), before the handover committed. The old process answered
// with its own rcv_nxt, past the state the next process got: the source freed
// those bytes, and the next process's RESUME_ACK named an offset the source no
// longer retained ("resume offset outside the retained data"; without the
// check, the bytes were lost).
func TestHandoverTargetReadOutAnswersNoResume(t *testing.T) {
	w := newHandoverWorld(t)
	source, target := w.open()
	first := w.tunnel(0)
	if err := source.Write([]byte("before")); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, target, 6); string(got) != "before" {
		t.Fatalf("got %q", got)
	}
	w.quiet(first)

	target.Freeze()
	state, err := target.HandoverState(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	returned, _ := first.tgt.counts()
	if err := source.Write([]byte("after the read-out")); err != nil {
		t.Fatal(err)
	}
	if !waitFor(10*time.Second, func() bool { return first.tgt.handled(returned + 1) }) {
		t.Fatal("the old process did not read the data")
	}
	// The source's path fails; its RESUME reaches the old process.
	first.tunnel.kill(status.Error(codes.Unavailable, "transport is closing"))
	select {
	case <-w.served:
	case <-time.After(10 * time.Second):
		t.Fatal("the source did not resume")
	}

	// The handover commits; the next process carries the stream on.
	w.currentTable().HandOver()
	target.Detach()
	next := NewTargetTable(nil)
	restored, err := next.Restore(state, nil)
	if err != nil {
		t.Fatal(err)
	}
	w.setTable(next)
	if got := receive(t, restored, 18); string(got) != "after the read-out" {
		t.Fatalf("the next process got %q", got)
	}
	finish(t, source, restored)
}

// The source side of the same race, as the stress test met it: the source's
// process read its stream out with its FIN not acked yet, then the target's
// ack of that FIN reached it. It finished the stream with the target (CLOSE),
// and the next process, which never learnt of the ack, was refused as
// "finished" while it still waited for it, and reset the stream.
func TestHandoverSourceReadOutFinishesNothing(t *testing.T) {
	w := newHandoverWorld(t)
	source, target := w.open()
	first := w.tunnel(0)
	if err := target.Write([]byte("reply")); err != nil {
		t.Fatal(err)
	}
	if err := target.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, source, 5); string(got) != "reply" {
		t.Fatalf("got %q", got)
	}
	if frame, err := source.Recv(); err != nil || frame.GetHalfClose() == nil {
		t.Fatalf("expected the target's FIN, got %v %v", frame, err)
	}
	if err := source.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := source.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	w.quiet(first)

	source.Freeze()
	state, err := source.HandoverState(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// The target delivers the request and its FIN, and acks them.
	if got := receive(t, target, 7); string(got) != "request" {
		t.Fatalf("got %q", got)
	}
	if frame, err := target.Recv(); err != nil || frame.GetHalfClose() == nil {
		t.Fatalf("expected the source's FIN, got %v %v", frame, err)
	}
	time.Sleep(3 * DelayedAck)
	_, acks := first.tgt.counts()
	if !waitFor(10*time.Second, func() bool { return first.src.handled(acks) || source.State().Terminal() }) {
		t.Fatal("the old process did not read the ack")
	}
	// Time for a CLOSE exchange the old process would start.
	waitFor(300*time.Millisecond, func() bool { return target.State().Terminal() })

	source.Detach()
	restored, err := w.mgr.RestoreSource(w.sourceConfig(), state)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []*Session{restored, target} {
		waitDone(t, s)
		if s.State() != StateFinished || s.Err() != nil {
			t.Fatalf("stream ended %s: %v", s.State(), s.Err())
		}
	}
}

// The target side of it: the target's process read its stream out before the
// source's ack of its FIN and the source's CLOSE arrived. It echoed the CLOSE
// and the source finished, while the next process, which never learnt of the
// ack, waited for a source that never came back and reset the stream.
func TestHandoverTargetReadOutFinishesNothing(t *testing.T) {
	w := newHandoverWorld(t)
	source, target := w.open()
	first := w.tunnel(0)
	if err := source.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := source.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, target, 7); string(got) != "request" {
		t.Fatalf("got %q", got)
	}
	if frame, err := target.Recv(); err != nil || frame.GetHalfClose() == nil {
		t.Fatalf("expected the source's FIN, got %v %v", frame, err)
	}
	if err := target.Write([]byte("reply")); err != nil {
		t.Fatal(err)
	}
	if err := target.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	w.quiet(first)

	target.Freeze()
	state, err := target.HandoverState(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// The source delivers the reply and its FIN: it acks them and, with both
	// directions complete, sends CLOSE.
	if got := receive(t, source, 5); string(got) != "reply" {
		t.Fatalf("got %q", got)
	}
	if frame, err := source.Recv(); err != nil || frame.GetHalfClose() == nil {
		t.Fatalf("expected the target's FIN, got %v %v", frame, err)
	}
	time.Sleep(3 * DelayedAck)
	_, sent := first.src.counts()
	if !waitFor(10*time.Second, func() bool { return first.tgt.handled(sent) || source.State().Terminal() }) {
		t.Fatal("the old process did not read the CLOSE")
	}
	waitFor(300*time.Millisecond, func() bool { return source.State().Terminal() })
	if now := source.State(); now.Terminal() {
		t.Fatalf("the source ended (%s) with the process that handed the stream over", now)
	}

	w.currentTable().HandOver()
	target.Detach()
	next := NewTargetTable(nil)
	restored, err := next.Restore(state, nil)
	if err != nil {
		t.Fatal(err)
	}
	w.setTable(next)
	for _, s := range []*Session{source, restored} {
		waitDone(t, s)
		if s.State() != StateFinished || s.Err() != nil {
			t.Fatalf("stream ended %s: %v", s.State(), s.Err())
		}
	}
}

// A source stream read out for a handover begins no move: a RESUME from the old
// process would name its own rcv_nxt, and the target would free bytes the next
// process still needs.
func TestHandoverSourceReadOutBeginsNoMove(t *testing.T) {
	w := newHandoverWorld(t)
	source, target := w.open()
	first := w.tunnel(0)
	if err := target.Write([]byte("before")); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, source, 6); string(got) != "before" {
		t.Fatalf("got %q", got)
	}
	w.quiet(first)

	source.Freeze()
	state, err := source.HandoverState(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	returned, _ := first.src.counts()
	if err := target.Write([]byte("after the read-out")); err != nil {
		t.Fatal(err)
	}
	if !waitFor(10*time.Second, func() bool { return first.src.handled(returned + 1) }) {
		t.Fatal("the old process did not read the data")
	}
	w.mgr.RelayLost(w.relay.id)
	time.Sleep(500 * time.Millisecond)
	if dials := w.dials(); dials != 1 {
		t.Fatalf("the read-out stream opened %d more paths", dials-1)
	}

	source.Detach()
	restored, err := w.mgr.RestoreSource(w.sourceConfig(), state)
	if err != nil {
		t.Fatal(err)
	}
	if got := receive(t, restored, 18); string(got) != "after the read-out" {
		t.Fatalf("the next process got %q", got)
	}
	finish(t, restored, target)
}

// A bridge Recv answered ErrFrozen holds no byte on its way to park: the
// handover must count it as stopped, or it finds the bridge between the two
// and cuts the stream as busy.
func TestHandoverFrozenRecvCountsAsStopped(t *testing.T) {
	w := newHandoverWorld(t)
	_, target := w.open()
	target.Freeze()
	if _, err := target.Recv(); err != ErrFrozen {
		t.Fatalf("Recv: %v", err)
	}
	if !target.RecvBlocked() {
		t.Fatal("a bridge Recv answered ErrFrozen does not count as stopped")
	}
	target.Thaw()
}

// A RESUME that reached a target process before it handed its streams over,
// and is looked up after the stream left its table, gets no answer: the next
// process carries the stream, so "unknown" would wrongly end it.
func TestHandoverHandedOverTableAnswersNoResume(t *testing.T) {
	w := newHandoverWorld(t)
	_, target := w.open()
	target.Freeze()
	if _, err := target.HandoverState(time.Now()); err != nil {
		t.Fatal(err)
	}
	w.currentTable().HandOver()
	target.Detach()

	src, tgt, tunnel := w.relay.open()
	op := OpenedPath{Stream: tgt, RelayID: w.relay.id, MaxFrame: MaxFrameBytes,
		Cancel: func() { tunnel.kill(status.Error(codes.Canceled, "context canceled")) }}
	// Accept saw the table before the handover; the lookup comes after it.
	accepted := w.currentTable().resume(op, AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1", RelayID: w.relay.id, Keys: w.keys},
		&Record{Type: TypeResume, SessionID: target.tableKey.SessionID, Epoch: 9, KeyID: "v1"})
	<-accepted.PathDone
	if accepted.Reject != 0 {
		t.Fatalf("the handed over process refused the resume (code %d)", accepted.Reject)
	}
	if frame, err := src.Recv(); err == nil {
		t.Fatalf("the handed over process answered %v", frame)
	}
}

// A process that read a stream out never ends it on a deadline while it is
// sealed: a refused planned move waits for Thaw (or goes to the next process
// with the state), where its hearing out goes on.
func TestHandoverSealedRefusedMoveWaitsForThaw(t *testing.T) {
	pair, _, _ := refusedMove(t)
	s := newSession(pair.src, "route-1", MaxFrameBytes)
	s.Freeze()
	st, err := s.HandoverState(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if st.Refused != RejectReset {
		t.Fatalf("read out refusal %d", st.Refused)
	}
	// The refusal's deadline (pair.now + ResumeAckTimeout) passed long ago.
	s.tick()
	s.mu.Lock()
	state := s.core.State()
	s.mu.Unlock()
	if state.Terminal() {
		t.Fatalf("the sealed process ended the stream: %v", s.core.Err())
	}
	s.Thaw()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the thawed stream's passed deadline did not act")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !isCut(s.core.Err()) {
		t.Fatalf("thawed without word from the old path: %v", s.core.Err())
	}
}
