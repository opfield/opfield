package supervisor

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func enrolledBaseConfig(t *testing.T, token string) *lifecycle.BaseConfig {
	t.Helper()
	dir := t.TempDir()
	cfg := &lifecycle.BaseConfig{}
	cfg.Control.Token = token
	cfg.TLS.CACert = filepath.Join(dir, "ca.pem")
	cfg.TLS.ClientCert = filepath.Join(dir, "node.pem")
	cfg.TLS.ClientKey = filepath.Join(dir, "node-key.pem")
	for _, path := range identityPaths(cfg) {
		if err := os.WriteFile(path, []byte("previous "+filepath.Base(path)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func TestBeginReenrollmentOnlyWithTokenWhileEnrolled(t *testing.T) {
	cfg := enrolledBaseConfig(t, "")
	if reenrollment, err := BeginReenrollment(cfg); err != nil || reenrollment != nil {
		t.Fatalf("re-enrollment started without a token: %v %v", reenrollment, err)
	}
	if !cfg.IsEnrolled() {
		t.Fatal("identity was moved without a token")
	}
}

// A rejected or failed enrollment must leave the relay with the identity it had.
func TestFailedReenrollmentRestoresPreviousIdentity(t *testing.T) {
	cfg := enrolledBaseConfig(t, "token")
	reenrollment, err := BeginReenrollment(cfg)
	if err != nil || reenrollment == nil {
		t.Fatalf("re-enrollment did not start: %v", err)
	}
	if cfg.IsEnrolled() {
		t.Fatal("the lifecycle would not enroll while the identity is in place")
	}
	// A partial enrollment wrote one new file before failing.
	if err := os.WriteFile(cfg.TLS.CACert, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reenrollment.Restore(); err != nil {
		t.Fatal(err)
	}
	for _, path := range identityPaths(cfg) {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != "previous "+filepath.Base(path) {
			t.Fatalf("%s was not restored: %q %v", path, content, err)
		}
	}
}

func TestInterruptedReenrollmentIsRestoredOnStart(t *testing.T) {
	cfg := enrolledBaseConfig(t, "token")
	if _, err := BeginReenrollment(cfg); err != nil {
		t.Fatal(err)
	}
	// The process died before it restored or committed anything.
	if err := RecoverInterruptedReenrollment(cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.IsEnrolled() {
		t.Fatal("interrupted re-enrollment left the supervisor without an identity")
	}
}

func TestEnrollmentTokenRejectedClassifiesOpfieldRefusals(t *testing.T) {
	wrapped := fmt.Errorf("enrollment: %w", fmt.Errorf("enrollment failed: %w", status.Error(codes.Unauthenticated, "Invalid enrollment token")))
	if !EnrollmentTokenRejected(wrapped) {
		t.Fatal("an invalid token was not treated as rejected")
	}
	if EnrollmentTokenRejected(fmt.Errorf("enrollment: %w", status.Error(codes.Unavailable, "connection refused"))) {
		t.Fatal("an unreachable Opfield was treated as a rejected token")
	}
}

// Enrollment is what authorizes policy trust. A relay locked out with trust
// only in keys Opfield destroyed is repaired by enrolling again: the worker's
// pinned trust and identity rotation state are moved aside and the stashed
// supervisor identity is dropped.
func TestPersistEnrollmentBundleResetsWorkerPolicyTrust(t *testing.T) {
	root := t.TempDir()
	base := enrolledBaseConfig(t, "token")
	cfg := &config.Config{BaseConfig: *base}
	cfg.StateDir = filepath.Join(root, "state")
	cfg.Worker.IdentityDir = filepath.Join(root, "worker-identity")
	cfg.Worker.StateDir = filepath.Join(root, "worker-state")
	if err := os.MkdirAll(cfg.Worker.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"relay.db", "identity-rotation.json"} {
		if err := os.WriteFile(filepath.Join(cfg.Worker.StateDir, name), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := BeginReenrollment(&cfg.BaseConfig); err != nil {
		t.Fatal(err)
	}
	// The lifecycle saved the new identity before handing over the bundle.
	for _, path := range identityPaths(&cfg.BaseConfig) {
		if err := os.WriteFile(path, []byte("new"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	plugin := New(cfg)
	if err := plugin.PersistEnrollmentBundle(&pb.EnrollResponse{RelayPoolId: "system"}); err == nil {
		t.Fatal("an incomplete bundle was accepted")
	}
	if _, err := os.Stat(filepath.Join(cfg.Worker.StateDir, "relay.db")); err != nil {
		t.Fatal("an invalid bundle reset the worker's policy trust")
	}
	if err := plugin.PersistEnrollmentBundle(validEnrollResponse(t)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"relay.db", "identity-rotation.json"} {
		if _, err := os.Stat(filepath.Join(cfg.Worker.StateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("worker %s survived the enrollment: %v", name, err)
		}
		matches, _ := filepath.Glob(filepath.Join(cfg.Worker.StateDir, name+".pre-enrollment-*"))
		if len(matches) != 1 {
			t.Fatalf("worker %s was not kept aside: %v", name, matches)
		}
	}
	for _, path := range identityPaths(&cfg.BaseConfig) {
		if _, err := os.Stat(path + stashedIdentitySuffix); !os.IsNotExist(err) {
			t.Fatalf("superseded identity %s was kept: %v", path, err)
		}
	}
}

func validEnrollResponse(t *testing.T) *pb.EnrollResponse {
	t.Helper()
	clientCert, clientKey := testCertificate(t, "relay-node")
	serverCert, serverKey := testCertificate(t, "relay-instance")
	publicKey := make([]byte, 32)
	if _, err := rand.Read(publicKey); err != nil {
		t.Fatal(err)
	}
	return &pb.EnrollResponse{
		CaCertificate: clientCert, ClientCertificate: clientCert, ClientKey: clientKey,
		RelayPoolId: "system", RelayInstanceId: "relay-1", HostIdentityId: "host-1",
		PolicySigningKeyId: "policy-1", PolicySigningPublicKey: publicKey,
		PolicySigningPublicKeyFingerprint: policyFingerprint(publicKey), RelayServerIdentity: "relay-relay-1",
		RelayServerCertificate: serverCert, RelayServerKey: serverKey,
	}
}

// Opfield binds the new identity as soon as it answers the enrollment. When
// persisting it fails on the relay, the next start completes it instead of
// leaving the relay half re-enrolled.
func TestInterruptedEnrollmentIsCompletedOnTheNextStart(t *testing.T) {
	root := t.TempDir()
	cfg := &config.Config{BaseConfig: *enrolledBaseConfig(t, "token")}
	cfg.StateDir = filepath.Join(root, "state")
	cfg.Worker.IdentityDir = filepath.Join(root, "worker-identity")
	cfg.Worker.StateDir = filepath.Join(root, "worker-state")
	if err := os.MkdirAll(cfg.Worker.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.Worker.StateDir, "relay.db"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := validEnrollResponse(t)
	// The bundle was recorded, then the process died before persisting it.
	if err := savePendingEnrollment(cfg.StateDir, response); err != nil {
		t.Fatal(err)
	}
	if !HasPendingEnrollment(cfg) {
		t.Fatal("the recorded enrollment was not found")
	}
	completed, err := CompletePendingEnrollment(cfg)
	if err != nil || !completed {
		t.Fatalf("pending enrollment was not completed: %v %v", completed, err)
	}
	state, err := loadEnrollmentState(cfg.StateDir)
	if err != nil || state.InstanceID != "relay-1" {
		t.Fatalf("enrollment state was not persisted: %#v %v", state, err)
	}
	if _, err := os.Stat(filepath.Join(cfg.Worker.StateDir, "relay.db")); !os.IsNotExist(err) {
		t.Fatal("the worker's previous policy trust was kept")
	}
	if HasPendingEnrollment(cfg) {
		t.Fatal("the completed enrollment is still pending")
	}
	if completed, err := CompletePendingEnrollment(cfg); completed || err != nil {
		t.Fatalf("nothing should be pending: %v %v", completed, err)
	}
}

func TestEnrollmentOutcomeTellsTheInstallerWhetherTheTokenWorked(t *testing.T) {
	stateDir := t.TempDir()
	read := func() enrollmentResult {
		t.Helper()
		encoded, err := os.ReadFile(filepath.Join(stateDir, EnrollmentResultFile))
		if err != nil {
			t.Fatal(err)
		}
		var result enrollmentResult
		if err := json.Unmarshal(encoded, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	rejected := status.Error(codes.Unauthenticated, "enrollment token was already used")
	if err := RecordEnrollmentOutcome(stateDir, rejected); err != nil {
		t.Fatal(err)
	}
	if result := read(); result.Outcome != "failed" || !strings.Contains(result.Error, "already used") {
		t.Fatalf("failed enrollment recorded as %+v", result)
	}
	if err := RecordEnrollmentOutcome(stateDir, nil); err != nil {
		t.Fatal(err)
	}
	if result := read(); result.Outcome != "enrolled" || result.Error != "" {
		t.Fatalf("enrollment recorded as %+v", result)
	}
}
