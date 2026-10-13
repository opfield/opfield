package relayresume

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protowire"
)

// Stream is one relay tunnel stream (OpenTunnel or AcceptTunnel).
type Stream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

// OpenedPath is a tunnel the relay admitted (its Ready frame was read).
type OpenedPath struct {
	Stream Stream
	// Cancel ends the stream (its context).
	Cancel func()
	// CloseSend half-closes the stream, when the stream supports it.
	CloseSend func() error
	RelayID   string
	MaxFrame  int
	// Generation is the driver's label of the path: the assignment generation
	// of the grant it was opened with (0 unknown). Planned moves pass it back
	// in DialRequest.FromGeneration.
	Generation uint64
	// Lane is the driver's label of the connection the path runs on (opaque
	// here; Session.CurrentLane).
	Lane any
}

type queued struct {
	frame  []byte
	pooled bool
}

// pathRun is the driver state of one path.
type pathRun struct {
	path   *Path
	op     OpenedPath
	queue  []queued // frames to send, in order
	close  bool     // close once the queue is sent
	sendMu sync.Mutex
	done   chan struct{} // closed once the stream is cancelled and the reader ended
	// readerBusy: someone (the bridge's Recv or the background reader) is in
	// Recv on this stream.
	readerBusy bool
	bgWaiting  bool
	reader     chan struct{} // closed when the reader goroutine exits
	// closing: closeRun owns the path's end; flushed closes once its queue
	// was sent (or failed).
	closing   bool
	flushed   chan struct{}
	flushOnce sync.Once
	// lingering: a target path given up with its last records (RST, CLOSE
	// echo) in flight: its reader keeps reading until the source ends the
	// tunnel (ended), so closeRun cancels it only then. A cancel right after
	// the send could drop those records in the transport.
	lingering bool
	ended     bool
	// held: what the path read while the session was sealed, in order;
	// heldEnd: the path ended among it, so its reader stops.
	held    []heldFrame
	heldEnd bool
}

// heldFrame is a path read a sealed session keeps for later.
type heldFrame struct {
	frame *relayv1.TunnelFrame
	err   error
}

// Session drives a Core over real relay streams. It implements the
// relaybridge FrameStream interface (Send and Recv of Data, HalfClose and
// Close frames) for the bridges, which work unchanged on top of it.
type Session struct {
	mu sync.Mutex
	// readCond wakes Recv, writeCond wakes Write, stateCond wakes the
	// migration worker; each only when its waiter can make progress.
	readCond, writeCond, stateCond *sync.Cond
	readers, writers               int
	bgCond                         *sync.Cond // background readers wait for the stream
	inRecv, recvGone, bgArmed      bool
	recvExit                       time.Time
	recvFrame                      *relayv1.TunnelFrame
	recvData                       *relayv1.TunnelData
	bgTimer                        *time.Timer
	lastBase                       uint64
	lastState                      State
	lastPending                    *Path
	lastCur                        *Path
	core                           *Core
	paths                          map[*Path]*pathRun
	timer                          *time.Timer
	armedAt                        time.Time

	// The largest Data payload Recv hands out (the first path's frame size,
	// which the bridges were given).
	recvMax   int
	frameSize int
	partial   []byte

	done     chan struct{}
	doneOnce sync.Once

	// Source side.
	source   *sourceState
	onChange func(*Session) // the target table watches its sessions
	// Target side: the table and key the session is registered under.
	table    *TargetTable
	tableKey TargetKey

	routeID string
	tag     any

	// Live handover (state.go). frozen: the bridge stops at a safe point (Recv
	// hands out nothing, Write takes everything). detached: another process
	// took the stream over. restoredFrozenAt: this process took it over; its
	// pause ended at resumedAt.
	frozen           bool
	detached         bool
	restoredFrozenAt time.Time
	resumedAt        time.Time
	// sealed: the stream's state was read out (HandoverState), and the next
	// process may carry it on from exactly that state. Until it thaws, this
	// process tells the peer nothing beyond it: what the peer sends is kept
	// unprocessed (Thaw processes it, Detach drops it), no RESUME is
	// answered or begun, and no deadline acts on it. Otherwise an offset
	// learnt after the read-out (a RESUME_ACK's rcv_nxt) lets the peer free
	// bytes the next process never got, or a CLOSE exchange or a timeout
	// ends the stream behind its back.
	sealed bool
	// frozenOut: Recv last answered ErrFrozen, so the bridge holds no byte
	// from the stream until it calls Recv again (RecvBlocked).
	frozenOut bool
}

