package supervisor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// stashedIdentitySuffix marks the supervisor identity kept aside while a
// re-enrollment runs.
const stashedIdentitySuffix = ".reenroll-previous"

// Reenrollment is a pending re-enrollment of an already enrolled supervisor.
//
// A relay whose pinned policy trust holds only keys Opfield can no longer sign
// with cannot be repaired over the control channel: a remote relay accepts new
// keys only through signed rotation. The supported way back is a fresh
// enrollment token, which an administrator issues in Opfield and passes to the
// relay installer. The installer writes the token into the configuration and
// restarts the supervisor; finding a token while already enrolled starts a
// re-enrollment. The current identity is kept aside until the new bundle is
// persisted, so a rejected or failed enrollment leaves the relay as it was.
type Reenrollment struct {
	paths []string
}

func identityPaths(cfg *lifecycle.BaseConfig) []string {
	return []string{cfg.TLS.CACert, cfg.TLS.ClientCert, cfg.TLS.ClientKey}
}

// RecoverInterruptedReenrollment restores an identity that a previous process
// moved aside and never committed or restored, for example because it was
// killed while enrolling.
func RecoverInterruptedReenrollment(cfg *lifecycle.BaseConfig) error {
	if cfg.IsEnrolled() {
		return nil
	}
	paths := identityPaths(cfg)
	for _, path := range paths {
		if _, err := os.Stat(path + stashedIdentitySuffix); err != nil {
			return nil
		}
	}
	return (&Reenrollment{paths: paths}).Restore()
}

// BeginReenrollment moves the current identity aside when the configuration
// carries an enrollment token although the supervisor is already enrolled.
// It returns nil when there is nothing to do.
func BeginReenrollment(cfg *lifecycle.BaseConfig) (*Reenrollment, error) {
	if strings.TrimSpace(cfg.Control.Token) == "" || !cfg.IsEnrolled() {
		return nil, nil
	}
	paths := identityPaths(cfg)
	moved := make([]string, 0, len(paths))
	for _, path := range paths {
		if err := os.Rename(path, path+stashedIdentitySuffix); err != nil {
			for _, done := range moved {
				_ = os.Rename(done+stashedIdentitySuffix, done)
			}
			return nil, fmt.Errorf("keep current relay supervisor identity aside: %w", err)
		}
		moved = append(moved, path)
	}
	return &Reenrollment{paths: paths}, nil
}

// Restore puts the previous identity back after an enrollment that did not
// complete. Anything a partial enrollment wrote in its place is discarded.
func (r *Reenrollment) Restore() error {
	var failed error
	for _, path := range r.paths {
		if err := os.Rename(path+stashedIdentitySuffix, path); err != nil && !os.IsNotExist(err) {
			failed = errors.Join(failed, err)
		}
	}
	return failed
}

// discardStashedIdentity drops the identity kept aside once the new
// enrollment bundle is persisted: Opfield has already superseded it.
func discardStashedIdentity(cfg *lifecycle.BaseConfig) {
	for _, path := range identityPaths(cfg) {
		if path != "" {
			_ = os.Remove(path + stashedIdentitySuffix)
		}
	}
}

// EnrollmentTokenRejected reports whether Opfield refused the enrollment for a
// reason a retry with the same token cannot fix: the token is invalid, used,
// expired, or belongs to another kind of node or host.
func EnrollmentTokenRejected(err error) bool {
	switch status.Code(err) {
	case codes.Unauthenticated, codes.PermissionDenied, codes.InvalidArgument, codes.AlreadyExists, codes.FailedPrecondition:
		return true
	default:
		return false
	}
}

// EnrollmentResultFile, in the supervisor state directory, holds the outcome
// of the last enrollment attempt with a token. The installer removes it before
// it restarts the supervisor and waits for it, so a re-run with a used or
// invalid token reports the failure instead of claiming success: a failed
// re-enrollment otherwise looks like a healthy relay, which keeps running with
// its previous identity.
const EnrollmentResultFile = "enrollment-result.json"

type enrollmentResult struct {
	Outcome string `json:"outcome"`
	Error   string `json:"error,omitempty"`
	At      string `json:"at"`
}

// RecordEnrollmentOutcome writes the outcome of an enrollment attempt: nil
// for an identity Opfield issued and this relay persisted, else the failure.
func RecordEnrollmentOutcome(stateDir string, err error) error {
	result := enrollmentResult{Outcome: "enrolled", At: time.Now().UTC().Format(time.RFC3339)}
	if err != nil {
		result.Outcome = "failed"
		result.Error = err.Error()
	}
	encoded, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return marshalErr
	}
	if mkdirErr := os.MkdirAll(stateDir, 0o700); mkdirErr != nil {
		return mkdirErr
	}
	return atomicWrite(filepath.Join(stateDir, EnrollmentResultFile), encoded, 0o600)
}
