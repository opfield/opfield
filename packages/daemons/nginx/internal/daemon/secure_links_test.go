package daemon

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const testSecureLinkID = "11111111-1111-4111-8111-111111111111"

func testSourceLinkManager(t *testing.T, opener func(string, net.Conn)) *sourceLinkManager {
	t.Helper()
	manager := newSourceLinkManager(opener, "", nil)
	manager.authorizeUnixPeer = func(net.Conn) bool { return true }
	manager.socketDir = sockettest.Dir(t)
	return manager
}

func TestSourceLinkManagerSocketOnlyClosesLegacyTCPWithoutReplacingUnixSocket(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	legacy, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(legacy) != 1 || legacy[0].Port == 0 {
		t.Fatalf("legacy sync: statuses=%#v err=%v", legacy, err)
	}
	socketPath := legacy[0].SocketPath
	command := sourceCommand(uint32(legacy[0].Port), 2)
	command.Bindings[0].SocketOnly = true
	current, err := manager.sync(command)
	if err != nil || len(current) != 1 || current[0].Port != 0 || current[0].SocketPath != socketPath {
		t.Fatalf("socket-only sync: statuses=%#v err=%v", current, err)
	}
	if connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(legacy[0].Port)), 100*time.Millisecond); err == nil {
		_ = connection.Close()
		t.Fatal("legacy TCP listener still accepts socket-only traffic")
	}
	connection, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("socket-only Unix listener is unavailable: %v", err)
	}
	_ = connection.Close()
	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket permissions: mode=%v", info.Mode().Perm())
	}
}

func TestSourceLinkManagerSocketOnlyClosesAcceptedLegacyTCPConnection(t *testing.T) {
	accepted := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		accepted <- struct{}{}
		_, _ = io.Copy(io.Discard, connection)
	})
	legacy, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(legacy) != 1 || legacy[0].Port == 0 {
		t.Fatalf("legacy sync: statuses=%#v err=%v", legacy, err)
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(legacy[0].Port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("legacy connection was not accepted")
	}

	command := sourceCommand(uint32(legacy[0].Port), 2)
	command.Bindings[0].SocketOnly = true
	if _, err := manager.sync(command); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("accepted legacy TCP connection survived socket-only transition")
	}
}

func TestSourceLinkManagerFailedMultiBindingRotationKeepsExistingSocketReachable(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	initial, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(initial) != 1 {
		t.Fatalf("initial sync: statuses=%#v err=%v", initial, err)
	}
	originalPath := initial[0].SocketPath
	secondID := "22222222-2222-4222-8222-222222222222"
	secondPath := filepath.Join(manager.socketDir, secondID+".sock")
	if err := os.WriteFile(secondPath, []byte("user-owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(0, 2)
	command.Bindings[0].RotateListener = true
	command.Bindings = append(command.Bindings, &pb.ProxySecureLinkBinding{
		LinkId: secondID, Role: "source", Generation: 1, SocketOnly: true,
	})

	if _, err := manager.sync(command); err == nil {
		t.Fatal("expected the second non-socket path to reject synchronization")
	}
	connection, err := net.DialTimeout("unix", originalPath, time.Second)
	if err != nil {
		t.Fatalf("failed rotation removed the original listener: %v", err)
	}
	_ = connection.Close()
	if current := manager.bindings[testSecureLinkID]; current == nil || current.generation != 1 {
		t.Fatalf("failed rotation replaced in-memory state: %#v", current)
	}
}

func TestSourceLinkManagerRawRotationPreservesTCPPort(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	initial, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(initial) != 1 || initial[0].Port == 0 {
		t.Fatalf("initial sync: statuses=%#v err=%v", initial, err)
	}
	command := sourceCommand(uint32(initial[0].Port), 2)
	command.Bindings[0].RotateListener = true
	command.Bindings[0].SocketOnly = false

	rotated, err := manager.sync(command)
	if err != nil || len(rotated) != 1 {
		t.Fatalf("rotated sync: statuses=%#v err=%v", rotated, err)
	}
	if rotated[0].Port != initial[0].Port {
		t.Fatalf("raw TCP port changed during socket rotation: got=%d want=%d", rotated[0].Port, initial[0].Port)
	}
	connection, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort("127.0.0.1", stringPort(initial[0].Port)),
		time.Second,
	)
	if err != nil {
		t.Fatalf("preserved raw TCP listener is unreachable: %v", err)
	}
	_ = connection.Close()
}

// A raw link's rotation duplicates its TCP listener while the listener's
// accept loop runs. The duplicate must never switch the socket all copies
// share to blocking mode, not even briefly: an accept() entered meanwhile
// blocks in the kernel, and Close then waits for the next connection, forever
// on an idle link, while sync holds the manager. 200 duplications under
// accept load, the socket's mode watched throughout, then a time-bounded
// Close.
func TestDuplicateTCPListenerKeepsTheAcceptLoopClosable(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := listener.(*net.TCPListener).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan struct{})
	go func() {
		defer close(accepted)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.Close()
		}
	}()
	var sawBlocking atomic.Bool
	stop := make(chan struct{})
	var load sync.WaitGroup
	load.Add(2)
	go func() {
		defer load.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second); err == nil {
				_ = connection.Close()
			}
		}
	}()
	go func() {
		defer load.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = raw.Control(func(fd uintptr) {
				flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFL, 0)
				if errno == 0 && flags&syscall.O_NONBLOCK == 0 {
					sawBlocking.Store(true)
				}
			})
		}
	}()
	for i := 0; i < 200; i++ {
		duplicate, err := duplicateTCPListener(listener)
		if err != nil {
			t.Fatal(err)
		}
		_ = duplicate.Close()
	}
	close(stop)
	load.Wait()
	closed := make(chan struct{})
	go func() {
		_ = listener.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		// Free an accept() stuck in blocking mode so the test can end.
		if connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second); err == nil {
			_ = connection.Close()
		}
		t.Fatal("closing the listener hung on an accept() in blocking mode")
	}
	<-accepted
	if sawBlocking.Load() {
		t.Fatal("duplicating the listener switched its socket to blocking mode")
	}
}

