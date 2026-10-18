package supervisor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/proto"
)

type workerManager struct {
	cfg                config.WorkerConfig
	enrollmentStateDir string
	mu                 sync.Mutex
	process            *exec.Cmd
	processDone        chan struct{}
	clientConn         *grpc.ClientConn
	client             relayv1.RelayAdminClient
	state              *enrollmentState
	lastError          string
	// updateMu is held while an update or identity renewal stops and starts
	// the worker itself.
	updateMu sync.Mutex
	// replaceBinary installs a verified worker binary at the destination.
	replaceBinary func(downloadURL, targetVersion, checksum, signedManifest, daemonType, destination string, logger *slog.Logger) error
	// checkPort tells whether the worker could listen on a port.
	checkPort func(port int) error
	// servingPort is the port the worker last served on, which the runtime
	// status reports: during a port change cfg.ServicePort is the port being
	// tried, and Opfield must not hand daemons that one before the worker is
	// ready on it.
	servingPort int
}

func newWorkerManager(cfg config.WorkerConfig, enrollmentStateDir string) *workerManager {
	return &workerManager{
		cfg: cfg, enrollmentStateDir: enrollmentStateDir, servingPort: cfg.ServicePort,
		replaceBinary: lifecycle.ReplaceBinaryAtPath, checkPort: canListenOn,
	}
}

// reportedServicePort is the port daemons are to dial: the one the worker
// serves on, not a port a change is still trying.
func (m *workerManager) reportedServicePort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.servingPort == 0 {
		return m.cfg.ServicePort
	}
	return m.servingPort
}

// servicePort is the TCP port the worker listens on, or listens on from its
// next start.
func (m *workerManager) servicePort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.ServicePort
}

// canListenOn binds the port the way the worker does (all IPv4 addresses) and
// releases it at once: a port in use, or a privileged port without the
// capability to bind it, fails here before the worker is moved.
func canListenOn(port int) error {
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return err
	}
	return listener.Close()
}

// keepRunning starts a worker that is not running, except while an update or
// identity renewal holds the worker: those stop and start it themselves, and a
// start in between could run the previous binary of an update.
func (m *workerManager) keepRunning() error {
	if !m.updateMu.TryLock() {
		return nil
	}
	defer m.updateMu.Unlock()
	return m.ensureRunning()
}

func (m *workerManager) ensureRunning() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.process != nil && m.process.Process != nil {
		return nil
	}
	state, err := loadEnrollmentState(m.enrollmentStateDir)
	if err != nil {
		return fmt.Errorf("load relay enrollment state: %w", err)
	}
	if _, err := os.Stat(m.cfg.BinaryPath); err != nil {
		return fmt.Errorf("relay worker binary: %w", err)
	}
	cmd := exec.Command(m.cfg.BinaryPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(),
		"RELAY_MODE=remote",
		"RELAY_POOL_ID="+state.PoolID,
		"RELAY_INSTANCE_ID="+state.InstanceID,
		"RELAY_PORT="+strconv.Itoa(m.cfg.ServicePort),
		"RELAY_IDENTITY_DIR="+m.cfg.IdentityDir,
		"RELAY_STATE_DIR="+m.cfg.StateDir,
	)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start relay worker: %w", err)
	}
	m.process = cmd
	done := make(chan struct{})
	m.processDone = done
	m.state = state
	m.lastError = ""
	go func(expected *exec.Cmd) {
		err := expected.Wait()
		close(done)
		m.mu.Lock()
		var conn *grpc.ClientConn
		if m.process == expected {
			m.process = nil
			m.processDone = nil
			conn = m.clientConn
			m.client = nil
			m.clientConn = nil
			if err != nil {
				m.lastError = err.Error()
			}
		}
		m.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
	}(cmd)
	return nil
}

// withUpdateLock runs fn while no update or identity renewal stops, starts or
// replaces the worker.
func (m *workerManager) withUpdateLock(fn func() error) error {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	return fn()
}

// setBinaryPath makes the next start and update of the worker use path. The
// running worker is not touched. Call it under withUpdateLock.
func (m *workerManager) setBinaryPath(path string) {
	m.mu.Lock()
	m.cfg.BinaryPath = path
	m.mu.Unlock()
}

