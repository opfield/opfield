package supervisor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

const (
	workerServerCertificate         = "external-server.crt"
	workerServerKey                 = "external-server.key"
	workerPreviousServerCertificate = "external-server.previous.crt"
	workerPreviousServerKey         = "external-server.previous.key"
	workerAdminClientCertificate    = "app-relay-client.crt"
	workerAdminClientKey            = "app-relay-client.key"
	workerAppClientCertificate      = "relay-app-client.crt"
	workerAppClientKey              = "relay-app-client.key"
	workerTrustManifest             = "trust-manifest.json"
	workerIdentityUpdatingMarker    = ".updating"
	workerIdentityStagingSuffix     = ".renewal-staging"
	workerIdentityBackupSuffix      = ".renewal-previous"
	workerIdentityFailedSuffix      = ".renewal-failed"
	adminClientSyncInterval         = 10 * time.Minute
	workerRestartReadyTimeout       = 30 * time.Second
	// serverCertificateRolloverCapability is what a worker advertises when it
	// keeps serving external-server.previous.* by that certificate's identity.
	serverCertificateRolloverCapability = "server_certificate_rollover_v1"
)

// errNoIdentityChange means the worker already holds the material.
var errNoIdentityChange = errors.New("relay worker identity is already current")

func fingerprintDER(der []byte) string {
	digest := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func pemFingerprint(certificatePEM []byte) (string, *x509.Certificate, error) {
	block, _ := pem.Decode(certificatePEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", nil, fmt.Errorf("certificate is not PEM encoded")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", nil, err
	}
	return fingerprintDER(block.Bytes), certificate, nil
}

func systemRoots(identityDir string) (*x509.CertPool, error) {
	caPEM, err := os.ReadFile(filepath.Join(identityDir, "system-ca.crt"))
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("relay worker system CA is invalid")
	}
	return roots, nil
}

// verifiedPair checks that a certificate/key pair belongs together, chains to
// the system CA for the given usage and is valid now.
func verifiedPair(certificatePEM, keyPEM []byte, roots *x509.CertPool, usage x509.ExtKeyUsage, serverName string, now time.Time) (string, error) {
	if _, err := tls.X509KeyPair(certificatePEM, keyPEM); err != nil {
		return "", fmt.Errorf("certificate and key do not match: %w", err)
	}
	fingerprint, leaf, err := pemFingerprint(certificatePEM)
	if err != nil {
		return "", err
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{usage}, DNSName: serverName, CurrentTime: now}); err != nil {
		return "", fmt.Errorf("certificate is not valid for the relay: %w", err)
	}
	return fingerprint, nil
}

type identityFile struct {
	name    string
	content []byte
	mode    os.FileMode
}

// stagedWorkerIdentity is the worker identity material a renewal writes.
type stagedWorkerIdentity struct {
	files       []identityFile
	removals    []string
	adminChange bool
	// The certificate daemons may still pin, kept as "previous", and the
	// identity (TLS server name) they ask for it by.
	retainedIdentity    string
	retainedFingerprint string
}

