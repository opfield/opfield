package supervisor

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/protobuf/proto"
)

type enrollmentState struct {
	PoolID                   string `json:"poolId"`
	InstanceID               string `json:"instanceId"`
	HostIdentityID           string `json:"hostIdentityId"`
	PolicySigningKeyID       string `json:"policySigningKeyId"`
	PolicySigningPublicKey   []byte `json:"policySigningPublicKey"`
	PolicySigningFingerprint string `json:"policySigningFingerprint"`
	RelayServerIdentity      string `json:"relayServerIdentity"`
}

type enrollmentBundle struct {
	policyFingerprint string
	clientFingerprint string
}

func validateEnrollmentBundle(response *pb.EnrollResponse) (enrollmentBundle, error) {
	if response.GetRelayPoolId() == "" || response.GetRelayInstanceId() == "" ||
		response.GetPolicySigningKeyId() == "" || len(response.GetPolicySigningPublicKey()) != 32 ||
		response.GetRelayServerIdentity() == "" || len(response.GetRelayServerCertificate()) == 0 ||
		len(response.GetRelayServerKey()) == 0 {
		return enrollmentBundle{}, fmt.Errorf("relay enrollment bundle is incomplete")
	}
	digest := sha256.Sum256(response.GetPolicySigningPublicKey())
	fingerprint := "sha256:" + hex.EncodeToString(digest[:])
	if fingerprint != response.GetPolicySigningPublicKeyFingerprint() {
		return enrollmentBundle{}, fmt.Errorf("policy signing public key fingerprint mismatch")
	}
	clientBlock, _ := pem.Decode(response.GetClientCertificate())
	if clientBlock == nil {
		return enrollmentBundle{}, fmt.Errorf("client certificate is invalid")
	}
	clientCert, err := x509.ParseCertificate(clientBlock.Bytes)
	if err != nil {
		return enrollmentBundle{}, fmt.Errorf("parse client certificate: %w", err)
	}
	clientDigest := sha256.Sum256(clientCert.Raw)
	return enrollmentBundle{
		policyFingerprint: fingerprint,
		clientFingerprint: "sha256:" + hex.EncodeToString(clientDigest[:]),
	}, nil
}

// resetWorkerPolicyState moves the worker's pinned policy trust and identity
// rotation state aside. An enrollment is what authorizes policy trust: the
// worker must pin only the key the new bundle carries. Trust left from an
// earlier enrollment can hold only keys Gateway no longer signs with (the
// lockout a re-enrollment repairs), and its rotation state would keep the
// previous supervisor certificate authorized. The worker must not be running;
// the files are kept beside the originals for inspection.
func resetWorkerPolicyState(workerStateDir string, now time.Time) error {
	if workerStateDir == "" {
		return nil
	}
	suffix := fmt.Sprintf(".pre-enrollment-%d", now.Unix())
	for _, name := range []string{"relay.db", "identity-rotation.json"} {
		path := filepath.Join(workerStateDir, name)
		if err := os.Rename(path, path+suffix); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("reset relay worker %s: %w", name, err)
		}
	}
	return nil
}

func persistEnrollmentBundle(stateDir, identityDir string, response *pb.EnrollResponse) error {
	bundle, err := validateEnrollmentBundle(response)
	if err != nil {
		return err
	}
	fingerprint, clientFingerprint := bundle.policyFingerprint, bundle.clientFingerprint

	staging := identityDir + ".staging"
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return err
	}
	files := map[string]struct {
		content []byte
		mode    os.FileMode
	}{
		"system-ca.crt":        {response.GetCaCertificate(), 0o644},
		"external-server.crt":  {response.GetRelayServerCertificate(), 0o644},
		"external-server.key":  {response.GetRelayServerKey(), 0o600},
		"app-relay-client.crt": {response.GetClientCertificate(), 0o644},
		"app-relay-client.key": {response.GetClientKey(), 0o600},
		"relay-app-client.crt": {response.GetClientCertificate(), 0o644},
		"relay-app-client.key": {response.GetClientKey(), 0o600},
	}
	trust, _ := json.Marshal(map[string]any{
		"version": 1, "appRelayClientFingerprint": clientFingerprint, "relayAppClientFingerprint": clientFingerprint,
	})
	files["trust-manifest.json"] = struct {
		content []byte
		mode    os.FileMode
	}{trust, 0o600}
	for name, file := range files {
		if err := os.WriteFile(filepath.Join(staging, name), file.content, file.mode); err != nil {
			_ = os.RemoveAll(staging)
			return err
		}
	}
	backup := identityDir + ".previous"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(identityDir); err == nil {
		if err := os.Rename(identityDir, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(staging, identityDir); err != nil {
		_ = os.Rename(backup, identityDir)
		return err
	}
	_ = os.RemoveAll(backup)

	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	state := enrollmentState{
		PoolID: response.GetRelayPoolId(), InstanceID: response.GetRelayInstanceId(),
		HostIdentityID: response.GetHostIdentityId(), PolicySigningKeyID: response.GetPolicySigningKeyId(),
		PolicySigningPublicKey:   append([]byte(nil), response.GetPolicySigningPublicKey()...),
		PolicySigningFingerprint: fingerprint, RelayServerIdentity: response.GetRelayServerIdentity(),
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(stateDir, "enrollment.json"), encoded, 0o600)
}

const pendingEnrollmentFile = "enrollment-pending.pb"

func savePendingEnrollment(stateDir string, response *pb.EnrollResponse) error {
	encoded, err := proto.Marshal(response)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(stateDir, pendingEnrollmentFile), encoded, 0o600)
}

func loadPendingEnrollment(stateDir string) (*pb.EnrollResponse, error) {
	encoded, err := os.ReadFile(filepath.Join(stateDir, pendingEnrollmentFile))
	if err != nil {
		return nil, err
	}
	response := &pb.EnrollResponse{}
	if err := proto.Unmarshal(encoded, response); err != nil {
		return nil, fmt.Errorf("decode pending relay enrollment: %w", err)
	}
	return response, nil
}

func removePendingEnrollment(stateDir string) error {
	if err := os.Remove(filepath.Join(stateDir, pendingEnrollmentFile)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func loadEnrollmentState(stateDir string) (*enrollmentState, error) {
	encoded, err := os.ReadFile(filepath.Join(stateDir, "enrollment.json"))
	if err != nil {
		return nil, err
	}
	var state enrollmentState
	if err := json.Unmarshal(encoded, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func atomicWrite(path string, encoded []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, encoded, mode); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
