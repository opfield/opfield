package lifecycle

import (
	"errors"
	"io"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

type fakeSession struct {
	sent   []string
	broken bool
}

func (f *fakeSession) Send(msg *pb.DaemonMessage) error {
	if f.broken {
		return io.EOF
	}
	f.sent = append(f.sent, msg.GetCommandResult().GetCommandId())
	return nil
}

// A result whose send fails as the control session ends (stand rc.9: EOF at the launcher's planned reconnect), and
// one produced before the next session is accepted, are delivered on that session, oldest first; results after it
// go out at once. Results the gateway long stopped waiting for are dropped.
func TestResultOutboxCarriesResultsAcrossAReconnect(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var outbox resultOutbox
	first := &fakeSession{}
	if _, err := outbox.attach(first, now); err != nil {
		t.Fatal(err)
	}
	if failed, kept, err := outbox.send(&pb.CommandResult{CommandId: "a"}, now); failed != nil || kept || err != nil {
		t.Fatalf("send on a live session: failed %v kept %v err %v", failed, kept, err)
	}
	first.broken = true
	failed, kept, err := outbox.send(&pb.CommandResult{CommandId: "865c59f6"}, now)
	if failed != first || !kept || !errors.Is(err, io.EOF) {
		t.Fatalf("send as the session ends: failed %v kept %v err %v", failed, kept, err)
	}
	outbox.detach(first)
	if failed, kept, _ := outbox.send(&pb.CommandResult{CommandId: "between"}, now); failed != nil || !kept {
		t.Fatalf("send between sessions: failed %v kept %v", failed, kept)
	}
	outbox.keepLocked(&pb.CommandResult{CommandId: "stale"}, now.Add(-outboxTTL-time.Second))
	broken := &fakeSession{broken: true}
	if _, err := outbox.attach(broken, now); err == nil {
		t.Fatal("attach to a broken session succeeded")
	}
	second := &fakeSession{}
	delivered, err := outbox.attach(second, now.Add(time.Second))
	if err != nil || delivered != 2 {
		t.Fatalf("attach: delivered %d err %v", delivered, err)
	}
	outbox.send(&pb.CommandResult{CommandId: "after"}, now)
	if got := second.sent; len(got) != 3 || got[0] != "865c59f6" || got[1] != "between" || got[2] != "after" {
		t.Fatalf("second session got %v", got)
	}
	outbox.detach(first) // a stale session's end leaves the current one attached
	outbox.send(&pb.CommandResult{CommandId: "later"}, now)
	if len(second.sent) != 4 {
		t.Fatalf("after a stale detach: %v", second.sent)
	}
}

func TestResultOutboxKeepsAtMostItsLimit(t *testing.T) {
	var outbox resultOutbox
	now := time.Unix(1_700_000_000, 0)
	for i := range outboxLimit + 10 {
		outbox.send(&pb.CommandResult{CommandId: string(rune('a' + i%26))}, now)
	}
	if len(outbox.kept) != outboxLimit {
		t.Fatalf("kept %d", len(outbox.kept))
	}
}
