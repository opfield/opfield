package broker

// Secure Link throughput over links with a round trip: streams through a real
// broker, raw and resumable (RSv1), uploads (source -> target) and downloads
// (target -> source), against the same bytes sent directly over a link with
// the same delay and rate. Every hop runs as deployed: TLS, the daemons' lane
// dial options, relaybridge on real TCP sockets at both ends.
//
//	go test -run XXX -bench SecureLinkRTT ./internal/broker
//	RELAY_RTT_MATRIX=1 RTT_MS=120 RATE_MBPS=0 SIZE_MB=256 go test -run SecureLinkThroughputMatrix -v ./internal/broker
//
// TestSecureLinkThroughputGate runs in the light suite: a resumable stream
// must carry at least 90 % of a direct connection over the same link in both
// directions once both ramped up.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	"google.golang.org/grpc"
)

// rtLink is a TCP proxy that delays each direction by oneWay and carries at
// most rate bytes per second (0: unlimited), like a long-distance link. It
// buffers what the sender writes (up to rtQueueBytes per direction), so only
// the protocols' own windows limit what is in flight.
type rtLink struct {
	listener net.Listener
	upstream string
	oneWay   atomic.Int64 // time.Duration; setDelay changes it under running streams
	rate     float64
	mu       sync.Mutex
	conns    []net.Conn
	closed   bool
}

func startRTLink(tb testing.TB, upstream string, oneWay time.Duration, rate float64) *rtLink {
	tb.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	link := &rtLink{listener: listener, upstream: upstream, rate: rate}
	link.oneWay.Store(int64(oneWay))
	go link.serve()
	tb.Cleanup(link.close)
	return link
}

func (l *rtLink) addr() string { return l.listener.Addr().String() }

// setDelay changes the link's one-way delay for what it reads from now on
// (a route that got longer under its connections).
func (l *rtLink) setDelay(oneWay time.Duration) { l.oneWay.Store(int64(oneWay)) }

func (l *rtLink) close() {
	l.mu.Lock()
	l.closed = true
	conns := l.conns
	l.conns = nil
	l.mu.Unlock()
	_ = l.listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (l *rtLink) track(conns ...net.Conn) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.conns = append(l.conns, conns...)
	return true
}

func (l *rtLink) serve() {
	for {
		down, err := l.listener.Accept()
		if err != nil {
			return
		}
		up, err := net.Dial("tcp", l.upstream)
		if err != nil {
			_ = down.Close()
			continue
		}
		if !l.track(down, up) {
			_ = down.Close()
			_ = up.Close()
			return
		}
		go l.pipe(up, down)
		go l.pipe(down, up)
	}
}

type rtSegment struct {
	data []byte
	due  time.Time
}

// rtQueueBytes bounds what one direction holds in flight: a sender beyond it
// waits like one whose socket buffer is full.
const rtQueueBytes = 64 << 20

