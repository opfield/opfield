package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/sockettest"
)

type discardWarnings struct{}

func (discardWarnings) Warn(string, ...any) {}

// Only nginx's workers post to the maintenance access socket: it is 0660 and belongs to their group, set as soon as
// that group is known (R3-03), not 0666 for every local user.
func TestMaintenanceAccessSocketBelongsToTheNginxWorkersGroup(t *testing.T) {
	path := filepath.Join(sockettest.Dir(t), "maintenance-access.sock")
	listener, keptName, err := listenServiceSocket(path, 0o660)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		releaseServiceSocket(listener, path, keptName, false)()
		_ = listener.Close()
	})
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode = %v, want 0660", info.Mode().Perm())
	}

	// Root may give the socket any group; another user only one of its own.
	group := os.Getgid()
	if os.Geteuid() == 0 {
		group = 4242
	}
	var calls atomic.Int32
	workerGID := func() (int, error) {
		// nginx is not running yet on the first try.
		if calls.Add(1) == 1 {
			return 0, errors.New("managed nginx worker process not found")
		}
		return group, nil
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		grantSocketToGroup(path, workerGID, 10*time.Millisecond, done, discardWarnings{})
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		close(done)
		t.Fatal("the socket's group was not set once the workers' group was known")
	}
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || int(stat.Gid) != group || calls.Load() < 2 {
		t.Fatalf("socket group = %v after %d tries, want %d", info.Sys(), calls.Load(), group)
	}
}
