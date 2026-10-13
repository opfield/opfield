//go:build linux

package handover

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// The handover's one dangerous failure is a byte lost or doubled at the
// freeze. Two daemons in one test process, a source (A) and a target (B),
// carry streams between local socket pairs (TCP loopback and Unix socket
// pairs, with small buffers so writes stall) over an in-memory relay. The
// applications at both ends write a continuous deterministic byte stream in
// both directions and check every byte they read against it; some streams
// half-close one direction early. Meanwhile A, B, or both hand over to a new
// "process" again and again. Every stream must end with exactly the bytes
// written, in order, and none may be cut.

// memStream is one end of an in-memory relay tunnel.
type memStream struct {
	in, out chan *relayv1.TunnelFrame
	tunnel  *memTunnel
}

type memTunnel struct {
	dead chan struct{}
	once sync.Once
}

func (t *memTunnel) kill() { t.once.Do(func() { close(t.dead) }) }

var errTunnelGone = status.Error(codes.Canceled, "context canceled")

func (m *memStream) Send(frame *relayv1.TunnelFrame) error {
	if data := frame.GetData(); data != nil {
		frame = &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), data.Data...)}}}
	}
	select {
	case <-m.tunnel.dead:
		return errTunnelGone
	default:
	}
	select {
	case m.out <- frame:
		return nil
	case <-m.tunnel.dead:
		return errTunnelGone
	}
}

func (m *memStream) Recv() (*relayv1.TunnelFrame, error) {
	select {
	case frame := <-m.in:
		return frame, nil
	case <-m.tunnel.dead:
		select {
		case frame := <-m.in:
			return frame, nil
		default:
		}
		return nil, errTunnelGone
	}
}

func openTunnel() (*memStream, *memStream, *memTunnel) {
	tunnel := &memTunnel{dead: make(chan struct{})}
	a, b := make(chan *relayv1.TunnelFrame, 64), make(chan *relayv1.TunnelFrame, 64)
	return &memStream{in: b, out: a, tunnel: tunnel}, &memStream{in: a, out: b, tunnel: tunnel}, tunnel
}

// pattern is the deterministic byte stream of one direction: each byte is a
// function of the seed and its offset, so the reader regenerates it whatever
// the chunks.
type pattern struct {
	state  uint64
	offset uint64
}

func (p *pattern) fill(buffer []byte) {
	for i := range buffer {
		z := p.state + (p.offset/8)*0x9e3779b97f4a7c15
		z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
		z = (z ^ (z >> 27)) * 0x94d049bb133111eb
		z ^= z >> 31
		buffer[i] = byte(z >> (8 * (p.offset % 8)))
		p.offset++
	}
}

// direction is one direction of one stream: what its writer wrote and what
// its reader checked.
type direction struct {
	name    string
	seed    uint64
	written atomic.Int64
	read    atomic.Int64
	// stopAfter: the writer half-closes after this many bytes (0: when told).
	stopAfter int64
	slow      bool
	done      chan error
}

func (d *direction) write(connection net.Conn, stop <-chan struct{}, rng *rand.Rand) {
	gen := pattern{state: d.seed}
	buffer := make([]byte, 64*1024)
	for {
		select {
		case <-stop:
			_ = connection.(interface{ CloseWrite() error }).CloseWrite()
			return
		default:
		}
		n := 1 + rng.IntN(len(buffer))
		if d.stopAfter > 0 {
			left := d.stopAfter - d.written.Load()
			if left <= 0 {
				_ = connection.(interface{ CloseWrite() error }).CloseWrite()
				return
			}
			n = int(min(int64(n), left))
		}
		gen.fill(buffer[:n])
		if _, err := connection.Write(buffer[:n]); err != nil {
			d.done <- fmt.Errorf("%s: write after %d bytes: %w", d.name, d.written.Load(), err)
			return
		}
		d.written.Add(int64(n))
	}
}