func (l *rtLink) pipe(dst, src net.Conn) {
	queue := make(chan rtSegment, 8192)
	var queued sync.Mutex
	room := sync.NewCond(&queued)
	held := 0
	go func() {
		var free time.Time
		for segment := range queue {
			at := segment.due
			if l.rate > 0 {
				if free.After(at) {
					at = free
				}
				free = at.Add(time.Duration(float64(len(segment.data)) / l.rate * float64(time.Second)))
				at = free
			}
			if wait := time.Until(at); wait > 200*time.Microsecond {
				time.Sleep(wait)
			}
			_, err := dst.Write(segment.data)
			queued.Lock()
			held -= len(segment.data)
			room.Signal()
			queued.Unlock()
			if err != nil {
				_ = src.Close()
				for range queue {
				}
				return
			}
		}
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	for {
		buffer := make([]byte, 64<<10)
		n, err := src.Read(buffer)
		if n > 0 {
			queued.Lock()
			for held > rtQueueBytes {
				room.Wait()
			}
			held += n
			queued.Unlock()
			queue <- rtSegment{data: buffer[:n], due: time.Now().Add(time.Duration(l.oneWay.Load()))}
		}
		if err != nil {
			close(queue)
			return
		}
	}
}

// rtTiming is when a transfer passed its warm-up mark and when it ended, as
// the receiving side saw it.
type rtTiming struct {
	warm, end time.Time
}

// rtBackend is the service behind the target: for an upload it reads to EOF
// (and reports its timing); for a download it writes size bytes and closes.
type rtBackend struct {
	listener net.Listener
	download bool
	size     int64
	warmup   int64
	block    []byte
	uploads  chan rtTiming
}

func startRTBackend(tb testing.TB, download bool, size, warmup int64) *rtBackend {
	tb.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	backend := &rtBackend{listener: listener, download: download, size: size, warmup: warmup, block: make([]byte, 256<<10),
		uploads: make(chan rtTiming, 16)}
	for i := range backend.block {
		backend.block[i] = byte(i * 7)
	}
	go backend.serve()
	tb.Cleanup(func() { _ = listener.Close() })
	return backend
}

func (b *rtBackend) serve() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			if !b.download {
				timing, _ := rtReceive(conn, b.warmup)
				select {
				case b.uploads <- timing:
				default:
				}
				return
			}
			for sent := int64(0); sent < b.size; {
				n := min(int64(len(b.block)), b.size-sent)
				if _, err := conn.Write(b.block[:n]); err != nil {
					return
				}
				sent += n
			}
			_ = conn.(*net.TCPConn).CloseWrite()
			_, _ = io.Copy(io.Discard, conn)
		}()
	}
}

// rtReceive reads to EOF, noting when warmup bytes had arrived.
func rtReceive(conn net.Conn, warmup int64) (rtTiming, int64) {
	var timing rtTiming
	buffer := make([]byte, 256<<10)
	var got int64
	for {
		n, err := conn.Read(buffer)
		got += int64(n)
		if timing.warm.IsZero() && got >= warmup {
			timing.warm = time.Now()
		}
		if err != nil {
			timing.end = time.Now()
			return timing, got
		}
	}
}

// rtRig is one relay with a delayed link to each daemon, a target serving
// two routes (raw and resumable) in front of the backend, and the source.
type rtRig struct {
	h       *rhHarness
	relay   *rhRelay
	backend *rtBackend
	phased  *rtPhasedBackend
	direct  *rtLink
	legs    []*rtLink
	table   *relayresume.TargetTable
	source  *rhSource
	// phasedSource opens streams to the phased backend (rtRoutePhased).
	phasedSource *rhSource
	rawConn      *grpc.ClientConn
	size         int64
	warmup       int64
	chunk        int
}

const (
	rtRouteRaw    = "route-rtt-raw"
	rtRouteResume = "route-rtt-resume"
	rtRoutePhased = "route-rtt-phased"
)

// newRTRig: legOneWay delays each daemon <-> relay leg in each direction, so
// a stream's round trip is 4*legOneWay; the direct link gets 2*legOneWay each
// way, the same round trip, and the same rate.
func newRTRig(tb testing.TB, download bool, size, warmup int64, legOneWay time.Duration, rate float64, chunk int) *rtRig {
	h := newRHHarness(tb)
	h.addRoute(rhRoute{id: rtRouteRaw})
	h.addRoute(rhRoute{id: rtRouteResume})
	h.addRoute(rhRoute{id: rtRoutePhased})
	relay := h.startRelay("relay-rtt")
	rig := &rtRig{h: h, relay: relay, size: size, warmup: warmup, chunk: chunk, table: relayresume.NewTargetTable(nil)}
	rig.backend = startRTBackend(tb, download, size, warmup)
	rig.phased = startRTPhasedBackend(tb, download, size, warmup)
	rig.direct = startRTLink(tb, rig.backend.listener.Addr().String(), 2*legOneWay, rate)
	sourceAddr, targetAddr := relay.addr, relay.addr
	if legOneWay > 0 || rate > 0 {
		sourceLeg, targetLeg := startRTLink(tb, relay.addr, legOneWay, rate), startRTLink(tb, relay.addr, legOneWay, rate)
		rig.legs = []*rtLink{sourceLeg, targetLeg}
		sourceAddr, targetAddr = sourceLeg.addr(), targetLeg.addr()
	}
	target := &rhTarget{h: h, handle: rig.serveTarget, ready: map[string]int{}}
	target.conn = h.laneDial(targetAddr, h.targetCert)
	target.register(relay)
	tb.Cleanup(target.stop)
	target.waitRegistered(relay)
	sourceConn := h.laneDial(sourceAddr, h.sourceCert)
	rig.rawConn = sourceConn
	rig.source = &rhSource{h: h, routeID: rtRouteResume, manager: relayresume.NewManager(nil), relays: []*rhRelay{relay},
		conns: map[string]*grpc.ClientConn{relay.id: sourceConn}, draining: map[string]bool{}}
	rig.source.keyOK.Store(true)
	rig.phasedSource = &rhSource{h: h, routeID: rtRoutePhased, manager: rig.source.manager, relays: []*rhRelay{relay},
		conns: map[string]*grpc.ClientConn{relay.id: sourceConn}, draining: map[string]bool{}}
	rig.phasedSource.keyOK.Store(true)
	return rig
}

