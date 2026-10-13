package docker

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// keepSocketForNextProcess listens at path with mode, hands the listener to the keeper as a stopping daemon process
// does, and returns the keeper name; the caller then starts the next process with connectKeeper.
// keeperSettleWait bounds a test's wait for the keeper to apply the messages sent before; Settle returns as soon as
// they are. One second was too short on a loaded host (the whole daemon suite runs its packages in parallel).
const keeperSettleWait = 10 * time.Second

func keepSocketForNextProcess(t *testing.T, store *listenerkeep.Store, path string, mode os.FileMode, uid, gid int) string {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	name := keepUnixListener(listener, path)
	if name == "" {
		t.Fatal("the listener was not kept")
	}
	_ = listener.Close()
	store.Settle(keeperSettleWait)
	return name
}

// A node switched from a root docker-daemon to one without root: the installer gave the state directory to the
// daemon's user, so the storage relay socket the root process kept is now owned by that user but still has the root
// mode 0600, which the connectors (uid 65532, the daemon's group) cannot connect to. The next process must not adopt
// it, and a socket that fits is still adopted.
func TestNonRootDaemonReplacesAHandedOverRootSocket(t *testing.T) {
	previousUID, previousGID := daemonEUID, daemonEGID
	t.Cleanup(func() { daemonEUID, daemonEGID = previousUID, previousGID })
	uid, gid := os.Geteuid(), os.Getegid()
	if uid == 0 {
		// Run as root, the test plays a daemon user that owns the files.
		uid, gid = 4242, 4242
	}
	daemonEUID = func() int { return uid }
	daemonEGID = func() int { return gid }

	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	path := filepath.Join(sockettest.Dir(t), storageConnectorSocketName)

	stale := keepSocketForNextProcess(t, store, path, 0o600, uid, gid)
	connectKeeper(t, store, inheritedFrom(t, store))
	if listener, _ := adoptKeptUnixListener(path, storageConnectorSocketFits); listener != nil {
		_ = listener.Close()
		t.Fatal("adopted a handed-over 0600 socket the connectors cannot reach")
	}
	store.Settle(keeperSettleWait)
	for _, name := range store.Names() {
		if name == stale {
			t.Fatal("the socket that no longer fits stayed in the keeper")
		}
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	fitting := keepSocketForNextProcess(t, store, path, 0o660, uid, gid)
	connectKeeper(t, store, inheritedFrom(t, store))
	listener, name := adoptKeptUnixListener(path, storageConnectorSocketFits)
	if listener == nil || name != fitting {
		t.Fatalf("a fitting handed-over socket was not adopted (%q, want %q)", name, fitting)
	}
	_ = listener.Close()
}

// The reverse switch: a root daemon does not take the 0660 socket of its non-root predecessor, only its own layout.
func TestRootDaemonAcceptsOnlyTheRootSocketLayout(t *testing.T) {
	previousUID := daemonEUID
	t.Cleanup(func() { daemonEUID = previousUID })
	daemonEUID = func() int { return 0 }
	path := filepath.Join(sockettest.Dir(t), storageConnectorSocketName)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o660); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(path); err != nil || storageConnectorSocketFits(info) {
		t.Fatalf("a root daemon accepted a non-root daemon's socket (%v)", err)
	}
	if os.Geteuid() != 0 {
		return
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, connectorUID, connectorUID); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(path); err != nil || !storageConnectorSocketFits(info) {
		t.Fatalf("a root daemon refused its own socket layout (%v)", err)
	}
}
