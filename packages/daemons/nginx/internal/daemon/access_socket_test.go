package daemon

import (
	"io"
	"log/slog"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/access"
)

func TestSyncAccessPolicyCommand(t *testing.T) {
	store, err := access.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), accessPolicy: store}
	sync := func(revision uint64, lists ...string) *pb.CommandResult {
		command := &pb.SyncAccessPolicyCommand{Revision: revision, SignInOrigin: "https://access.example.net"}
		for _, id := range lists {
			command.Lists = append(command.Lists, &pb.AccessListPolicy{Id: id, SignInMethods: []string{"opfield"}, IncludeRules: []*pb.AccessRule{{Selector: "everyone"}}})
		}
		return h.HandleCommand(&pb.OpfieldCommand{CommandId: "c", Payload: &pb.OpfieldCommand_SyncAccessPolicy{SyncAccessPolicy: command}})
	}
	const list = "11111111-1111-4111-8111-111111111111"
	if result := sync(3, list); !result.Success || !store.HasList(list) {
		t.Fatalf("apply: %+v", result)
	}
	// An older revision is acknowledged without changes.
	if result := sync(2); !result.Success || !store.HasList(list) {
		t.Fatalf("stale revision: %+v", result)
	}
	if result := sync(4, "not a list id"); result.Success || !store.HasList(list) {
		t.Fatalf("invalid policy: %+v", result)
	}
	if result := (&Handler{logger: h.logger}).HandleCommand(&pb.OpfieldCommand{Payload: &pb.OpfieldCommand_SyncAccessPolicy{SyncAccessPolicy: &pb.SyncAccessPolicyCommand{}}}); result.Success {
		t.Fatal("a node without access checks must refuse the policy")
	}
}