func newSession(core *Core, routeID string, recvMax int) *Session {
	if recvMax <= 0 || recvMax > MaxFrameBytes {
		recvMax = MaxFrameBytes
	}
	// The bridges read and receive at most MaxFrame bytes: one read is one
	// DATA frame on a path with the first path's frame size.
	s := &Session{core: core, paths: map[*Path]*pathRun{}, done: make(chan struct{}), routeID: routeID, recvMax: ReadChunk(recvMax), frameSize: recvMax}
	s.readCond, s.writeCond, s.stateCond, s.bgCond = sync.NewCond(&s.mu), sync.NewCond(&s.mu), sync.NewCond(&s.mu), sync.NewCond(&s.mu)
	// Until a bridge calls Recv the background reader reads (the handshake
	// answer must be read even if nobody receives yet).
	s.recvExit = time.Now()
	s.armGraceLocked(readGrace)
	return s
}

// attach registers a path and starts its reader. Called with mu held.
func (s *Session) attach(path *Path, op OpenedPath) *pathRun {
	run := &pathRun{path: path, op: op, done: make(chan struct{}), reader: make(chan struct{}), flushed: make(chan struct{})}
	s.paths[path] = run
	go s.read(run)
	return run
}

// readGrace is how long the bridge may stay out of Recv before the path's
// own reader takes the stream over (acks of the other direction must not
// wait behind a slow local socket).
const readGrace = 2 * time.Millisecond

// read is the path's background reader. The bridge's Recv reads the current
// path itself while it keeps calling (no goroutine handoff per frame); this
// reader takes over when the bridge stays away longer than readGrace (a
// slow local socket, the peer's FIN delivered) and always reads paths that
// are not current. It never blocks on a send, so both peers always drain
// their inbound streams and gRPC flow control cannot deadlock.
func (s *Session) read(run *pathRun) {
	defer close(run.reader)
	s.mu.Lock()
	for {
		for !s.readerDone(run) && !s.backgroundMayRead(run) {
			run.bgWaiting = true
			s.bgCond.Wait()
			run.bgWaiting = false
		}
		if s.readerDone(run) {
			s.mu.Unlock()
			return
		}
		run.readerBusy = true
		s.mu.Unlock()
		frame, err := run.op.Stream.Recv()
		s.mu.Lock()
		run.readerBusy = false
		s.handleFrameLocked(run, frame, err)
	}
}

// readerDone: the path's reader has nothing more to read (mu held). A
// lingering path is read until its stream ends.
func (s *Session) readerDone(run *pathRun) bool {
	return run.path.Closed() && (!run.lingering || run.ended || s.detached)
}

// backgroundMayRead: the path is free and the bridge is not about to read it.
func (s *Session) backgroundMayRead(run *pathRun) bool {
	if run.readerBusy || run.heldEnd {
		return false
	}
	if run.path != s.core.Current() || s.recvGone {
		return true
	}
	return !s.inRecv && time.Since(s.recvExit) >= readGrace
}