func TestSourceLinkManagerRollbackRestoresCanonicalSocketWhenMoveBackFails(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	secondID := "22222222-2222-4222-8222-222222222222"
	initialCommand := sourceCommand(0, 1)
	initialCommand.Bindings[0].SocketOnly = true
	initialCommand.Bindings = append(initialCommand.Bindings, &pb.ProxySecureLinkBinding{
		LinkId: secondID, Role: "source", Generation: 1, SocketOnly: true,
	})
	initial, err := manager.sync(initialCommand)
	if err != nil || len(initial) != 2 {
		t.Fatalf("initial sync: statuses=%#v err=%v", initial, err)
	}
	paths := map[string]string{}
	for _, status := range initial {
		paths[status.LinkID] = status.SocketPath
	}
	rotation := sourceCommand(0, 2)
	rotation.Bindings[0].SocketOnly = true
	rotation.Bindings[0].RotateListener = true
	rotation.Bindings = append(rotation.Bindings, &pb.ProxySecureLinkBinding{
		LinkId: secondID, Role: "source", Generation: 2, RotateListener: true, SocketOnly: true,
	})
	renameCalls := 0
	manager.renameSocket = func(oldPath, newPath string) error {
		renameCalls++
		if renameCalls == 4 {
			return errors.New("injected second publish failure")
		}
		if renameCalls == 6 {
			return errors.New("injected rollback move failure")
		}
		return os.Rename(oldPath, newPath)
	}

	if _, err := manager.sync(rotation); err == nil {
		t.Fatal("expected injected multi-rotation failure")
	}
	for _, id := range []string{testSecureLinkID, secondID} {
		connection, err := net.DialTimeout("unix", paths[id], time.Second)
		if err != nil {
			t.Fatalf("restored socket %s is unreachable: %v", id, err)
		}
		_ = connection.Close()
		if manager.bindings[id].generation != 1 {
			t.Fatalf("failed rotation changed generation for %s", id)
		}
	}
}

func TestSourceLinkManagerRejectsUnauthorizedUnixPeerBeforeOpeningRelay(t *testing.T) {
	opened := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		opened <- struct{}{}
		_ = connection.Close()
	})
	manager.authorizeUnixPeer = func(net.Conn) bool { return false }
	command := sourceCommand(0, 1)
	command.Bindings[0].SocketOnly = true
	statuses, err := manager.sync(command)
	if err != nil || len(statuses) != 1 {
		t.Fatalf("socket-only sync: statuses=%#v err=%v", statuses, err)
	}
	connection, err := net.DialTimeout("unix", statuses[0].SocketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	select {
	case <-opened:
		t.Fatal("unauthorized Unix peer reached the relay opener")
	case <-time.After(100 * time.Millisecond):
	}
}

