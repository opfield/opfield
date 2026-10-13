package lifecycle

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/auth"
	"github.com/opfield/opfield/daemon-shared/connector"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
)

// A re-enrolled relay comes back with a new certificate. Its lanes pinned the
// old one and failed every handshake until the daemon restarted; they must be
// rebuilt for the certificate Opfield hands out, while the lanes to the other
// relay stay as they are.
func TestRelayPoolReplacesLanesOfAReEnrolledRelay(t *testing.T) {
	pki := newRelayTestPKI(t)
	relayA := newTestRelay(t, pki, "relay-a-1")
	relayB := newTestRelay(t, pki, "relay-b")
	plugin := newTestRelayPoolPlugin(relayA.target("a"), relayB.target("b"))
	startTestRelayPool(t, pki, plugin)
	firstA := plugin.waitForLane(t, "a", 1)
	firstB := plugin.waitForLane(t, "b", 1)

	// Re-enrollment: the relay restarts and serves only its new certificate.
	relayA.serveOnly(pki.serverCertificate(t, "relay-a-2"))
	relayA.path.drop()
	waitForLaneState(t, firstA, func(state connectivity.State) bool { return state != connectivity.Ready })
	plugin.setTargets(relayA.target("a"), relayB.target("b"))

	replaced := plugin.waitForLane(t, "a", 2)
	if replaced == firstA {
		t.Fatal("the lane to the re-enrolled relay was not replaced")
	}
	if !relayA.servedName("relay-a-2") {
		t.Fatal("the new lane did not ask for the relay's new certificate")
	}
	if lanes, ended := plugin.laneCount("b"); lanes != 1 || ended != 0 || firstB.GetState() != connectivity.Ready {
		t.Fatalf("the lane to the unchanged relay was touched: %d lanes, %d ended, %s", lanes, ended, firstB.GetState())
	}
}

// A renewed relay keeps serving the previous certificate, so lanes that are up
// keep their tunnels. Once such a lane drops, it reconnects with the renewed
// certificate instead of the one it was built for.
func TestRelayPoolKeepsConnectedLanesThroughARenewal(t *testing.T) {
	pki := newRelayTestPKI(t)
	relayA := newTestRelay(t, pki, "relay-a-1")
	plugin := newTestRelayPoolPlugin(relayA.target("a"))
	startTestRelayPool(t, pki, plugin)
	first := plugin.waitForLane(t, "a", 1)

	relayA.renew(pki.serverCertificate(t, "relay-a-2"))
	plugin.setTargets(relayA.target("a"))
	time.Sleep(500 * time.Millisecond)
	if lanes, ended := plugin.laneCount("a"); lanes != 1 || ended != 0 || first.GetState() != connectivity.Ready {
		t.Fatalf("a renewal must not drop a connected lane: %d lanes, %d ended, %s", lanes, ended, first.GetState())
	}

	relayA.path.drop()
	plugin.waitForLane(t, "a", 2)
	if !relayA.servedName("relay-a-2") {
		t.Fatal("the lane reconnected with the certificate it was built for, not the renewed one")
	}
}

type relayTestPKI struct {
	ca      *x509.Certificate
	caKey   *ecdsa.PrivateKey
	caPEM   []byte
	serial  int64
	pemDir  string
	clients *auth.TLSManager
}

func newRelayTestPKI(t *testing.T) *relayTestPKI {
	t.Helper()
	key := newTestKey(t)
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test system CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pki := &relayTestPKI{ca: ca, caKey: key, caPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), serial: 1, pemDir: t.TempDir()}
	client := pki.issue(t, "node-test", x509.ExtKeyUsageClientAuth)
	keyDER, err := x509.MarshalECPrivateKey(client.PrivateKey.(*ecdsa.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"ca.pem":     pki.caPEM,
		"client.pem": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: client.Certificate[0]}),
		"client.key": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(pki.pemDir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pki.clients = auth.NewTLSManager(filepath.Join(pki.pemDir, "ca.pem"), filepath.Join(pki.pemDir, "client.pem"), filepath.Join(pki.pemDir, "client.key"))
	return pki
}

func (p *relayTestPKI) serverCertificate(t *testing.T, name string) tls.Certificate {
	return p.issue(t, name, x509.ExtKeyUsageServerAuth)
}

func (p *relayTestPKI) issue(t *testing.T, name string, usage x509.ExtKeyUsage) tls.Certificate {
	t.Helper()
	key := newTestKey(t)
	p.serial++
	template := &x509.Certificate{
		SerialNumber: big.NewInt(p.serial),
		Subject:      pkix.Name{CommonName: name},
		DNSNames:     []string{name},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, p.ca, &key.PublicKey, p.caKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func newTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// testRelay is a relay worker behind a path that can drop its connections. It
// serves its current certificate and, after a renewal, the previous one to
// clients that ask for it by name.
type testRelay struct {
	path   *droppingPath
	mu     sync.Mutex
	names  []string
	certs  map[string]tls.Certificate
	served []string
}

func newTestRelay(t *testing.T, pki *relayTestPKI, name string) *testRelay {
	t.Helper()
	relay := &testRelay{}
	relay.serveOnly(pki.serverCertificate(t, name))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{GetCertificate: relay.certificate})))
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	relay.path = newDroppingPath(t, listener.Addr().String())
	return relay
}