// setLegDelay sets both relay legs' one-way delay (the stream's round trip
// is 4*oneWay).
func (r *rtRig) setLegDelay(oneWay time.Duration) {
	for _, leg := range r.legs {
		leg.setDelay(oneWay)
	}
}

// laneDial dials addr with the daemons' relay lane options over the harness
// PKI.
func (h *rhHarness) laneDial(addr string, cert tls.Certificate) *grpc.ClientConn {
	h.t.Helper()
	config := &tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: h.pki.pool, ServerName: rhRelayServer, MinVersion: tls.VersionTLS13}
	conn, err := grpc.NewClient(addr, connector.LaneDialOptions(config)...)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// serveTarget is the target daemon: it dials the backend and bridges it, as
// the docker daemon does for a container link.
func (r *rtRig) serveTarget(accepted *rhAccepted) {
	route := accepted.incoming.GetRoute().GetRouteId()
	backendAddr := r.backend.listener.Addr().String()
	if route == rtRoutePhased {
		backendAddr = r.phased.listener.Addr().String()
	}
	backend, err := net.Dial("tcp", backendAddr)
	if err != nil {
		accepted.cancel()
		return
	}
	if route == rtRouteRaw {
		_ = relaybridge.BridgeWithChunk(context.Background(), backend, accepted.stream, accepted.maxFrame, r.chunk, accepted.cancel)
		return
	}
	decision := r.table.Accept(relayresume.OpenedPath{Stream: accepted.stream, Cancel: accepted.cancel, CloseSend: accepted.stream.CloseSend,
		RelayID: accepted.relayID, MaxFrame: accepted.maxFrame},
		relayresume.AcceptRequest{RouteID: route, SourceKind: accepted.incoming.GetRoute().GetSourceKind(), SourceID: accepted.incoming.GetRoute().GetSourceId(),
			RelayID: accepted.relayID, Keys: func(keyID string) []byte {
				id, key := rhRouteKey(r.h.t, route)
				if keyID != id {
					return nil
				}
				return key
			}})
	if decision.Kind != relayresume.AcceptHello {
		_ = backend.Close()
		if decision.PathDone != nil {
			<-decision.PathDone
		}
		return
	}
	session, err := decision.Establish()
	if err != nil {
		_ = backend.Close()
		accepted.cancel()
		return
	}
	_ = relaybridge.BridgeWithChunk(context.Background(), backend, session, session.MaxFrame(), relayresume.ReadChunk(r.chunk), session.Cancel)
	<-decision.PathDone
}

// rtResult is one transfer: payload bytes per second over the whole of it,
// and after the warm-up mark (the windows ramped up).
type rtResult struct {
	whole, steady float64
}