func (m *workerManager) connectAdmin(ctx context.Context) (relayv1.RelayAdminClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.client != nil {
		return m.client, nil
	}
	if m.state == nil {
		state, err := loadEnrollmentState(m.enrollmentStateDir)
		if err != nil {
			return nil, err
		}
		m.state = state
	}
	caPEM, err := os.ReadFile(filepath.Join(m.cfg.IdentityDir, "system-ca.crt"))
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("relay worker system CA is invalid")
	}
	certificate, err := tls.LoadX509KeyPair(
		filepath.Join(m.cfg.IdentityDir, "app-relay-client.crt"),
		filepath.Join(m.cfg.IdentityDir, "app-relay-client.key"),
	)
	if err != nil {
		return nil, err
	}
	conn, err := grpc.NewClient(
		fmt.Sprintf("127.0.0.1:%d", m.cfg.ServicePort),
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{certificate}, ServerName: m.state.RelayServerIdentity,
		})),
	)
	if err != nil {
		return nil, err
	}
	m.clientConn = conn
	m.client = relayv1.NewRelayAdminClient(conn)
	return m.client, nil
}

func (m *workerManager) bootstrapTrust(ctx context.Context) error {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	state := *m.state
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = client.BootstrapPolicyTrust(ctx, &relayv1.BootstrapPolicyTrustRequest{
		KeyId: state.PolicySigningKeyID, PublicKey: state.PolicySigningPublicKey,
		PublicKeyFingerprint: state.PolicySigningFingerprint,
	})
	return err
}

// ensurePolicyTrust pins the enrollment key only on a relay that trusts no
// policy key yet. Once the relay holds signed trust, Opfield rotates keys
// through signed snapshots and the enrollment key may have aged out of trust;
// re-bootstrapping it then fails on older Opfield releases even though the relay is
// healthy, so it is skipped. A relay that does not report its trusted keys
// (an older worker) is bootstrapped on every call, as before.
func (m *workerManager) ensurePolicyTrust(ctx context.Context, health *relayv1.HealthResponse) error {
	if len(health.GetPolicyKeyIds()) > 0 {
		return nil
	}
	return m.bootstrapTrust(ctx)
}

func (m *workerManager) applyPolicy(ctx context.Context, encoded []byte) (*relayv1.ApplySnapshotResponse, error) {
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(encoded, request); err != nil {
		return nil, fmt.Errorf("decode relay policy snapshot: %w", err)
	}
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return client.ApplySnapshot(ctx, request)
}

func (m *workerManager) setDrain(ctx context.Context, enabled, forceDisconnect bool) error {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = client.SetDrain(ctx, &relayv1.SetDrainRequest{Draining: enabled, ForceDisconnect: forceDisconnect})
	return err
}

func (m *workerManager) health(ctx context.Context) (*relayv1.HealthResponse, error) {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return client.GetHealth(ctx, &relayv1.HealthRequest{})
}

func (m *workerManager) update(
	ctx context.Context,
	downloadURL string,
	targetVersion string,
	checksum string,
	signedManifest string,
	logger *slog.Logger,
) error {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()

	// The binary is replaced while the worker still runs: the rename leaves
	// the running process on the previous file, and a download or check that
	// fails leaves the worker as it was. Stopping the worker first left it
	// down for the whole download, and a start in that window ran the
	// previous binary, which then stayed.
	if err := m.replaceBinary(
		downloadURL,
		targetVersion,
		checksum,
		signedManifest,
		"relay-worker",
		m.cfg.BinaryPath,
		logger,
	); err != nil {
		_ = m.ensureRunning()
		return err
	}

	m.shutdown()
	err := m.waitReadyVersion(ctx, targetVersion, workerRestartReadyTimeout)
	var stale *staleWorkerVersionError
	if errors.As(err, &stale) {
		// The worker was started before its binary was replaced.
		logger.Warn("relay worker runs the previous version after its update; restarting it",
			"reported_version", stale.reported, "target_version", targetVersion)
		m.shutdown()
		err = m.waitReadyVersion(ctx, targetVersion, workerRestartReadyTimeout)
	}
	if err != nil {
		return fmt.Errorf("relay worker did not become ready after update: %w", err)
	}
	return nil
}

