package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

func TestRelayManifestIncludesOnlySecureLinkConnectorImage(t *testing.T) {
	keyDir := filepath.Join(t.TempDir(), "keys")
	keygen([]string{"--out-dir", keyDir})
	encodedKey, err := os.ReadFile(filepath.Join(keyDir, "private.pem.b64"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("UPDATE_SIGNING_PRIVATE_KEY_PEM_B64", string(encodedKey))

	out := filepath.Join(t.TempDir(), "relay-image.update.json")
	digest := "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	secureLinkConnector := "registry.example/gateway/secure-link-connector@" + digest
	sign([]string{
		"--kind", "relay-image",
		"--version", "v1.2.3",
		"--tag", "v1.2.3-relay",
		"--image", "registry.example/gateway/relay",
		"--digest", digest,
		"--relay-protocol-major", "1",
		"--min-gateway-version", "v1.2.3",
		"--secure-link-connector-image", secureLinkConnector,
		"--out", out,
	})

	manifestBytes, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var envelope updateauth.Envelope
	if err := json.Unmarshal(manifestBytes, &envelope); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatal(err)
	}
	if _, exists := payload["databaseConnectorImage"]; exists {
		t.Fatalf("database connector image must not be published: %v", payload["databaseConnectorImage"])
	}
	if payload["secureLinkConnectorImage"] != secureLinkConnector {
		t.Fatalf("secure-link connector image = %v, want %s", payload["secureLinkConnectorImage"], secureLinkConnector)
	}
}

func TestWitnessManifestIsAWitnessBinary(t *testing.T) {
	keyDir := filepath.Join(t.TempDir(), "keys")
	keygen([]string{"--out-dir", keyDir})
	encodedKey, err := os.ReadFile(filepath.Join(keyDir, "private.pem.b64"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("UPDATE_SIGNING_PRIVATE_KEY_PEM_B64", string(encodedKey))
	out := filepath.Join(t.TempDir(), "witness.update.json")
	sha := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	sign([]string{
		"--kind", "witness-binary",
		"--component", "witness-clickhouse-keeper",
		"--version", "25.8.28.1",
		"--arch", "arm64",
		"--artifact-name", "witness-clickhouse-keeper-25.8.28.1-linux-arm64",
		"--download-url", "https://updates.example/gateway/witness-clickhouse-keeper/v2.12.0/witness-clickhouse-keeper-25.8.28.1-linux-arm64",
		"--sha256", sha,
		"--out", out,
	})
	manifestBytes, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var envelope updateauth.Envelope
	if err := json.Unmarshal(manifestBytes, &envelope); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var payload updateauth.WitnessManifestPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Kind != updateauth.WitnessBinaryKind || payload.Component != "witness-clickhouse-keeper" || payload.Arch != "arm64" || payload.SHA256 != sha {
		t.Fatalf("witness manifest payload %+v", payload)
	}
}
