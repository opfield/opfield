//go:build linux

package docker

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

type lockedLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedLogBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *lockedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// Any local process may connect to a backup relay route's loopback port while the run lasts: a user other than root,
// the daemon's own and the backup runner's is cut before the route's relay grant is used for it.
func TestBackupRelayRouteRefusesOtherLocalUsers(t *testing.T) {
	const routeID = "33333333-3333-4333-8333-333333333333"
	logs := &lockedLogBuffer{}
	plugin := &DockerPlugin{
		logger: slog.New(slog.NewTextHandler(logs, nil)),
		relayGrants: &relayGrantStore{current: &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{{
			Role: "connect", OwnerKind: "storage_backup_target", OwnerId: routeID, Grant: &pb.RelaySignedGrant{},
		}}}},
	}
	open := func() *BackupRelayRoute {
		route, err := plugin.OpenBackupRelayRoute(context.Background(), "storage_backup_target", routeID)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(route.Close)
		if !strings.HasPrefix(route.Address, "127.0.0.1:") {
			t.Fatalf("route address = %s", route.Address)
		}
		return route
	}
	dial := func(route *BackupRelayRoute) {
		connection, err := net.DialTimeout("tcp4", route.Address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _ = connection.Read(make([]byte, 1))
	}

	// The run's own clients (this process's user) are served: no refusal.
	dial(open())
	if strings.Contains(logs.String(), "refused") {
		t.Fatalf("a connection of the daemon's own user was refused: %s", logs.String())
	}

	previous := backupRelayRoutePeers
	backupRelayRoutePeers = func() func(int) bool { return func(int) bool { return false } }
	t.Cleanup(func() { backupRelayRoutePeers = previous })
	dial(open())
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(logs.String(), "backup relay route refused a local connection of another user") {
		if time.Now().After(deadline) {
			t.Fatalf("the connection of another user was not refused: %s", logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
