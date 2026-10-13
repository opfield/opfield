package securelink

import (
	"os"
	"path/filepath"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/statecompat"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/dynamicpb"
)

func stateCommand(id string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{LinkId: id}}}
}

func TestStateStoreStagesWithoutReplacingCommittedState(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	committed := stateCommand("11111111-1111-4111-8111-111111111111")
	pending := stateCommand("22222222-2222-4222-8222-222222222222")
	if err := store.Commit(committed); err != nil {
		t.Fatal(err)
	}
	if err := store.Stage(pending); err != nil {
		t.Fatal(err)
	}
	if !store.HasPending() {
		t.Fatal("expected pending marker")
	}
	staged, exists, err := store.Pending()
	if err != nil || !exists || staged.Bindings[0].LinkId != pending.Bindings[0].LinkId {
		t.Fatalf("pending state = %#v exists=%v err=%v", staged, exists, err)
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Bindings[0].LinkId; got != committed.Bindings[0].LinkId {
		t.Fatalf("restart restored pending state %s", got)
	}
}

func TestStateStoreCommitPromotesAndClearsPendingState(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	next := stateCommand("22222222-2222-4222-8222-222222222222")
	if err := store.Stage(next); err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(next); err != nil {
		t.Fatal(err)
	}
	if store.HasPending() {
		t.Fatal("pending marker survived commit")
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().Bindings[0].LinkId; got != next.Bindings[0].LinkId {
		t.Fatalf("committed state = %s", got)
	}
}

func TestStateStorePersistsSourceConfigOwnershipIndependentlyOfListenerState(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	command := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: "11111111-1111-4111-8111-111111111111", Role: "source", ListenerPort: 41000,
	}}}
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}
	previous, found, err := store.SetSourceConfigManaged(command.Bindings[0].LinkId, true)
	if err != nil || !found || previous {
		t.Fatalf("ownership update previous=%v found=%v err=%v", previous, found, err)
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.Get().Bindings[0]
	if !got.SourceConfigManaged || got.ListenerPort != 41000 {
		t.Fatalf("persisted binding = %#v", got)
	}
}

// B-10: a node rolled back to a daemon that predates the lease must start on
// this state and must not serve dormant availability members.
func TestStateStoreKeepsFilesOlderDaemonsRead(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	command := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: "11111111-1111-4111-8111-111111111111", Role: "target", AvailabilityPolicyId: "p1", AvailabilityCandidateId: "n1"},
		{LinkId: "22222222-2222-4222-8222-222222222222", Role: "target", Dormant: true, AvailabilityPolicyId: "p1", AvailabilityCandidateId: "n1"},
	}}
	if err := store.Stage(command); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}
	legacyDescriptor, err := statecompat.LegacyDescriptor("gateway.v1.SyncProxySecureLinksCommand")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"proxy-secure-links.json", "proxy-secure-links.pending.json"} {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		// v2.10.0 decodes with protojson's default, strict options.
		old := dynamicpb.NewMessage(legacyDescriptor)
		if err := protojson.Unmarshal(data, old); err != nil {
			t.Fatalf("%s: an older daemon cannot read it: %v\n%s", name, err, data)
		}
		legacy := &pb.SyncProxySecureLinksCommand{}
		if err := protojson.Unmarshal(data, legacy); err != nil {
			t.Fatal(err)
		}
		if len(legacy.Bindings) != 1 || legacy.Bindings[0].LinkId != command.Bindings[0].LinkId || legacy.Bindings[0].AvailabilityPolicyId != "" {
			t.Fatalf("%s: legacy copy = %v, want the serving member only, without availability fields", name, legacy)
		}
	}
	reopened, err := NewStateStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get(); !proto.Equal(got, command) {
		t.Fatalf("current daemon restored %v, want %v", got, command)
	}
	pending, found, err := reopened.Pending()
	if err != nil || !found || !proto.Equal(pending, command) {
		t.Fatalf("pending = %v found=%v err=%v", pending, found, err)
	}
	if err := reopened.DiscardPending(); err != nil || reopened.HasPending() {
		t.Fatalf("discard left a pending copy: %v", err)
	}
}
