package listenerkeep

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/sockettest"
)

type notification struct {
	message string
	files   int
}

// A daemon under a launcher with a keeper, in a unit that gave the launcher no
// NOTIFY_SOCKET (started before it had a file descriptor store): what it keeps,
// and what it takes over from the previous process, also goes to systemd's
// store on the launcher's behalf, so a restart of the whole unit keeps it.
func TestKeeperWithoutNotifySocketStoresListenersInSystemd(t *testing.T) {
	if !notifyOnBehalfSupported || os.Geteuid() != 0 {
		t.Skip("notifying on behalf of another process needs Linux and root")
	}
	notify := listenNotify(t)
	launcher, childEnd := keeperChannel(t)
	// The keeper client owns the inherited descriptor and the channel end.
	listenerFile := duplicateListener(t, listenUnix(t, "inherited.sock"))
	inherited, err := syscall.Dup(int(listenerFile.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	kept, _ := json.Marshal([]keptDescriptor{{Name: "inherited#1", FD: inherited}})
	t.Setenv(launcherManagedEnv, "1")
	t.Setenv(ChannelFDEnv, strconv.Itoa(childEnd))
	t.Setenv(KeptEnv, string(kept))
	t.Setenv("NOTIFY_SOCKET", "")
	t.Setenv("INVOCATION_ID", "test")

	keeper := newClientFromEnvironment()
	file, ok := keeper.take("inherited#1")
	if !ok {
		t.Fatal("the inherited listener was not handed over")
	}
	_ = file.Close()
	if got := readNotifications(t, notify, 2); got[1].message != "FDSTORE=1\nFDNAME=inherited#1\n" || got[1].files != 1 {
		t.Fatalf("the taken listener was not stored in systemd: %+v", got)
	}

	fresh := duplicateListener(t, listenUnix(t, "fresh.sock"))
	if err := keeper.keep("fresh#2", fresh); err != nil {
		t.Fatal(err)
	}
	if message := readLauncher(t, launcher); message != "keep\nfresh#2" {
		t.Fatalf("the launcher got %q", message)
	}
	if got := readNotifications(t, notify, 2); got[1].message != "FDSTORE=1\nFDNAME=fresh#2\n" || got[1].files != 1 {
		t.Fatalf("the kept listener was not stored in systemd: %+v", got)
	}
	if err := keeper.drop("fresh#2"); err != nil {
		t.Fatal(err)
	}
	if got := readNotifications(t, notify, 1); got[0].message != "FDSTOREREMOVE=1\nFDNAME=fresh#2\n" {
		t.Fatalf("the dropped listener stayed in systemd: %+v", got)
	}
}

// A launcher that systemd gave a NOTIFY_SOCKET stores what it keeps itself;
// the daemon leaves systemd alone.
func TestKeeperWithNotifySocketLeavesSystemdToTheLauncher(t *testing.T) {
	_, childEnd := keeperChannel(t)
	t.Setenv(launcherManagedEnv, "1")
	t.Setenv(ChannelFDEnv, strconv.Itoa(childEnd))
	t.Setenv(KeptEnv, "")
	t.Setenv("NOTIFY_SOCKET", filepath.Join(sockettest.Dir(t), "notify"))
	t.Setenv("INVOCATION_ID", "test")
	if keeper := newClientFromEnvironment(); keeper.send == nil || keeper.mirror != nil {
		t.Fatalf("keeper client: send %v, mirror %v", keeper.send != nil, keeper.mirror != nil)
	}
}

func listenNotify(t *testing.T) *net.UnixConn {
	t.Helper()
	path := filepath.Join(sockettest.Dir(t), "notify")
	connection, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	previous := systemdNotifySocket
	systemdNotifySocket = path
	t.Cleanup(func() { systemdNotifySocket = previous })
	return connection
}

func keeperChannel(t *testing.T) (*net.UnixConn, int) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_DGRAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	launcherFile := os.NewFile(uintptr(fds[0]), "launcher")
	connection, err := net.FileConn(launcherFile)
	_ = launcherFile.Close()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection.(*net.UnixConn), fds[1]
}

func listenUnix(t *testing.T, name string) *net.UnixListener {
	t.Helper()
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(sockettest.Dir(t), name), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func duplicateListener(t *testing.T, listener *net.UnixListener) *os.File {
	t.Helper()
	file, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func readNotifications(t *testing.T, connection *net.UnixConn, count int) []notification {
	t.Helper()
	var got []notification
	for range count {
		buffer, oob := make([]byte, maxMessage), make([]byte, syscall.CmsgSpace(4*4))
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, oobn, _, _, err := connection.ReadMsgUnix(buffer, oob)
		if err != nil {
			t.Fatalf("after %+v: %v", got, err)
		}
		files := receivedFiles(oob[:oobn])
		for _, file := range files {
			_ = file.Close()
		}
		got = append(got, notification{message: string(buffer[:n]), files: len(files)})
	}
	return got
}

func readLauncher(t *testing.T, connection *net.UnixConn) string {
	t.Helper()
	buffer, oob := make([]byte, maxMessage), make([]byte, syscall.CmsgSpace(4*4))
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, oobn, _, _, err := connection.ReadMsgUnix(buffer, oob)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range receivedFiles(oob[:oobn]) {
		_ = file.Close()
	}
	return strings.TrimSpace(string(buffer[:n]))
}
