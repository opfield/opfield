package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

type stubSetLease struct{}

func (stubSetLease) HolderStatus(memberha.Key) memberha.HolderStatus { return memberha.HolderStatus{} }
func (stubSetLease) ManifestInfo(string) (memberha.ManifestInfo, bool) {
	return memberha.ManifestInfo{}, false
}
func (stubSetLease) BootstrapPending(memberha.Key) bool                        { return false }
func (stubSetLease) SetCandidateReady(string, bool)                            {}
func (stubSetLease) SetStateHandler(string, *memberha.StateHandler)            {}
func (stubSetLease) ProposeTransition(memberha.Key, memberha.Transition) error { return nil }
func (stubSetLease) TransitionStatus(memberha.Key, string) (memberha.TransitionOutcome, string) {
	return 0, ""
}
func (stubSetLease) CommittedState(memberha.Key) (memberha.CertifiedState, bool) {
	return memberha.CertifiedState{}, false
}
func (stubSetLease) ObservedCommit(memberha.Key) (memberha.CertifiedState, bool) {
	return memberha.CertifiedState{}, false
}
func (stubSetLease) Recover(memberha.Key, time.Duration) {}
func (stubSetLease) Release(memberha.Key, string) error  { return nil }
func (stubSetLease) FenceComplete(memberha.Key)          {}
func (stubSetLease) Abandon(memberha.Key)                {}

type stubSetWatchdog struct{}

func (stubSetWatchdog) HeartbeatAge(time.Duration) (time.Duration, bool) { return 0, true }
func (stubSetWatchdog) Records() (map[string]leasefence.Record, error) {
	return map[string]leasefence.Record{}, nil
}
func (stubSetWatchdog) WriteRecord(leasefence.Record) error { return nil }
func (stubSetWatchdog) DeleteRecord(string) error           { return nil }

type stubSetEndpoints struct{}

func (stubSetEndpoints) SetServing(string, string, bool) {}

func TestMemberConfigFromProtoNamesThisNodeFromTheMemberList(t *testing.T) {
	config := memberConfigFromProto(&pb.AvailabilityMemberConfig{
		SetId: testSetID, MemberId: testMemberB, Engine: "postgres", OwnerKind: "managed_database", OwnerId: testDatabase,
		Mode: "automatic", LeasePolicyId: "22222222-2222-4222-8222-222222222222", ConfigRevision: 4, PublishedPort: 15432,
		Members: []*pb.AvailabilityMemberPeer{
			{MemberId: testMemberA, NodeId: "node-a", MemberIndex: 0, Priority: 10},
			{MemberId: testMemberB, NodeId: "node-b", MemberIndex: 1, Removing: true},
		},
	})
	if config.NodeID != "node-b" || config.ConfigRevision != 4 || config.PublishedPort != 15432 || len(config.Members) != 2 ||
		!config.Members[1].Removing || config.Members[0].Priority != 10 {
		t.Fatalf("config = %+v", config)
	}
	if err := config.Validate(); err != nil {
		t.Fatalf("a converted configuration must validate: %v", err)
	}
}

func TestAvailabilityMemberCommandsNeedTheMemberRuntime(t *testing.T) {
	plugin := &DockerPlugin{}
	if err := plugin.handleAvailabilityMember(&pb.AvailabilityMemberCommand{}); err == nil {
		t.Fatal("a daemon without the member runtime must refuse member commands")
	}
}