// handleFrameLocked processes what a path read returned (mu held).
func (s *Session) handleFrameLocked(run *pathRun, frame *relayv1.TunnelFrame, err error) {
	if err != nil {
		run.ended = true
	}
	if run.path.Closed() || s.detached {
		s.bgCond.Broadcast()
		return
	}
	if s.sealed {
		// Read out for a handover: it waits (see sealed). The path is still
		// read, so the peer's sends never block on this process, until it ends.
		run.held = append(run.held, heldFrame{frame: frame, err: err})
		run.heldEnd = run.heldEnd || err != nil || frame.GetData() == nil
		if run.bgWaiting && s.backgroundMayRead(run) {
			s.bgCond.Broadcast()
		}
		return
	}
	now := time.Now()
	if err != nil {
		s.core.PathFailed(run.path, terminalPathError(err), err, now)
	} else {
		switch payload := frame.Payload.(type) {
		case *relayv1.TunnelFrame_Data:
			if len(payload.Data.GetData()) == 0 {
				s.core.Abort(RstProtocol, "empty data frame", ErrProtocol)
			} else {
				s.core.PathFrame(run.path, payload.Data.GetData(), now)
			}
		case *relayv1.TunnelFrame_Error:
			code := payload.Error.GetCode()
			s.core.PathFailed(run.path, s.core.State() == StateHandshake, fmt.Errorf("relay tunnel error: %s", code), now)
		default:
			// Close, HalfClose or anything else: this path is over.
			s.core.PathFailed(run.path, false, errors.New("relay tunnel ended"), now)
		}
	}
	s.afterLocked(true)
	// The stream is free again: wake this path's background reader only if
	// it may take it now (not on every frame the bridge reads itself).
	if run.bgWaiting && s.backgroundMayRead(run) {
		s.bgCond.Broadcast()
	}
	if s.readers > 0 {
		s.readCond.Signal()
	}
}

// recvExitLocked notes that the bridge left Recv; the background reader
// takes over if it does not come back within readGrace.
func (s *Session) recvExitLocked(gone bool) {
	s.inRecv = false
	s.recvExit = time.Now()
	if gone {
		s.recvGone = true
		s.bgCond.Broadcast()
		return
	}
	// One armed timer at a time (not a reset per frame): when it fires
	// it checks how long the bridge has been away.
	if !s.bgArmed {
		s.armGraceLocked(readGrace)
	}
}

func (s *Session) armGraceLocked(after time.Duration) {
	s.bgArmed = true
	if s.bgTimer == nil {
		s.bgTimer = time.AfterFunc(after, s.graceCheck)
	} else {
		s.bgTimer.Reset(after)
	}
}

func (s *Session) graceCheck() {
	s.mu.Lock()
	s.bgArmed = false
	if !s.inRecv {
		if away := time.Since(s.recvExit); away >= readGrace {
			s.bgCond.Broadcast()
		} else {
			s.armGraceLocked(readGrace - away)
		}
	}
	s.mu.Unlock()
}

// terminalPathError reports relay verdicts that end the stream itself: the
// relay's idle and half-close timeouts and refused frames. Everything else
// (transport loss, GOAWAY, a forced disconnect, a revocation) is resumable;
// the target rechecks authorization on resume.
func terminalPathError(err error) bool {
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.DeadlineExceeded:
		return strings.Contains(current.Message(), "idle timeout") || strings.Contains(current.Message(), "half-close timeout")
	case codes.InvalidArgument:
		return true
	}
	return false
}

// afterLocked moves outputs to the paths, rearms the timer and wakes
// waiters. async: the caller is a reader, which must not block on sends.
// Called with mu held; it may release and retake mu.
func (s *Session) afterLocked(async bool) {
	if s.detached {
		// Another process carries the stream: nothing leaves this one.
		for _, out := range s.core.TakeOutputs() {
			if out.Pooled {
				ReleaseFrame(out.Frame)
			}
		}
		return
	}
	if !s.restoredFrozenAt.IsZero() && s.resumedAt.IsZero() && s.core.State() == StateOpen {
		s.resumedAt = time.Now()
	}
	var kick []*pathRun
	for _, out := range s.core.TakeOutputs() {
		run := s.paths[out.Path]
		if run == nil {
			continue
		}
		if out.Close {
			run.close = true
			if s.core.Role() == RoleTarget && run.op.CloseSend != nil {
				run.lingering = true
			}
			s.bgCond.Broadcast()
			if !run.closing {
				// A given-up path ends on its own: its last records get a
				// short time to leave, then it is cancelled even if a send
				// on it is stuck (a stream nobody reads any more).
				run.closing = true
				go s.closeRun(run)
			}
		} else {
			run.queue = append(run.queue, queued{out.Frame, out.Pooled})
		}
		if len(kick) == 0 || kick[len(kick)-1] != run {
			kick = append(kick, run)
		}
	}
	s.armLocked()
	s.wakeLocked()
	if s.core.State().Terminal() {
		s.doneOnce.Do(func() { close(s.done) })
	}
	if s.source != nil {
		s.source.observeLocked(s)
	}
	if s.onChange != nil {
		s.onChange(s)
	}
	if len(kick) == 0 {
		return
	}
	if async {
		for _, run := range kick {
			go s.drain(run)
		}
		return
	}
	// The caller (a writer, a resume) waits for the live paths only: a path
	// being given up drains on its own goroutine, so a send stuck on it
	// never holds back another path's frames (a RESUME_ACK).
	var live []*pathRun
	for _, run := range kick {
		if run.close {
			go s.drain(run)
		} else {
			live = append(live, run)
		}
	}
	if len(live) == 0 {
		return
	}
	s.mu.Unlock()
	for _, run := range live {
		s.drain(run)
	}
	s.mu.Lock()
}

