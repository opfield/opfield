//go:build linux

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// stand rc.8 F-3: an hour after a Relay Pool update replaced the secure-link connector, the replaced one was removed
// with every session it still carried. A replaced connector now hands its sessions to its replacement. These tests run
// the sessions a node's workloads hold through a connector (a WebSocket-like duplex stream and an SSE-like push
// through ingress bindings, a database-like duplex stream and a storage-like bulk download through egress listeners,
// a same-node container link through both) and replace the connector twice while every stream carries bytes. Each
// byte is checked in order at both ends, and each stream must end with exactly the bytes written: no stream may be
// cut, reconnected, or lose or double a byte. The replaced connector is killed right after its handover (as the daemon
// removes its container), which must not touch a session.

const (
	handoverTestIngressID = "5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b"
	handoverTestLinkID    = "6f2a3b4c-5d6e-4f70-9b8c-0d1e2f3a4b5c"
	handoverTestBulkID    = "7a3b4c5d-6e7f-4081-8c9d-1e2f3a4b5c6d"
	handoverTestLocalID   = "8b4c5d6e-7f80-4192-9dae-2f3a4b5c6d7e"
	handoverTestLocalIn   = "9c5d6e7f-8091-42a3-8ebf-3a4b5c6d7e8f"
	handoverTestTLSID     = "ad6e7f80-91a2-43b4-9fc0-4b5c6d7e8f90"
	handoverTestUploadID  = "be7f8091-a2b3-44c5-a0d1-5c6d7e8f9001"
	handoverTestTLS12ID   = "cf8091a2-b3c4-45d6-b1e2-6d7e8f900112"
	runConnectorEnv       = "SECURE_LINK_CONNECTOR_TEST_RUN_MAIN"
)