func (d *direction) check(connection net.Conn, rng *rand.Rand) {
	gen := pattern{state: d.seed}
	buffer := make([]byte, 48*1024)
	expect := make([]byte, len(buffer))
	for {
		n, err := connection.Read(buffer[:1+rng.IntN(len(buffer))])
		if n > 0 {
			gen.fill(expect[:n])
			for i := 0; i < n; i++ {
				if buffer[i] != expect[i] {
					d.done <- fmt.Errorf("%s: byte %d differs (lost or doubled bytes)", d.name, d.read.Load()+int64(i))
					return
				}
			}
			d.read.Add(int64(n))
			if d.slow && rng.IntN(4) == 0 {
				time.Sleep(time.Duration(rng.IntN(3)) * time.Millisecond)
			}
		}
		if errors.Is(err, io.EOF) {
			d.done <- nil
			return
		}
		if err != nil {
			d.done <- fmt.Errorf("%s: read after %d bytes: %w", d.name, d.read.Load(), err)
			return
		}
	}
}

// localPair is a connected pair of local sockets; small ones have small
// buffers, so a write to them stalls often.
func localPair(t testing.TB, unix bool, small bool) (net.Conn, net.Conn) {
	t.Helper()
	if unix {
		fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
		if err != nil {
			t.Fatal(err)
		}
		var conns [2]net.Conn
		for i, fd := range fds {
			if small {
				_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_SNDBUF, 8*1024)
				_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 8*1024)
			}
			file := os.NewFile(uintptr(fd), "pair")
			connection, err := net.FileConn(file)
			_ = file.Close()
			if err != nil {
				t.Fatal(err)
			}
			conns[i] = connection
		}
		return conns[0], conns[1]
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	for _, connection := range []net.Conn{client, server} {
		// Every TCP pair sets its buffers, so the kernel never resizes them.
		// Linux 6.17 ("tcp: stronger sk_rcvbuf checks", reverted upstream in
		// 2026) clamps an autotuned receive buffer to what it holds when a
		// loopback segment does not fit, down to a few KB below one MSS:
		// under CPU starvation such a stream then crawls on zero-window
		// probes for minutes and the test failed with "no end" (stand rc.7,
		// CT 1138 at load 15-50), with every byte still in the sender's
		// queue. A buffer the application set is never clamped.
		buffer := 4 << 20
		if small {
			buffer = 32 * 1024
		}
		_ = connection.(*net.TCPConn).SetReadBuffer(buffer)
		_ = connection.(*net.TCPConn).SetWriteBuffer(buffer)
	}
	return client, server
}

// world holds the two daemons: their current processes, their keepers, and
// the relay between them.
type world struct {
	t       testing.TB
	key     []byte
	keeperA *handovertest.Keeper
	keeperB *handovertest.Keeper

	mu      sync.Mutex
	a       *sourceDaemon
	b       *targetDaemon
	pending chan net.Conn // B's application end of each new stream

	bridges sync.WaitGroup
	errs    chan error
	cut     atomic.Int64
}

// itemCount counts the bridges and pipes a daemon process started and the
// ones that returned.
type itemCount struct{ started, returned atomic.Int64 }

// waitStarted waits until every bridge and pipe started on registry is in it
// (or returned already): a daemon carries the connections it took over before
// it can be updated again.
func waitStarted(t testing.TB, registry *Registry, count *itemCount) {
	deadline := time.Now().Add(10 * time.Second)
	for {
		returned := count.returned.Load() // before the snapshot: an item is never counted twice
		if int64(len(registry.snapshotItems()))+returned >= count.started.Load() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the connections a daemon took over did not start")
		}
		time.Sleep(time.Millisecond)
	}
}

type sourceDaemon struct {
	mgr   *relayresume.Manager
	reg   *Registry
	items itemCount
}

type targetDaemon struct {
	table *relayresume.TargetTable
	reg   *Registry
	items itemCount
	// accepting: the relay passes new tunnels to this process.
	accepting atomic.Bool
}

func (w *world) current() (*sourceDaemon, *targetDaemon) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.a, w.b
}

func (w *world) newSource() *sourceDaemon {
	mgr := relayresume.NewManager(nil)
	mgr.OnEnd = func(_ *relayresume.Session, err error) {
		if err != nil {
			w.cut.Add(1)
			w.errs <- fmt.Errorf("source stream ended: %w", err)
		}
	}
	return &sourceDaemon{mgr: mgr, reg: NewRegistry()}
}

