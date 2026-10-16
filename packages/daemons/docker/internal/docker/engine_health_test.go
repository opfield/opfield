package docker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// shortSocketDir is a directory for unix sockets: t.TempDir() paths can pass
// the 108-byte limit of a socket path.
func shortSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "eh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// refusingSocket is a socket file nothing listens on any more: what a
// crashed containerd leaves, connect fails with "connection refused".
func refusingSocket(t *testing.T) string {
	t.Helper()
	path := filepath.Join(shortSocketDir(t), "containerd.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// healthServer is a containerd stand-in: a gRPC health service on a socket.
func healthServer(t *testing.T, serving healthpb.HealthCheckResponse_ServingStatus) (string, *health.Server) {
	t.Helper()
	path := filepath.Join(shortSocketDir(t), "containerd.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	status := health.NewServer()
	status.SetServingStatus("", serving)
	healthpb.RegisterHealthServer(server, status)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return path, status
}

func testProber(address string, pingErr error) *engineProber {
	prober := newEngineProber("unix:///var/run/docker.sock",
		func(context.Context) error { return pingErr },
		func(context.Context) (string, error) { return address, nil })
	prober.defaultSockets = nil
	prober.pingTimeout = time.Second
	prober.checkTimeout = 2 * time.Second
	return prober
}

// app-node-1 (F-12): dockerd answered, containerd crash-looped and its socket
// refused every connection; the node looked fine for a day.
func TestEngineProbeReportsAContainerdThatRefusesConnections(t *testing.T) {
	socket := refusingSocket(t)
	result := testProber(socket, nil).probe(context.Background(), time.Now())
	if result.available || result.component != "containerd" {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.problem, socket) || !strings.Contains(result.problem, "connection refused") || strings.Count(result.problem, ". ") > 0 {
		t.Fatalf("problem = %q", result.problem)
	}
	// Docker before API 1.46 names no address: the usual socket is checked.
	prober := testProber("", nil)
	prober.defaultSockets = []string{filepath.Join(filepath.Dir(socket), "missing.sock"), socket}
	if result := prober.probe(context.Background(), time.Now()); result.available || result.component != "containerd" {
		t.Fatalf("default socket result = %+v", result)
	}
	// A stale socket file of a containerd no longer in use does not hide the
	// one dockerd runs with, and a socket it may not open is never "known".
	serving, _ := healthServer(t, healthpb.HealthCheckResponse_SERVING)
	prober = testProber("", nil)
	prober.defaultSockets = []string{socket, serving}
	if result := prober.probe(context.Background(), time.Now()); !result.available || prober.lastGood != serving {
		t.Fatalf("stale and live socket: %+v, last good %q", result, prober.lastGood)
	}
}

func TestEngineProbeAsksContainerdsHealthService(t *testing.T) {
	socket, status := healthServer(t, healthpb.HealthCheckResponse_SERVING)
	prober := testProber(socket, nil)
	if result := prober.probe(context.Background(), time.Now()); !result.available || result.component != "" || result.problem != "" {
		t.Fatalf("serving result = %+v", result)
	}
	status.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
	result := prober.probe(context.Background(), time.Now())
	if result.available || result.component != "containerd" || !strings.Contains(result.problem, "NOT_SERVING") || !strings.Contains(result.problem, socket) {
		t.Fatalf("not serving result = %+v", result)
	}
}

func TestEngineProbeReportsDockerdThatDoesNotAnswer(t *testing.T) {
	socket, _ := healthServer(t, healthpb.HealthCheckResponse_SERVING)
	result := testProber(socket, errors.New("docker ping: Cannot connect to the Docker daemon")).probe(context.Background(), time.Now())
	if result.available || result.component != "dockerd" || !strings.Contains(result.problem, "/var/run/docker.sock") || !strings.Contains(result.problem, "Cannot connect") {
		t.Fatalf("result = %+v", result)
	}
}

// A socket that is gone counts only when it is known to be containerd's:
// dockerd named it, or it answered before. Without any known socket nothing is
// claimed, and a socket this daemon may not open (rootless Docker, a non-root
// daemon) says nothing about containerd.
func TestEngineProbeClaimsOnlyWhatItKnows(t *testing.T) {
	dir := shortSocketDir(t)
	missing := filepath.Join(dir, "gone.sock")
	result := testProber(missing, nil).probe(context.Background(), time.Now())
	if result.available || result.component != "containerd" || !strings.Contains(result.problem, missing+" is gone") {
		t.Fatalf("named socket missing: %+v", result)
	}
	if result := testProber("", nil).probe(context.Background(), time.Now()); !result.available || result.component != "" {
		t.Fatalf("no socket known: %+v", result)
	}

	// A socket that answered once and is gone now.
	socket, _ := healthServer(t, healthpb.HealthCheckResponse_SERVING)
	prober := testProber("", nil)
	prober.defaultSockets = []string{socket}
	if result := prober.probe(context.Background(), time.Now()); !result.available {
		t.Fatalf("first probe: %+v", result)
	}
	prober.defaultSockets = nil
	prober.lastGood = missing
	if result := prober.probe(context.Background(), time.Now()); result.available {
		t.Fatalf("a socket that answered before is gone: %+v", result)
	}

	denied := testProber(socket, nil)
	denied.dial = func(context.Context, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "unix", Err: os.NewSyscallError("connect", syscall.EACCES)}
	}
	if result := denied.probe(context.Background(), time.Now()); !result.available || result.component != "" {
		t.Fatalf("permission denied: %+v", result)
	}
	deniedDefault := testProber("", nil)
	deniedDefault.defaultSockets = []string{socket}
	deniedDefault.dial = denied.dial
	if result := deniedDefault.probe(context.Background(), time.Now()); !result.available || deniedDefault.lastGood != "" {
		t.Fatalf("permission denied on a usual socket: %+v, last good %q", result, deniedDefault.lastGood)
	}
}

// The address dockerd reports is kept and looked up again only now and then;
// a failed lookup keeps the last one.
func TestEngineProbeCachesTheContainerdAddress(t *testing.T) {
	socket, _ := healthServer(t, healthpb.HealthCheckResponse_SERVING)
	lookups := 0
	prober := testProber("", nil)
	prober.containerdAddress = func(context.Context) (string, error) {
		lookups++
		if lookups > 1 {
			return "", errors.New("info failed")
		}
		return "unix://" + socket, nil
	}
	now := time.Now()
	for i := 0; i < 3; i++ {
		if result := prober.probe(context.Background(), now.Add(time.Duration(i)*engineHealthInterval)); !result.available {
			t.Fatalf("probe %d: %+v", i, result)
		}
	}
	if lookups != 1 || prober.address != socket {
		t.Fatalf("lookups = %d, address = %q", lookups, prober.address)
	}
	if result := prober.probe(context.Background(), now.Add(containerdAddressRefresh+time.Second)); !result.available || lookups != 2 || prober.address != socket {
		t.Fatalf("after a failed lookup: %+v, lookups %d, address %q", result, lookups, prober.address)
	}
}

func TestEngineHealthTracksUnavailableSinceAndFlips(t *testing.T) {
	var h engineHealth
	if h.report() != nil {
		t.Fatal("a report before the first probe")
	}
	start := time.UnixMilli(1_760_000_000_000)
	if h.record(engineProbeResult{available: true}, start) {
		t.Fatal("an available first result is no flip")
	}
	down := engineProbeResult{component: "containerd", problem: "containerd does not answer"}
	if !h.record(down, start.Add(20*time.Second)) {
		t.Fatal("going down is a flip")
	}
	if h.record(down, start.Add(40*time.Second)) {
		t.Fatal("staying down is no flip")
	}
	report := h.report()
	if report.Available || report.Component != "containerd" || report.Problem != down.problem ||
		report.UnavailableSinceUnixMs != start.Add(20*time.Second).UnixMilli() || report.CheckedAtUnixMs != start.Add(40*time.Second).UnixMilli() {
		t.Fatalf("report = %+v", report)
	}
	if !h.record(engineProbeResult{available: true}, start.Add(60*time.Second)) {
		t.Fatal("coming back is a flip")
	}
	if report := h.report(); !report.Available || report.UnavailableSinceUnixMs != 0 || report.Component != "" || report.Problem != "" {
		t.Fatalf("report = %+v", report)
	}
	var fresh engineHealth
	if !fresh.record(down, start) {
		t.Fatal("an unavailable first result is a flip")
	}
}

// A flip asks for a health report at once, and the report carries the result
// also when dockerd does not answer (the early return of CollectHealth).
func TestCollectHealthCarriesEngineHealthWhenDockerdDoesNotAnswer(t *testing.T) {
	client, err := NewClient("unix://"+filepath.Join(shortSocketDir(t), "docker.sock"), t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{}
	cfg.StateDir = t.TempDir()
	p := NewDockerPlugin(cfg)
	p.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	p.client = client
	p.observeEngineHealth(engineProbeResult{component: "dockerd", problem: "dockerd does not answer"}, time.Now())
	select {
	case <-p.HealthRefreshRequested():
	default:
		t.Fatal("no health report was asked for")
	}
	report := p.CollectHealth(&pb.HealthReport{})
	if report.DockerEngineHealth == nil || report.DockerEngineHealth.Available || report.DockerEngineHealth.Component != "dockerd" {
		t.Fatalf("engine health = %+v", report.DockerEngineHealth)
	}
	if report.ContainersTotal != 0 {
		t.Fatalf("containers = %d", report.ContainersTotal)
	}
}