func sourceCommand(port uint32, generation uint64) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: testSecureLinkID, Role: "source", Generation: generation, ListenerPort: port, SourceConfigManaged: true,
	}}}
}

func TestCanonicalExecutablePathResolvesPathNames(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	resolved := canonicalExecutablePath("true")
	if resolved == "" || !filepath.IsAbs(resolved) {
		t.Fatalf("PATH executable was not canonicalized: %q", resolved)
	}
	if expected, err := filepath.EvalSymlinks(trueBinary); err == nil && resolved != filepath.Clean(expected) {
		t.Fatalf("canonical executable = %q, want %q", resolved, filepath.Clean(expected))
	}
	if resolved := canonicalExecutablePath("gateway-definitely-missing-nginx-binary"); resolved != "" {
		t.Fatalf("unresolved executable did not fail closed: %q", resolved)
	}
}

func TestProxySecureLinkSetupTimeoutOnlyCoversHandshake(t *testing.T) {
	t.Run("cancels an unready stream", func(t *testing.T) {
		ctx, cancel, finishSetup := proxySecureLinkSetupContext(context.Background(), 20*time.Millisecond)
		defer cancel()
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("setup context was not cancelled")
		}
		if finishSetup() {
			t.Fatal("expired setup timer reported a successful stop")
		}
	})

	t.Run("keeps a ready stream alive", func(t *testing.T) {
		ctx, cancel, finishSetup := proxySecureLinkSetupContext(context.Background(), 20*time.Millisecond)
		defer cancel()
		if !finishSetup() {
			t.Fatal("ready stream lost the setup timeout race")
		}
		time.Sleep(40 * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Fatal("setup timeout cancelled an established stream")
		default:
		}
	})
}

func TestProxySecureLinkProbeDoesNotRetainIdleConnection(t *testing.T) {
	closed := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		defer connection.Close()
		request, err := http.ReadRequest(bufio.NewReader(connection))
		if err != nil {
			return
		}
		_ = request.Body.Close()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
		_ = connection.SetReadDeadline(time.Now().Add(time.Second))
		_, _ = connection.Read(make([]byte, 1))
		closed <- struct{}{}
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync listener: statuses=%#v err=%v", statuses, err)
	}
	plugin := &NginxPlugin{secureLinks: manager}
	if _, err := plugin.ProbeProxySecureLink(&pb.ProbeProxySecureLinkCommand{
		LinkId: testSecureLinkID, Scheme: "http", Path: "/", ExpectedStatus: 200, TimeoutSeconds: 1,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("health probe retained an idle secure-link connection")
	}
}

func TestSourceLinkManagerAllocatesReusesAndReallocatesPorts(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(statuses) != 1 || statuses[0].Port == 0 {
		t.Fatalf("initial sync: statuses=%#v err=%v", statuses, err)
	}
	allocated := statuses[0].Port
	statuses, err = manager.sync(sourceCommand(uint32(allocated), 2))
	if err != nil || statuses[0].Port != allocated {
		t.Fatalf("reuse sync: statuses=%#v err=%v", statuses, err)
	}
	if _, err := manager.sync(&pb.SyncProxySecureLinksCommand{}); err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", stringPort(allocated)))
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()

	restarted := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err = restarted.sync(sourceCommand(uint32(allocated), 2))
	if err != nil || statuses[0].Port == allocated || statuses[0].Port == 0 {
		t.Fatalf("conflict sync: statuses=%#v err=%v", statuses, err)
	}
	reallocated := statuses[0].Port
	statuses, err = restarted.sync(sourceCommand(uint32(allocated), 3))
	if err != nil || statuses[0].Port != reallocated {
		t.Fatalf("stale control-plane port caused listener churn: statuses=%#v err=%v", statuses, err)
	}
}

func TestSourceLinkManagerRejectedSnapshotKeepsThePreviousSet(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	secondID := "22222222-2222-4222-8222-222222222222"
	initial := &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: testSecureLinkID, Role: "source", Generation: 2},
		{LinkId: secondID, Role: "source", Generation: 2},
	}}
	before, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.sync(sourceCommand(0, 1)); err == nil {
		t.Fatal("expected stale snapshot to fail")
	}
	after, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 || before[0].Port != after[0].Port || before[1].Port != after[1].Port {
		t.Fatalf("rejected snapshot mutated listeners: before=%#v after=%#v", before, after)
	}
}

