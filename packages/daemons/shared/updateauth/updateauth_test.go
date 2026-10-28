package updateauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"strings"
	"testing"
)

const testChecksum = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// testURL is the artifact the signed fixture names (the self-hosted GitLab of an early release).
var testURL = func() string {
	var envelope struct{ Payload string }
	_ = json.Unmarshal([]byte(testManifest), &envelope)
	raw, _ := base64.RawURLEncoding.DecodeString(envelope.Payload)
	var payload struct {
		DownloadURL string `json:"downloadUrl"`
	}
	_ = json.Unmarshal(raw, &payload)
	return payload.DownloadURL
}()

var testManifest = `{
  "schemaVersion": 1,
  "keyId": "` + legacycompat.UpdateKeyID + `",
  "payload": "eyJraW5kIjoiZGFlbW9uLWJpbmFyeSIsInZlcnNpb24iOiJ2OS45LjkiLCJ0YWciOiJ2OS45LjktbmdpbngiLCJkYWVtb25UeXBlIjoibmdpbngiLCJhcmNoIjoiYW1kNjQiLCJhcnRpZmFjdE5hbWUiOiJuZ2lueC1kYWVtb24tbGludXgtYW1kNjQiLCJkb3dubG9hZFVybCI6Imh0dHBzOi8vZ2l0bGFiLndpb2xldHQubmV0L2FwaS92NC9wcm9qZWN0cy93aW9sZXR0JTJGZ2F0ZXdheS9wYWNrYWdlcy9nZW5lcmljL25naW54LWRhZW1vbi92OS45LjktbmdpbngvbmdpbngtZGFlbW9uLWxpbnV4LWFtZDY0Iiwic2hhMjU2IjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsImNyZWF0ZWRBdCI6IjIwMjYtMDUtMDJUMTQ6Mzk6MDNaIiwiZ2l0Q29tbWl0U2hhIjoidGVzdCIsImdpdFBpcGVsaW5lSWQiOiIxIn0",
  "signature": "sNy92HOZyOUMyGJkXQ1nRmTSFm3BosuaAUaInP_Svo0cWGx50jvMlnsfU64FyubGDXK4ihvpgtlcNCfqN61ABw"
}`

func TestVerifyDaemonManifest(t *testing.T) {
	payload, err := VerifyDaemonManifest(testManifest, DaemonExpectation{
		DaemonType:   "nginx",
		Version:      "v9.9.9",
		Tag:          "v9.9.9-nginx",
		Arch:         "amd64",
		ArtifactName: "nginx-daemon-linux-amd64",
		DownloadURL:  testURL,
		SHA256:       testChecksum,
	})
	if err != nil {
		t.Fatalf("VerifyDaemonManifest returned error: %v", err)
	}
	if payload.ArtifactName != "nginx-daemon-linux-amd64" {
		t.Fatalf("unexpected artifact name %q", payload.ArtifactName)
	}
}

func TestVerifyDaemonManifestRejectsMismatch(t *testing.T) {
	_, err := VerifyDaemonManifest(testManifest, DaemonExpectation{
		DaemonType:   "docker",
		Version:      "v9.9.9",
		Tag:          "v9.9.9-nginx",
		Arch:         "amd64",
		ArtifactName: "nginx-daemon-linux-amd64",
		DownloadURL:  testURL,
		SHA256:       testChecksum,
	})
	if err == nil {
		t.Fatal("expected daemon type mismatch to fail")
	}
}

func TestVerifyDaemonManifestRejectsTampering(t *testing.T) {
	tampered := `{"schemaVersion":1,"keyId":"` + legacycompat.UpdateKeyID + `","payload":"eyJraW5kIjoiZGFlbW9uLWJpbmFyeSJ9","signature":"sNy92HOZyOUMyGJkXQ1nRmTSFm3BosuaAUaInP_Svo0cWGx50jvMlnsfU64FyubGDXK4ihvpgtlcNCfqN61ABw"}`
	_, err := VerifyDaemonManifest(tampered, DaemonExpectation{
		DaemonType:   "nginx",
		Version:      "v9.9.9",
		Tag:          "v9.9.9-nginx",
		Arch:         "amd64",
		ArtifactName: "nginx-daemon-linux-amd64",
		DownloadURL:  testURL,
		SHA256:       testChecksum,
	})
	if err == nil {
		t.Fatal("expected tampered manifest to fail")
	}
}

func TestTrustedHTTPSURLAllowsConfiguredGitLabOrigins(t *testing.T) {
	if !isTrustedHTTPSURL("https://gitlab.example.test/api/v4/projects/custom%2Fopfield/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64") {
		t.Fatal("expected HTTPS package URL from a configured GitLab origin to be trusted")
	}
	if isTrustedHTTPSURL("http://gitlab.example.test/api/v4/projects/custom%2Fopfield/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64") {
		t.Fatal("expected non-HTTPS package URL to be rejected")
	}
}

func witnessManifest(t *testing.T, private ed25519.PrivateKey, payload WitnessManifestPayload) string {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(SignPayload(private, encoded))
	if err != nil {
		t.Fatal(err)
	}
	return string(envelope)
}