func TestMain(m *testing.M) {
	if os.Getenv(runConnectorEnv) == "1" {
		// A connector process of the cross-process tests.
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// patternFill fills buffer with the stream seed's bytes from position on.
func patternFill(buffer []byte, seed uint64, position int64) {
	for i := range buffer {
		x := (uint64(position)+uint64(i))*0x9E3779B97F4A7C15 ^ seed
		x ^= x >> 31
		buffer[i] = byte(x)
	}
}

// setBuffers fixes a test socket's buffers: the kernel never shrinks a buffer the application set (a 6.17 kernel
// clamps an autotuned receive buffer of a reader that falls behind, and the stream then crawls).
func setBuffers(connection net.Conn) {
	if tcp, ok := connection.(*net.TCPConn); ok {
		_ = tcp.SetReadBuffer(1 << 20)
		_ = tcp.SetWriteBuffer(1 << 20)
	}
}

// writePattern writes total bytes of the stream seed in chunks, pausing pace between them, then half-closes.
func writePattern(connection net.Conn, seed uint64, total int64, chunk int, pace time.Duration) error {
	buffer := make([]byte, chunk)
	for written := int64(0); written < total; {
		n := min(int64(chunk), total-written)
		patternFill(buffer[:n], seed, written)
		if _, err := connection.Write(buffer[:n]); err != nil {
			return fmt.Errorf("write at %d of %d: %w", written, total, err)
		}
		written += n
		if pace > 0 {
			time.Sleep(pace)
		}
	}
	if closer, ok := connection.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// readPattern reads the stream seed and checks every byte, until its end, which must come after exactly total bytes.
// slow, if set, is how long to pause after a read at that position.
func readPattern(connection net.Conn, seed uint64, total int64, slow func(read int64) time.Duration) error {
	buffer := make([]byte, 64*1024)
	want := make([]byte, len(buffer))
	read := int64(0)
	for {
		n, err := connection.Read(buffer)
		if n > 0 {
			if read+int64(n) > total {
				return fmt.Errorf("read %d bytes, more than the %d written", read+int64(n), total)
			}
			patternFill(want[:n], seed, read)
			for i := 0; i < n; i++ {
				if buffer[i] != want[i] {
					return fmt.Errorf("byte %d of %d differs", read+int64(i), total)
				}
			}
			read += int64(n)
			if slow != nil {
				time.Sleep(slow(read))
			}
		}
		if errors.Is(err, io.EOF) {
			if read != total {
				return fmt.Errorf("stream ended after %d of %d bytes", read, total)
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("read after %d of %d bytes: %w", read, total, err)
		}
	}
}

// flowSpec is one session: what the client (the workload, or the daemon's side of an ingress session) and the server
// (the target, or the daemon's egress end) write.
type flowSpec struct {
	name         string
	clientBytes  int64
	serverBytes  int64
	chunk        int
	pace         time.Duration
	clientCloses bool // the client half-closes right after its id (an SSE request)
	slowReader   bool // the client reads slowly at first (a download to a slow consumer)
	slowServer   bool // the server reads slowly at first (an upload to a slow target)
}

func flowSeeds(id uint64) (client, server uint64) { return id*2 + 1, id*2 + 2 }

// serveFlow is the server end of a flow: it reads the flow's id, then reads the client's stream to its end while it
// writes its own, and closes once both are done.
func serveFlow(connection net.Conn, specs *flowSpecs, failures chan<- error) {
	defer connection.Close()
	setBuffers(connection)
	var header [8]byte
	if _, err := io.ReadFull(connection, header[:]); err != nil {
		failures <- fmt.Errorf("server: read flow id: %w", err)
		return
	}
	id := binary.BigEndian.Uint64(header[:])
	spec, ok := specs.get(id)
	if !ok {
		failures <- fmt.Errorf("server: unknown flow %d", id)
		return
	}
	clientSeed, serverSeed := flowSeeds(id)
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		var slow func(int64) time.Duration
		if spec.slowServer {
			started := time.Now()
			slow = func(int64) time.Duration {
				if time.Since(started) < 2500*time.Millisecond {
					return 20 * time.Millisecond
				}
				return 0
			}
		}
		if err := readPattern(connection, clientSeed, spec.clientBytes, slow); err != nil {
			failures <- fmt.Errorf("%s: server read: %w", spec.name, err)
		}
	}()
	chunk := spec.chunk
	pace := spec.pace
	if spec.slowReader {
		// A storage download: as fast as the client takes it.
		chunk, pace = 256*1024, 0
	}
	buffer := make([]byte, chunk)
	for written := int64(0); written < spec.serverBytes; {
		n := min(int64(chunk), spec.serverBytes-written)
		patternFill(buffer[:n], serverSeed, written)
		if _, err := connection.Write(buffer[:n]); err != nil {
			failures <- fmt.Errorf("%s: server write at %d: %w", spec.name, written, err)
			return
		}
		written += n
		if pace > 0 {
			time.Sleep(pace)
		}
	}
	// The connector ends a session when its target's end of stream arrives: the server ends only after it read the
	// client's whole stream.
	group.Wait()
}

// flowSpecs are the flows the servers know, by id.
type flowSpecs struct {
	mu    sync.Mutex
	specs map[uint64]flowSpec
}

func (s *flowSpecs) set(id uint64, spec flowSpec) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.specs[id] = spec
}

func (s *flowSpecs) get(id uint64) (flowSpec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	spec, ok := s.specs[id]
	return spec, ok
}

// runFlow is the client end: it sends the flow's id and both streams, and checks the server's.
func runFlow(dial func() (net.Conn, error), id uint64, spec flowSpec) (func() error, error) {
	connection, err := dial()
	if err != nil {
		return nil, fmt.Errorf("%s: dial: %w", spec.name, err)
	}
	setBuffers(connection)
	var header [8]byte
	binary.BigEndian.PutUint64(header[:], id)
	if _, err := connection.Write(header[:]); err != nil {
		connection.Close()
		return nil, err
	}
	clientSeed, serverSeed := flowSeeds(id)
	errs := make(chan error, 2)
	go func() {
		if spec.clientCloses {
			errs <- writePattern(connection, clientSeed, spec.clientBytes, 1, 0)
			return
		}
		errs <- writePattern(connection, clientSeed, spec.clientBytes, spec.chunk, spec.pace)
	}()
	go func() {
		var slow func(int64) time.Duration
		if spec.slowReader {
			started := time.Now()
			slow = func(int64) time.Duration {
				if time.Since(started) < 2500*time.Millisecond {
					return 20 * time.Millisecond
				}
				return 0
			}
		}
		errs <- readPattern(connection, serverSeed, spec.serverBytes, slow)
	}()
	return func() error {
		defer connection.Close()
		var failed []string
		for range 2 {
			select {
			case err := <-errs:
				if err != nil {
					failed = append(failed, err.Error())
				}
			case <-time.After(90 * time.Second):
				return fmt.Errorf("%s: no end after 90 s", spec.name)
			}
		}
		if len(failed) > 0 {
			return fmt.Errorf("%s: %s", spec.name, strings.Join(failed, "; "))
		}
		return nil
	}, nil
}

// handoverHarness is the node around the connectors: the target workload, the daemon's egress socket and the
// sessions' specs.
type handoverHarness struct {
	t        *testing.T
	dir      string
	host     string
	target   net.Listener
	egress   net.Listener
	specs    *flowSpecs
	failures chan error
	// localTarget is the ingress binding a same-node container link's stream reaches ("host:port").
	localTarget atomic.Value
	tlsConfig   *tls.Config
	caPEM       string
}

func newHandoverHarness(t *testing.T) *handoverHarness {
	t.Helper()
	h := &handoverHarness{t: t, dir: sockettest.Dir(t), host: nonLoopbackHost(t), specs: &flowSpecs{specs: map[uint64]flowSpec{}}, failures: make(chan error, 64)}
	target, err := net.Listen("tcp", net.JoinHostPort(h.host, "0"))
	if err != nil {
		t.Fatal(err)
	}
	h.target = target
	t.Cleanup(func() { target.Close() })
	go func() {
		for {
			connection, err := target.Accept()
			if err != nil {
				return
			}
			go serveFlow(connection, h.specs, h.failures)
		}
	}()
	egress, err := net.Listen("unix", filepath.Join(h.dir, egressSocketName))
	if err != nil {
		t.Fatal(err)
	}
	h.egress = egress
	t.Cleanup(func() { egress.Close() })
	go func() {
		for {
			connection, err := egress.Accept()
			if err != nil {
				return
			}
			go h.serveEgress(connection)
		}
	}()
	return h
}

// serveEgress is the daemon's egress socket: a link's stream ends here (served like a target), a same-node container
// link's is carried to its ingress binding on the connector, and the TLS link's ends in a TLS server.
func (h *handoverHarness) serveEgress(connection net.Conn) {
	var request securelink.RelayRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		connection.Close()
		return
	}
	if err := securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion}); err != nil {
		connection.Close()
		return
	}
	switch request.BindingID {
	case handoverTestLocalID:
		defer connection.Close()
		address, _ := h.localTarget.Load().(string)
		target, err := net.Dial("tcp", address)
		if err != nil {
			h.failures <- fmt.Errorf("container link: dial the ingress binding: %w", err)
			return
		}
		defer target.Close()
		setBuffers(target)
		done := make(chan struct{}, 2)
		carry := func(destination, source net.Conn) {
			_, _ = io.Copy(destination, source)
			if closer, ok := destination.(interface{ CloseWrite() error }); ok {
				_ = closer.CloseWrite()
			}
			done <- struct{}{}
		}
		go carry(target, connection)
		go carry(connection, target)
		<-done
		<-done
	case handoverTestTLSID, handoverTestUploadID:
		serveFlow(tls.Server(connection, h.tlsConfig), h.specs, h.failures)
	case handoverTestTLS12ID:
		config := h.tlsConfig.Clone()
		config.MaxVersion = tls.VersionTLS12
		serveFlow(tls.Server(connection, config), h.specs, h.failures)
	default:
		serveFlow(connection, h.specs, h.failures)
	}
}

