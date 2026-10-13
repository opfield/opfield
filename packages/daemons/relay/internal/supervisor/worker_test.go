package supervisor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
)

const testRelayServerIdentity = "relay-server.test"

// fakeWorkerAdmin answers for the fake worker processes: they record the
// version they run in a marker file while they are alive.
type fakeWorkerAdmin struct {
	relayv1.UnimplementedRelayAdminServer
	marker string
}

func (a *fakeWorkerAdmin) GetHealth(context.Context, *relayv1.HealthRequest) (*relayv1.HealthResponse, error) {
	version, err := os.ReadFile(a.marker)
	if err != nil {
		return nil, status.Error(codes.Unavailable, "relay worker is not running")
	}
	return &relayv1.HealthResponse{
		BuildVersion: strings.TrimSpace(string(version)), Readiness: true, PolicyKeyIds: []string{"policy-key"},
	}, nil
}

type workerUpdateHarness struct {
	plugin  *Plugin
	worker  *workerManager
	dir     string
	staged  string
	started string
}

// newWorkerUpdateHarness runs a worker binary that reports v1 and stages one
// that reports v2. The v2 binary reports v1 for its first staleStarts starts.
func newWorkerUpdateHarness(t *testing.T, staleStarts int) *workerUpdateHarness {
	t.Helper()
	ca := newTestCA(t)
	serverCert, serverKey := ca.issue(t, testRelayServerIdentity, x509.ExtKeyUsageServerAuth, time.Now().Add(time.Hour))
	adminCert, adminKey := ca.issue(t, "relay-supervisor", x509.ExtKeyUsageClientAuth, time.Now().Add(time.Hour))
	identityDir := workerIdentityDir(t, ca, serverCert, serverKey, adminCert, adminKey)
	stateDir := t.TempDir()
	encoded, _ := json.Marshal(enrollmentState{PoolID: "pool", InstanceID: "instance", RelayServerIdentity: testRelayServerIdentity})
	if err := os.WriteFile(filepath.Join(stateDir, "enrollment.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	marker := filepath.Join(dir, "running")
	serverPair, err := tls.X509KeyPair(serverCert, serverKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca.pem)
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverPair},
		ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert,
	})))
	relayv1.RegisterRelayAdminServer(server, &fakeWorkerAdmin{marker: marker})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	h := &workerUpdateHarness{dir: dir, started: filepath.Join(dir, "started")}
	binaryPath := filepath.Join(dir, "relay-worker")
	h.writeWorker(t, binaryPath, "v1", 0)
	h.staged = filepath.Join(dir, "relay-worker.v2")
	h.writeWorker(t, h.staged, "v2", staleStarts)

	cfg := &config.Config{Worker: config.WorkerConfig{
		BinaryPath: binaryPath, IdentityDir: identityDir, StateDir: t.TempDir(),
		ServicePort: listener.Addr().(*net.TCPAddr).Port,
	}}
	cfg.StateDir = stateDir
	h.worker = newWorkerManager(cfg.Worker, stateDir)
	h.plugin = &Plugin{cfg: cfg, worker: h.worker, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	t.Cleanup(h.worker.shutdown)
	if err := h.worker.ensureRunning(); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(marker); err == nil {
			break
		} else if time.Now().After(deadline) {
			t.Fatal("the fake relay worker did not start")
		}
	}
	return h
}

func (h *workerUpdateHarness) writeWorker(t *testing.T, path, version string, staleStarts int) {
	t.Helper()
	script := fmt.Sprintf(`#!/bin/sh
echo %[2]s >> '%[1]s/started'
reported=%[2]s
if [ "$(grep -cx %[2]s '%[1]s/started')" -le %[3]d ]; then reported=v1; fi
trap 'rm -f "%[1]s/running"; kill "$child" 2>/dev/null; exit 0' TERM
printf '%%s' "$reported" > '%[1]s/running.tmp' && mv '%[1]s/running.tmp' '%[1]s/running'
sleep 60 &
child=$!
wait "$child"
`, h.dir, version, staleStarts)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// update runs a worker update whose download takes a while, during which
// the supervisor keeps sending its status reports, as it does every 5 s.
func (h *workerUpdateHarness) update(t *testing.T) error {
	t.Helper()
	h.worker.replaceBinary = func(_, _, _, _, _, destination string, _ *slog.Logger) error {
		time.Sleep(600 * time.Millisecond)
		return os.Rename(h.staged, destination)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var reports sync.WaitGroup
	reports.Add(1)
	go func() {
		defer reports.Done()
		for ctx.Err() == nil {
			h.plugin.collectRuntime(ctx)
			time.Sleep(20 * time.Millisecond)
		}
	}()
	err := h.worker.update(context.Background(), "", "v2", "", "", h.plugin.logger)
	cancel()
	reports.Wait()
	return err
}

func (h *workerUpdateHarness) starts(t *testing.T) []string {
	t.Helper()
	content, err := os.ReadFile(h.started)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(content))
}

// Regression: the worker was stopped before its download, and a status report
// in that window started the previous binary again. The update then found a
// running worker on the previous version and failed after 30 s.
func TestWorkerUpdateKeepsStatusReportsFromStartingThePreviousBinary(t *testing.T) {
	h := newWorkerUpdateHarness(t, 0)

	if err := h.update(t); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if got := h.starts(t); strings.Join(got, " ") != "v1 v2" {
		t.Fatalf("worker starts = %v, want the previous worker once and then the updated one", got)
	}
	health, err := h.worker.health(context.Background())
	if err != nil || health.GetBuildVersion() != "v2" {
		t.Fatalf("worker after the update reports %q (%v), want v2", health.GetBuildVersion(), err)
	}
}

func TestWorkerUpdateRestartsAWorkerStillOnThePreviousVersionOnce(t *testing.T) {
	h := newWorkerUpdateHarness(t, 1)

	if err := h.update(t); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if got := h.starts(t); strings.Join(got, " ") != "v1 v2 v2" {
		t.Fatalf("worker starts = %v, want one restart of the updated worker", got)
	}
}

// Opfield dispatches the update again on this message.
func TestWorkerUpdateReportsTheVersionTheWorkerKeepsRunning(t *testing.T) {
	h := newWorkerUpdateHarness(t, 2)

	err := h.update(t)
	if err == nil || !strings.HasSuffix(err.Error(), "worker reported version v1, expected v2") {
		t.Fatalf("update error = %v, want the version mismatch", err)
	}
	if got := h.starts(t); strings.Join(got, " ") != "v1 v2 v2" {
		t.Fatalf("worker starts = %v, want a single restart before the update fails", got)
	}
}

func TestFailedWorkerDownloadLeavesTheRunningWorker(t *testing.T) {
	h := newWorkerUpdateHarness(t, 0)
	h.worker.replaceBinary = func(_, _, _, _, _, _ string, _ *slog.Logger) error {
		return fmt.Errorf("checksum mismatch")
	}

	if err := h.worker.update(context.Background(), "", "v2", "", "", h.plugin.logger); err == nil {
		t.Fatal("update succeeded without a binary")
	}
	if got := h.starts(t); strings.Join(got, " ") != "v1" {
		t.Fatalf("worker starts = %v, want the previous worker left running", got)
	}
	health, err := h.worker.health(context.Background())
	if err != nil || health.GetBuildVersion() != "v1" {
		t.Fatalf("worker after a failed download reports %q (%v), want v1", health.GetBuildVersion(), err)
	}
}
