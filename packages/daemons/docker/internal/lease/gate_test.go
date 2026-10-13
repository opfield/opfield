package lease

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

func TestBackendGateAllowsOnlyTheHolder(t *testing.T) {
	w := twoCandidateWorld(t)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	// Lease-mode manifest, nobody holds yet: refused everywhere (A5).
	for _, h := range []*daemonHost{d1, d2} {
		if err := h.runtime.CheckServe(testPolicy); !errors.Is(err, ErrLeaseNotHeld) {
			t.Fatalf("%s: start allowed without the lease: %v", h.id, err)
		}
	}
	if err := d1.runtime.CheckServe("legacy-policy"); err != nil {
		t.Fatalf("a policy without a lease manifest keeps legacy behavior: %v", err)
	}
	w.waitServing("d1", 45*time.Second)
	if err := d1.runtime.CheckServe(testPolicy); err != nil {
		t.Fatalf("holder refused: %v", err)
	}
	if err := d2.runtime.CheckServe(testPolicy); !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("standby allowed to start: %v", err)
	}
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	if err := d1.runtime.CheckServe(testPolicy); !errors.Is(err, ErrLeaseNotHeld) {
		t.Fatalf("holder releasing must refuse backend starts: %v", err)
	}
}

func TestDaemonVoterPersistsAndHoldsAcrossARestart(t *testing.T) {
	w := newWorld(t, worldSpec{
		relays: []string{"r1"}, daemons: []string{"d1", "d2", "d3"}, candidates: []string{"d1"},
		voters: []string{"r1", "d2", "d3"},
	})
	d2 := w.daemon("d2")
	store, err := OpenFileStore(filepath.Join(t.TempDir(), "acceptor.json"))
	if err != nil {
		t.Fatal(err)
	}
	d2.store = store
	w.startDaemon(d2)
	w.deliverBlocks(d2)
	w.daemon("d1").addContainer(testPolicy, false)
	w.waitServing("d1", 45*time.Second)
	views := d2.runtime.Node().AcceptorView()
	if len(views) != 1 || views[0].Holder != "d1" || views[0].Abstaining {
		t.Fatalf("daemon voter must accept the holder: %+v", views)
	}
	// N-5: the voter reports when it first saw the holder's commit, on its wall clock.
	if acceptor := d2.runtime.Report().Acceptor; len(acceptor) != 1 || acceptor[0].HolderSinceUnixMs <= 0 ||
		acceptor[0].HolderSinceUnixMs > d2.runtime.opts.Wall().UnixMilli() {
		t.Fatalf("voter report must carry when it saw the holder take over: %+v", acceptor)
	}
	incarnation := d2.runtime.Node().Incarnation()
	w.startDaemon(d2)
	if d2.runtime.Node().Incarnation() <= incarnation {
		t.Fatal("incarnation must be bumped and persisted on every start (A3)")
	}
	w.run(time.Second)
	views = d2.runtime.Node().AcceptorView()
	// Restarted within the same boot (the store's boot stamp proves it): it
	// keeps voting and restores the hold of its last accept.
	if len(views) != 1 || views[0].Abstaining || views[0].Promised.IsZero() || views[0].Holder != "d1" {
		t.Fatalf("voter restarted within the same boot must keep voting for the holder and its persisted promise: %+v", views)
	}
	w.run(60 * time.Second)
	w.requireClean()
	if w.holderOf() != "d1" {
		t.Fatal("holder lost its lease across a voter restart")
	}
	if len(w.daemon("d1").runtime.Report().Acceptor) != 0 {
		t.Fatal("a non-voter must not report acceptor views (A18)")
	}
	report := d2.runtime.Report()
	if report.MemberID != "d2" || len(report.Manifests) != 1 || report.Manifests[0].VoterEpoch != 1 || len(report.TrustedPolicyKeyIDs) != 1 ||
		len(report.Acceptor) != 1 || report.Acceptor[0].VoterEpoch != 1 || report.Acceptor[0].Holder != "d1" {
		t.Fatalf("voter report incomplete: %+v", report)
	}
	if report.Acceptor[0].HolderSinceUnixMs != 0 {
		t.Fatalf("a commit restored after a restart has no known takeover time: %+v", report.Acceptor[0])
	}
}

func TestFileStoreIsDurableAndRejectsCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "acceptor.json")
	store, err := OpenFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(map[string][]byte{"a": []byte("1"), "b": []byte("2")}, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.Apply(map[string][]byte{"c": []byte("3")}, []string{"a"}); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	records, _ := reopened.Load()
	if len(records) != 2 || string(records["b"]) != "2" || string(records["c"]) != "3" {
		t.Fatalf("records after reopen: %v", records)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenFileStore(path); err == nil {
		t.Fatal("a corrupt acceptor store must not silently restart from zero ballots")
	}
	var _ availabilitylease.Store = reopened
}