func (h *handoverHarness) targetPort() uint16 { return uint16(h.target.Addr().(*net.TCPAddr).Port) }

func (h *handoverHarness) bindings() []securelink.BindingConfig {
	return []securelink.BindingConfig{
		{ID: handoverTestIngressID, Generation: 1, ListenHost: h.host, TargetHost: h.host, TargetPort: h.targetPort()},
		{ID: handoverTestLocalIn, Generation: 1, ListenHost: h.host, TargetHost: h.host, TargetPort: h.targetPort()},
	}
}

// failure returns a failure a server reported, if any.
func (h *handoverHarness) failure() error {
	select {
	case err := <-h.failures:
		return err
	default:
		return nil
	}
}

// withTLS adds a TLS server for the TLS link: the connector originates TLS over its stream.
func (h *handoverHarness) withTLS() {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		h.t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "storage.test"}, DNSNames: []string{"storage.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		h.t.Fatal(err)
	}
	h.caPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	h.tlsConfig = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
}

// testConnector is one connector: in this process, or a process of its own.
type testConnector interface {
	sync(t *testing.T, bindings []securelink.BindingConfig, egress []securelink.EgressConfig) map[string]uint16
	handOver(t *testing.T, to string) securelink.SyncResponse
	socketName() string
	stop()
}

