package handover

import (
	"errors"
	"fmt"
	"io"
	"math/bits"
	"net"
	"os"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// ErrHandedOver is what a bridge returns once the next daemon process carries
// its connection: the caller lets go of its copy of the connection (Close
// closes this process's descriptor only) and of nothing else.
var ErrHandedOver = errors.New("handover: the connection was handed over to the next daemon process")

// BridgeConfig configures a bridge of a local connection over a resumable
// relay stream.
type BridgeConfig struct {
	// ReadChunk bounds one read of the local connection (one DATA frame).
	ReadChunk int
	// Idle ends the bridge once the connection carried no byte for that long
	// (0: never).
	Idle time.Duration
	// Labels is what the daemon needs to serve the connection again in its
	// next process (owner, route, link).
	Labels Labels
	// CutClass is the class an update counts the connection under when it
	// cannot hand it over ("": by why it could not).
	CutClass string
	// Started, if set, is called as the bridge is registered (with the
	// registry's lock held: it must not call the registry): a handover from
	// then on stops it and passes it on (Registry.Setup).
	Started func()
}

// Labels names what a handed over connection belongs to, for the daemon.
type Labels map[string]string

// side is one direction of a bridge or pipe.
type side int

const (
	// sideLocal reads the local connection (bridge) or the left one (pipe).
	sideLocal side = iota
	// sideRemote writes the local connection (bridge) or the left one (pipe).
	sideRemote
)

type verdict int

const (
	verdictNone verdict = iota
	// verdictThaw: carry on in this process.
	verdictThaw
	// verdictHanded: the next process carries the connection.
	verdictHanded
)

// stopper is the freeze control shared by bridges and pipes: each direction
// parks at a point where it holds no byte, or reports the bytes it holds, and
// waits for the verdict.
type stopper struct {
	mu       sync.Mutex
	cond     *sync.Cond
	freezing bool
	verdict  verdict
	parked   [2]bool
	done     [2]bool
	// terminated: the connection is ending for a reason of its own.
	terminated bool
	// idle and idleAt: the idle limit and the deadline it set last.
	idle   time.Duration
	idleAt time.Time
	conns  []net.Conn
}

func newStopper(idle time.Duration, conns ...net.Conn) *stopper {
	s := &stopper{idle: idle, conns: conns}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// pastDeadline interrupts a blocked read or write at once.
var pastDeadline = time.Unix(1, 0)

// freeze makes every read and write of the connections return at once.
func (s *stopper) freeze() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.freezing {
		return
	}
	s.freezing, s.verdict = true, verdictNone
	for _, connection := range s.conns {
		_ = connection.SetDeadline(pastDeadline)
	}
}

// release ends a freeze with v.
func (s *stopper) release(v verdict) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.freezing {
		return
	}
	s.freezing, s.verdict = false, v
	if v == verdictThaw {
		s.idleAt = time.Time{}
		if s.idle > 0 {
			s.idleAt = time.Now().Add(s.idle)
		}
		for _, connection := range s.conns {
			_ = connection.SetDeadline(s.idleAt)
		}
	}
	s.cond.Broadcast()
}

// park stops direction d until the verdict. A thawed direction carries on;
// for one handed over the caller returns without touching the connection.
func (s *stopper) park(d side) verdict {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.parked[d] = true
	s.cond.Broadcast()
	for s.freezing || s.verdict == verdictNone {
		s.cond.Wait()
	}
	s.parked[d] = false
	return s.verdict
}

// stopped reports a read or write error that a freeze caused (park), or a
// stale one from a freeze that ended (retry), as opposed to the idle limit or
// a failure.
func (s *stopper) stopped(err error) (park, retry bool) {
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		return false, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.freezing {
		return true, false
	}
	return false, s.idleAt.IsZero() || time.Now().Before(s.idleAt)
}

// touch extends the idle deadline after bytes moved.
func (s *stopper) touch() {
	if s.idle <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.freezing {
		return
	}
	s.idleAt = time.Now().Add(s.idle)
	for _, connection := range s.conns {
		_ = connection.SetDeadline(s.idleAt)
	}
}

func (s *stopper) finish(d side) {
	s.mu.Lock()
	s.done[d] = true
	s.cond.Broadcast()
	s.mu.Unlock()
}

// ended reports per direction whether it ended (its half-close passed on).
func (s *stopper) ended() [2]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// verdictIs reports the last verdict.
func (s *stopper) verdictIs(v verdict) (bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.verdict == v, s.freezing
}

