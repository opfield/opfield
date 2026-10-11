package identity

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var ErrMaterialUpdating = errors.New("relay identity material is being updated")

// ServerCertificateRolloverCapability tells a supervisor, and Gateway, that this
// worker keeps serving external-server.previous.* by that certificate's own
// identity. A renewal must not be installed on a worker without it: daemons
// still pinning the previous certificate would be cut off.
const ServerCertificateRolloverCapability = "server_certificate_rollover_v1"

type TrustManifest struct {
	Version                   int    `json:"version"`
	AppRelayClientFingerprint string `json:"appRelayClientFingerprint"`
	RelayAppClientFingerprint string `json:"relayAppClientFingerprint"`
}

type Snapshot struct {
	SystemCA    *x509.CertPool
	SystemCAPEM []byte
	External    tls.Certificate
	// PreviousExternal is the server certificate a renewal replaced. Daemons pin
	// it until their grant bundles name the renewed one, and they ask for it by
	// its own identity, so it is served to clients that name it.
	PreviousExternal *tls.Certificate
	AppClient        tls.Certificate
	RelayClient      tls.Certificate
	Trust            TrustManifest
}

// ServerCertificate picks the certificate for a TLS client that asked for
// serverName: the previous one when it names that identity and the current
// one does not, while it is still valid; otherwise the current one.
// LoadedFingerprints names the external server certificate, the relay's own
// client certificate toward Gateway, and the Gateway client certificate it
// trusts, as loaded. Gateway compares them with what it installed before it
// treats an identity rotation as done.
func (s *Snapshot) LoadedFingerprints() (external, relayClient, appClient string) {
	if len(s.External.Certificate) > 0 {
		external = Fingerprint(s.External.Certificate[0])
	}
	if len(s.RelayClient.Certificate) > 0 {
		relayClient = Fingerprint(s.RelayClient.Certificate[0])
	}
	return external, relayClient, s.Trust.AppRelayClientFingerprint
}

func (s *Snapshot) ServerCertificate(serverName string, now time.Time) tls.Certificate {
	previous := s.PreviousExternal
	if previous == nil || serverName == "" || previous.Leaf == nil || !now.Before(previous.Leaf.NotAfter) {
		return s.External
	}
	if s.External.Leaf != nil && s.External.Leaf.VerifyHostname(serverName) == nil {
		return s.External
	}
	if previous.Leaf.VerifyHostname(serverName) != nil {
		return s.External
	}
	return *previous
}

type Store struct {
	dir       string
	statePath string
	current   atomic.Pointer[Snapshot]
	rotation  rotationState
	mu        sync.RWMutex
}

type rotationState struct {
	Version                  int    `json:"version"`
	CurrentFingerprint       string `json:"currentFingerprint"`
	PreviousFingerprint      string `json:"previousFingerprint,omitempty"`
	PendingOperationID       string `json:"pendingOperationId,omitempty"`
	LastCommittedOperationID string `json:"lastCommittedOperationId,omitempty"`
}

func NewStore(dir, stateDir string) (*Store, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	store := &Store{dir: dir, statePath: filepath.Join(stateDir, "identity-rotation.json")}
	loaded, err := store.readSnapshot()
	if err != nil {
		return nil, err
	}
	store.current.Store(loaded)
	if err := store.loadRotationState(loaded.Trust.AppRelayClientFingerprint); err != nil {
		return nil, err
	}
	return store, nil
}

// LoadSnapshot reads the identity material without opening the rotation state.
// The container health check uses it: it runs beside the live relay and must
// never write identity-rotation.json, or it could resurrect a committed
// rotation's previous client fingerprint.
func LoadSnapshot(dir string) (*Snapshot, error) {
	return (&Store{dir: dir}).readSnapshot()
}

func (s *Store) Current() *Snapshot { return s.current.Load() }

