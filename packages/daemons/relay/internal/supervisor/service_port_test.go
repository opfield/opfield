package supervisor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
)

// portWorkerAdmin answers for a fake worker only while one runs with
// RELAY_PORT set to its own port: the fake worker writes that port to the
// marker file while it is alive.
type portWorkerAdmin struct {
	relayv1.UnimplementedRelayAdminServer
	marker string
	port   int
}

func (a *portWorkerAdmin) GetHealth(context.Context, *relayv1.HealthRequest) (*relayv1.HealthResponse, error) {
	content, err := os.ReadFile(a.marker)
	if err != nil || strings.TrimSpace(string(content)) != strconv.Itoa(a.port) {
		return nil, status.Error(codes.Unavailable, "relay worker is not running on this port")
	}
	return &relayv1.HealthResponse{BuildVersion: "v1", Readiness: true, PolicyKeyIds: []string{"policy-key"}}, nil
}

type servicePortHarness struct {
	worker    *workerManager
	plugin    *Plugin
	dir       string
	oldPort   int
	persisted []int
}

// newServicePortHarness runs a fake worker on oldPort. Each port in
// servingPorts gets an admin endpoint that answers once a worker started on
// it; a port without one never becomes ready.
func newServicePortHarness(t *testing.T, servingPorts ...int) *servicePortHarness {
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
	for _, port := range servingPorts {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverPair},
			ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert,
		})))
		relayv1.RegisterRelayAdminServer(server, &portWorkerAdmin{marker: marker, port: port})
		go func() { _ = server.Serve(listener) }()
		t.Cleanup(server.Stop)
	}
	binaryPath := filepath.Join(dir, "relay-worker")
	script := fmt.Sprintf(`#!/bin/sh
echo "$RELAY_PORT" >> '%[1]s/started'
trap 'rm -f "%[1]s/running"; kill "$child" 2>/dev/null; exit 0' TERM
printf '%%s' "$RELAY_PORT" > '%[1]s/running.tmp' && mv '%[1]s/running.tmp' '%[1]s/running'
sleep 60 &
child=$!
wait "$child"
`, dir)
	if err := os.WriteFile(binaryPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Worker: config.WorkerConfig{
		BinaryPath: binaryPath, IdentityDir: identityDir, StateDir: t.TempDir(), ServicePort: servingPorts[0],
	}}
	cfg.StateDir = stateDir
	h := &servicePortHarness{dir: dir, oldPort: servingPorts[0]}
	h.worker = newWorkerManager(cfg.Worker, stateDir)
	h.worker.checkPort = func(int) error { return nil }
	h.plugin = &Plugin{cfg: cfg, worker: h.worker, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	t.Cleanup(h.worker.shutdown)
	if err := h.worker.waitReadyVersion(context.Background(), "", 5*time.Second); err != nil {
		t.Fatalf("the fake relay worker did not start: %v", err)
	}
	return h
}

func (h *servicePortHarness) persist(port int) error {
	h.persisted = append(h.persisted, port)
	return nil
}

func (h *servicePortHarness) starts(t *testing.T) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(h.dir, "started"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(string(content)), " ")
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func TestServicePortChangeRestartsTheWorkerOnTheNewPort(t *testing.T) {
	oldPort, newPort := freePort(t), freePort(t)
	h := newServicePortHarness(t, oldPort, newPort)

	detail, err := h.worker.changeServicePort(context.Background(), newPort, h.persist, 5*time.Second)
	if err != nil {
		t.Fatalf("port change failed: %v", err)
	}
	if want := fmt.Sprintf("service_port=%d previous_service_port=%d", newPort, oldPort); detail != want {
		t.Fatalf("detail = %q, want %q", detail, want)
	}
	if got := h.worker.servicePort(); got != newPort || h.worker.reportedServicePort() != newPort {
		t.Fatalf("worker port = %d (reported %d), want %d", got, h.worker.reportedServicePort(), newPort)
	}
	if fmt.Sprint(h.persisted) != fmt.Sprint([]int{newPort}) {
		t.Fatalf("persisted ports = %v, want only the new one", h.persisted)
	}
	if got, want := h.starts(t), fmt.Sprintf("%d %d", oldPort, newPort); got != want {
		t.Fatalf("worker starts = %q, want %q", got, want)
	}
	if _, err := h.worker.health(context.Background()); err != nil {
		t.Fatalf("worker on the new port does not answer: %v", err)
	}
	// The runtime status reports the port daemons dial now.
	if got := h.plugin.collectRuntime(context.Background()).GetServicePort(); got != uint32(newPort) {
		t.Fatalf("reported service port = %d, want %d", got, newPort)
	}
}