func (s *stopper) terminate() {
	s.mu.Lock()
	s.terminated = true
	s.mu.Unlock()
}

// directions reports per direction whether it parked or ended, and whether the
// connection is ending on its own.
func (s *stopper) directions() (still [2]bool, terminated bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for d := range still {
		still[d] = s.parked[d] || s.done[d]
	}
	return still, s.terminated
}

// Bridge is a local connection carried over a resumable relay stream.
type Bridge struct {
	conn    net.Conn
	session *relayresume.Session
	cfg     BridgeConfig
	stop    *stopper
	// excluded: why the last handover left it out ("" before any).
	excluded string
	// registry hears when the local connection ends (localEnded).
	registry *Registry
}

// localEnded reports the end of the local connection (err nil: its end of
// stream), unless the bridge itself closed it for an end of its own.
func (b *Bridge) localEnded(err error) {
	if _, terminated := b.stop.directions(); terminated || errors.Is(err, os.ErrDeadlineExceeded) {
		// Its own end, or its idle limit.
		return
	}
	b.registry.localEnded(b.session, err)
}

// readBufferPools[i] holds read buffers of 1<<i bytes, up to the largest frame.
var readBufferPools [21]sync.Pool

func init() {
	for class := range readBufferPools {
		size := 1 << class
		readBufferPools[class].New = func() any {
			buffer := make([]byte, size)
			return &buffer
		}
	}
}

type bridgeResult struct {
	local    bool
	terminal bool
	handed   bool
	err      error
}

// Bridge carries connection over session until either side ends it, like the
// daemons' raw bridges (relaybridge.BridgeWithChunk): a half-close passes on,
// an error resets the stream and closes the connection, and once both
// directions ended it waits for the stream to finish. While the daemon hands
// over to its next process it stops (Registry.HandOver) and, handed over,
// returns ErrHandedOver without touching the connection. A session taken over
// from the previous process starts with the directions that were still open.
func (r *Registry) Bridge(connection net.Conn, session *relayresume.Session, cfg BridgeConfig) error {
	maxFrame := session.MaxFrame()
	readChunk := cfg.ReadChunk
	if readChunk <= 0 || readChunk > maxFrame {
		readChunk = maxFrame
	}
	cfg.ReadChunk = readChunk
	b := &Bridge{conn: connection, session: session, cfg: cfg, stop: newStopper(cfg.Idle, connection), registry: r}
	if cfg.Idle > 0 {
		b.stop.touch()
	}
	if r != nil {
		defer r.add(b, cfg.Started)()
	} else if cfg.Started != nil {
		cfg.Started()
	}
	readLocal, writeLocal := !session.FinQueued(), !session.FinDelivered()
	completed := make(chan bridgeResult, 2)
	if readLocal {
		go b.readLoop(completed)
	} else {
		b.stop.finish(sideLocal)
	}
	if writeLocal {
		go b.writeLoop(completed, maxFrame)
	} else {
		b.stop.finish(sideRemote)
	}
	localDone, remoteDone := !readLocal, !writeLocal
	var terminated, handed bool
	var bridgeErr error
	for !localDone || !remoteDone {
		item := <-completed
		if item.local {
			localDone = true
		} else {
			remoteDone = true
		}
		if item.handed {
			handed = true
			continue
		}
		if item.err != nil && bridgeErr == nil {
			bridgeErr = item.err
		}
		if (item.terminal || item.err != nil) && !terminated {
			terminated = true
			b.stop.terminate()
			session.Cancel()
			_ = connection.Close()
		}
	}
	if handed || session.Detached() {
		return ErrHandedOver
	}
	if !terminated {
		// Both directions ended: the CLOSE exchange finishes the stream. A
		// handover meanwhile takes the stream (and the connection) along.
		<-session.Done()
		if session.Detached() {
			return ErrHandedOver
		}
		session.Cancel()
		_ = connection.Close()
	}
	return bridgeErr
}

