package docker

import (
	"log/slog"
	"sync"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
)

// fakeCommandStream records what the daemon sends Gateway on its control session.
type fakeCommandStream struct {
	pb.NodeControl_CommandStreamClient
	mu   sync.Mutex
	sent []*pb.DaemonMessage
}

func (f *fakeCommandStream) Send(message *pb.DaemonMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, message)
	return nil
}

func (f *fakeCommandStream) logEntries(message string) []*pb.DaemonLogEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	var entries []*pb.DaemonLogEntry
	for _, sent := range f.sent {
		if entry := sent.GetDaemonLog(); entry != nil && entry.GetMessage() == message {
			entries = append(entries, entry)
		}
	}
	return entries
}

// The host listener manager keeps the logger it got at Init. Once a control session starts, its refused connections
// reach the Gateway's node logs like every other WARN of the daemon, and still the journal.
func TestComponentWarningsReachTheSessionLogStream(t *testing.T) {
	journal, journalLines := newTestLogger()
	plugin := &DockerPlugin{}
	plugin.useLogger(journal)
	manager := newManagedDatabaseHostListenerManager(plugin)
	derived := plugin.logger.With("component", "links")

	stream.SetDaemonLogStreaming(true, "info")
	commands := &fakeCommandStream{}
	plugin.SetLogger(slog.New(stream.NewGrpcLogHandlerWithWriter(stream.NewWriter(commands), journal.Handler())))

	manager.rejections.rejected(manager.logger, linkKindManagedDatabaseBinding, testListenerBindingA, linkRejectedLinkLimit, "limit", 64)
	derived.Warn("derived logger line")

	entries := commands.logEntries("managed link connection rejected")
	if len(entries) != 1 {
		t.Fatalf("rejection sent to Gateway %d times", len(entries))
	}
	if entry := entries[0]; entry.GetLevel() != "warn" || entry.GetFields()["binding_id"] != testListenerBindingA ||
		entry.GetFields()["reason"] != linkRejectedLinkLimit || entry.GetFields()["limit"] != "64" {
		t.Fatalf("rejection entry %+v", entry)
	}
	if entries := commands.logEntries("derived logger line"); len(entries) != 1 || entries[0].GetComponent() != "links" {
		t.Fatalf("derived logger entries %+v", entries)
	}
	if len(journalLines.lines("managed link connection rejected", "reason="+linkRejectedLinkLimit)) != 1 ||
		len(journalLines.lines("derived logger line")) != 1 {
		t.Fatal("lines missing from the journal")
	}
}