func TestSourceLinkManagerRotatesManagedSocketBeforeActiveTargetCutover(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	before, err := manager.sync(sourceCommand(0, 2))
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(uint32(before[0].Port), 3)
	command.Bindings[0].RotateListener = true
	command.Bindings[0].SocketOnly = true
	after, err := manager.sync(command)
	if err != nil {
		t.Fatal(err)
	}
	if after[0].Port != 0 {
		t.Fatalf("managed rotation retained a TCP listener: %d", after[0].Port)
	}
	if connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(before[0].Port)), 100*time.Millisecond); err == nil {
		_ = connection.Close()
		t.Fatal("retired production listener still accepts traffic")
	}
	connection, err := net.DialTimeout("unix", after[0].SocketPath, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("replacement Unix listener is not addressable after rotation: %v", err)
	}
	_ = connection.Close()
}

func TestSourceLinkRemovalClosesActiveConnections(t *testing.T) {
	accepted := make(chan struct{})
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		close(accepted)
		_, _ = io.Copy(io.Discard, connection)
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", stringPort(statuses[0].Port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("listener did not accept connection")
	}
	if _, err := manager.sync(&pb.SyncProxySecureLinksCommand{}); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected active connection to close")
	}
}

func TestSourceLinkGrantRevocationClosesActiveConnectionButKeepsListener(t *testing.T) {
	accepted := make(chan struct{}, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		select {
		case accepted <- struct{}{}:
		default:
		}
		_, _ = io.Copy(io.Discard, connection)
	})
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	address := net.JoinHostPort("127.0.0.1", stringPort(statuses[0].Port))
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("listener did not accept connection")
	}

	manager.closeActive(testSecureLinkID)
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := connection.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected revoked connection to close")
	}

	reconnected, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("listener was removed by grant revocation: %v", err)
	}
	_ = reconnected.Close()
}

func stringPort(port int) string {
	return strconv.Itoa(port)
}

func TestReconcileRestoredSecureLinkPortsAtomicallyUpdatesProxyPass(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{
		mgr:    manager,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	path := manager.ConfigPath(testSecureLinkID)
	original := "location / {\n  # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n  proxy_pass https://127.0.0.1:41000;\n}\nlocation /secondary {\n  proxy_pass http://127.0.0.1:9999;\n}\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	restored := sourceCommand(41000, 2)
	statuses := []sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}}

	if err := plugin.reconcileRestoredSecureLinkPorts(restored, statuses); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	actual := string(content)
	if !strings.Contains(actual, "proxy_pass https://127.0.0.1:42000;") {
		t.Fatalf("recovered config did not use new listener port: %s", actual)
	}
	if !strings.Contains(actual, "proxy_pass http://127.0.0.1:9999;") {
		t.Fatalf("recovery changed a secondary loopback proxy_pass: %s", actual)
	}
}

func TestReconcileRestoredSecureLinkPortsNeverRewritesUnmarkedRawConfig(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location /one { proxy_pass http://127.0.0.1:9000; }\n# gateway-managed-secure-link-upstream 22222222-2222-4222-8222-222222222222\nproxy_pass http://127.0.0.1:41000;\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := plugin.reconcileRestoredSecureLinkPorts(
		sourceCommand(41000, 2),
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, original) {
		t.Fatalf("raw config was rewritten: %s", content)
	}
}

func TestReconcileRestoredSecureLinkPortsNeverRewritesUserOwnedCopiedManagedConfig(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(trueBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location / {\n # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n proxy_pass http://127.0.0.1:41000;\n}\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := sourceCommand(41000, 2)
	restored.Bindings[0].SourceConfigManaged = false
	if err := plugin.reconcileRestoredSecureLinkPorts(
		restored,
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, original) {
		t.Fatalf("user-owned copied config was rewritten: %s", content)
	}
}

func TestApplyRawConfigDurablyDropsManagedRecoveryOwnershipBeforeWriting(t *testing.T) {
	trueBinary, err := exec.LookPath("true")
	if err != nil {
		t.Skip("true binary unavailable")
	}
	manager := nginx.NewManager(trueBinary, t.TempDir(), t.TempDir(), "")
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(41000, 2)
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}
	handler := &Handler{
		mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), secureLinkState: store,
	}
	result := &pb.CommandResult{Success: true}
	handler.handleApplyConfig(&pb.ApplyConfigCommand{
		HostId: testSecureLinkID,
		ConfigContent: "# gateway-managed-secure-link-upstream " + testSecureLinkID +
			"\nproxy_pass http://127.0.0.1:41000;\n",
		ConfigOwnership: configOwnershipUserOwned,
	}, result)
	if !result.Success {
		t.Fatalf("apply raw config: %s", result.Error)
	}
	if store.Get().Bindings[0].SourceConfigManaged {
		t.Fatal("raw config retained managed restart-rewrite ownership")
	}
}