func TestTheMemberControlPortAnswersWithThePrimaryAssignment(t *testing.T) {
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: stubSetLease{}, Watchdog: stubSetWatchdog{}, Endpoints: stubSetEndpoints{}, Clock: bootWallClock{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine: func(memberha.Config) (memberha.Engine, error) { return nil, nil },
		Async:  func(func()) {},
		// The signature itself is checked by the lease keychain (managed_database_pg_test.go).
		VerifyAssignment: func(string, memberha.Assignment) error { return nil },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	config := memberConfigFromProto(&pb.AvailabilityMemberConfig{
		SetId: testSetID, MemberId: testMemberA, Engine: "fake", Mode: "manual", ConfigRevision: 1,
		Members: []*pb.AvailabilityMemberPeer{{MemberId: testMemberA, NodeId: "node-a"}, {MemberId: testMemberB, NodeId: "node-b"}},
	})
	if err := manager.Configure(config); err != nil {
		t.Fatal(err)
	}
	if err := manager.AssignPrimary(testSetID, memberha.Assignment{PrimaryMemberID: testMemberA, Generation: 7, SigningKeyID: "k1", Signature: []byte("signed")}); err != nil {
		t.Fatal(err)
	}
	adapter := setMemberRuntimeAdapter{manager: manager}
	if !adapter.PeerServing(testSetID, testMemberA, memberha.MemberControlPort) {
		t.Fatal("the member-control port serves while the member exists")
	}
	if _, err := adapter.DialPeer(context.Background(), testSetID, testMemberB, memberha.MemberControlPort); !errors.Is(err, errSetMemberNotServing) {
		t.Fatalf("another member's control port is not served here: %v", err)
	}
	conn, err := adapter.DialPeer(context.Background(), testSetID, testMemberA, memberha.MemberControlPort)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var state memberha.PeerState
	if err := json.Unmarshal(line, &state); err != nil || state.Generation != 7 || state.Primary != testMemberA {
		t.Fatalf("peer state = %+v, %v", state, err)
	}
	if state.Assignment == nil || string(state.Assignment.Signature) != "signed" || state.Assignment.SigningKeyID != "k1" {
		t.Fatalf("the peer line must carry the signed assignment: %+v", state.Assignment)
	}
}

// P3-T07: a paused member (stopped), the restart command for every engine,
// and the backup port of a database member (P3-T06).
func TestPausedMembersRestartsAndTheBackupPortOverTheProto(t *testing.T) {
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
	plugin := &DockerPlugin{setMembers: manager, databaseManager: m}
	configure := &pb.AvailabilityMemberConfig{
		SetId: testSetID, MemberId: testMemberA, Engine: "seaweedfs", OwnerKind: "managed_storage", OwnerId: testDatabase,
		Mode: "automatic", LeasePolicyId: "22222222-2222-4222-8222-222222222222", ConfigRevision: 1, Stopped: true,
		Members: []*pb.AvailabilityMemberPeer{{MemberId: testMemberA, NodeId: "node-a"}, {MemberId: testMemberB, NodeId: "node-b", MemberIndex: 1}},
	}
	if err := plugin.handleAvailabilityMember(&pb.AvailabilityMemberCommand{Action: &pb.AvailabilityMemberCommand_Configure{Configure: configure}}); err != nil {
		t.Fatal(err)
	}
	if !manager.Stopped(testSetID) {
		t.Fatal("stopped must reach the member runtime")
	}
	reports := plugin.availabilityMemberReports()
	if len(reports) != 1 || reports[0].GetEligible() || reports[0].GetEligibilityReason() != "stopped" {
		t.Fatalf("a paused member reports ineligible (stopped): %+v", reports)
	}
	restart := func(member, op string) error {
		return plugin.handleAvailabilityMember(&pb.AvailabilityMemberCommand{Action: &pb.AvailabilityMemberCommand_Restart{
			Restart: &pb.AvailabilityMemberRestart{SetId: testSetID, MemberId: member, OperationId: op}}})
	}
	if err := restart(testMemberB, "op-1"); err == nil {
		t.Fatal("a restart naming another member must be refused")
	}
	if err := restart(testMemberA, ""); err == nil {
		t.Fatal("a restart needs its operation id")
	}
	if err := restart(testMemberA, "op-1"); err != nil {
		t.Fatal(err)
	}
	if err := restart(testMemberA, "op-1"); err != nil {
		t.Fatalf("a repeat with the same operation id is accepted: %v", err)
	}
	if reports := plugin.availabilityMemberReports(); reports[0].GetPendingRestartOperationId() != "op-1" {
		t.Fatalf("the pending restart is reported: %+v", reports[0])
	}
	adapter := setMemberRuntimeAdapter{manager: manager, plugin: plugin}
	if _, err := adapter.DialPeer(context.Background(), testSetID, testMemberB, setMemberBackupPort); !errors.Is(err, errSetMemberNotServing) {
		t.Fatalf("another member's backup port is not served here: %v", err)
	}
	if _, err := adapter.DialPeer(context.Background(), testSetID, testMemberA, setMemberBackupPort); err == nil {
		t.Fatal("a storage member serves no database backup")
	}
	capabilities := (&DockerPlugin{}).setMemberCapabilities()
	if len(capabilities) != 0 {
		t.Fatalf("no member runtime, no capabilities: %v", capabilities)
	}
}
