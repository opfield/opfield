package docker

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

const (
	liftSetA   = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
	liftSetB   = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"
	liftOther  = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
	liftMember = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"
	liftPeer   = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5"
	liftDB     = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6"
)

func liftedMemberPlugin(t *testing.T) (*DockerPlugin, *memberha.Manager, *managedDatabaseManager) {
	t.Helper()
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: stubSetLease{}, Watchdog: stubSetWatchdog{}, Endpoints: stubSetEndpoints{}, Clock: bootWallClock{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine: func(memberha.Config) (memberha.Engine, error) { return muEngine{}, nil },
		Async:  func(func()) {},
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	m := newTestDatabaseManager(t, nil)
	plugin := &DockerPlugin{setMembers: manager, databaseManager: m, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	m.plugin = plugin
	return plugin, manager, m
}

func configureLiftMember(t *testing.T, manager *memberha.Manager, setID, ownerKind, ownerID string, peers ...string) {
	t.Helper()
	members := []memberha.Peer{{MemberID: liftMember, NodeID: "node-a"}}
	for i, peer := range peers {
		members = append(members, memberha.Peer{MemberID: peer, NodeID: "node-" + peer[:4], MemberIndex: uint32(i + 1)})
	}
	if err := manager.Configure(memberha.Config{SetID: setID, MemberID: liftMember, NodeID: "node-a", Engine: "postgres",
		OwnerKind: ownerKind, OwnerID: ownerID, Mode: memberha.ModeManual, ConfigRevision: 6, Members: members}); err != nil {
		t.Fatal(err)
	}
}

func configured(manager *memberha.Manager, setID string) bool {
	_, ok := manager.Config(setID)
	return ok
}

// DB-O-2: a create on several servers that failed before the first server's
// database became a member is turned off by a detach (or lift) the node
// answers "already a single node". The member runtime lets go of the set's
// member at once instead of keeping it until the leftover sweep; members of
// other sets and owners stay.
func TestDetachOfASingleNodeDatabaseForgetsTheRuntimeMember(t *testing.T) {
	_, manager, m := liftedMemberPlugin(t)
	saveTestDatabase(t, m, liftDB)
	configureLiftMember(t, manager, liftSetA, "managed_database", liftDB)
	configureLiftMember(t, manager, liftOther, "managed_database", "99999999-9999-4999-8999-999999999999")
	detail, err := m.pgLift(context.Background(), manager, liftDB, pgMemberRef{SetID: liftSetA, MemberID: liftMember},
		&memberha.DetachEvidence{NeverHeld: true})
	if err != nil || !strings.Contains(detail, `"singleNode":true`) {
		t.Fatalf("detach of a single-node database = %s, %v", detail, err)
	}
	if configured(manager, liftSetA) {
		t.Fatal("the runtime must forget the member of the set the database left")
	}
	if !configured(manager, liftOther) {
		t.Fatal("a member of another database must stay")
	}

	// The Valkey lift of a store that is already a single node does the same.
	configureLiftMember(t, manager, liftSetB, "managed_database", liftDB)
	if _, err := m.kvLift(context.Background(), manager, liftDB, kvLiftCommand{kvMemberRef: kvMemberRef{SetID: liftSetB, MemberID: liftMember}}); err != nil {
		t.Fatal(err)
	}
	if configured(manager, liftSetB) {
		t.Fatal("the Valkey lift must forget the member of the set the store left")
	}
}

// A member of the set the record still names is never forgotten by this
// path, nor one of another member id.
func TestForgetLiftedSetMemberChecksOwnerAndMember(t *testing.T) {
	plugin, manager, _ := liftedMemberPlugin(t)
	configureLiftMember(t, manager, liftSetA, "managed_database", liftDB)
	plugin.forgetLiftedSetMember(liftSetA, liftPeer, liftDB)
	plugin.forgetLiftedSetMember(liftSetA, liftMember, "99999999-9999-4999-8999-999999999999")
	if !configured(manager, liftSetA) {
		t.Fatal("another member id or owner must not forget the member")
	}
	plugin.forgetLiftedSetMember(liftSetA, liftMember, liftDB)
	if configured(manager, liftSetA) {
		t.Fatal("the named member must be forgotten")
	}
}

// Storage taken back to a single node: a member left alone in its set goes;
// one whose set still lists other members (a make available that has not
// reached the record yet) stays.
func TestSingleNodeStorageForgetsOnlyALoneRuntimeMember(t *testing.T) {
	plugin, manager, _ := liftedMemberPlugin(t)
	configureLiftMember(t, manager, liftSetA, "managed_storage", liftDB)
	configureLiftMember(t, manager, liftSetB, "managed_storage", liftDB, liftPeer)
	plugin.forgetLoneSetMembersOf("managed_storage", liftDB)
	if configured(manager, liftSetA) {
		t.Fatal("the member left alone in its set must be forgotten")
	}
	if !configured(manager, liftSetB) {
		t.Fatal("a member of a set with other members must stay")
	}
}
