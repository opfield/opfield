package updateauth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"runtime"
	"strings"
)

const KeyID = "wiolett-update-v1"

// publicKeyPEM is generated from config/update-trust/update-signing-public-key.pem
// by scripts/sync-update-trust-anchor.sh so daemon binaries can embed it.
//
//go:embed update-signing-public-key.pem
var publicKeyPEM string

type Envelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	KeyID         string `json:"keyId"`
	Payload       string `json:"payload"`
	Signature     string `json:"signature"`
}

type DaemonManifestPayload struct {
	Kind          string `json:"kind"`
	Version       string `json:"version"`
	Tag           string `json:"tag"`
	DaemonType    string `json:"daemonType"`
	Arch          string `json:"arch"`
	ArtifactName  string `json:"artifactName"`
	DownloadURL   string `json:"downloadUrl"`
	SHA256        string `json:"sha256"`
	CreatedAt     string `json:"createdAt"`
	GitCommitSHA  string `json:"gitCommitSha,omitempty"`
	GitPipelineID string `json:"gitPipelineId,omitempty"`
}

type DaemonExpectation struct {
	DaemonType   string
	Version      string
	Tag          string
	Arch         string
	ArtifactName string
	DownloadURL  string
	SHA256       string
}

func VerifyDaemonManifest(signedManifest string, expected DaemonExpectation) (*DaemonManifestPayload, error) {
	payload, err := VerifyEnvelope[DaemonManifestPayload](signedManifest)
	if err != nil {
		return nil, err
	}
	if payload.Kind != "daemon-binary" {
		return nil, errors.New("update manifest kind is not daemon-binary")
	}
	if payload.DaemonType != expected.DaemonType {
		return nil, errors.New("update daemon type mismatch")
	}
	if payload.Version != expected.Version {
		return nil, errors.New("update version mismatch")
	}
	if payload.Tag != expected.Tag {
		return nil, errors.New("update tag mismatch")
	}
	if payload.Arch != expected.Arch {
		return nil, errors.New("update architecture mismatch")
	}
	if payload.ArtifactName != expected.ArtifactName {
		return nil, errors.New("update artifact name mismatch")
	}
	if payload.DownloadURL != expected.DownloadURL {
		return nil, errors.New("update download URL mismatch")
	}
	if payload.SHA256 != expected.SHA256 {
		return nil, errors.New("update checksum mismatch")
	}
	if !isValidSHA256(payload.SHA256) {
		return nil, errors.New("update checksum is invalid")
	}
	if !isTrustedHTTPSURL(payload.DownloadURL) {
		return nil, errors.New("update download URL is not trusted")
	}
	return payload, nil
}

// WitnessBinaryKind is the manifest kind of a witness process artifact (a
// ClickHouse Keeper binary a relay supervisor runs for an availability set).
// It is data, not a daemon release: new versions need no relay release.
const WitnessBinaryKind = "witness-binary"

type WitnessManifestPayload struct {
	Kind         string `json:"kind"`
	Component    string `json:"component"`
	Version      string `json:"version"`
	Arch         string `json:"arch"`
	ArtifactName string `json:"artifactName"`
	DownloadURL  string `json:"downloadUrl"`
	SHA256       string `json:"sha256"`
	CreatedAt    string `json:"createdAt"`
	GitCommitSHA string `json:"gitCommitSha,omitempty"`
}

type WitnessExpectation struct {
	Component   string
	Version     string
	Arch        string
	DownloadURL string
	SHA256      string
}

// VerifyWitnessManifest checks a witness artifact manifest against the
// compiled update key and the expected artifact. Only the witness-binary kind
// is accepted, so a daemon manifest can never stand for a witness and the
// reverse.
func VerifyWitnessManifest(signedManifest string, expected WitnessExpectation) (*WitnessManifestPayload, error) {
	payload, err := VerifyEnvelope[WitnessManifestPayload](signedManifest)
	if err != nil {
		return nil, err
	}
	if payload.Kind != WitnessBinaryKind {
		return nil, errors.New("witness manifest kind is not witness-binary")
	}
	if payload.Component == "" || payload.Component != expected.Component {
		return nil, errors.New("witness component mismatch")
	}
	if payload.Version != expected.Version {
		return nil, errors.New("witness version mismatch")
	}
	if payload.Arch != expected.Arch {
		return nil, errors.New("witness architecture mismatch")
	}
	if payload.DownloadURL != expected.DownloadURL {
		return nil, errors.New("witness download URL mismatch")
	}
	if payload.SHA256 != expected.SHA256 || !isValidSHA256(payload.SHA256) {
		return nil, errors.New("witness checksum mismatch")
	}
	if !isTrustedHTTPSURL(payload.DownloadURL) {
		return nil, errors.New("witness download URL is not trusted")
	}
	return payload, nil
}

func VerifyEnvelope[T any](signedManifest string) (*T, error) {
	var envelope Envelope
	if err := json.Unmarshal([]byte(signedManifest), &envelope); err != nil {
		return nil, fmt.Errorf("parse update manifest envelope: %w", err)
	}
	if envelope.SchemaVersion != 1 {
		return nil, errors.New("update manifest schema version is unsupported")
	}
	if envelope.KeyID != KeyID {
		return nil, errors.New("update manifest key ID is unknown")
	}
	if envelope.Payload == "" {
		return nil, errors.New("update manifest payload is missing")
	}
	if envelope.Signature == "" {
		return nil, errors.New("update manifest signature is missing")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return nil, fmt.Errorf("decode update manifest payload: %w", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature)
	if err != nil {
		return nil, fmt.Errorf("decode update manifest signature: %w", err)
	}

	publicKey, err := trustedKey()
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(publicKey, payloadBytes, signature) {
		return nil, errors.New("update manifest signature is invalid")
	}

	var payload T
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("parse update manifest payload: %w", err)
	}
	return &payload, nil
}

func NormalizeArch(arch string) string {
	switch strings.ToLower(strings.TrimSpace(arch)) {
	case "x86_64", "x64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	case "":
		return NormalizeArch(runtime.GOARCH)
	default:
		return strings.ToLower(strings.TrimSpace(arch))
	}
}

func SignPayload(privateKey ed25519.PrivateKey, payload []byte) Envelope {
	return Envelope{
		SchemaVersion: 1,
		KeyID:         KeyID,
		Payload:       base64.RawURLEncoding.EncodeToString(payload),
		Signature:     base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	}
}

func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// trustedKey is trustedPublicKey; tests of this package substitute a test key.
var trustedKey = trustedPublicKey

func trustedPublicKey() (ed25519.PublicKey, error) {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return nil, errors.New("trusted update public key PEM is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse trusted update public key: %w", err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("trusted update public key is not Ed25519")
	}
	return publicKey, nil
}

func isValidSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isTrustedHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" && parsed.Host != ""
}