func (w *world) newTarget() *targetDaemon {
	table := relayresume.NewTargetTable(nil)
	table.OnEnd = func(_ relayresume.TargetKey, _ *relayresume.Session, err error) {
		if err != nil {
			w.cut.Add(1)
			w.errs <- fmt.Errorf("target stream ended: %w", err)
		}
	}
	daemon := &targetDaemon{table: table, reg: NewRegistry()}
	daemon.accepting.Store(true)
	return daemon
}

func (w *world) sourceConfig() relayresume.SourceConfig {
	return relayresume.SourceConfig{RouteID: "route-1", Dial: w.dial,
		Key: func() (string, []byte, bool) { return "v1", w.key, true }}
}

// dial opens a tunnel to the target daemon's current process; while it
// restarts, the relay answers "restarting".
func (w *world) dial(ctx context.Context, _ relayresume.DialRequest) (relayresume.OpenedPath, error) {
	_, b := w.current()
	if b == nil || !b.accepting.Load() {
		return relayresume.OpenedPath{}, status.Error(codes.Unavailable, "relay endpoint is restarting")
	}
	src, tgt, tunnel := openTunnel()
	go w.serveTarget(b, relayresume.OpenedPath{Stream: tgt, Cancel: tunnel.kill, RelayID: "relay-1", MaxFrame: 64 * 1024,
		CloseSend: func() error {
			select {
			case tgt.out <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}:
			case <-tunnel.dead:
			}
			return nil
		}})
	return relayresume.OpenedPath{Stream: src, Cancel: tunnel.kill, RelayID: "relay-1", MaxFrame: 64 * 1024}, nil
}

func (w *world) serveTarget(b *targetDaemon, op relayresume.OpenedPath) {
	defer op.Cancel()
	accepted := b.table.Accept(op, relayresume.AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-a", RelayID: op.RelayID,
		Keys: func(keyID string) []byte {
			if keyID == "v1" {
				return w.key
			}
			return nil
		}})
	switch accepted.Kind {
	case relayresume.AcceptHello:
		session, err := accepted.Establish()
		if err != nil {
			w.errs <- err
			return
		}
		local, app := localPair(w.t, rand.IntN(2) == 0, rand.IntN(2) == 0)
		w.bridge(b.reg, &b.items, local, session)
		w.pending <- app
		<-accepted.PathDone
	case relayresume.AcceptLegacy:
		w.errs <- errors.New("target saw a raw tunnel")
	default:
		<-accepted.PathDone
	}
}

// bridge runs a daemon's bridge: like the daemons, it closes its copy of the
// connection when the bridge returns, handed over or not.
func (w *world) bridge(registry *Registry, count *itemCount, connection net.Conn, session *relayresume.Session) {
	w.bridges.Add(1)
	count.started.Add(1)
	go func() {
		defer w.bridges.Done()
		defer count.returned.Add(1)
		defer connection.Close()
		err := registry.Bridge(connection, session, BridgeConfig{ReadChunk: 16 * 1024, Labels: Labels{"stream": "x"}})
		if err != nil && !errors.Is(err, ErrHandedOver) {
			w.errs <- fmt.Errorf("bridge: %w", err)
		}
	}()
}

// pipe runs a daemon's node-local pipe (left, right), or carries a restored
// one on; like the daemons, it closes its copies when the pipe returns.
func (w *world) pipe(registry *Registry, count *itemCount, restored *RestoredPipe, left, right net.Conn) {
	w.bridges.Add(1)
	count.started.Add(1)
	go func() {
		defer w.bridges.Done()
		defer count.returned.Add(1)
		var err error
		if restored != nil {
			left, right = restored.Conns[0], restored.Conns[1]
			err = registry.ResumePipe(restored, PipeConfig{Labels: restored.Labels})
		} else {
			err = registry.Pipe(left, right, PipeConfig{Labels: Labels{"pipe": "x"}})
		}
		_ = left.Close()
		_ = right.Close()
		if err != nil && !errors.Is(err, ErrHandedOver) {
			w.errs <- fmt.Errorf("pipe: %w", err)
		}
	}()
}