// inProcessConnector is a connector's managers and takeover socket in the test process.
type inProcessConnector struct {
	name     string
	manager  *bindingManager
	egress   *egressManager
	takeover *net.UnixListener
}

func startInProcessConnector(t *testing.T, h *handoverHarness, name string) *inProcessConnector {
	t.Helper()
	c := &inProcessConnector{name: name, manager: newBindingManager(0, 0), egress: newEgressManager(filepath.Join(h.dir, egressSocketName))}
	c.egress.sessions = c.manager.sessions
	takeover, err := listenTakeover(filepath.Join(h.dir, c.socketName()))
	if err != nil {
		t.Fatal(err)
	}
	c.takeover = takeover
	go serveTakeover(takeover, c.manager, c.egress)
	t.Cleanup(c.stop)
	return c
}

func (c *inProcessConnector) socketName() string { return c.name + ".sock" }

func (c *inProcessConnector) sync(t *testing.T, bindings []securelink.BindingConfig, egress []securelink.EgressConfig) map[string]uint16 {
	t.Helper()
	response := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: bindings, Egress: egress}, c.manager, c.egress)
	return syncedPorts(t, response, egress)
}

func (c *inProcessConnector) handOver(t *testing.T, to string) securelink.SyncResponse {
	return handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersionHandover, Handover: &securelink.HandoverRequest{To: to}}, c.manager, c.egress)
}

// stop is the container's removal: every descriptor of the connector closes.
func (c *inProcessConnector) stop() {
	c.takeover.Close()
	c.manager.close()
	c.egress.close()
}

func syncedPorts(t *testing.T, response securelink.SyncResponse, egress []securelink.EgressConfig) map[string]uint16 {
	t.Helper()
	if response.Error != "" {
		t.Fatalf("sync refused: %s", response.Error)
	}
	for _, status := range response.Egress {
		if status.State != securelink.EgressListening {
			t.Fatalf("egress %s: %s %s", status.ID, status.State, status.Error)
		}
	}
	if len(response.Egress) != len(egress) {
		t.Fatalf("egress statuses %+v", response.Egress)
	}
	ports := map[string]uint16{}
	for _, binding := range response.Bindings {
		ports[binding.ID] = binding.Port
	}
	return ports
}

// processConnector is the connector binary (this test binary running main) in a process of its own, driven through
// its control socket as the daemon drives it.
type processConnector struct {
	name    string
	dir     string
	command *exec.Cmd
	once    sync.Once
}

func startProcessConnector(t *testing.T, h *handoverHarness, name string) *processConnector {
	t.Helper()
	c := &processConnector{name: name, dir: h.dir}
	c.command = exec.Command(os.Args[0], "-test.run=^$")
	c.command.Env = append(os.Environ(), runConnectorEnv+"=1", legacycompat.EnvPrefix+"SECURE_LINK_SOCKET="+filepath.Join(h.dir, c.socketName()))
	c.command.Stdout, c.command.Stderr = os.Stderr, os.Stderr
	if err := c.command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(takeoverSocketPath(filepath.Join(h.dir, c.socketName()))); err == nil {
			return c
		}
		if time.Now().After(deadline) {
			t.Fatalf("connector %s did not start", name)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (c *processConnector) socketName() string { return c.name + ".sock" }

func (c *processConnector) sync(t *testing.T, bindings []securelink.BindingConfig, egress []securelink.EgressConfig) map[string]uint16 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	response, err := securelink.Sync(ctx, filepath.Join(c.dir, c.socketName()), securelink.SyncRequest{Bindings: bindings, Egress: egress})
	if err != nil {
		t.Fatalf("sync %s: %v", c.name, err)
	}
	return syncedPorts(t, *response, egress)
}

func (c *processConnector) handOver(t *testing.T, to string) securelink.SyncResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, active, err := securelink.Handover(ctx, filepath.Join(c.dir, c.socketName()), to)
	if err != nil {
		t.Fatalf("handover from %s: %v", c.name, err)
	}
	return securelink.SyncResponse{Version: securelink.ProtocolVersionHandover, Handover: result, Active: active}
}