func (b *Bridge) readLoop(completed chan<- bridgeResult) {
	// The smallest power of two that holds the chunk.
	pool := &readBufferPools[bits.Len(uint(b.cfg.ReadChunk-1))]
	pooled := pool.Get().(*[]byte)
	defer pool.Put(pooled)
	buffer := (*pooled)[:b.cfg.ReadChunk]
	for {
		n, err := b.conn.Read(buffer)
		if n > 0 {
			b.stop.touch()
			if sendErr := b.session.Write(append([]byte(nil), buffer[:n]...)); sendErr != nil {
				completed <- bridgeResult{local: true, terminal: true, handed: errors.Is(sendErr, relayresume.ErrHandedOver), err: sendErr}
				return
			}
		}
		if err == nil {
			continue
		}
		if park, retry := b.stop.stopped(err); park {
			if b.stop.park(sideLocal) == verdictHanded {
				completed <- bridgeResult{local: true, handed: true}
				return
			}
			continue
		} else if retry {
			continue
		}
		if errors.Is(err, io.EOF) {
			b.localEnded(nil)
			if sendErr := b.session.CloseWrite(); sendErr != nil {
				completed <- bridgeResult{local: true, terminal: true, handed: errors.Is(sendErr, relayresume.ErrHandedOver), err: sendErr}
				return
			}
			b.stop.finish(sideLocal)
			completed <- bridgeResult{local: true}
			return
		}
		b.localEnded(err)
		completed <- bridgeResult{local: true, terminal: true, err: err}
		return
	}
}

func (b *Bridge) writeLoop(completed chan<- bridgeResult, maxFrame int) {
	for {
		frame, err := b.session.Recv()
		if err != nil {
			switch {
			case errors.Is(err, relayresume.ErrFrozen):
				if b.stop.park(sideRemote) == verdictHanded {
					completed <- bridgeResult{handed: true}
					return
				}
				continue
			case errors.Is(err, relayresume.ErrHandedOver):
				completed <- bridgeResult{handed: true}
				return
			}
			completed <- bridgeResult{terminal: true, err: err}
			return
		}
		switch {
		case frame.GetData() != nil:
			data := frame.GetData().GetData()
			if len(data) == 0 || len(data) > maxFrame {
				completed <- bridgeResult{terminal: true, err: errors.New("invalid relay frame size")}
				return
			}
			for len(data) > 0 {
				n, writeErr := b.conn.Write(data)
				if n > 0 {
					data = data[n:]
				}
				if writeErr == nil {
					continue
				}
				park, retry := b.stop.stopped(writeErr)
				if retry {
					continue
				}
				if !park {
					b.localEnded(writeErr)
					completed <- bridgeResult{terminal: true, err: writeErr}
					return
				}
				// What the socket did not take goes out first after the
				// freeze, here or in the next process.
				b.session.Unread(data)
				data = nil
				if b.stop.park(sideRemote) == verdictHanded {
					completed <- bridgeResult{handed: true}
					return
				}
			}
			b.stop.touch()
		case frame.GetHalfClose() != nil:
			if closer, ok := b.conn.(interface{ CloseWrite() error }); ok {
				_ = closer.CloseWrite()
			}
			b.stop.finish(sideRemote)
			completed <- bridgeResult{}
			return
		case frame.GetClose() != nil:
			completed <- bridgeResult{terminal: true}
			return
		case frame.GetError() != nil:
			completed <- bridgeResult{terminal: true, err: fmt.Errorf("relay tunnel error: %s", frame.GetError().GetCode())}
			return
		default:
			completed <- bridgeResult{terminal: true, err: errors.New("unexpected relay tunnel frame")}
			return
		}
	}
}

// cutClass is the class an update cuts the bridge under whatever it hands
// over ("": it can be handed over): its own (BridgeConfig.CutClass), or
// no_socket for a connection whose bytes the daemon transforms (TLS).
func (b *Bridge) cutClass() string {
	if b.cfg.CutClass != "" {
		return b.cfg.CutClass
	}
	if _, err := socketOf(b.conn); err != nil {
		return CutNoSocket
	}
	return ""
}

func (b *Bridge) pinned() bool { return b.cutClass() != "" }

// quiescent reports a frozen bridge whose directions hold no byte: each parked
// or ended, or the writer waits in Recv for the stream's path (a frozen
// stream hands it nothing). ok=false: the connection is ending on its own.
func (b *Bridge) quiescent() (quiet, ok bool) {
	still, terminated := b.stop.directions()
	if terminated {
		return false, false
	}
	if !still[sideRemote] {
		still[sideRemote] = b.session.RecvBlocked()
	}
	return still[sideLocal] && still[sideRemote], true
}

// freeze stops the bridge for a handover.
func (b *Bridge) freeze() {
	b.session.Freeze()
	b.stop.freeze()
}

// thaw lets a frozen bridge carry on in this process.
func (b *Bridge) thaw() {
	b.session.Thaw()
	b.stop.release(verdictThaw)
}

// handedOver ends a bridge the next process carries.
func (b *Bridge) handedOver() {
	markHandedOver(b.conn)
	b.session.Detach()
	b.stop.release(verdictHanded)
}

var _ item = (*Bridge)(nil)