// transfer runs one stream in mode (direct, raw, resumable).
func (r *rtRig) transfer(mode string) (rtResult, error) {
	local, app, err := rtTCPPair()
	if err != nil {
		return rtResult{}, err
	}
	defer app.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := time.Now()
	bridged := make(chan error, 1)
	switch mode {
	case "direct":
		_ = local.Close()
		app, err = net.Dial("tcp", r.direct.addr())
		if err != nil {
			return rtResult{}, err
		}
		defer app.Close()
		close(bridged)
	case "raw":
		stream, maxFrame, err := r.h.openTunnel(ctx, r.rawConn, rtRouteRaw)
		if err != nil {
			return rtResult{}, err
		}
		go func() {
			bridged <- relaybridge.BridgeWithChunk(ctx, local, stream, maxFrame, r.chunk, cancel)
		}()
	case "resumable":
		first, err := r.source.dial(ctx, relayresume.DialRequest{})
		if err != nil {
			return rtResult{}, err
		}
		session, err := r.source.manager.NewSource(r.source.config(0), first)
		if err != nil {
			return rtResult{}, err
		}
		go func() {
			bridged <- relaybridge.BridgeWithChunk(ctx, local, session, session.MaxFrame(), relayresume.ReadChunk(r.chunk), session.Cancel)
		}()
	default:
		return rtResult{}, fmt.Errorf("unknown mode %q", mode)
	}
	var timing rtTiming
	if r.backend.download {
		// Like an HTTP client: the request side stays open until the
		// response ended.
		var got int64
		timing, got = rtReceive(app, r.warmup)
		if got != r.size {
			return rtResult{}, fmt.Errorf("%s download: %d of %d bytes", mode, got, r.size)
		}
		_ = app.(*net.TCPConn).CloseWrite()
	} else {
		block := make([]byte, 256<<10)
		for sent := int64(0); sent < r.size; {
			n := min(int64(len(block)), r.size-sent)
			if _, err := app.Write(block[:n]); err != nil {
				return rtResult{}, err
			}
			sent += n
		}
		_ = app.(*net.TCPConn).CloseWrite()
		// The backend closes after EOF: every byte arrived.
		if _, err := io.Copy(io.Discard, app); err != nil {
			return rtResult{}, err
		}
		select {
		case timing = <-r.backend.uploads:
		case <-time.After(10 * time.Second):
			return rtResult{}, errors.New("the backend reported no upload")
		}
	}
	if err := <-bridged; err != nil && !errors.Is(err, context.Canceled) {
		return rtResult{}, fmt.Errorf("%s bridge: %w", mode, err)
	}
	result := rtResult{whole: float64(r.size) / timing.end.Sub(started).Seconds()}
	if !timing.warm.IsZero() && timing.end.After(timing.warm) {
		result.steady = float64(r.size-r.warmup) / timing.end.Sub(timing.warm).Seconds()
	}
	return result, nil
}

func rtTCPPair() (net.Conn, net.Conn, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	defer listener.Close()
	app, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		return nil, nil, err
	}
	local, err := listener.Accept()
	if err != nil {
		_ = app.Close()
		return nil, nil, err
	}
	return local, app, nil
}

func rtCPU() time.Duration {
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
}

func rtEnv(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value >= 0 {
		return value
	}
	return fallback
}

// The gate's link: 40 MB/s and a 160 ms round trip (6.4 MB in flight). A
// window of 4 MiB carried 26 MB/s there.
const (
	gateRate   = 40e6
	gateRTT    = 160 * time.Millisecond
	gateSize   = 80 << 20
	gateWarmup = 24 << 20
)