// drain sends a path's queued frames in order; one drainer per path at a
// time.
func (s *Session) drain(run *pathRun) {
	run.sendMu.Lock()
	defer run.sendMu.Unlock()
	for {
		s.mu.Lock()
		if len(run.queue) == 0 {
			if run.close {
				run.flushOnce.Do(func() { close(run.flushed) })
			}
			s.mu.Unlock()
			return
		}
		item := run.queue[0]
		run.queue[0] = queued{}
		run.queue = run.queue[1:]
		s.mu.Unlock()
		err := run.op.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: item.frame}}})
		if item.pooled {
			ReleaseFrame(item.frame)
		}
		if err != nil {
			s.mu.Lock()
			for _, item := range run.queue {
				if item.pooled {
					ReleaseFrame(item.frame)
				}
			}
			run.queue = nil
			if !run.path.Closed() {
				s.core.PathFailed(run.path, false, err, time.Now())
			}
			s.afterLocked(true)
			if run.close {
				run.flushOnce.Do(func() { close(run.flushed) })
			}
			s.mu.Unlock()
			return
		}
	}
}

// closeFlushTimeout bounds how long a given-up path's last records may take
// to leave before its stream is cancelled under a stuck send.
const closeFlushTimeout = 2 * time.Second

// closeRun ends a path's stream once the session gave it up: after its
// queued records left (or closeFlushTimeout), the source sends the relay
// Close of a finished stream, a target half-closes and lingers so its last
// record arrives, and the stream is cancelled.
func (s *Session) closeRun(run *pathRun) {
	go s.drain(run) // flushes what is queued, or reports an empty queue
	flushed := true
	select {
	case <-run.flushed:
	case <-time.After(closeFlushTimeout):
		flushed = false
	}
	s.mu.Lock()
	state := s.core.State()
	s.mu.Unlock()
	switch {
	case !flushed:
	case s.core.Role() == RoleSource:
		if state == StateFinished {
			// As the bridges always did: the relay ends the tunnel on Close.
			sent := make(chan struct{})
			go func() {
				_ = run.op.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
				close(sent)
			}()
			select {
			case <-sent:
			case <-time.After(closeFlushTimeout):
			}
		}
	case run.op.CloseSend != nil:
		// Let the last records (CLOSE echo, RST, RESUME_REJ) leave before the
		// stream is cancelled: the source ends the tunnel once it read them,
		// which the path's reader sees (lingering). Cancelled at once, the
		// transport could drop them: the source then saw its path fail instead
		// of the reset, and the target refused its resume (stand rc.6 O-3).
		_ = run.op.CloseSend()
		select {
		case <-run.reader:
		case <-time.After(CloseLingerTimeout):
		}
	}
	if run.op.Cancel != nil {
		run.op.Cancel()
	}
	<-run.reader
	s.mu.Lock()
	delete(s.paths, run.path)
	s.mu.Unlock()
	close(run.done)
}