// handOverA hands the source daemon's process over to a new one.
func (w *world) handOverA(t testing.TB) {
	old, _ := w.current()
	result := old.reg.HandOver(Options{DaemonType: "test-source", Version: "v1", Keeper: w.keeperA, FreezeWait: 3 * time.Second})
	if result.Err != nil || len(result.Cut) > 0 {
		t.Errorf("source handover: %+v", result)
	}
	if err := w.keeperA.Restart(); err != nil {
		t.Fatal(err)
	}
	next := w.newSource()
	restored, err := RestoreFrom(w.keeperA, "test-source", nil)
	if err != nil {
		t.Fatalf("source restore: %v", err)
	}
	if restored != nil {
		if restored.Lost > 0 {
			t.Errorf("source restore lost %d connections", restored.Lost)
		}
		for _, item := range restored.Sessions {
			session, err := next.mgr.RestoreSource(w.sourceConfig(), item.State)
			if err != nil {
				t.Fatalf("restore source stream: %v", err)
			}
			w.bridge(next.reg, &next.items, item.Conn, session)
		}
		for _, item := range restored.Pipes {
			w.pipe(next.reg, &next.items, item, nil, nil)
		}
	}
	waitStarted(t, next.reg, &next.items)
	w.mu.Lock()
	w.a = next
	w.mu.Unlock()
}

// handOverB hands the target daemon's process over: new tunnels get
// "restarting" from the moment its old process committed until the new one
// restored (and, briefly, the old one drops the RESUMEs it still gets).
func (w *world) handOverB(t testing.TB) {
	_, old := w.current()
	result := old.reg.HandOver(Options{DaemonType: "test-target", Version: "v1", Keeper: w.keeperB, FreezeWait: 3 * time.Second,
		Tables: []*relayresume.TargetTable{old.table}})
	if result.Err != nil || len(result.Cut) > 0 {
		t.Errorf("target handover: %+v", result)
	}
	time.Sleep(time.Duration(rand.IntN(20)) * time.Millisecond)
	old.accepting.Store(false)
	if err := w.keeperB.Restart(); err != nil {
		t.Fatal(err)
	}
	next := w.newTarget()
	next.accepting.Store(false)
	restored, err := RestoreFrom(w.keeperB, "test-target", nil)
	if err != nil {
		t.Fatalf("target restore: %v", err)
	}
	if restored != nil {
		if restored.Lost > 0 {
			t.Errorf("target restore lost %d connections", restored.Lost)
		}
		next.table.RestoreTombstones(restored.Tombstones)
		for _, item := range restored.Sessions {
			session, err := next.table.Restore(item.State, nil)
			if err != nil {
				t.Fatalf("restore target stream: %v", err)
			}
			w.bridge(next.reg, &next.items, item.Conn, session)
		}
	}
	waitStarted(t, next.reg, &next.items)
	w.mu.Lock()
	w.b = next
	w.mu.Unlock()
	next.accepting.Store(true)
}

func stressIterations(t *testing.T) int {
	if value, err := strconv.Atoi(os.Getenv("HANDOVER_STRESS_ITERATIONS")); err == nil && value > 0 {
		return value
	}
	if testing.Short() {
		return 8
	}
	return 40
}

