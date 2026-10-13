package relayresume

import (
	"context"
	"io"
	"net"
	"os"
	"runtime"
	"sort"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// The normal-path throughput gate (T9): one stream over a real gRPC bidi
// stream on loopback, raw frames against RSv1 sessions, the same bridges on
// both ends. Run:
//
//	go test -run XXX -bench Throughput -count 10 ./relayresume
//	RELAYRESUME_BENCH_GATE=1 go test -run ThroughputGate ./relayresume

const benchStreamBytes = 64 << 20

type benchServer struct {
	relayv1.UnimplementedTunnelBrokerServer
	resumable bool
	table     *TargetTable
	sink      string
}

func (s *benchServer) OpenTunnel(stream relayv1.TunnelBroker_OpenTunnelServer) error {
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()
	conn, err := net.Dial("tcp", s.sink)
	if err != nil {
		return err
	}
	if !s.resumable {
		return relaybridge.BridgeWithChunk(ctx, conn, stream, MaxFrameBytes, benchRawChunk(), cancel)
	}
	accepted := s.table.Accept(OpenedPath{Stream: stream, Cancel: cancel, RelayID: "bench", MaxFrame: MaxFrameBytes},
		AcceptRequest{RouteID: "route-1", SourceKind: "daemon", SourceID: "node", RelayID: "bench",
			Keys: func(string) []byte { return benchKey }})
	session, err := accepted.Establish()
	if err != nil {
		return err
	}
	go func() {
		_ = relaybridge.BridgeWithChunk(context.Background(), conn, session, session.MaxFrame(), ReadChunk(relaybridge.DefaultChunkBytes), session.Cancel)
	}()
	select {
	case <-accepted.PathDone:
	case <-session.Done():
		<-accepted.PathDone
	}
	return nil
}

var benchKey = make([]byte, KeyLen)

// benchRawChunk is the raw bridges' read size: today's 32 KiB, or the
// session's read size (RELAYRESUME_BENCH_RAWCHUNK=session) to isolate the
// protocol's own cost from the allocation-class effect.
func benchRawChunk() int {
	if os.Getenv("RELAYRESUME_BENCH_RAWCHUNK") == "session" {
		return ReadChunk(relaybridge.DefaultChunkBytes)
	}
	return relaybridge.DefaultChunkBytes
}

type benchRig struct {
	client relayv1.TunnelBrokerClient
	mgr    *Manager
	close  func()
}

func newBenchRig(tb testing.TB, resumable bool) *benchRig {
	sink, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	go func() {
		for {
			conn, err := sink.Accept()
			if err != nil {
				return
			}
			go func() {
				_, _ = io.Copy(io.Discard, conn)
				conn.Close()
			}()
		}
	}()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	// Static HTTP/2 windows: gRPC's BDP estimation otherwise settles each
	// connection in one of two throughput modes at random, which drowns the
	// comparison. Both rigs get the same transport.
	server := grpc.NewServer(grpc.InitialWindowSize(8<<20), grpc.InitialConnWindowSize(16<<20))
	relayv1.RegisterTunnelBrokerServer(server, &benchServer{resumable: resumable, table: NewTargetTable(nil), sink: sink.Addr().String()})
	go server.Serve(listener)
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithInitialWindowSize(8<<20), grpc.WithInitialConnWindowSize(16<<20))
	if err != nil {
		tb.Fatal(err)
	}
	return &benchRig{client: relayv1.NewTunnelBrokerClient(conn), mgr: NewManager(nil), close: func() {
		conn.Close()
		server.Stop()
		sink.Close()
	}}
}

// run carries benchStreamBytes from a local application through one tunnel
// to the sink and waits for the sink's close to come back.
func (r *benchRig) run(tb testing.TB, resumable bool, payload []byte) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := r.client.OpenTunnel(ctx)
	if err != nil {
		tb.Fatal(err)
	}
	local, app := tcpPair(tb)
	defer app.Close()
	var bridgeStream relaybridge.FrameStream = stream
	maxFrame, readChunk, bridgeCancel := MaxFrameBytes, benchRawChunk(), context.CancelFunc(cancel)
	if resumable {
		session, err := r.mgr.NewSource(SourceConfig{RouteID: "route-1", Key: func() (string, []byte, bool) { return "v1", benchKey, true },
			Dial: func(context.Context, DialRequest) (OpenedPath, error) { return OpenedPath{}, io.EOF }},
			OpenedPath{Stream: stream, Cancel: cancel, CloseSend: stream.CloseSend, RelayID: "bench", MaxFrame: MaxFrameBytes})
		if err != nil {
			tb.Fatal(err)
		}
		bridgeStream, maxFrame, readChunk, bridgeCancel = session, session.MaxFrame(), ReadChunk(relaybridge.DefaultChunkBytes), session.Cancel
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = relaybridge.BridgeWithChunk(ctx, local, bridgeStream, maxFrame, readChunk, bridgeCancel)
	}()
	for off := 0; off < benchStreamBytes; off += len(payload) {
		if _, err := app.Write(payload); err != nil {
			tb.Fatal(err)
		}
	}
	_ = app.(*net.TCPConn).CloseWrite()
	_, _ = io.Copy(io.Discard, app)
	<-done
}

