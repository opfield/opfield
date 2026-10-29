package access

import (
	"os"
	"path/filepath"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/protobuf/proto"
)

// A restarted daemon answers from the policy it applied last; older and equal revisions change nothing.
func TestStorePersistsAndFencesRevisions(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil || store.Policy() != nil {
		t.Fatalf("empty store: %v %v", store.Policy(), err)
	}
	command, _ := testPolicy(t)
	if applied, err := store.Apply(command); err != nil || !applied {
		t.Fatalf("apply: %v %v", applied, err)
	}
	info, err := os.Stat(filepath.Join(dir, policyFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("policy file: %v %v", info, err)
	}

	stale := proto.Clone(command).(*pb.SyncAccessPolicyCommand)
	stale.Lists = nil
	for _, revision := range []uint64{command.Revision, command.Revision - 1} {
		stale.Revision = revision
		if applied, err := store.Apply(stale); err != nil || applied || !store.HasList(testListID) {
			t.Fatalf("revision %d replaced the policy: %v %v", revision, applied, err)
		}
	}
	invalid := proto.Clone(command).(*pb.SyncAccessPolicyCommand)
	invalid.Revision = command.Revision + 1
	invalid.Lists[0].IncludeRules[0].Selector = "astrology"
	if _, err := store.Apply(invalid); err == nil || !store.HasList(testListID) {
		t.Fatalf("invalid policy applied: %v", err)
	}

	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	policy := reopened.Policy()
	if policy == nil || policy.Revision != command.Revision || !reopened.HasList(testListID) || !reopened.HasList(testBasicID) || policy.SignInOrigin != "https://access.example.net" {
		t.Fatalf("reopened policy: %+v", policy)
	}
	if list, _ := policy.List(testBasicID); list.users["lena"] == "" {
		t.Fatal("basic users were not kept")
	}

	next := proto.Clone(command).(*pb.SyncAccessPolicyCommand)
	next.Revision = command.Revision + 1
	next.Lists = next.Lists[1:]
	if applied, err := reopened.Apply(next); err != nil || !applied || reopened.HasList(testListID) {
		t.Fatalf("newer revision: %v %v", applied, err)
	}
}
