package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestServerTLSConfigPreservesGRPCALPNForDynamicCertificates(t *testing.T) {
	store := &Store{}
	store.current.Store(&Snapshot{})
	config := store.ServerTLSConfig()
	if !slices.Contains(config.NextProtos, "h2") {
		t.Fatalf("base TLS config does not advertise h2: %v", config.NextProtos)
	}
	dynamic, err := config.GetConfigForClient(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(dynamic.NextProtos, "h2") {
		t.Fatalf("dynamic TLS config lost h2 ALPN: %v", dynamic.NextProtos)
	}
}

func TestAppClientTrustSurvivesUncertainReloadAcknowledgement(t *testing.T) {
	store := &Store{}
	previous := "sha256:" + repeatHex("a")
	current := "sha256:" + repeatHex("b")
	store.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	store.rotation = rotationState{
		Version:             1,
		CurrentFingerprint:  current,
		PreviousFingerprint: previous,
		PendingOperationID:  "rotation-1",
	}

	if !store.AuthorizeAppClient(previous) {
		t.Fatal("previous app client identity was rejected before rotation commit")
	}
	if !store.AuthorizeAppClient(current) {
		t.Fatal("current app client identity was rejected")
	}
	if !store.AuthorizeAppClient(previous) {
		t.Fatal("health or another current-client RPC implicitly committed the rotation")
	}
	if err := store.CommitAppClientRotation("rotation-1", previous); err == nil {
		t.Fatal("previous client was allowed to commit the rotation")
	}
	if err := store.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("current client could not commit rotation: %v", err)
	}
	if store.AuthorizeAppClient(previous) {
		t.Fatal("previous app client identity remained trusted after explicit commit")
	}
	if err := store.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("identity rotation commit was not idempotent: %v", err)
	}
}

func TestAppClientRotationStateSurvivesRestart(t *testing.T) {
	current := "sha256:" + repeatHex("b")
	previous := "sha256:" + repeatHex("a")
	statePath := filepath.Join(t.TempDir(), "identity-rotation.json")
	store := &Store{statePath: statePath}
	store.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	store.rotation = rotationState{
		Version:             1,
		CurrentFingerprint:  current,
		PreviousFingerprint: previous,
		PendingOperationID:  "rotation-1",
	}
	if err := store.persistRotationState(store.rotation); err != nil {
		t.Fatalf("persist rotation state: %v", err)
	}

	restarted := &Store{statePath: statePath}
	restarted.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	if err := restarted.loadRotationState(current); err != nil {
		t.Fatalf("load rotation state: %v", err)
	}
	if !restarted.AuthorizeAppClient(previous) {
		t.Fatal("previous identity was not restored for an uncertain reload acknowledgement")
	}
	if err := restarted.CommitAppClientRotation("rotation-1", current); err != nil {
		t.Fatalf("commit restored rotation: %v", err)
	}
}

func TestAppClientCanInitiateRotationAfterFilesChangedBeforeRestart(t *testing.T) {
	previous := "sha256:" + repeatHex("a")
	current := "sha256:" + repeatHex("b")
	statePath := filepath.Join(t.TempDir(), "identity-rotation.json")
	before := &Store{statePath: statePath, rotation: rotationState{Version: 1, CurrentFingerprint: previous}}
	if err := before.persistRotationState(before.rotation); err != nil {
		t.Fatalf("persist previous identity state: %v", err)
	}

	restarted := &Store{statePath: statePath}
	restarted.current.Store(&Snapshot{Trust: TrustManifest{AppRelayClientFingerprint: current}})
	if err := restarted.loadRotationState(current); err != nil {
		t.Fatalf("load changed identity state: %v", err)
	}
	if !restarted.AuthorizeAppClient(previous) {
		t.Fatal("previous Opfield identity was not retained across pre-reload restart")
	}
}

func repeatHex(value string) string {
	result := ""
	for range 64 {
		result += value
	}
	return result
}

func selfSignedServerCertificate(t *testing.T, name string, notAfter time.Time) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		DNSNames: []string{name, "relay.example.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}

// After a renewal the relay serves the renewed certificate by its new identity
// and the retained one by the identity daemons still pin, until it expires.
func TestServerCertificateServesRetainedCertificateByItsIdentity(t *testing.T) {
	now := time.Now()
	current := selfSignedServerCertificate(t, "relay-instance-r2", now.Add(365*24*time.Hour))
	previous := selfSignedServerCertificate(t, "relay-instance", now.Add(20*24*time.Hour))
	snapshot := &Snapshot{External: current, PreviousExternal: &previous}

	if got := snapshot.ServerCertificate("relay-instance-r2", now); got.Leaf != current.Leaf {
		t.Fatal("renewed identity did not get the renewed certificate")
	}
	if got := snapshot.ServerCertificate("relay-instance", now); got.Leaf != previous.Leaf {
		t.Fatal("the identity daemons still pin did not get the retained certificate")
	}
	// Names both certificates carry, and no name at all, get the current one.
	if got := snapshot.ServerCertificate("relay.example.test", now); got.Leaf != current.Leaf {
		t.Fatal("a shared name did not get the renewed certificate")
	}
	if got := snapshot.ServerCertificate("", now); got.Leaf != current.Leaf {
		t.Fatal("a client without SNI did not get the renewed certificate")
	}
	// An expired retained certificate is never served.
	if got := snapshot.ServerCertificate("relay-instance", now.Add(21*24*time.Hour)); got.Leaf != current.Leaf {
		t.Fatal("an expired retained certificate was served")
	}
}

func TestLoadedFingerprintsNameTheLoadedIdentity(t *testing.T) {
	now := time.Now()
	external := selfSignedServerCertificate(t, "gateway-grpc", now.Add(time.Hour))
	relayClient := selfSignedServerCertificate(t, "relay-app-client", now.Add(time.Hour))
	appClient := "sha256:" + repeatHex("c")
	snapshot := &Snapshot{External: external, RelayClient: relayClient, Trust: TrustManifest{AppRelayClientFingerprint: appClient}}

	gotExternal, gotRelayClient, gotAppClient := snapshot.LoadedFingerprints()
	if gotExternal != Fingerprint(external.Certificate[0]) || gotRelayClient != Fingerprint(relayClient.Certificate[0]) || gotAppClient != appClient {
		t.Fatalf("loaded fingerprints = %q %q %q", gotExternal, gotRelayClient, gotAppClient)
	}
	if external, relayClient, _ := (&Snapshot{}).LoadedFingerprints(); external != "" || relayClient != "" {
		t.Fatal("an empty snapshot reported certificate fingerprints")
	}
}
