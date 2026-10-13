package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ControlSessionFile, in the daemon state directory, records the last control
// session Opfield accepted, or why the enrollment before it failed. The
// installers remove it before they start the daemon and wait for it, so a
// daemon that runs but never reaches Opfield, or does not run at all, fails the
// install instead of passing it, and a refused token is named as such.
const ControlSessionFile = "control-session.json"

// LegacyControlSessionFile is the same record under its pre-Opfield name, still
// written for installers that wait on it.
// legacy-name: gateway-session.json read by the setup-*.sh installers — remove once every installer reads control-session.json
const LegacyControlSessionFile = "gateway-session.json"

type controlSessionRecord struct {
	PID         int    `json:"pid"`
	Version     string `json:"version"`
	ConnectedAt int64  `json:"connected_at,omitempty"`
	// EnrollmentRefused: Gateway refused the enrollment token (used, expired,
	// or for another node or host), so retrying it cannot succeed.
	EnrollmentRefused bool   `json:"enrollment_refused,omitempty"`
	EnrollmentError   string `json:"enrollment_error,omitempty"`
}

// recordControlSession notes that Gateway accepted this process's control
// session at the given time.
func recordControlSession(stateDir string, connectedAt time.Time) error {
	return writeControlSessionRecord(stateDir, controlSessionRecord{ConnectedAt: connectedAt.Unix()})
}

// recordEnrollmentFailure notes why this process could not enroll.
func recordEnrollmentFailure(stateDir string, enrollErr error) error {
	return writeControlSessionRecord(stateDir, controlSessionRecord{
		EnrollmentRefused: enrollmentTokenRefused(enrollErr),
		EnrollmentError:   enrollErr.Error(),
	})
}

// enrollmentTokenRefused reports whether Gateway answered the enrollment and
// refused its token, rather than not being reached.
func enrollmentTokenRefused(err error) bool {
	switch status.Code(err) {
	case codes.Unauthenticated, codes.PermissionDenied, codes.InvalidArgument, codes.AlreadyExists, codes.FailedPrecondition:
		return true
	default:
		return false
	}
}

func writeControlSessionRecord(stateDir string, record controlSessionRecord) error {
	record.PID, record.Version = os.Getpid(), Version
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if err := atomicfile.WriteFile(filepath.Join(stateDir, ControlSessionFile), encoded, 0o600); err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(stateDir, LegacyControlSessionFile), encoded, 0o600)
}