func TestHandoverStressKeepsEveryByte(t *testing.T) {
	iterations := stressIterations(t)
	w := &world{t: t, key: make([]byte, relayresume.KeyLen), keeperA: handovertest.NewKeeper(), keeperB: handovertest.NewKeeper(),
		pending: make(chan net.Conn, 16), errs: make(chan error, 1024)}
	for i := range w.key {
		w.key[i] = byte(i + 1)
	}
	w.a, w.b = w.newSource(), w.newTarget()

	const streams = 6
	stop := make(chan struct{})
	var directions []*direction
	var appConns []net.Conn
	for i := 0; i < streams; i++ {
		first, err := w.dial(context.Background(), relayresume.DialRequest{})
		if err != nil {
			t.Fatal(err)
		}
		a, _ := w.current()
		session, err := a.mgr.NewSource(w.sourceConfig(), first)
		if err != nil {
			t.Fatal(err)
		}
		local, appA := localPair(t, i%2 == 0, i%3 != 0)
		w.bridge(a.reg, &a.items, local, session)
		var appB net.Conn
		select {
		case appB = <-w.pending:
		case <-time.After(5 * time.Second):
			t.Fatal("the target did not accept the stream")
		}
		appConns = append(appConns, appA, appB)
		up := &direction{name: fmt.Sprintf("stream %d A->B", i), seed: uint64(i)*2 + 1, slow: i%3 == 1, done: make(chan error, 2)}
		down := &direction{name: fmt.Sprintf("stream %d B->A", i), seed: uint64(i)*2 + 2, slow: i%3 == 2, done: make(chan error, 2)}
		switch i {
		case 2:
			up.stopAfter = 3 << 20 // A half-closes early, B keeps sending
		case 3:
			down.stopAfter = 2 << 20 // and the other way round
		case 4:
			up.stopAfter, down.stopAfter = 1<<20, 1<<20 // ends early: the CLOSE exchange runs during handovers
		}
		directions = append(directions, up, down)
		rngs := [4]*rand.Rand{}
		for k := range rngs {
			rngs[k] = rand.New(rand.NewPCG(uint64(i), uint64(k)))
		}
		go up.write(appA, stop, rngs[0])
		go up.check(appB, rngs[1])
		go down.write(appB, stop, rngs[2])
		go down.check(appA, rngs[3])
	}

	// Node-local link connections the source daemon copies between two local
	// sockets (a container link whose target is on the same node).
	for i := 0; i < 2; i++ {
		workloadSide, appLeft := localPair(t, i == 0, i == 1)
		targetSide, appRight := localPair(t, i == 1, false)
		a, _ := w.current()
		w.pipe(a.reg, &a.items, nil, workloadSide, targetSide)
		appConns = append(appConns, appLeft, appRight)
		up := &direction{name: fmt.Sprintf("pipe %d left->right", i), seed: uint64(100 + i*2), slow: i == 1, done: make(chan error, 2)}
		down := &direction{name: fmt.Sprintf("pipe %d right->left", i), seed: uint64(101 + i*2), done: make(chan error, 2)}
		if i == 1 {
			down.stopAfter = 1 << 20
		}
		directions = append(directions, up, down)
		rngs := [4]*rand.Rand{}
		for k := range rngs {
			rngs[k] = rand.New(rand.NewPCG(uint64(50+i), uint64(k)))
		}
		go up.write(appLeft, stop, rngs[0])
		go up.check(appRight, rngs[1])
		go down.write(appRight, stop, rngs[2])
		go down.check(appLeft, rngs[3])
	}

	initialA, initialB := w.current()
	waitStarted(t, initialA.reg, &initialA.items)
	waitStarted(t, initialB.reg, &initialB.items)
	rng := rand.New(rand.NewPCG(7, 7))
	started := time.Now()
	for i := 0; i < iterations; i++ {
		time.Sleep(time.Duration(10+rng.IntN(120)) * time.Millisecond)
		switch rng.IntN(3) {
		case 0:
			w.handOverA(t)
		case 1:
			w.handOverB(t)
		default:
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); w.handOverA(t) }()
			go func() { defer wg.Done(); w.handOverB(t) }()
			wg.Wait()
		}
		select {
		case err := <-w.errs:
			t.Fatalf("after %d handovers: %v", i+1, err)
		default:
		}
	}
	t.Logf("%d handovers in %s", iterations, time.Since(started).Round(time.Millisecond))
	close(stop)
	deadline := time.After(90 * time.Second)
	for _, d := range directions {
		select {
		case err := <-d.done:
			if err != nil {
				t.Fatal(err)
			}
		case err := <-w.errs:
			t.Fatal(err)
		case <-deadline:
			t.Fatalf("%s: no end after %d of %d bytes", d.name, d.read.Load(), d.written.Load())
		}
		if d.read.Load() != d.written.Load() {
			t.Fatalf("%s: read %d bytes, %d written", d.name, d.read.Load(), d.written.Load())
		}
		if d.written.Load() == 0 {
			t.Fatalf("%s carried nothing", d.name)
		}
	}
	for _, connection := range appConns {
		_ = connection.Close()
	}
	done := make(chan struct{})
	go func() { w.bridges.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("bridges did not end")
	}
	select {
	case err := <-w.errs:
		t.Fatal(err)
	default:
	}
	if cut := w.cut.Load(); cut > 0 {
		t.Fatalf("%d streams were cut", cut)
	}
	var total int64
	for _, d := range directions {
		total += d.read.Load()
	}
	t.Logf("%d bytes checked", total)
}