func (r *testRelay) serveOnly(certificate tls.Certificate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := certificateName(certificate)
	r.names = []string{name}
	r.certs = map[string]tls.Certificate{name: certificate}
}

func (r *testRelay) renew(certificate tls.Certificate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := certificateName(certificate)
	r.names = append([]string{name}, r.names...)
	r.certs[name] = certificate
}

func (r *testRelay) certificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.served = append(r.served, hello.ServerName)
	if certificate, ok := r.certs[hello.ServerName]; ok {
		return &certificate, nil
	}
	certificate := r.certs[r.names[0]]
	return &certificate, nil
}

func (r *testRelay) servedName(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.served, name)
}

// target is what Opfield's grants name for the relay: its current certificate.
func (r *testRelay) target(id string) RelayTunnelTarget {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.certs[r.names[0]]
	digest := sha256.Sum256(current.Certificate[0])
	return RelayTunnelTarget{
		ID: id, Addresses: []string{r.path.listener.Addr().String()}, CertificateIdentity: r.names[0],
		CertificateFingerprint: "sha256:" + hex.EncodeToString(digest[:]),
	}
}

func certificateName(certificate tls.Certificate) string {
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		panic(err)
	}
	return leaf.Subject.CommonName
}

type testRelayPoolPlugin struct {
	mu      sync.Mutex
	targets []RelayTunnelTarget
	changed chan struct{}
	lanes   map[string][]*grpc.ClientConn
	ended   map[string]int
}

func newTestRelayPoolPlugin(targets ...RelayTunnelTarget) *testRelayPoolPlugin {
	return &testRelayPoolPlugin{targets: targets, changed: make(chan struct{}, 1), lanes: map[string][]*grpc.ClientConn{}, ended: map[string]int{}}
}

func startTestRelayPool(t *testing.T, pki *relayTestPKI, plugin *testRelayPoolPlugin) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	done := make(chan struct{})
	go func() {
		defer close(done)
		runProcessRelayPool(ctx, connector.NewConnector("127.0.0.1:1", pki.clients, logger), plugin, "node-test", nil, logger)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func (p *testRelayPoolPlugin) RunRelayTunnels(ctx context.Context, _ *grpc.ClientConn, _ string) {
	<-ctx.Done()
}

func (p *testRelayPoolPlugin) SyncRelayGrants(*pb.SyncRelayGrantsCommand) (string, error) {
	return "", nil
}

func (p *testRelayPoolPlugin) RelayTunnelLaneCount() int { return 1 }

func (p *testRelayPoolPlugin) RelayTunnelRuntimeChanged() <-chan struct{} { return p.changed }

func (p *testRelayPoolPlugin) RelayTunnelTargets() []RelayTunnelTarget {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.targets)
}

func (p *testRelayPoolPlugin) RunRelayTargetTunnels(ctx context.Context, conn *grpc.ClientConn, _, relayInstanceID string) {
	p.mu.Lock()
	p.lanes[relayInstanceID] = append(p.lanes[relayInstanceID], conn)
	p.mu.Unlock()
	<-ctx.Done()
	p.mu.Lock()
	p.ended[relayInstanceID]++
	p.mu.Unlock()
}

func (p *testRelayPoolPlugin) setTargets(targets ...RelayTunnelTarget) {
	p.mu.Lock()
	p.targets = targets
	p.mu.Unlock()
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

func (p *testRelayPoolPlugin) laneCount(id string) (lanes, ended int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.lanes[id]), p.ended[id]
}

// waitForLane waits until the target's nth lane carries tunnels and is connected.
func (p *testRelayPoolPlugin) waitForLane(t *testing.T, id string, nth int) *grpc.ClientConn {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		lanes := p.lanes[id]
		p.mu.Unlock()
		if len(lanes) >= nth && lanes[nth-1].GetState() == connectivity.Ready {
			return lanes[nth-1]
		}
		time.Sleep(20 * time.Millisecond)
	}
	lanes, ended := p.laneCount(id)
	t.Fatalf("relay %s: lane %d did not come up (%d lanes, %d ended)", id, nth, lanes, ended)
	return nil
}

func waitForLaneState(t *testing.T, conn *grpc.ClientConn, want func(connectivity.State) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for state := conn.GetState(); !want(state); state = conn.GetState() {
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatalf("lane stayed %s", state)
		}
	}
}
