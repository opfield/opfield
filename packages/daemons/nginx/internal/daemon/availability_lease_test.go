package daemon

import (
	"os"
	"path/filepath"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// TestNewAvailabilityLeaseCoordinatorRemovesObsoleteAcceptorStateFile covers
// the A18-A20 migration: nginx daemons no longer run the availabilitylease
// acceptor, so a state file an older build left behind is cleaned up on
// start instead of lingering forever.
func TestNewAvailabilityLeaseCoordinatorRemovesObsoleteAcceptorStateFile(t *testing.T) {
	stateDir := t.TempDir()
	obsolete := filepath.Join(stateDir, availabilityLeaseObsoleteStateFile)
	if err := os.WriteFile(obsolete, []byte(`{"incarnation":"AAAAAAAAAAE="}`), 0o600); err != nil {
		t.Fatal(err)
	}
	coordinator := newAvailabilityLeaseCoordinator(stateDir, nil, nil)
	defer coordinator.close()
	if _, err := os.Stat(obsolete); !os.IsNotExist(err) {
		t.Fatalf("obsolete acceptor state file should have been removed: err=%v", err)
	}
}

// TestNewAvailabilityLeaseCoordinatorToleratesNoObsoleteStateFile covers the
// common case: nothing to clean up, construction still succeeds.
func TestNewAvailabilityLeaseCoordinatorToleratesNoObsoleteStateFile(t *testing.T) {
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), nil, nil)
	defer coordinator.close()
	if coordinator.gates == nil {
		t.Fatal("coordinator must still initialize its gate tracker")
	}
}

// TestAvailabilityLeaseCoordinatorApplyIsAnObserverNoOpThatTracksRevision
// covers the observer-only contract (A18-A20): nginx never votes and adopts
// no policy keys, voters or manifests, but it still echoes back the revision
// it was asked to apply, so the Gateway's resend loop settles.
func TestAvailabilityLeaseCoordinatorApplyIsAnObserverNoOpThatTracksRevision(t *testing.T) {
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), nil, nil)
	defer coordinator.close()

	if report := coordinator.buildReport(); report == nil || report.LeaseRevision != 0 {
		t.Fatalf("a coordinator with no applied command should report revision 0: %#v", report)
	}

	command := &pb.SyncAvailabilityLeaseCommand{
		Revision:   5,
		PolicyKeys: []*pb.AvailabilityLeasePolicyKey{{KeyId: "k1", PublicKey: []byte("not a real key")}},
		Manifests:  [][]byte{[]byte("not a real manifest")},
	}
	if _, err := coordinator.apply(command); err != nil {
		t.Fatalf("apply must not fail even on content nginx does not understand: %v", err)
	}
	report := coordinator.buildReport()
	if report == nil || report.LeaseRevision != 5 {
		t.Fatalf("apply should track the revision it was given: %#v", report)
	}
	if len(report.TrustedPolicyKeyIds) != 0 || len(report.Manifests) != 0 || len(report.Acceptor) != 0 {
		t.Fatalf("an observer report must carry no policy-key, manifest or acceptor state: %#v", report)
	}

	// An older or duplicate revision does not move the tracked value backward.
	if _, err := coordinator.apply(&pb.SyncAvailabilityLeaseCommand{Revision: 3}); err != nil {
		t.Fatal(err)
	}
	if report := coordinator.buildReport(); report.LeaseRevision != 5 {
		t.Fatalf("an older revision must not regress the tracked value: got %d", report.LeaseRevision)
	}
}

func TestAvailabilityLeaseCoordinatorApplyToleratesNilCommand(t *testing.T) {
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), nil, nil)
	defer coordinator.close()
	if _, err := coordinator.apply(nil); err != nil {
		t.Fatalf("apply(nil) must not fail: %v", err)
	}
}