func (s *Session) wakeLocked() {
	state := s.core.State()
	terminal := state.Terminal()
	if s.readers > 0 && (terminal || s.core.Readable() || len(s.partial) > 0) {
		s.readCond.Signal()
	}
	if base := s.core.WindowBase(); s.writers > 0 && (terminal || base != s.lastBase) {
		s.writeCond.Signal()
	}
	s.lastBase = s.core.WindowBase()
	if cur := s.core.Current(); cur != s.lastCur {
		s.lastCur = cur
		if s.readers > 0 {
			s.readCond.Signal()
		}
		s.bgCond.Broadcast()
	}
	if pending := s.core.Pending(); state != s.lastState || pending != s.lastPending {
		s.lastState, s.lastPending = state, pending
		s.stateCond.Broadcast()
	}
}

func (s *Session) armLocked() {
	next := s.core.NextDeadline()
	if next.Equal(s.armedAt) {
		return
	}
	s.armedAt = next
	if next.IsZero() {
		if s.timer != nil {
			s.timer.Stop()
		}
		return
	}
	delay := time.Until(next)
	if s.timer == nil {
		s.timer = time.AfterFunc(delay, s.tick)
		return
	}
	s.timer.Reset(delay)
}

func (s *Session) tick() {
	s.mu.Lock()
	if s.detached {
		s.mu.Unlock()
		return
	}
	s.armedAt = time.Time{}
	if s.sealed {
		// Read out for a handover: no deadline acts on the stream here (see
		// sealed; a refused move, a suspend or half-close timeout would end
		// it behind the next process's back). Thaw rearms the timer.
		s.mu.Unlock()
		return
	}
	s.core.Tick(time.Now())
	s.afterLocked(false)
	s.mu.Unlock()
}

// Send takes a frame from a bridge: Data (owned by the session from now on),
// HalfClose (FIN) or Close (wait until the stream finished).
func (s *Session) Send(frame *relayv1.TunnelFrame) error {
	switch payload := frame.Payload.(type) {
	case *relayv1.TunnelFrame_Data:
		return s.Write(payload.Data.GetData())
	case *relayv1.TunnelFrame_HalfClose:
		return s.CloseWrite()
	case *relayv1.TunnelFrame_Close:
		// The bridges send Close after both directions ended: wait for the
		// CLOSE exchange. A Close after a failure is a reset.
		s.mu.Lock()
		clean := s.core.finQueued && s.core.finDelivered
		s.mu.Unlock()
		if !clean {
			s.Abort(RstAborted, "local side ended the stream")
			return nil
		}
		s.WaitFinished()
		return nil
	case *relayv1.TunnelFrame_Error:
		s.Abort(RstAborted, payload.Error.GetCode())
		return nil
	}
	return fmt.Errorf("%w: unexpected frame from the bridge", ErrProtocol)
}

// Write queues p for the peer, waiting while the window is full.
func (s *Session) Write(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for !s.frozen && !s.detached && !s.core.CanWrite(len(p)) {
		s.writers++
		s.writeCond.Wait()
		s.writers--
	}
	if s.detached {
		return ErrHandedOver
	}
	if s.frozen {
		// The bridge is stopping for a handover: what it read goes into the
		// stream at once, and the frames leave on their own.
		err := s.core.writeFrozen(p, time.Now())
		s.afterLocked(true)
		return err
	}
	ok, err := s.core.Write(p, time.Now())
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("relayresume: window refused a write")
	}
	s.afterLocked(false)
	return nil
}

// CloseWrite sends FIN after the queued data.
func (s *Session) CloseWrite() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached {
		return ErrHandedOver
	}
	err := s.core.CloseWrite(time.Now())
	s.afterLocked(s.frozen)
	return err
}

// Recv hands the bridge the next Data frame, HalfClose for the peer's FIN,
// Close once the stream finished, or the error that reset it. While nothing
// is queued it reads the current path itself. A returned Data frame is valid
// until the next Recv.
func (s *Session) Recv() (*relayv1.TunnelFrame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inRecv = true
	frame, gone, err := s.recvLocked()
	// A bridge answered ErrFrozen goes on to park holding no byte: it counts
	// as stopped from here on, not only once it parked.
	s.frozenOut = err == ErrFrozen
	s.recvExitLocked(gone)
	return frame, err
}

