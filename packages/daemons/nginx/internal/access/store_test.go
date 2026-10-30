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

// Lists of IP rules and basic authentication are decided by nginx itself; only the others need the access socket
// (needsAccessSocket in Opfield's nginx-access-list.ts: the same cases).
func TestNeedsSocket(t *testing.T) {
	everyone := []RuleSpec{{Selector: SelectorEveryone}}
	cases := []struct {
		name  string
		spec  ListSpec
		users bool
		want  bool
	}{
		{"ip only", ListSpec{SkipIPRanges: []string{"10.0.0.0/8"}, ExcludeRules: []RuleSpec{{Selector: SelectorIP, Values: []string{"10.0.0.9"}}}}, false, false},
		{"empty", ListSpec{}, false, false},
		{"basic", ListSpec{SignInMethods: []string{MethodBasic}, IncludeRules: everyone}, true, false},
		{"basic from one network", ListSpec{SignInMethods: []string{MethodBasic}, IncludeRules: everyone, RequireRules: []RuleSpec{{Selector: SelectorIP, Values: []string{"10.0.0.0/8"}}}}, true, false},
		{"basic with a skip range", ListSpec{SignInMethods: []string{MethodBasic}, IncludeRules: everyone, SkipIPRanges: []string{"10.0.0.0/8"}}, true, true},
		{"basic from two networks", ListSpec{SignInMethods: []string{MethodBasic}, IncludeRules: everyone, RequireRules: []RuleSpec{{Selector: SelectorIP, Values: []string{"10.0.0.0/8"}}, {Selector: SelectorIP, Values: []string{"10.1.0.0/16"}}}}, true, true},
		{"basic for some addresses", ListSpec{SignInMethods: []string{MethodBasic}, IncludeRules: []RuleSpec{{Selector: SelectorIP, Values: []string{"10.0.0.0/8"}}}}, true, true},
		{"opfield", ListSpec{SignInMethods: []string{MethodOpfield}, IncludeRules: everyone}, false, true},
		{"basic and password", ListSpec{SignInMethods: []string{MethodBasic, MethodPassword}, IncludeRules: everyone}, true, true},
		{"service token", ListSpec{IncludeRules: []RuleSpec{{Selector: SelectorServiceToken, Values: []string{"token-1"}}}}, false, true},
	}
	for _, c := range cases {
		c.spec.ID = "list-1"
		list, err := NewList(c.spec)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if c.users {
			list.users = map[string]string{"ops": "$2a$10$hash"}
		}
		if got := list.NeedsSocket(); got != c.want {
			t.Errorf("%s: NeedsSocket() = %v, want %v", c.name, got, c.want)
		}
	}
}
