package docker

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// A root → non-root switch: the egress socket the root process handed over does not fit the new mode (0600, or set
// aside with its directory). A connection a connector made during the switch waits in its backlog and is served by
// the next process, and so is one the previous mode's connector makes through it afterwards; once that connector is
// retired the socket is dropped from the listener keeper. Before, the next process neither served nor dropped it:
// the connections hung, and the keeper held the socket for good.
func TestModeSwitchPreviousSockets(t *testing.T) {
	previousUID, previousGID := daemonEUID, daemonEGID
	t.Cleanup(func() { daemonEUID, daemonEGID = previousUID, previousGID })
	uid, gid := os.Geteuid(), os.Getegid()
	if uid == 0 {
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
	base := sockettest.Dir(t)
	// The socket stays where it was with the root mode, and one whose directory is set aside.
	inPlace := filepath.Join(base, "a", egressSocketName)
	setAside := filepath.Join(base, "b", egressSocketName)
	for _, path := range []string{inPlace, setAside} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	keptNames := []string{
		keepSocketForNextProcess(t, store, inPlace, 0o600, uid, gid),
		keepSocketForNextProcess(t, store, setAside, 0o600, uid, gid),
	}
	// Connections the connectors make while no daemon process runs.
	waiting := []net.Conn{}
	for _, path := range []string{inPlace, setAside} {
		connection, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		waiting = append(waiting, connection)
	}
	asideDirectory := filepath.Join(base, "b.aside")
	if err := os.Rename(filepath.Dir(setAside), asideDirectory); err != nil {
		t.Fatal(err)
	}

	connectKeeper(t, store, inheritedFrom(t, store))
	var previous previousUnixListeners
	for _, path := range []string{inPlace, setAside} {
		kept, _, others := adoptKeptUnixListeners(path, storageConnectorSocketFits)
		if kept != nil || len(others) != 1 {
			t.Fatalf("%s: adopted %v as this mode's socket, %d of the previous mode", path, kept != nil, len(others))
		}
		previous.serve(others, func(connection net.Conn) {
			defer connection.Close()
			line, _ := bufio.NewReader(connection).ReadString('\n')
			_, _ = fmt.Fprint(connection, strings.ToUpper(line))
		})
	}
	served := func(connection net.Conn, what string) {
		t.Helper()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = fmt.Fprint(connection, "hello\n")
		if line, err := bufio.NewReader(connection).ReadString('\n'); err != nil || line != "HELLO\n" {
			t.Fatalf("%s was not served: %q, %v", what, line, err)
		}
	}
	for index, connection := range waiting {
		served(connection, fmt.Sprintf("connection %d made during the switch", index))
	}
	// The previous mode's connector still reaches the set-aside socket through its mount.
	later, err := net.DialTimeout("unix", filepath.Join(asideDirectory, egressSocketName), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer later.Close()
	served(later, "a connection of the previous mode's connector after the switch")

	previous.retire()
	if previous.count() != 0 {
		t.Fatal("previous mode sockets still served after their connector was retired")
	}
	store.Settle(keeperSettleWait)
	for _, name := range keptNames {
		if slices.Contains(store.Names(), name) {
			t.Fatalf("the listener keeper still holds %s", name)
		}
	}
}

// The other direction, non-root → root: the 0660 egress socket the non-root process handed over does not fit a root
// daemon; a connection the previous mode's connector made during the switch is served instead of reset (F2).
func TestModeSwitchToRootPreviousSocket(t *testing.T) {
	previousUID := daemonEUID
	t.Cleanup(func() { daemonEUID = previousUID })
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	path := filepath.Join(sockettest.Dir(t), egressSocketName)
	// Written by a daemon without root, then given to root by the installer.
	daemonEUID = func() int { return 4242 }
	keptName := keepSocketForNextProcess(t, store, path, 0o660, 0, 0)
	waiting, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer waiting.Close()

	daemonEUID = func() int { return 0 }
	connectKeeper(t, store, inheritedFrom(t, store))
	kept, _, others := adoptKeptUnixListeners(path, storageConnectorSocketFits)
	if kept != nil || len(others) != 1 {
		t.Fatalf("adopted %v as the root daemon's socket, %d of the previous mode", kept != nil, len(others))
	}
	var previous previousUnixListeners
	previous.serve(others, func(connection net.Conn) {
		defer connection.Close()
		line, _ := bufio.NewReader(connection).ReadString('\n')
		_, _ = fmt.Fprint(connection, strings.ToUpper(line))
	})
	_ = waiting.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = fmt.Fprint(waiting, "hello\n")
	if line, err := bufio.NewReader(waiting).ReadString('\n'); err != nil || line != "HELLO\n" {
		t.Fatalf("the connection made during the switch was not served: %q, %v", line, err)
	}
	previous.retire()
	store.Settle(keeperSettleWait)
	if slices.Contains(store.Names(), keptName) {
		t.Fatal("the listener keeper still holds the previous mode's socket")
	}
}

// The connectors' ACL entry on the socket directories and sockets survives the installer giving them to another
// user, so a connector of the previous mode keeps its access through the switch (root → non-root reset connections
// for seconds before).
func TestConnectorAccessSurvivesAnOwnerChange(t *testing.T) {
	directory := filepath.Join(sockettest.Dir(t), "c")
	if err := os.Mkdir(directory, 0o750); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(directory, egressSocketName)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socket, 0o600); err != nil {
		t.Fatal(err)
	}
	for path, perms := range map[string]uint16{directory: 7, socket: 6} {
		if err := grantConnectorAccess(path, perms); err != nil {
			t.Fatal(err)
		}
	}
	if _, set := connectorACLPermissions(directory); !set {
		t.Skip("the file system here has no POSIX ACLs")
	}
	if os.Geteuid() == 0 {
		// The installer gives the state directory to the daemon's new user.
		for _, path := range []string{directory, socket} {
			if err := os.Lchown(path, 4242, 4242); err != nil {
				t.Fatal(err)
			}
		}
	}
	for path, want := range map[string]uint16{directory: 7, socket: 6} {
		if perms, set := connectorACLPermissions(path); !set || perms != want {
			t.Fatalf("%s gives the connectors %o (set %v), want %o", path, perms, set, want)
		}
	}
	// The mask lets the entry apply: the group bits of the mode show it.
	if info, err := os.Stat(socket); err != nil || info.Mode().Perm()&0o060 != 0o060 {
		t.Fatalf("socket mode %v, %v: the ACL mask does not let the connectors write", info.Mode(), err)
	}
	// A root daemon still takes its own socket with the entry as its own.
	previousUID := daemonEUID
	t.Cleanup(func() { daemonEUID = previousUID })
	daemonEUID = func() int { return 0 }
	if os.Geteuid() == 0 {
		if err := os.Lchown(socket, connectorUID, connectorUID); err != nil {
			t.Fatal(err)
		}
		if info, err := os.Lstat(socket); err != nil || !storageConnectorSocketFits(info) {
			t.Fatalf("a root daemon refused its own socket with the connectors' ACL entry (%v)", err)
		}
	}
}