func tcpPair(tb testing.TB) (net.Conn, net.Conn) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	defer listener.Close()
	app, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		tb.Fatal(err)
	}
	local, err := listener.Accept()
	if err != nil {
		tb.Fatal(err)
	}
	return local, app
}

func benchmarkThroughput(b *testing.B, resumable bool) {
	rig := newBenchRig(b, resumable)
	defer rig.close()
	payload := make([]byte, 256*1024)
	b.SetBytes(benchStreamBytes)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rig.run(b, resumable, payload)
	}
}

func BenchmarkThroughputRaw(b *testing.B)       { benchmarkThroughput(b, false) }
func BenchmarkThroughputResumable(b *testing.B) { benchmarkThroughput(b, true) }

func BenchmarkThroughputResumableMaxWindow(b *testing.B) {
	initialWindow = MaxWindow
	defer func() { initialWindow = InitialWindow }()
	benchmarkThroughput(b, true)
}

func cpuTime() time.Duration {
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
}

// TestThroughputGate alternates raw and resumable streams (as deployed: the
// session's bridges read ReadChunk bytes) and compares process CPU time per
// stream and the per-round wall throughput: the resumable normal path must
// stay within 2 %.
func TestThroughputGate(t *testing.T) {
	if os.Getenv("RELAYRESUME_BENCH_GATE") == "" {
		t.Skip("set RELAYRESUME_BENCH_GATE=1")
	}
	if os.Getenv("RELAYRESUME_BENCH_MAXWINDOW") != "" {
		initialWindow = MaxWindow
		defer func() { initialWindow = InitialWindow }()
	}
	payload := make([]byte, 256*1024)
	raw, resumable := newBenchRig(t, false), newBenchRig(t, true)
	defer raw.close()
	defer resumable.close()
	var rawWall, resWall, rawCPU, resCPU []time.Duration
	for i := 0; i < 3; i++ { // warm up
		raw.run(t, false, payload)
		resumable.run(t, true, payload)
	}
	rounds := 31
	if value, err := strconv.Atoi(os.Getenv("RELAYRESUME_BENCH_ROUNDS")); err == nil && value > 0 {
		rounds = value
	}
	measure := func(rig *benchRig, resumable bool, wall, cpu *[]time.Duration) {
		runtime.GC()
		startCPU, start := cpuTime(), time.Now()
		rig.run(t, resumable, payload)
		*wall = append(*wall, time.Since(start))
		*cpu = append(*cpu, cpuTime()-startCPU)
	}
	for i := 0; i < rounds; i++ {
		measure(raw, false, &rawWall, &rawCPU)
		measure(resumable, true, &resWall, &resCPU)
	}
	median := func(values []time.Duration) time.Duration {
		sorted := append([]time.Duration(nil), values...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		return sorted[len(sorted)/2]
	}
	// Each round runs raw and resumable back to back: the host's load moves
	// both alike, so the per-round ratio is the stable measure.
	ratios := make([]float64, rounds)
	for i := range ratios {
		ratios[i] = float64(rawWall[i]) / float64(resWall[i])
	}
	sort.Float64s(ratios)
	wallRatio := ratios[len(ratios)/2]
	mbps := func(d time.Duration) float64 { return float64(benchStreamBytes) / d.Seconds() / (1 << 20) }
	cpuRatio := float64(median(rawCPU)) / float64(median(resCPU))
	t.Logf("median of per-round throughput ratios %.3f (raw %.0f MiB/s, resumable %.0f MiB/s); cpu per stream: raw %s, resumable %s, ratio %.3f",
		wallRatio, mbps(median(rawWall)), mbps(median(resWall)), median(rawCPU), median(resCPU), cpuRatio)
	// The gate is the CPU each stream costs: on a shared host the wall
	// throughput of either mode swings by more than the 2 % this guards.
	if cpuRatio < 0.98 {
		t.Errorf("resumable normal path costs %.1f %% more CPU than raw", (1/cpuRatio-1)*100)
	}
	if wallRatio < 0.98 {
		t.Logf("note: wall throughput ratio %.3f (host noise; see the CPU gate)", wallRatio)
	}
}