func (s *Store) Reload(operationID string) error {
	if operationID == "" || len(operationID) > 128 {
		return fmt.Errorf("identity rotation operation ID is invalid")
	}
	next, err := s.readSnapshot()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.current.Load()
	rotation := s.rotation
	rotation.Version = 1
	rotation.CurrentFingerprint = next.Trust.AppRelayClientFingerprint
	rotation.PendingOperationID = operationID
	if current != nil && current.Trust.AppRelayClientFingerprint != next.Trust.AppRelayClientFingerprint {
		rotation.PreviousFingerprint = current.Trust.AppRelayClientFingerprint
	}
	if err := s.persistRotationState(rotation); err != nil {
		return err
	}
	s.rotation = rotation
	s.current.Store(next)
	return nil
}

func (s *Store) readSnapshot() (*Snapshot, error) {
	if _, err := os.Stat(filepath.Join(s.dir, ".updating")); err == nil {
		return nil, ErrMaterialUpdating
	}
	read := func(name string) ([]byte, error) { return os.ReadFile(filepath.Join(s.dir, name)) }
	caPEM, err := read("system-ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("system CA is invalid")
	}
	loadPair := func(certName, keyName string) (tls.Certificate, error) {
		cert, err := read(certName)
		if err != nil {
			return tls.Certificate{}, err
		}
		key, err := read(keyName)
		if err != nil {
			return tls.Certificate{}, err
		}
		return tls.X509KeyPair(cert, key)
	}
	external, err := loadPair("external-server.crt", "external-server.key")
	if err != nil {
		return nil, err
	}
	appClient, err := loadPair("app-relay-client.crt", "app-relay-client.key")
	if err != nil {
		return nil, err
	}
	relayClient, err := loadPair("relay-app-client.crt", "relay-app-client.key")
	if err != nil {
		return nil, err
	}
	manifestBytes, err := read("trust-manifest.json")
	if err != nil {
		return nil, err
	}
	var trust TrustManifest
	if err := json.Unmarshal(manifestBytes, &trust); err != nil {
		return nil, err
	}
	if trust.Version != 1 || !validFingerprint(trust.AppRelayClientFingerprint) || !validFingerprint(trust.RelayAppClientFingerprint) {
		return nil, fmt.Errorf("relay trust manifest is invalid")
	}
	if len(appClient.Certificate) == 0 || Fingerprint(appClient.Certificate[0]) != trust.AppRelayClientFingerprint {
		return nil, fmt.Errorf("app relay client certificate does not match trust manifest")
	}
	if len(relayClient.Certificate) == 0 || Fingerprint(relayClient.Certificate[0]) != trust.RelayAppClientFingerprint {
		return nil, fmt.Errorf("relay app client certificate does not match trust manifest")
	}
	// The retained certificate is optional: without it, or when it cannot be
	// loaded, the relay serves only its current certificate.
	var previousExternal *tls.Certificate
	if previous, previousErr := loadPair("external-server.previous.crt", "external-server.previous.key"); previousErr == nil && len(previous.Certificate) > 0 {
		if leaf, parseErr := x509.ParseCertificate(previous.Certificate[0]); parseErr == nil {
			previous.Leaf = leaf
			previousExternal = &previous
		}
	}
	if len(external.Certificate) > 0 && external.Leaf == nil {
		if leaf, parseErr := x509.ParseCertificate(external.Certificate[0]); parseErr == nil {
			external.Leaf = leaf
		}
	}
	if _, err := os.Stat(filepath.Join(s.dir, ".updating")); err == nil {
		return nil, fmt.Errorf("relay identity material changed during reload: %w", ErrMaterialUpdating)
	}
	return &Snapshot{SystemCA: pool, SystemCAPEM: caPEM, External: external, PreviousExternal: previousExternal, AppClient: appClient, RelayClient: relayClient, Trust: trust}, nil
}