// planWorkerIdentity decides what the worker identity directory needs: a
// renewed server certificate (keeping the one daemons pin as "previous"),
// and/or the supervisor's current client certificate as its admin client.
func planWorkerIdentity(identityDir string, renewal *pb.RenewRelayIdentityCommand, adminCertificate, adminKey []byte, now time.Time) (*stagedWorkerIdentity, error) {
	roots, err := systemRoots(identityDir)
	if err != nil {
		return nil, err
	}
	plan := &stagedWorkerIdentity{}
	if renewal != nil {
		if renewal.GetServerIdentity() == "" {
			return nil, fmt.Errorf("renewed relay server identity is required")
		}
		renewed, err := verifiedPair(renewal.GetServerCertificate(), renewal.GetServerKey(), roots, x509.ExtKeyUsageServerAuth, renewal.GetServerIdentity(), now)
		if err != nil {
			return nil, fmt.Errorf("renewed relay server certificate: %w", err)
		}
		// Keep the certificate daemons pin, whichever file holds it now. When
		// Opfield names none the worker holds, keep the one it serves today:
		// daemons were handed that one most recently.
		type pair struct {
			certificate, key []byte
			fingerprint      string
			leaf             *x509.Certificate
		}
		load := func(certificateName, keyName string) *pair {
			certificatePEM, certErr := os.ReadFile(filepath.Join(identityDir, certificateName))
			keyPEM, keyErr := os.ReadFile(filepath.Join(identityDir, keyName))
			if certErr != nil || keyErr != nil {
				return nil
			}
			fingerprint, leaf, parseErr := pemFingerprint(certificatePEM)
			if parseErr != nil || fingerprint == renewed || !now.Before(leaf.NotAfter) {
				return nil
			}
			return &pair{certificatePEM, keyPEM, fingerprint, leaf}
		}
		current := load(workerServerCertificate, workerServerKey)
		previous := load(workerPreviousServerCertificate, workerPreviousServerKey)
		var retained *pair
		for _, candidate := range []*pair{current, previous} {
			if candidate != nil && candidate.fingerprint == renewal.GetRetainServerFingerprint() {
				retained = candidate
				break
			}
		}
		if retained == nil {
			retained = current
		}
		if retained != nil {
			plan.files = append(plan.files,
				identityFile{workerPreviousServerCertificate, retained.certificate, 0o644},
				identityFile{workerPreviousServerKey, retained.key, 0o600},
			)
			plan.retainedFingerprint = retained.fingerprint
			plan.retainedIdentity = retained.leaf.Subject.CommonName
			if plan.retainedIdentity == "" && len(retained.leaf.DNSNames) > 0 {
				plan.retainedIdentity = retained.leaf.DNSNames[0]
			}
		} else if previous == nil {
			plan.removals = append(plan.removals, workerPreviousServerCertificate, workerPreviousServerKey)
		}
		plan.files = append(plan.files,
			identityFile{workerServerCertificate, renewal.GetServerCertificate(), 0o644},
			identityFile{workerServerKey, renewal.GetServerKey(), 0o600},
		)
	}
	if len(adminCertificate) > 0 {
		adminFingerprint, err := verifiedPair(adminCertificate, adminKey, roots, x509.ExtKeyUsageClientAuth, "", now)
		if err != nil {
			return nil, fmt.Errorf("relay supervisor client certificate: %w", err)
		}
		currentPEM, readErr := os.ReadFile(filepath.Join(identityDir, workerAdminClientCertificate))
		current := ""
		if readErr == nil {
			current, _, _ = pemFingerprint(currentPEM)
		}
		if current != adminFingerprint {
			plan.adminChange = true
			trust, _ := json.Marshal(map[string]any{
				"version": 1, "appRelayClientFingerprint": adminFingerprint, "relayAppClientFingerprint": adminFingerprint,
			})
			plan.files = append(plan.files,
				identityFile{workerAdminClientCertificate, adminCertificate, 0o644},
				identityFile{workerAdminClientKey, adminKey, 0o600},
				identityFile{workerAppClientCertificate, adminCertificate, 0o644},
				identityFile{workerAppClientKey, adminKey, 0o600},
				identityFile{workerTrustManifest, trust, 0o600},
			)
		}
	}
	if len(plan.files) == 0 && len(plan.removals) == 0 {
		return nil, errNoIdentityChange
	}
	return plan, nil
}

// identitySwap is a worker identity directory replaced as a whole. The
// previous directory stays until commit, so a failed renewal is rolled back
// completely: a certificate is never left without its key.
type identitySwap struct{ dir string }

func (s identitySwap) commit() { _ = os.RemoveAll(s.dir + workerIdentityBackupSuffix) }

func (s identitySwap) rollback() error {
	backup := s.dir + workerIdentityBackupSuffix
	if _, err := os.Stat(backup); err != nil {
		return err
	}
	failed := s.dir + workerIdentityFailedSuffix
	_ = os.RemoveAll(failed)
	if err := os.Rename(s.dir, failed); err != nil {
		return err
	}
	if err := os.Rename(backup, s.dir); err != nil {
		_ = os.Rename(failed, s.dir)
		return err
	}
	return os.RemoveAll(failed)
}

// swapWorkerIdentity builds the new identity in a staging directory and swaps
// it in with two renames. The worker reads its identity only when it starts
// (and retries a missing directory) or when asked to reload afterwards.
func swapWorkerIdentity(identityDir string, plan *stagedWorkerIdentity) (identitySwap, error) {
	staging := identityDir + workerIdentityStagingSuffix
	backup := identityDir + workerIdentityBackupSuffix
	_ = os.RemoveAll(staging)
	if err := copyIdentityDir(identityDir, staging); err != nil {
		_ = os.RemoveAll(staging)
		return identitySwap{}, err
	}
	for _, file := range plan.files {
		if err := os.WriteFile(filepath.Join(staging, file.name), file.content, file.mode); err != nil {
			_ = os.RemoveAll(staging)
			return identitySwap{}, err
		}
	}
	for _, name := range plan.removals {
		if err := os.Remove(filepath.Join(staging, name)); err != nil && !os.IsNotExist(err) {
			_ = os.RemoveAll(staging)
			return identitySwap{}, err
		}
	}
	_ = os.RemoveAll(backup)
	if err := os.Rename(identityDir, backup); err != nil {
		_ = os.RemoveAll(staging)
		return identitySwap{}, err
	}
	if err := os.Rename(staging, identityDir); err != nil {
		_ = os.Rename(backup, identityDir)
		_ = os.RemoveAll(staging)
		return identitySwap{}, err
	}
	return identitySwap{dir: identityDir}, nil
}