func (s *Session) recvLocked() (*relayv1.TunnelFrame, bool, error) {
	for {
		switch {
		case s.detached:
			return nil, true, ErrHandedOver
		case s.frozen:
			// Nothing more reaches the local socket until the stream thaws or
			// another process takes it over.
			return nil, false, ErrFrozen
		}
		if len(s.partial) > 0 {
			return s.dataFrame(), false, nil
		}
		data, fin, ok := s.core.Read(time.Now())
		if ok {
			// An ACK leaves on its own goroutine: the bridge goes back to
			// writing the local socket.
			s.afterLocked(true)
			if fin {
				return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}, true, nil
			}
			s.partial = data
			continue
		}
		switch s.core.State() {
		case StateReset:
			return nil, true, s.core.Err()
		case StateFinished:
			return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, true, nil
		}
		if run := s.paths[s.core.Current()]; run != nil && !run.readerBusy && !run.path.Closed() {
			run.readerBusy = true
			s.mu.Unlock()
			frame, err := run.op.Stream.Recv()
			s.mu.Lock()
			run.readerBusy = false
			s.handleFrameLocked(run, frame, err)
			continue
		}
		s.readers++
		s.readCond.Wait()
		s.readers--
	}
}

func (s *Session) dataFrame() *relayv1.TunnelFrame {
	data := s.partial
	if len(data) > s.recvMax {
		data = data[:s.recvMax]
	}
	s.partial = s.partial[len(data):]
	// One frame object per session, refilled on every Recv: a bridge uses
	// a frame before it receives the next one.
	if s.recvData == nil {
		s.recvData = &relayv1.TunnelData{}
		s.recvFrame = &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: s.recvData}}
	}
	s.recvData.Data = data
	return s.recvFrame
}

// WaitFinished blocks until the stream finished or was reset (the CLOSE
// exchange; bounded by the session's own timers).
func (s *Session) WaitFinished() {
	<-s.done
}

// Abort resets the stream: the peer closes its socket hard.
func (s *Session) Abort(code byte, reason string) {
	s.abortWith(code, reason, nil)
}

// abortWith resets the stream with a cause.
func (s *Session) abortWith(code byte, reason string, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached {
		return
	}
	s.core.Abort(code, reason, cause)
	s.afterLocked(false)
}

// Cancel is the cancel func the bridges call when they end: a no-op for a
// finished stream, a reset otherwise.
func (s *Session) Cancel() { s.Abort(RstAborted, "local side ended the stream") }

// Done closes when the stream finished or was reset.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err is why the stream was reset (nil while open or after a clean finish).
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.Err()
}

// State is the session state.
func (s *Session) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.State()
}

// RelayID is the relay of the current path ("" while suspended).
func (s *Session) RelayID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.core.Current(); p != nil {
		return p.RelayID()
	}
	return ""
}

// CurrentPath is the relay and generation label (OpenedPath.Generation) of
// the path the stream runs on; ok=false while it has none.
func (s *Session) CurrentPath() (relayID string, generation uint64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.core.Current()
	if current == nil {
		return "", 0, false
	}
	if run := s.runOf(current); run != nil {
		generation = run.op.Generation
	}
	return current.RelayID(), generation, true
}

// LastMove is when the stream last moved to another path (zero: never; only
// source streams move).
func (s *Session) LastMove() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil {
		return time.Time{}
	}
	return s.source.movedAt
}

// Moving reports a source stream with a move running (or suspended, waiting
// for a path).
func (s *Session) Moving() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.source != nil && (s.source.migrating || s.core.Current() == nil)
}

// CheapToMove reports a stream whose move costs little at now: it carried no
// byte for quiet, or fewer than bytes since its current transfer started
// (TransferGap). A stream that a keepalive connection reuses for request
// after request starts a transfer with each (stand rc.11 F-1: Route Secure
// Link PUTs after GETs through nginx's upstream keepalive counted the GETs'
// 256 MiB and stayed on a collapsed lane).
func (s *Session) CheapToMove(now time.Time, quiet time.Duration, bytes uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return now.Sub(s.core.lastActivity) >= quiet || s.core.TransferBytes() < bytes
}