// AuthorizeAppClient retains the previous Gateway client until an explicit,
// operation-bound commit. Health probes and unrelated admin RPCs never commit.
func (s *Store) AuthorizeAppClient(fingerprint string) bool {
	current := s.Current().Trust.AppRelayClientFingerprint
	if subtle.ConstantTimeCompare([]byte(fingerprint), []byte(current)) == 1 {
		return true
	}
	s.mu.RLock()
	previous := s.rotation.PreviousFingerprint
	s.mu.RUnlock()
	return previous != "" && subtle.ConstantTimeCompare([]byte(fingerprint), []byte(previous)) == 1
}

func (s *Store) CommitAppClientRotation(operationID, fingerprint string) error {
	current := s.Current().Trust.AppRelayClientFingerprint
	if subtle.ConstantTimeCompare([]byte(fingerprint), []byte(current)) != 1 {
		return fmt.Errorf("identity rotation must be committed by the current Opfield client")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rotation.LastCommittedOperationID == operationID {
		return nil
	}
	if operationID == "" || s.rotation.PendingOperationID != operationID {
		return fmt.Errorf("identity rotation operation is not pending")
	}
	next := s.rotation
	next.PreviousFingerprint = ""
	next.PendingOperationID = ""
	next.LastCommittedOperationID = operationID
	if err := s.persistRotationState(next); err != nil {
		return err
	}
	s.rotation = next
	return nil
}

func (s *Store) loadRotationState(currentFingerprint string) error {
	encoded, err := os.ReadFile(s.statePath)
	if err != nil {
		if os.IsNotExist(err) {
			s.rotation = rotationState{Version: 1, CurrentFingerprint: currentFingerprint}
			return s.persistRotationState(s.rotation)
		}
		return err
	}
	var loaded rotationState
	if err := json.Unmarshal(encoded, &loaded); err != nil {
		return fmt.Errorf("decode identity rotation state: %w", err)
	}
	if loaded.Version != 1 || !validFingerprint(loaded.CurrentFingerprint) ||
		(loaded.PreviousFingerprint != "" && !validFingerprint(loaded.PreviousFingerprint)) ||
		len(loaded.PendingOperationID) > 128 || len(loaded.LastCommittedOperationID) > 128 {
		return fmt.Errorf("identity rotation state is invalid")
	}
	if loaded.CurrentFingerprint != currentFingerprint {
		// Identity files can be atomically replaced immediately before the relay
		// restarts. Retain the last durable client fingerprint so the still-running
		// Gateway can initiate and explicitly commit the rotation after restart.
		s.rotation = rotationState{
			Version:             1,
			CurrentFingerprint:  currentFingerprint,
			PreviousFingerprint: loaded.CurrentFingerprint,
		}
		return s.persistRotationState(s.rotation)
	}
	s.rotation = loaded
	return nil
}

func (s *Store) persistRotationState(state rotationState) error {
	if s.statePath == "" {
		return nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.pending-%d", s.statePath, os.Getpid())
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(encoded); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, s.statePath); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(s.statePath))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (s *Store) ServerTLSConfig() *tls.Config {
	base := &tls.Config{
		MinVersion: tls.VersionTLS13,
		ClientAuth: tls.VerifyClientCertIfGiven,
		NextProtos: []string{"h2"},
	}
	base.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		current := s.Current()
		clone := base.Clone()
		clone.GetConfigForClient = nil
		clone.ClientCAs = current.SystemCA
		serverName := ""
		if hello != nil {
			serverName = hello.ServerName
		}
		clone.Certificates = []tls.Certificate{current.ServerCertificate(serverName, time.Now())}
		return clone, nil
	}
	return base
}

func (s *Store) AppTLSConfig(serverName string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		ServerName: serverName,
		RootCAs:    s.Current().SystemCA,
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			certificate := s.Current().RelayClient
			return &certificate, nil
		},
	}
}

func Fingerprint(raw []byte) string {
	digest := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func validFingerprint(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != len("sha256:")+64 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}