// stop kills the process, as docker removes a container (SIGKILL).
func (c *processConnector) stop() {
	c.once.Do(func() {
		_ = c.command.Process.Signal(syscall.SIGKILL)
		_ = c.command.Wait()
	})
}

// handoverFlows are the sessions of a node: each runs about three seconds.
func handoverFlows() map[string]flowSpec {
	return map[string]flowSpec{
		"websocket": {name: "websocket (ingress, duplex)", clientBytes: 3 << 20, serverBytes: 3 << 20, chunk: 8 * 1024, pace: 8 * time.Millisecond},
		"sse":       {name: "sse (ingress, push after a half-close)", clientBytes: 1, serverBytes: 2 << 20, chunk: 4 * 1024, pace: 6 * time.Millisecond, clientCloses: true},
		"database":  {name: "database (egress, duplex)", clientBytes: 2 << 20, serverBytes: 4 << 20, chunk: 16 * 1024, pace: 10 * time.Millisecond},
		"storage":   {name: "storage (egress, bulk to a slow reader)", clientBytes: 1, serverBytes: 24 << 20, chunk: 64 * 1024, clientCloses: true, slowReader: true},
		"container": {name: "container link (egress to an ingress binding on the node)", clientBytes: 3 << 20, serverBytes: 3 << 20, chunk: 8 * 1024, pace: 8 * time.Millisecond},
	}
}

// startFlows opens the sessions through connector c and returns their checks.
func startFlows(t *testing.T, h *handoverHarness, ports map[string]uint16, link, bulk, local securelink.EgressConfig, flows map[string]flowSpec, extra map[string]func() (net.Conn, error)) map[string]func() error {
	t.Helper()
	h.localTarget.Store(net.JoinHostPort(h.host, fmt.Sprint(ports[handoverTestLocalIn])))
	dialPort := func(port uint16) func() (net.Conn, error) {
		return func() (net.Conn, error) {
			return net.DialTimeout("tcp", net.JoinHostPort(h.host, fmt.Sprint(port)), 5*time.Second)
		}
	}
	routes := map[string]func() (net.Conn, error){
		"websocket": dialPort(ports[handoverTestIngressID]),
		"sse":       dialPort(ports[handoverTestIngressID]),
		"database":  dialPort(link.ListenPort),
		"storage":   dialPort(bulk.ListenPort),
		"container": dialPort(local.ListenPort),
	}
	names := make([]string, 0, len(flows))
	for name := range flows {
		names = append(names, name)
	}
	sort.Strings(names)
	checks := map[string]func() error{}
	for index, name := range names {
		id := uint64(index + 1)
		h.specs.set(id, flows[name])
		dial := routes[name]
		if dial == nil {
			dial = extra[name]
		}
		check, err := runFlow(dial, id, flows[name])
		if err != nil {
			t.Fatal(err)
		}
		checks[name] = check
	}
	return checks
}

// waitSessions waits until connector c carries n sessions (each relayed stream started).
func waitSessions(t *testing.T, sessions *sessionSet, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if count := len(sessionsOf(sessions)); count >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the connector carries %d sessions, want %d (%d being set up)", len(sessionsOf(sessions)), n, sessions.starting.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sessionsOf(sessions *sessionSet) []struct{} {
	live, _ := sessions.registry.Live(true, "")
	return make([]struct{}, live)
}

