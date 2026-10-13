package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// The installers read this record to tell a daemon Opfield accepted in their
// run from one that runs but never connected.
func TestRecordOpfieldSessionWritesTheInstallerRecord(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, LegacyControlSessionFile)
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	connectedAt := time.Unix(1_700_000_000, 0)
	if err := recordControlSession(stateDir, connectedAt); err != nil {
		t.Fatalf("record gateway session: %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record controlSessionRecord
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatalf("parse %q: %v", contents, err)
	}
	if record.PID != os.Getpid() || record.ConnectedAt != connectedAt.Unix() || record.Version != Version {
		t.Fatalf("record = %+v, want pid %d, connected_at %d, version %q", record, os.Getpid(), connectedAt.Unix(), Version)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
	// The Opfield name carries the same record.
	if current, err := os.ReadFile(filepath.Join(stateDir, ControlSessionFile)); err != nil || string(current) != string(contents) {
		t.Fatalf("%s = %q, %v; want %q", ControlSessionFile, current, err, contents)
	}
}

// A refused token is named for the installer; an unreachable Opfield is only an error.
func TestRecordEnrollmentFailureNamesARefusedToken(t *testing.T) {
	for _, test := range []struct {
		err     error
		refused bool
	}{
		{fmt.Errorf("enrollment failed: %w", status.Error(codes.Unauthenticated, "Invalid enrollment token")), true},
		{fmt.Errorf("enrollment failed: %w", status.Error(codes.Unavailable, "connection refused")), false},
		{errors.New("Opfield certificate fingerprint mismatch"), false},
	} {
		stateDir := t.TempDir()
		if err := recordEnrollmentFailure(stateDir, test.err); err != nil {
			t.Fatal(err)
		}
		contents, err := os.ReadFile(filepath.Join(stateDir, LegacyControlSessionFile))
		if err != nil {
			t.Fatal(err)
		}
		var record controlSessionRecord
		if err := json.Unmarshal(contents, &record); err != nil {
			t.Fatal(err)
		}
		if record.EnrollmentRefused != test.refused || record.EnrollmentError != test.err.Error() || record.ConnectedAt != 0 || record.PID != os.Getpid() {
			t.Errorf("%v: record = %+v", test.err, record)
		}
	}
}