func TestApplyManagedConfigClaimsRecoveryOwnershipBeforeNginxValidation(t *testing.T) {
	stateDir := t.TempDir()
	store, err := securelink.NewStateStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	command := sourceCommand(42000, 3)
	command.Bindings[0].SourceConfigManaged = false // listener was rotated for an active target update
	if err := store.Save(command); err != nil {
		t.Fatal(err)
	}

	checker := filepath.Join(t.TempDir(), "nginx-check")
	statePath := filepath.Join(stateDir, "proxy-secure-links.json")
	script := "#!/bin/sh\ngrep -q '\"source_config_managed\":true' " + strconv.Quote(statePath) + "\n"
	if err := os.WriteFile(checker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := nginx.NewManager(checker, t.TempDir(), t.TempDir(), "")
	handler := &Handler{
		mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), secureLinkState: store,
	}
	result := &pb.CommandResult{Success: true}
	handler.handleApplyConfig(&pb.ApplyConfigCommand{
		HostId:          testSecureLinkID,
		ConfigContent:   "# gateway-managed-secure-link-upstream " + testSecureLinkID + "\nproxy_pass http://127.0.0.1:42000;\n",
		ConfigOwnership: configOwnershipManagedSecureLink,
	}, result)
	if !result.Success {
		t.Fatalf("apply managed config: %s", result.Error)
	}
	if !store.Get().Bindings[0].SourceConfigManaged {
		t.Fatal("managed config did not claim restart-rewrite ownership")
	}
}

func TestApplyConfigRollsBackWhenNginxReloadFails(t *testing.T) {
	checker := filepath.Join(t.TempDir(), "nginx-check")
	script := "#!/bin/sh\nif [ \"$1\" = \"-t\" ]; then exit 0; fi\nexit 1\n"
	if err := os.WriteFile(checker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name     string
		original []byte
	}{
		{name: "removes newly-created config"},
		{name: "restores existing config", original: []byte("server { listen 8080; }\n")},
	} {
		t.Run(test.name, func(t *testing.T) {
			configDir := t.TempDir()
			manager := nginx.NewManager(checker, configDir, t.TempDir(), "")
			path := manager.ConfigPath(testSecureLinkID)
			if test.original != nil {
				if err := os.WriteFile(path, test.original, 0o600); err != nil {
					t.Fatal(err)
				}
			}

			handler := &Handler{mgr: manager, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			result := &pb.CommandResult{Success: true}
			handler.handleApplyConfig(&pb.ApplyConfigCommand{
				HostId:        testSecureLinkID,
				ConfigContent: "server { listen 9090; }\n",
			}, result)

			if result.Success || !strings.Contains(result.Error, "nginx reload failed") {
				t.Fatalf("expected reload failure, got success=%v error=%q", result.Success, result.Error)
			}
			content, err := os.ReadFile(path)
			if test.original == nil {
				if !os.IsNotExist(err) {
					t.Fatalf("new config was not removed: content=%q err=%v", content, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(content, test.original) {
				t.Fatalf("existing config was not restored: %q", content)
			}
		})
	}
}

func TestReconcileRestoredSecureLinkPortsRollsBackInvalidConfig(t *testing.T) {
	falseBinary, err := exec.LookPath("false")
	if err != nil {
		t.Skip("false binary unavailable")
	}
	configDir := t.TempDir()
	manager := nginx.NewManager(falseBinary, configDir, t.TempDir(), "")
	plugin := &NginxPlugin{
		mgr:    manager,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	path := manager.ConfigPath(testSecureLinkID)
	original := []byte("location / {\n # gateway-managed-secure-link-upstream " + testSecureLinkID + "\n proxy_pass http://127.0.0.1:41000;\n}\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	err = plugin.reconcileRestoredSecureLinkPorts(
		sourceCommand(41000, 2),
		[]sourceLinkStatus{{LinkID: testSecureLinkID, Generation: 2, Port: 42000}},
	)
	if err == nil {
		t.Fatal("expected nginx config validation failure")
	}
	content, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(content) != string(original) {
		t.Fatalf("config was not rolled back: %s", content)
	}
}