// runOf is the driver state of path (mu held).
// CurrentLane is the driver's lane label of the current path (OpenedPath.Lane;
// nil while suspended).
func (s *Session) CurrentLane() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run := s.runOf(s.core.Current()); run != nil {
		return run.op.Lane
	}
	return nil
}

func (s *Session) runOf(path *Path) *pathRun {
	return s.paths[path]
}

// RouteID is the route the stream belongs to.
func (s *Session) RouteID() string { return s.routeID }

// MaxFrame is the Data size the bridges should be given (their read size
// for bridgeRelayConnection-style bridges, their frame limit always).
func (s *Session) MaxFrame() int { return s.recvMax }

// Unacked is the retained send data.
func (s *Session) Unacked() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.Unacked()
}

// pathDone returns a channel closed once path's stream ended (target).
func (s *Session) pathDone(path *Path) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run := s.paths[path]; run != nil {
		return run.done
	}
	closed := make(chan struct{})
	close(closed)
	return closed
}

// ReadChunk is the read size for a bridge over a session: a DATA record of
// it (header and payload) in its TunnelFrame then fits chunk bytes as a gRPC
// message. gRPC takes message buffers from size tiers (16 KiB, 32 KiB, 1 MiB)
// and clears the whole buffer on every use: a 32 KiB read made a message a
// few bytes over 32 KiB, which took and cleared a 1 MiB buffer for every frame
// on both daemons.
func ReadChunk(chunk int) int {
	if chunk <= 4*MaxRecordHeader {
		return chunk
	}
	return tunnelDataLimit(chunk) - MaxRecordHeader
}

// tunnelDataLimit is the largest TunnelData payload whose TunnelFrame message
// is at most message bytes (relaybridge.DataLimit).
func tunnelDataLimit(message int) int {
	n := message - 2
	for n > 0 && n+2+protowire.SizeVarint(uint64(n))+protowire.SizeVarint(uint64(n+1+protowire.SizeVarint(uint64(n)))) > message {
		n--
	}
	return n
}

// ErrFrozen is what Recv answers while the stream is frozen for a handover.
var ErrFrozen = errors.New("relayresume: stream is frozen for a handover")

// Freeze stops the stream at the local socket for a handover: Recv hands out
// nothing more (ErrFrozen) and Write takes whatever the bridge read, whatever
// the window. The paths keep running: acks and data from the peer still
// arrive, until HandoverState reads the stream out (from then on they wait,
// see sealed). Thaw undoes it; Detach ends it once another process took the
// stream over.
func (s *Session) Freeze() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached {
		return
	}
	s.frozen = true
	s.readCond.Broadcast()
	s.writeCond.Broadcast()
}

// Thaw lets a frozen stream carry on in this process, starting with what the
// peer sent since it was read out.
func (s *Session) Thaw() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached || !s.frozen {
		return
	}
	s.frozen = false
	if s.sealed {
		s.sealed = false
		for _, run := range s.paths {
			held := run.held
			run.held, run.heldEnd = nil, false
			for _, item := range held {
				s.handleFrameLocked(run, item.frame, item.err)
			}
		}
		// The deadlines that passed while it was sealed act now.
		s.armLocked()
		s.stateCond.Broadcast()
		s.bgCond.Broadcast()
	}
	s.readCond.Broadcast()
	s.writeCond.Broadcast()
}

// Unread gives back the bytes of the last Data frame Recv handed out that the
// bridge did not write to the local socket: they go out first, here or in the
// process the stream is handed to.
func (s *Session) Unread(p []byte) {
	if len(p) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.partial = append(append(make([]byte, 0, len(p)+len(s.partial)), p...), s.partial...)
}

