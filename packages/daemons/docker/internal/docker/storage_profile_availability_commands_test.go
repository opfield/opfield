package docker

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const storageProfileRefusal = "storage-profile daemon accepts only"

// Availability sets run their members on storage nodes: the lease, member and
// witness commands must reach their handlers there, while generic Docker
// workload commands stay refused.
func TestStorageProfileRoutesAvailabilityCommands(t *testing.T) {
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	members, err := memberha.NewManager(memberha.Deps{
		Lease: stubSetLease{}, Watchdog: stubSetWatchdog{}, Endpoints: stubSetEndpoints{}, Clock: bootWallClock{},
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine:           func(memberha.Config) (memberha.Engine, error) { return nil, nil },
		Async:            func(func()) {},
		VerifyAssignment: func(string, memberha.Assignment) error { return nil },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{cfg: &config.Config{}, setMembers: members}
	plugin.keeperWitnesses = &nodeKeeperWitnesses{p: plugin, dir: filepath.Join(t.TempDir(), "keeper-witnesses"),
		desired: map[string]*pb.WitnessSpec{}, wake: make(chan struct{}, 1)}

	for _, mode := range []string{"storage", "databases"} {
		plugin.cfg.Docker.Mode = mode

		// Without an enrolled node the lease runtime does not run: the handler answers, not the profile switch.
		for name, cmd := range map[string]*pb.GatewayCommand{
			"lease sync": {Payload: &pb.GatewayCommand_SyncAvailabilityLease{SyncAvailabilityLease: &pb.SyncAvailabilityLeaseCommand{Revision: 1}}},
			"lease handoff": {Payload: &pb.GatewayCommand_AvailabilityLeaseHandoff{
				AvailabilityLeaseHandoff: &pb.AvailabilityLeaseHandoffCommand{PolicyId: "policy-1"}}},
		} {
			if result := plugin.HandleCommand(cmd); result.Error != errLeaseRuntimeUnavailable {
				t.Fatalf("%s: %s did not reach the lease handler: %+v", mode, name, result)
			}
		}

		witnesses := plugin.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_ApplyWitnesses{
			ApplyWitnesses: &pb.ApplyWitnessesCommand{Revision: 1}}})
		if !witnesses.Success || witnesses.Error != "" {
			t.Fatalf("%s: witness set refused: %+v", mode, witnesses)
		}

		member := plugin.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_AvailabilityMember{AvailabilityMember: &pb.AvailabilityMemberCommand{
			Action: &pb.AvailabilityMemberCommand_AckEvents{AckEvents: &pb.AvailabilityMemberEventsAck{SetId: testSetID, ThroughSequence: 1}},
		}}})
		if !member.Success || member.Error != "" {
			t.Fatalf("%s: member command refused: %+v", mode, member)
		}

		for name, cmd := range map[string]*pb.GatewayCommand{
			"container": {Payload: &pb.GatewayCommand_DockerContainer{DockerContainer: &pb.DockerContainerCommand{Action: "start", ContainerId: "c1"}}},
			"availability": {Payload: &pb.GatewayCommand_DockerAvailability{
				DockerAvailability: &pb.DockerAvailabilityCommand{Action: availabilityActionActivate}}},
		} {
			if result := plugin.HandleCommand(cmd); result.Success || !strings.Contains(result.Error, storageProfileRefusal) {
				t.Fatalf("%s: %s command was not refused: %+v", mode, name, result)
			}
		}
	}
}