// staleWorkerVersionError reports a ready worker that runs another build than
// the update installed. Opfield dispatches the update again on this message.
type staleWorkerVersionError struct {
	reported string
	expected string
}

func (e *staleWorkerVersionError) Error() string {
	return fmt.Sprintf("worker reported version %s, expected %s", e.reported, e.expected)
}

// waitReadyVersion starts the worker and waits until it is ready on
// targetVersion. A ready worker on another version is returned at once as a
// staleWorkerVersionError: that process does not change its version.
func (m *workerManager) waitReadyVersion(ctx context.Context, targetVersion string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := m.ensureRunning(); err != nil {
			lastErr = err
		} else if health, err := m.health(ctx); err != nil {
			lastErr = err
		} else if err := m.ensurePolicyTrust(ctx, health); err != nil && !health.GetReadiness() {
			lastErr = fmt.Errorf("bootstrap policy trust: %w", err)
		} else if !health.GetReadiness() {
			lastErr = fmt.Errorf("worker is not ready: %s", health.GetReason())
		} else if targetVersion != "" && health.GetBuildVersion() != targetVersion {
			return &staleWorkerVersionError{reported: health.GetBuildVersion(), expected: targetVersion}
		} else {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("worker did not become ready before deadline: %w", lastErr)
}

// changeServicePort moves the worker to port. persist writes a port to the
// supervisor config file, so the port survives a supervisor restart. The
// worker is restarted on the new port and must become ready there within
// readyTimeout; otherwise the previous port is written back and the worker
// restarted on it, and the error says why the new port failed. The runtime
// status keeps reporting the previous port until the worker is ready on the
// new one.
func (m *workerManager) changeServicePort(ctx context.Context, port int, persist func(port int) error, readyTimeout time.Duration) (string, error) {
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("relay port %d is not a TCP port from 1 to 65535", port)
	}
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	previous := m.servicePort()
	if port == previous {
		return fmt.Sprintf("service_port=%d previous_service_port=%d", port, previous), nil
	}
	if m.checkPort != nil {
		if err := m.checkPort(port); err != nil {
			return "", fmt.Errorf("the relay cannot listen on port %d on its host: %w", port, err)
		}
	}
	if err := persist(port); err != nil {
		return "", fmt.Errorf("write relay port %d to the relay configuration: %w", port, err)
	}
	m.shutdown()
	m.setServicePort(port)
	readyErr := m.waitReadyVersion(ctx, "", readyTimeout)
	if readyErr == nil {
		m.mu.Lock()
		m.servingPort = port
		m.mu.Unlock()
		return fmt.Sprintf("service_port=%d previous_service_port=%d", port, previous), nil
	}
	// Back to the port the worker served on: the relay keeps its place in the
	// pool instead of staying down on a port it cannot serve.
	m.shutdown()
	m.setServicePort(previous)
	var rollbackProblems []error
	if err := persist(previous); err != nil {
		rollbackProblems = append(rollbackProblems, fmt.Errorf("write relay port %d back: %w", previous, err))
	}
	if err := m.waitReadyVersion(ctx, "", readyTimeout); err != nil {
		rollbackProblems = append(rollbackProblems, fmt.Errorf("relay worker on port %d: %w", previous, err))
	}
	if len(rollbackProblems) > 0 {
		return "", fmt.Errorf("the relay worker did not become ready on port %d (%v), and moving it back to port %d failed: %w",
			port, readyErr, previous, errors.Join(rollbackProblems...))
	}
	return "", fmt.Errorf("the relay worker did not become ready on port %d (%v); it is back on port %d", port, readyErr, previous)
}

func (m *workerManager) setServicePort(port int) {
	m.mu.Lock()
	m.cfg.ServicePort = port
	m.mu.Unlock()
}

func (m *workerManager) shutdown() {
	m.mu.Lock()
	process := m.process
	done := m.processDone
	conn := m.clientConn
	m.client = nil
	m.clientConn = nil
	m.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	if process != nil && process.Process != nil {
		_ = process.Process.Signal(syscall.SIGTERM)
		if done == nil {
			return
		}
		select {
		case <-done:
			return
		case <-time.After(10 * time.Second):
			_ = process.Process.Kill()
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}