func checkFlows(t *testing.T, h *handoverHarness, checks map[string]func() error) {
	t.Helper()
	for name, check := range checks {
		if err := check(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	for err := h.failure(); err != nil; err = h.failure() {
		t.Error(err)
	}
}

func handoverEgressConfigs(t *testing.T) (link, bulk, local securelink.EgressConfig) {
	link = egressTestConfig(t, handoverTestLinkID)
	link.OwnerKind = "managed_database_binding"
	bulk = egressTestConfig(t, handoverTestBulkID)
	bulk.OwnerKind = "managed_storage_binding"
	local = egressTestConfig(t, handoverTestLocalID)
	return link, bulk, local
}

// expectHandover checks a handover's answer: every session handed over, nothing left, the connections of the ingress
// sessions named.
func expectHandover(t *testing.T, response securelink.SyncResponse, sessions, ingress int) {
	t.Helper()
	result := response.Handover
	if response.Error != "" || result == nil || result.Error != "" {
		t.Fatalf("handover answered %+v (result %+v)", response, result)
	}
	if result.HandedOver != sessions || response.Active != 0 || len(result.Left) != 0 {
		t.Fatalf("handed over %d of %d sessions, still carrying %d, left %v", result.HandedOver, sessions, response.Active, result.Left)
	}
	if len(result.Peers) != ingress {
		t.Fatalf("%d ingress connections named, want %d: %+v", len(result.Peers), ingress, result.Peers)
	}
	for _, peer := range result.Peers {
		if peer.Daemon == "" || peer.Connector == "" {
			t.Fatalf("incomplete peer %+v", peer)
		}
	}
}

// runReplacementChain opens the sessions through a first connector, replaces it twice while they carry bytes, and
// checks every stream.
func runReplacementChain(t *testing.T, h *handoverHarness, start func(name string) testConnector) {
	link, bulk, local := handoverEgressConfigs(t)
	egress := []securelink.EgressConfig{link, bulk, local}
	first := start("a")
	ports := first.sync(t, h.bindings(), egress)
	checks := startFlows(t, h, ports, link, bulk, local, handoverFlows(), nil)
	// Five flows, the container link twice (its egress stream and the ingress session it reaches): 6 sessions, 3 of
	// them ingress.
	if inProcess, ok := first.(*inProcessConnector); ok {
		waitSessions(t, inProcess.manager.sessions, 6)
	}
	time.Sleep(time.Second)

	// The replacement starts next to it with the same links; the first hands its sessions over and goes at once.
	second := start("b")
	second.sync(t, h.bindings(), egress)
	expectHandover(t, first.handOver(t, second.socketName()), 6, 3)
	first.stop()
	time.Sleep(800 * time.Millisecond)

	// Replaced again: the sessions it took over move on.
	third := start("c")
	third.sync(t, h.bindings(), egress)
	expectHandover(t, second.handOver(t, third.socketName()), 6, 3)
	second.stop()

	checkFlows(t, h, checks)
}

// Two replacements in this process: the sessions of the first connector end on the third, byte-exact.
func TestReplacedConnectorHandsItsSessionsOver(t *testing.T) {
	h := newHandoverHarness(t)
	runReplacementChain(t, h, func(name string) testConnector { return startInProcessConnector(t, h, name) })
}

// The connectors in processes of their own, driven through their control sockets as the daemon drives them, each
// killed (SIGKILL, as docker removes a container) right after its handover: the sessions move between processes and
// outlive the one that opened them.
func TestReplacedConnectorProcessHandsItsSessionsOver(t *testing.T) {
	h := newHandoverHarness(t)
	runReplacementChain(t, h, func(name string) testConnector { return startProcessConnector(t, h, name) })
}

// A session whose TLS the connector originates (managed storage with TLS) moves too: the connector carries its TLS 1.3
// records itself, and the state (secrets, sequence numbers, records read or written in part) goes with the sockets:
// an upload to a slow target leaves records written in part at the stop. A session crypto/tls carries (TLS 1.2) cannot
// move: it stays with the replaced connector, which carries it on to its end, and the answer says so.
func TestHandoverCarriesTLSSessions(t *testing.T) {
	h := newHandoverHarness(t)
	h.withTLS()
	link, bulk, local := handoverEgressConfigs(t)
	tlsLink := func(id string) securelink.EgressConfig {
		config := egressTestConfig(t, id)
		config.OwnerKind = "managed_storage_binding"
		config.TLSCAPEM, config.TLSServerName = h.caPEM, "storage.test"
		return config
	}
	secure, upload, legacy := tlsLink(handoverTestTLSID), tlsLink(handoverTestUploadID), tlsLink(handoverTestTLS12ID)
	egress := []securelink.EgressConfig{link, bulk, local, secure, upload, legacy}
	first := startInProcessConnector(t, h, "a")
	ports := first.sync(t, h.bindings(), egress)
	flows := handoverFlows()
	flows["tls"] = flowSpec{name: "storage with TLS 1.3 (egress, duplex)", clientBytes: 2 << 20, serverBytes: 3 << 20, chunk: 8 * 1024, pace: 8 * time.Millisecond}
	flows["tls-upload"] = flowSpec{name: "storage with TLS 1.3 (egress, upload to a slow target)", clientBytes: 16 << 20, serverBytes: 1, chunk: 64 * 1024, slowServer: true}
	flows["tls12"] = flowSpec{name: "storage with TLS 1.2 (egress, duplex)", clientBytes: 1 << 20, serverBytes: 2 << 20, chunk: 8 * 1024, pace: 8 * time.Millisecond}
	dialTo := func(config securelink.EgressConfig) func() (net.Conn, error) {
		return func() (net.Conn, error) {
			return net.DialTimeout("tcp", net.JoinHostPort(config.ListenHost, fmt.Sprint(config.ListenPort)), 5*time.Second)
		}
	}
	checks := startFlows(t, h, ports, link, bulk, local, flows, map[string]func() (net.Conn, error){
		"tls": dialTo(secure), "tls-upload": dialTo(upload), "tls12": dialTo(legacy),
	})
	waitSessions(t, first.manager.sessions, 8)
	time.Sleep(time.Second)

	second := startInProcessConnector(t, h, "b")
	second.sync(t, h.bindings(), egress)
	response := first.handOver(t, second.socketName())
	result := response.Handover
	if result == nil || result.HandedOver != 8 || response.Active != 1 || result.Left[securelink.HandoverLeftTLS] != 1 || result.Error != "" {
		t.Fatalf("handover answered %+v (result %+v), want 8 handed over and the TLS 1.2 session left", response, result)
	}
	time.Sleep(500 * time.Millisecond)
	third := startInProcessConnector(t, h, "c")
	third.sync(t, h.bindings(), egress)
	expectHandover(t, second.handOver(t, third.socketName()), 8, 3)
	second.stop()

	checkFlows(t, h, checks)
	if active := first.manager.active() + first.egress.active(); active != 0 {
		t.Fatalf("the replaced connector still carries %d sessions after they ended", active)
	}
}

// A replacement that takes no sessions (a connector image of an earlier release has no takeover socket): nothing is
// handed over, the replaced connector drains and carries every session on to its end, as before.
func TestHandoverToAnOlderReplacementKeepsTheSessions(t *testing.T) {
	h := newHandoverHarness(t)
	link, bulk, local := handoverEgressConfigs(t)
	egress := []securelink.EgressConfig{link, bulk, local}
	first := startInProcessConnector(t, h, "a")
	ports := first.sync(t, h.bindings(), egress)
	checks := startFlows(t, h, ports, link, bulk, local, handoverFlows(), nil)
	waitSessions(t, first.manager.sessions, 6)
	time.Sleep(500 * time.Millisecond)

	response := first.handOver(t, "older.sock")
	result := response.Handover
	if result == nil || result.HandedOver != 0 || response.Active == 0 || result.Error == "" || result.Left[securelink.HandoverLeftFailed] == 0 {
		t.Fatalf("handover to a replacement without a takeover socket answered %+v (result %+v)", response, result)
	}
	// It drains like a drain request: no new connection is accepted.
	if connection, err := net.DialTimeout("tcp", net.JoinHostPort(link.ListenHost, fmt.Sprint(link.ListenPort)), 200*time.Millisecond); err == nil {
		connection.Close()
		t.Fatal("the connector still accepts after the handover request")
	}
	checkFlows(t, h, checks)
}

// A handover request names a socket in the connector's own directory, nothing else.
func TestHandoverRequestNamesASocketInTheControlDirectory(t *testing.T) {
	h := newHandoverHarness(t)
	first := startInProcessConnector(t, h, "a")
	for _, to := range []string{"", "../x.sock", legacycompat.ConnectorRunDir + "/x.sock", "x", "a b.sock"} {
		response := first.handOver(t, to)
		if response.Error == "" {
			t.Fatalf("handover to %q accepted: %+v", to, response)
		}
	}
}
