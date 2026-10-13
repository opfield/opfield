package lifecycle

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func grantSyncCommand(id string, revision uint64) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{CommandId: id, Payload: &pb.OpfieldCommand_SyncRelayGrants{
		SyncRelayGrants: &pb.SyncRelayGrantsCommand{PolicyRevision: revision},
	}}
}

// A slow grant sync (database listeners, connector egress) no longer holds the session's receive loop: submitting
// returns at once, so the commands behind it are served meanwhile (S6). Bundles that arrive while one is applied
// collapse into the newest, and every command is answered.
func TestSlowGrantSyncDoesNotHoldTheSession(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var applied []uint64
	results := make(chan *pb.CommandResult, 8)
	worker := newGrantSyncWorker(context.Background(), &sync.Mutex{}, func(bundle *pb.SyncRelayGrantsCommand) (string, error) {
		mu.Lock()
		applied = append(applied, bundle.GetPolicyRevision())
		first := len(applied) == 1
		mu.Unlock()
		if first {
			close(started)
			<-release
		}
		return "applied", nil
	}, func(result *pb.CommandResult) { results <- result })

	submitted := make(chan struct{})
	go func() {
		worker.submit(grantSyncCommand("bundle-1", 1))
		<-started
		// The receive loop goes on with the next commands while bundle 1 is applied.
		worker.submit(grantSyncCommand("bundle-3", 3))
		worker.submit(grantSyncCommand("bundle-2", 2))
		close(submitted)
	}()
	select {
	case <-submitted:
	case <-time.After(2 * time.Second):
		t.Fatal("a slow grant sync held the receive loop")
	}
	select {
	case result := <-results:
		t.Fatalf("answered %s before the slow sync finished", result.CommandId)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)

	answered := map[string]bool{}
	for range 3 {
		select {
		case result := <-results:
			if !result.Success || result.Detail != "applied" {
				t.Fatalf("result %+v", result)
			}
			answered[result.CommandId] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("answered only %v", answered)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(applied) != 2 || applied[0] != 1 || applied[1] != 3 {
		t.Fatalf("applied revisions %v, want 1 then the newest pending (3)", applied)
	}
}

// A sync of a session that dropped may still run when the next session's first bundle arrives: the two never run
// at once (every worker of a daemon shares its lock), and the dropped session's result is not sent anywhere.
func TestGrantSyncsOfConsecutiveSessionsNeverOverlap(t *testing.T) {
	var serial sync.Mutex
	var running, overlapped atomic.Int32
	release, started := make(chan struct{}), make(chan struct{})
	run := func(bundle *pb.SyncRelayGrantsCommand) (string, error) {
		if running.Add(1) > 1 {
			overlapped.Store(1)
		}
		defer running.Add(-1)
		if bundle.GetPolicyRevision() == 1 {
			close(started)
			<-release
		}
		return "applied", nil
	}
	oldCtx, dropSession := context.WithCancel(context.Background())
	oldResults := make(chan *pb.CommandResult, 4)
	newResults := make(chan *pb.CommandResult, 4)
	oldSession := newGrantSyncWorker(oldCtx, &serial, run, func(result *pb.CommandResult) { oldResults <- result })
	newSession := newGrantSyncWorker(context.Background(), &serial, run, func(result *pb.CommandResult) { newResults <- result })

	oldSession.submit(grantSyncCommand("old-bundle", 1))
	<-started
	dropSession()
	newSession.submit(grantSyncCommand("new-bundle", 2))
	select {
	case result := <-newResults:
		t.Fatalf("the new session's sync ran while the old one's was in flight: %+v", result)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	select {
	case result := <-newResults:
		if result.CommandId != "new-bundle" || !result.Success {
			t.Fatalf("new session result %+v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the new session's sync never ran")
	}
	if overlapped.Load() != 0 {
		t.Fatal("two grant syncs ran at once")
	}
	select {
	case result := <-oldResults:
		t.Fatalf("the dropped session's result was sent: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}
}