func copyIdentityDir(source, target string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || entry.Name() == workerIdentityUpdatingMarker {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		content, err := os.ReadFile(filepath.Join(source, entry.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(target, entry.Name()), content, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

// RecoverWorkerIdentity repairs what an interrupted enrollment or renewal left
// in the worker identity directory, before the worker starts. A stale update
// marker would otherwise keep the worker from ever loading its identity.
func RecoverWorkerIdentity(identityDir string) error {
	if identityDir == "" {
		return nil
	}
	_ = os.RemoveAll(identityDir + workerIdentityStagingSuffix)
	_ = os.RemoveAll(identityDir + workerIdentityFailedSuffix)
	for _, backup := range []string{identityDir + workerIdentityBackupSuffix, identityDir + ".previous"} {
		if _, err := os.Stat(backup); err != nil {
			continue
		}
		if _, err := os.Stat(identityDir); os.IsNotExist(err) {
			// Killed between the two renames: the previous identity is complete.
			if err := os.Rename(backup, identityDir); err != nil {
				return err
			}
			continue
		}
		// The swap completed; the new identity serves both certificates.
		_ = os.RemoveAll(backup)
	}
	_ = os.Remove(filepath.Join(identityDir, workerIdentityUpdatingMarker))
	return nil
}

func randomOperationID() string {
	value := make([]byte, 16)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

// renewIdentity installs a renewed server certificate on the worker and
// returns the fingerprint the worker now serves for the renewed identity.
func (m *workerManager) renewIdentity(ctx context.Context, renewal *pb.RenewRelayIdentityCommand, adminCertificatePath, adminKeyPath string) (string, error) {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	// An older worker serves only its current certificate: renewing it would cut
	// off every daemon that still pins the one it replaces.
	health, err := m.health(ctx)
	if err != nil {
		return "", fmt.Errorf("relay worker is unavailable for a certificate renewal: %w", err)
	}
	if !hasCapability(health.GetCapabilities(), serverCertificateRolloverCapability) {
		return "", fmt.Errorf("relay worker %s cannot keep serving the certificate daemons pin during a renewal; update the relay worker first", health.GetBuildVersion())
	}
	adminCertificate, adminKey := readOptionalPair(adminCertificatePath, adminKeyPath)
	plan, err := planWorkerIdentity(m.cfg.IdentityDir, renewal, adminCertificate, adminKey, time.Now())
	if err != nil && !errors.Is(err, errNoIdentityChange) {
		return "", err
	}
	if plan == nil {
		// Already installed (a retried command): only confirm what is served.
		return m.verifyServedCertificates(ctx, renewal, nil)
	}
	previousIdentity := m.serverIdentity()
	swap, err := swapWorkerIdentity(m.cfg.IdentityDir, plan)
	if err != nil {
		return "", fmt.Errorf("write relay worker identity: %w", err)
	}
	served, err := "", m.applyStagedIdentity(ctx, renewal.GetServerIdentity())
	if err == nil {
		served, err = m.verifyServedCertificates(ctx, renewal, plan)
	}
	if err != nil {
		// Put the worker back on the identity daemons use now.
		if rollbackErr := swap.rollback(); rollbackErr == nil {
			_ = m.applyStagedIdentity(ctx, previousIdentity)
		}
		return "", err
	}
	swap.commit()
	return served, nil
}

// verifyServedCertificates checks, as a daemon would, that the worker serves
// the renewed certificate by its new identity and still serves the one daemons
// pin by the old identity.
func (m *workerManager) verifyServedCertificates(ctx context.Context, renewal *pb.RenewRelayIdentityCommand, plan *stagedWorkerIdentity) (string, error) {
	served, err := m.servedServerFingerprint(ctx, renewal.GetServerIdentity())
	if err != nil {
		return "", fmt.Errorf("relay worker does not serve the renewed certificate: %w", err)
	}
	expected, _, _ := pemFingerprint(renewal.GetServerCertificate())
	if served != expected {
		return "", fmt.Errorf("relay worker serves %s for %s, expected %s", served, renewal.GetServerIdentity(), expected)
	}
	if plan != nil && plan.retainedIdentity != "" {
		retained, err := m.servedServerFingerprint(ctx, plan.retainedIdentity)
		if err != nil || retained != plan.retainedFingerprint {
			return "", fmt.Errorf("relay worker no longer serves the certificate daemons pin for %s", plan.retainedIdentity)
		}
	}
	return served, nil
}

func (m *workerManager) serverIdentity() string {
	state, err := loadEnrollmentState(m.enrollmentStateDir)
	if err != nil {
		return ""
	}
	return state.RelayServerIdentity
}

func hasCapability(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// syncAdminClient keeps the worker's admin client on the supervisor's current
// certificate, which the daemon lifecycle renews before it expires. Skipped
// while a worker update or renewal holds the worker.
func (m *workerManager) syncAdminClient(ctx context.Context, adminCertificatePath, adminKeyPath string) error {
	if !m.updateMu.TryLock() {
		return nil
	}
	defer m.updateMu.Unlock()
	adminCertificate, adminKey := readOptionalPair(adminCertificatePath, adminKeyPath)
	if len(adminCertificate) == 0 {
		return nil
	}
	plan, err := planWorkerIdentity(m.cfg.IdentityDir, nil, adminCertificate, adminKey, time.Now())
	if errors.Is(err, errNoIdentityChange) {
		return nil
	}
	if err != nil {
		return err
	}
	swap, err := swapWorkerIdentity(m.cfg.IdentityDir, plan)
	if err != nil {
		return err
	}
	if err := m.applyStagedIdentity(ctx, ""); err != nil {
		if rollbackErr := swap.rollback(); rollbackErr == nil {
			_ = m.applyStagedIdentity(ctx, "")
		}
		return err
	}
	swap.commit()
	return nil
}

func readOptionalPair(certificatePath, keyPath string) ([]byte, []byte) {
	if certificatePath == "" || keyPath == "" {
		return nil, nil
	}
	certificatePEM, certErr := os.ReadFile(certificatePath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr != nil || keyErr != nil {
		return nil, nil
	}
	return certificatePEM, keyPEM
}

// applyStagedIdentity makes the running worker load the staged files. A live
// reload keeps every tunnel; the admin client that is still trusted asks for
// it, and the new admin client then commits the rotation. Only when the
// worker cannot be asked (not running, or its admin client expired) is it
// restarted onto the new files.
func (m *workerManager) applyStagedIdentity(ctx context.Context, serverIdentity string) error {
	operationID := randomOperationID()
	reloadErr := func() error {
		client, err := m.connectAdmin(ctx)
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err = client.ReloadIdentity(callCtx, &relayv1.ReloadIdentityRequest{OperationId: operationID})
		return err
	}()
	if serverIdentity != "" {
		if err := m.setServerIdentity(serverIdentity); err != nil {
			return err
		}
	}
	m.resetAdminClient()
	if reloadErr != nil {
		m.shutdown()
		if err := m.ensureRunning(); err != nil {
			return fmt.Errorf("restart relay worker with renewed identity: %w", err)
		}
		deadline := time.Now().Add(workerRestartReadyTimeout)
		for {
			if _, err := m.health(ctx); err == nil {
				return nil
			} else if time.Now().After(deadline) {
				return fmt.Errorf("relay worker did not come back after an identity restart: %w", err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := client.CommitIdentityRotation(callCtx, &relayv1.CommitIdentityRotationRequest{OperationId: operationID}); err != nil {
		// The previous admin client stays trusted until a commit; nothing is lost.
		return fmt.Errorf("commit relay worker identity rotation: %w", err)
	}
	return nil
}

// setServerIdentity records the identity the supervisor asks its worker for.
func (m *workerManager) setServerIdentity(identity string) error {
	state, err := loadEnrollmentState(m.enrollmentStateDir)
	if err != nil {
		return err
	}
	state.RelayServerIdentity = identity
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(m.enrollmentStateDir, "enrollment.json"), encoded, 0o600); err != nil {
		return err
	}
	m.mu.Lock()
	m.state = state
	m.mu.Unlock()
	return nil
}

func (m *workerManager) resetAdminClient() {
	m.mu.Lock()
	conn := m.clientConn
	m.client = nil
	m.clientConn = nil
	m.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// servedServerFingerprint completes a TLS handshake with the worker as a
// daemon does for serverName and returns the certificate it was given.
func (m *workerManager) servedServerFingerprint(ctx context.Context, serverName string) (string, error) {
	roots, err := systemRoots(m.cfg.IdentityDir)
	if err != nil {
		return "", err
	}
	certificate, err := tls.LoadX509KeyPair(
		filepath.Join(m.cfg.IdentityDir, workerAdminClientCertificate),
		filepath.Join(m.cfg.IdentityDir, workerAdminClientKey),
	)
	if err != nil {
		return "", err
	}
	dialer := &tls.Dialer{Config: &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: serverName,
		Certificates: []tls.Certificate{certificate}, NextProtos: []string{"h2"},
	}}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := dialer.DialContext(dialCtx, "tcp", fmt.Sprintf("127.0.0.1:%d", m.servicePort()))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	peers := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(peers) == 0 {
		return "", fmt.Errorf("relay worker presented no certificate")
	}
	return fingerprintDER(peers[0].Raw), nil
}