func TestServicePortChangeMovesBackWhenTheWorkerDoesNotComeUp(t *testing.T) {
	oldPort, deadPort := freePort(t), freePort(t)
	h := newServicePortHarness(t, oldPort)

	_, err := h.worker.changeServicePort(context.Background(), deadPort, h.persist, time.Second)
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("it is back on port %d", oldPort)) {
		t.Fatalf("port change error = %v, want the move back to port %d", err, oldPort)
	}
	if got := h.worker.servicePort(); got != oldPort {
		t.Fatalf("worker port = %d, want the previous %d", got, oldPort)
	}
	if fmt.Sprint(h.persisted) != fmt.Sprint([]int{deadPort, oldPort}) {
		t.Fatalf("persisted ports = %v, want the new one and then the previous one", h.persisted)
	}
	if got, want := h.starts(t), fmt.Sprintf("%d %d %d", oldPort, deadPort, oldPort); got != want {
		t.Fatalf("worker starts = %q, want %q", got, want)
	}
	if _, err := h.worker.health(context.Background()); err != nil {
		t.Fatalf("worker back on the previous port does not answer: %v", err)
	}
}

// Opfield follows the port the status reports; it must not see the port being
// tried before the worker is ready there (stand 2.12.6-rc.1, O-3).
func TestServicePortChangeReportsThePreviousPortUntilTheNewOneServes(t *testing.T) {
	oldPort, deadPort := freePort(t), freePort(t)
	h := newServicePortHarness(t, oldPort)
	done := make(chan error, 1)
	go func() {
		_, err := h.worker.changeServicePort(context.Background(), deadPort, h.persist, time.Second)
		done <- err
	}()
	for {
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("the change to a port where nothing serves succeeded")
			}
			if got := h.worker.reportedServicePort(); got != oldPort {
				t.Fatalf("reported port after the move back = %d, want %d", got, oldPort)
			}
			return
		default:
		}
		if got := h.worker.reportedServicePort(); got != oldPort {
			t.Fatalf("reported port during the change = %d, want the serving %d", got, oldPort)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestServicePortChangeLeavesTheWorkerWhenThePortCannotBeBound(t *testing.T) {
	oldPort, newPort := freePort(t), freePort(t)
	h := newServicePortHarness(t, oldPort, newPort)
	h.worker.checkPort = func(int) error { return errors.New("bind: permission denied") }

	_, err := h.worker.changeServicePort(context.Background(), newPort, h.persist, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("port change error = %v, want the bind failure", err)
	}
	if len(h.persisted) != 0 || h.worker.servicePort() != oldPort {
		t.Fatalf("a refused port was written (%v) or taken (%d)", h.persisted, h.worker.servicePort())
	}
	if got := h.starts(t); got != strconv.Itoa(oldPort) {
		t.Fatalf("worker starts = %q, want the running worker left alone", got)
	}
}

func TestServicePortChangeRejectsANonPort(t *testing.T) {
	h := newServicePortHarness(t, freePort(t))
	for _, port := range []int{0, 65536} {
		if _, err := h.worker.changeServicePort(context.Background(), port, h.persist, time.Second); err == nil {
			t.Fatalf("port %d accepted", port)
		}
	}
	if len(h.persisted) != 0 {
		t.Fatalf("persisted %v for invalid ports", h.persisted)
	}
}

func TestProtectedRelayRefusesAPortChange(t *testing.T) {
	plugin := &Plugin{cfg: &config.Config{Protected: config.ProtectedConfig{Enabled: true}}, configPath: func() string { return "/nonexistent" }}
	result := plugin.HandleCommand(&pb.OpfieldCommand{CommandId: "port", Payload: &pb.OpfieldCommand_SetRelayServicePort{
		SetRelayServicePort: &pb.SetRelayServicePortCommand{ServicePort: 10443}}})
	if result.GetSuccess() || !strings.Contains(result.GetError(), "protected mode") {
		t.Fatalf("protected relay result = %+v, want a protected mode refusal", result)
	}
	if plugin.ProtectedCommandAllowed(&pb.OpfieldCommand{Payload: &pb.OpfieldCommand_SetRelayServicePort{}}) {
		t.Fatal("protected mode lets a port change through")
	}
}

func TestRelayAdvertisesServicePortChanges(t *testing.T) {
	plugin := New(&config.Config{})
	if register := plugin.BuildRegisterMessage("node"); !containsString(register.GetCapabilities(), RelayServicePortCapability) {
		t.Fatalf("registration capabilities = %v, want %s", register.GetCapabilities(), RelayServicePortCapability)
	}
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