// RecvBlocked reports a bridge waiting inside Recv for the stream's path, or
// one Recv answered ErrFrozen that did not call it again: it holds no byte,
// and a frozen stream hands it none.
func (s *Session) RecvBlocked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inRecv || s.frozenOut
}

// HandoverState reads a frozen stream out for another process. The bridge
// must have stopped (no byte moves between the session and the local socket
// any more). A stream still in its handshake, or one that ended, cannot be
// handed over. frozenAt is when the stream stopped carrying data. From now on
// the stream is sealed: it stays at the state read out until Thaw or Detach.
func (s *Session) HandoverState(frozenAt time.Time) (*SessionState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.core.State()
	if s.detached || !s.frozen || state.Terminal() || state == StateHandshake {
		return nil, ErrNotHandoverable
	}
	st := s.core.exportState()
	st.MaxFrame = s.frameSize
	st.Unwritten = append([]byte(nil), s.partial...)
	st.SourceKind, st.SourceID = s.tableKey.SourceKind, s.tableKey.SourceID
	st.FrozenAt = frozenAt
	if !s.restoredFrozenAt.IsZero() && s.resumedAt.IsZero() {
		// Taken over and not resumed yet: its pause started at the first freeze.
		st.FrozenAt = s.restoredFrozenAt
	}
	s.sealed = true
	return &st, nil
}

// Detach ends this process's part in a stream another process took over
// (its HandoverState reached that process): the session lets its paths go
// without a word to the peer, which sees them fail and resumes the stream
// with the next process. From now on the session answers ErrHandedOver and
// leaves its manager or table without a tombstone.
func (s *Session) Detach() {
	s.mu.Lock()
	if s.detached {
		s.mu.Unlock()
		return
	}
	s.detached = true
	if s.timer != nil {
		s.timer.Stop()
	}
	if s.bgTimer != nil {
		s.bgTimer.Stop()
	}
	for _, out := range s.core.TakeOutputs() {
		if out.Pooled {
			ReleaseFrame(out.Frame)
		}
	}
	var cancels []func()
	for path, run := range s.paths {
		path.closed = true
		for _, item := range run.queue {
			if item.pooled {
				ReleaseFrame(item.frame)
			}
		}
		run.queue, run.held = nil, nil
		if run.closing {
			continue // closeRun ends it
		}
		run.closing = true
		if run.op.Cancel != nil {
			cancels = append(cancels, run.op.Cancel)
		}
		go func(run *pathRun) {
			<-run.reader
			s.mu.Lock()
			delete(s.paths, run.path)
			s.mu.Unlock()
			close(run.done)
		}(run)
	}
	if s.core.reserved > 0 && s.core.cfg.Budget != nil {
		s.core.cfg.Budget.release(s.core.reserved)
		s.core.reserved = 0
	}
	s.readCond.Broadcast()
	s.writeCond.Broadcast()
	s.stateCond.Broadcast()
	s.bgCond.Broadcast()
	source, table, key := s.source, s.table, s.tableKey
	s.mu.Unlock()
	s.doneOnce.Do(func() { close(s.done) })
	for _, cancel := range cancels {
		cancel()
	}
	if source != nil {
		source.mgr.forget(s)
	}
	if table != nil {
		table.forget(key, s)
	}
}

// Detached reports a stream another process took over.
func (s *Session) Detached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.detached
}

// HandoverPause reports, for a stream this process took over, how long it
// stood still from its freeze in the previous process until it carried data
// again (resumed), or that it ended first (ended). Both false: still waiting,
// or not a stream taken over.
func (s *Session) HandoverPause() (pause time.Duration, resumed, ended bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.restoredFrozenAt.IsZero() {
		return 0, false, false
	}
	if !s.resumedAt.IsZero() {
		return s.resumedAt.Sub(s.restoredFrozenAt), true, false
	}
	return 0, false, s.core.State().Terminal()
}

// FinQueued reports that the local socket's end of stream was passed on: the
// bridge reads it no more.
func (s *Session) FinQueued() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.finQueued
}

// FinDelivered reports that the peer's end of stream reached the bridge: it
// writes the local socket no more.
func (s *Session) FinDelivered() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.core.finDelivered
}