// useTestKey makes the package trust a test key instead of the compiled one.
func useTestKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previous := trustedKeys
	trustedKeys = func() ([]ed25519.PublicKey, error) { return []ed25519.PublicKey{public}, nil }
	t.Cleanup(func() { trustedKeys = previous })
	return private
}

func pemOf(t *testing.T, key ed25519.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// The trust is a list of key slots plus a revocation list (R3-09): a manifest signed by the standby key verifies once
// that key fills the secondary slot, and a revoked key verifies nothing, whatever keyId its envelope names.
func TestTrustedKeySlotsAndRevocation(t *testing.T) {
	primaryPublic, primary, _ := ed25519.GenerateKey(rand.Reader)
	standbyPublic, standby, _ := ed25519.GenerateKey(rand.Reader)
	standbyDER, _ := x509.MarshalPKIXPublicKey(standbyPublic)
	standbyLine := base64.StdEncoding.EncodeToString(standbyDER)
	primaryID, err := PublicKeyID(primaryPublic)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"kind":"daemon-binary"}`)
	verifies := func(slots []string, revoked []string, private ed25519.PrivateKey) bool {
		keys, err := trustedKeySet(slots, revoked)
		if err != nil {
			return false
		}
		return signedByAny(keys, payload, ed25519.Sign(private, payload))
	}

	if !verifies([]string{pemOf(t, primaryPublic), ""}, nil, primary) {
		t.Fatal("the primary key with an empty secondary slot does not verify")
	}
	if verifies([]string{pemOf(t, primaryPublic), ""}, nil, standby) {
		t.Fatal("a key in no slot verifies")
	}
	if !verifies([]string{pemOf(t, primaryPublic), standbyLine}, nil, standby) {
		t.Fatal("the standby key in the secondary slot does not verify")
	}
	if verifies([]string{pemOf(t, primaryPublic), standbyLine}, []string{strings.ToUpper(primaryID)}, primary) {
		t.Fatal("a revoked primary key still verifies")
	}
	if !verifies([]string{pemOf(t, primaryPublic), standbyLine}, []string{primaryID}, standby) {
		t.Fatal("the standby key stopped verifying when the primary was revoked")
	}
	if _, err := trustedKeySet([]string{pemOf(t, primaryPublic), ""}, []string{primaryID}); err == nil {
		t.Fatal("a trust with every key revoked was accepted")
	}
	if _, err := trustedKeySet([]string{pemOf(t, primaryPublic), "not a key"}, nil); err == nil {
		t.Fatal("a broken key slot was accepted")
	}
}

// The compiled slots parse: a key added to the secondary slot or the revocation list in a broken form fails here.
func TestCompiledTrustParses(t *testing.T) {
	keys, err := trustedKeys()
	if err != nil || len(keys) == 0 {
		t.Fatalf("compiled trust: %d keys, %v", len(keys), err)
	}
}

func TestVerifyWitnessManifest(t *testing.T) {
	private := useTestKey(t)
	url := "https://github.com/opfield/opfield/releases/download/v2.12.0/witness-clickhouse-keeper-25.3.6-linux-amd64"
	good := WitnessManifestPayload{Kind: WitnessBinaryKind, Component: "witness-clickhouse-keeper", Version: "25.3.6", Arch: "amd64",
		ArtifactName: "witness-clickhouse-keeper-25.3.6-linux-amd64", DownloadURL: url, SHA256: testChecksum, CreatedAt: "2026-10-11T00:00:00Z"}
	expected := WitnessExpectation{Component: "witness-clickhouse-keeper", Version: "25.3.6", Arch: "amd64", DownloadURL: url, SHA256: testChecksum}
	if _, err := VerifyWitnessManifest(witnessManifest(t, private, good), expected); err != nil {
		t.Fatalf("valid witness manifest refused: %v", err)
	}
	daemonKind := good
	daemonKind.Kind = "daemon-binary"
	otherSHA := expected
	otherSHA.SHA256 = strings.Repeat("f", 64)
	otherComponent := expected
	otherComponent.Component = "witness-other"
	plainHTTP := good
	plainHTTP.DownloadURL = "http://example.test/keeper"
	plainExpected := expected
	plainExpected.DownloadURL = plainHTTP.DownloadURL
	_, foreign, _ := ed25519.GenerateKey(rand.Reader)
	for name, test := range map[string]struct {
		manifest string
		expected WitnessExpectation
	}{
		"daemon manifest kind":  {witnessManifest(t, private, daemonKind), expected},
		"wrong sha256":          {witnessManifest(t, private, good), otherSHA},
		"wrong component":       {witnessManifest(t, private, good), otherComponent},
		"plain http":            {witnessManifest(t, private, plainHTTP), plainExpected},
		"signed by another key": {witnessManifest(t, foreign, good), expected},
		"daemon manifest as-is": {testManifest, expected},
	} {
		if _, err := VerifyWitnessManifest(test.manifest, test.expected); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