// TestSecureLinkThroughputGate: a resumable stream through a relay carries at
// least 90 % of a direct TCP connection over a link of the same rate and
// round trip, uploads and downloads, once both ramped up. Secure Link must
// never be slower than going direct; a flow-control regression (the window,
// its growth, acks, HTTP/2 windows, frame sizes) shows here.
func TestSecureLinkThroughputGate(t *testing.T) {
	if testing.Short() {
		t.Skip("throughput gate: not in -short")
	}
	for _, download := range []bool{false, true} {
		direction := map[bool]string{false: "upload", true: "download"}[download]
		t.Run(direction, func(t *testing.T) {
			rig := newRTRig(t, download, gateSize, gateWarmup, gateRTT/4, gateRate, relaybridge.DefaultChunkBytes)
			// Best of up to three: a scheduling hiccup on a shared CI host
			// only ever slows a run down.
			best := func(mode string) rtResult {
				var top rtResult
				for range 3 {
					result, err := rig.transfer(mode)
					if err != nil {
						t.Fatalf("%s %s: %v", direction, mode, err)
					}
					if result.steady > top.steady {
						top = result
					}
					if mode == "direct" || result.steady >= 0.95*gateRate {
						break
					}
				}
				return top
			}
			direct := best("direct")
			resumable := best("resumable")
			t.Logf("%s over %.0f MB/s, %v: direct %.1f MB/s, resumable %.1f MB/s (whole transfer %.1f / %.1f)", direction, gateRate/1e6, gateRTT,
				direct.steady/1e6, resumable.steady/1e6, direct.whole/1e6, resumable.whole/1e6)
			if resumable.steady < 0.9*direct.steady {
				t.Fatalf("%s: a resumable stream carried %.1f MB/s, %.0f %% of a direct connection over the same link (%.1f MB/s); the gate is 90 %%",
					direction, resumable.steady/1e6, 100*resumable.steady/direct.steady, direct.steady/1e6)
			}
		})
	}
}

// rtPhasedBackend serves a stream in two parts: phase1 bytes first, then,
// once the test let it (a token on gate), size bytes, timed after warmup of
// them. For an upload it counts what arrived (received, from zero for each
// stream), so the test knows when the first part is through.
type rtPhasedBackend struct {
	listener net.Listener
	download bool
	phase1   int64
	size     int64
	warmup   int64
	block    []byte
	received atomic.Int64
	gate     chan struct{}
	done     chan rtTiming
}

const rtPhase1 = 32 << 20

func startRTPhasedBackend(tb testing.TB, download bool, size, warmup int64) *rtPhasedBackend {
	tb.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	backend := &rtPhasedBackend{listener: listener, download: download, phase1: rtPhase1, size: size, warmup: warmup,
		block: make([]byte, 256<<10), gate: make(chan struct{}, 1), done: make(chan rtTiming, 1)}
	go backend.serve()
	tb.Cleanup(func() { _ = listener.Close() })
	return backend
}

func (b *rtPhasedBackend) serve() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			if !b.download {
				var timing rtTiming
				buffer := make([]byte, 256<<10)
				for {
					n, err := conn.Read(buffer)
					got := b.received.Add(int64(n))
					if timing.warm.IsZero() && got >= b.phase1+b.warmup {
						timing.warm = time.Now()
					}
					if err != nil {
						timing.end = time.Now()
						b.done <- timing
						return
					}
				}
			}
			write := func(size int64) bool {
				for sent := int64(0); sent < size; {
					n := min(int64(len(b.block)), size-sent)
					if _, err := conn.Write(b.block[:n]); err != nil {
						return false
					}
					sent += n
				}
				return true
			}
			if !write(b.phase1) {
				return
			}
			<-b.gate
			if !write(b.size) {
				return
			}
			_ = conn.(*net.TCPConn).CloseWrite()
			_, _ = io.Copy(io.Discard, conn)
		}()
	}
}

// phasedTransfer runs one resumable stream that first carries phase1 bytes
// with the legs at lanOneWay, then size bytes after the legs' delay became
// oneWay; it reports the second part.
func (r *rtRig) phasedTransfer(lanOneWay, oneWay time.Duration) (rtResult, error) {
	r.setLegDelay(lanOneWay)
	r.phased.received.Store(0)
	local, app, err := rtTCPPair()
	if err != nil {
		return rtResult{}, err
	}
	defer app.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, err := r.phasedSource.dial(ctx, relayresume.DialRequest{})
	if err != nil {
		return rtResult{}, err
	}
	session, err := r.phasedSource.manager.NewSource(r.phasedSource.config(0), first)
	if err != nil {
		return rtResult{}, err
	}
	bridged := make(chan error, 1)
	go func() {
		bridged <- relaybridge.BridgeWithChunk(ctx, local, session, session.MaxFrame(), relayresume.ReadChunk(r.chunk), session.Cancel)
	}()
	var timing rtTiming
	var started time.Time
	// Between the parts the stream pauses, as a connection between two
	// requests does; then the route is longer.
	const pause = 300 * time.Millisecond
	if r.phased.download {
		if _, err := io.CopyN(io.Discard, app, r.phased.phase1); err != nil {
			return rtResult{}, fmt.Errorf("first part: %w", err)
		}
		time.Sleep(pause)
		r.setLegDelay(oneWay)
		started = time.Now()
		r.phased.gate <- struct{}{}
		var got int64
		timing, got = rtReceive(app, r.warmup)
		if got != r.size {
			return rtResult{}, fmt.Errorf("phased download: %d of %d bytes", got, r.size)
		}
		_ = app.(*net.TCPConn).CloseWrite()
	} else {
		block := make([]byte, 256<<10)
		send := func(size int64) error {
			for sent := int64(0); sent < size; {
				n := min(int64(len(block)), size-sent)
				if _, err := app.Write(block[:n]); err != nil {
					return err
				}
				sent += n
			}
			return nil
		}
		if err := send(r.phased.phase1); err != nil {
			return rtResult{}, err
		}
		deadline := time.Now().Add(30 * time.Second)
		for r.phased.received.Load() < r.phased.phase1 {
			if time.Now().After(deadline) {
				return rtResult{}, errors.New("the first part did not arrive")
			}
			time.Sleep(time.Millisecond)
		}
		time.Sleep(pause)
		r.setLegDelay(oneWay)
		started = time.Now()
		if err := send(r.size); err != nil {
			return rtResult{}, err
		}
		_ = app.(*net.TCPConn).CloseWrite()
		if _, err := io.Copy(io.Discard, app); err != nil {
			return rtResult{}, err
		}
		select {
		case timing = <-r.phased.done:
		case <-time.After(10 * time.Second):
			return rtResult{}, errors.New("the backend reported no upload")
		}
	}
	if err := <-bridged; err != nil && !errors.Is(err, context.Canceled) {
		return rtResult{}, fmt.Errorf("phased bridge: %w", err)
	}
	result := rtResult{whole: float64(r.size) / timing.end.Sub(started).Seconds()}
	if !timing.warm.IsZero() && timing.end.After(timing.warm) {
		result.steady = float64(r.size-r.warmup) / timing.end.Sub(timing.warm).Seconds()
	}
	return result, nil
}

// TestSecureLinkThroughputAfterTheRoundTripGrows: the gate's link, but the
// relay legs start as a LAN and their round trip grows to the gate's under
// the lanes (stand rc.7 F-5). A stream opened after that, and a stream that
// carried a LAN transfer before it, carry at least 90 % of a direct
// connection over the longer link once ramped up.
func TestSecureLinkThroughputAfterTheRoundTripGrows(t *testing.T) {
	if testing.Short() {
		t.Skip("throughput gate: not in -short")
	}
	for _, download := range []bool{false, true} {
		direction := map[bool]string{false: "upload", true: "download"}[download]
		t.Run(direction, func(t *testing.T) {
			rig := newRTRig(t, download, gateSize, gateWarmup, gateRTT/4, gateRate, relaybridge.DefaultChunkBytes)
			var direct rtResult
			for range 2 {
				result, err := rig.transfer("direct")
				if err != nil {
					t.Fatalf("%s direct: %v", direction, err)
				}
				direct.steady = max(direct.steady, result.steady)
			}
			// LAN traffic over the lanes first.
			rig.setLegDelay(0)
			if _, err := rig.transfer("resumable"); err != nil {
				t.Fatalf("%s LAN: %v", direction, err)
			}
			rig.setLegDelay(gateRTT / 4)
			var fresh rtResult
			for range 3 {
				result, err := rig.transfer("resumable")
				if err != nil {
					t.Fatalf("%s after the round trip grew: %v", direction, err)
				}
				if result.steady > fresh.steady {
					fresh = result
				}
				if fresh.steady >= 0.95*gateRate {
					break
				}
			}
			var kept rtResult
			for range 3 {
				result, err := rig.phasedTransfer(0, gateRTT/4)
				if err != nil {
					t.Fatalf("%s one stream, LAN then the longer round trip: %v", direction, err)
				}
				if result.steady > kept.steady {
					kept = result
				}
				if kept.steady >= 0.95*gateRate {
					break
				}
			}
			t.Logf("%s over %.0f MB/s, %v after a LAN: direct %.1f MB/s, new stream %.1f MB/s, stream kept from the LAN %.1f MB/s", direction,
				gateRate/1e6, gateRTT, direct.steady/1e6, fresh.steady/1e6, kept.steady/1e6)
			for name, result := range map[string]rtResult{"a stream opened after the round trip grew": fresh, "a stream kept from the LAN": kept} {
				if result.steady < 0.9*direct.steady {
					t.Errorf("%s: %s carried %.1f MB/s, %.0f %% of a direct connection over the same link (%.1f MB/s); the gate is 90 %%",
						direction, name, result.steady/1e6, 100*result.steady/direct.steady, direct.steady/1e6)
				}
			}
		})
	}
}

// BenchmarkSecureLinkRTT reports MB/s per direction and mode over the gate's
// link (RTT_MS, RATE_MBPS, SIZE_MB override it).
func BenchmarkSecureLinkRTT(b *testing.B) {
	rtt := time.Duration(rtEnv("RTT_MS", int(gateRTT/time.Millisecond))) * time.Millisecond
	rate := float64(rtEnv("RATE_MBPS", int(gateRate/1e6))) * 1e6
	size := int64(rtEnv("SIZE_MB", gateSize>>20)) << 20
	for _, download := range []bool{false, true} {
		for _, mode := range []string{"direct", "raw", "resumable"} {
			name := map[bool]string{false: "upload", true: "download"}[download] + "/" + mode
			b.Run(name, func(b *testing.B) {
				rig := newRTRig(b, download, size, size/4, rtt/4, rate, relaybridge.DefaultChunkBytes)
				b.SetBytes(size)
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if _, err := rig.transfer(mode); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

// TestSecureLinkThroughputMatrix prints MB/s and CPU per GiB for each mode and
// direction on the link given by RTT_MS (stream round trip, 0: no proxies),
// RATE_MBPS (link rate, 0 unlimited), SIZE_MB, ROUNDS, RTT_CHUNK (the
// bridges' read size), MODES and DIRECTIONS. Exploration aid:
// RELAY_RTT_MATRIX=1.
func TestSecureLinkThroughputMatrix(t *testing.T) {
	if os.Getenv("RELAY_RTT_MATRIX") == "" {
		t.Skip("set RELAY_RTT_MATRIX=1")
	}
	rtt := time.Duration(rtEnv("RTT_MS", 40)) * time.Millisecond
	rate := float64(rtEnv("RATE_MBPS", 0)) * 1e6
	size := int64(rtEnv("SIZE_MB", 128)) << 20
	rounds := max(1, rtEnv("ROUNDS", 3))
	chunk := rtEnv("RTT_CHUNK", relaybridge.DefaultChunkBytes)
	modes := []string{"direct", "raw", "resumable"}
	if value := os.Getenv("MODES"); value != "" {
		modes = strings.Split(value, ",")
	}
	for _, download := range []bool{false, true} {
		direction := map[bool]string{false: "upload", true: "download"}[download]
		if value := os.Getenv("DIRECTIONS"); value != "" && !slices.Contains(strings.Split(value, ","), direction) {
			continue
		}
		rig := newRTRig(t, download, size, size/4, rtt/4, rate, chunk)
		for _, mode := range modes {
			var whole, steady []float64
			cpu := rtCPU()
			for round := 0; round < rounds; round++ {
				result, err := rig.transfer(mode)
				if err != nil {
					t.Fatalf("%s %s: %v", direction, mode, err)
				}
				whole, steady = append(whole, result.whole/1e6), append(steady, result.steady/1e6)
			}
			perGiB := (rtCPU() - cpu).Seconds() / (float64(int64(rounds)*size) / (1 << 30))
			slices.Sort(whole)
			slices.Sort(steady)
			t.Logf("rtt %v rate %.0f MB/s chunk %d %s %-9s: median %.1f MB/s (steady %.1f), %.2f CPU-s/GiB %.1f", rtt, rate/1e6, chunk, direction, mode,
				whole[len(whole)/2], steady[len(steady)/2], perGiB, whole)
		}
	}
}
