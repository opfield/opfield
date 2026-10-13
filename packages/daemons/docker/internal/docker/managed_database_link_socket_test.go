//go:build linux

package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

func postgresStartupMessage(user string) []byte {
	body := []byte{0, 3, 0, 0}
	body = append(body, []byte("user\x00"+user+"\x00\x00")...)
	message := make([]byte, 4, 4+len(body))
	binary.BigEndian.PutUint32(message, uint32(4+len(body)))
	return append(message, body...)
}

// listenLinkSocket is a database's link socket directory with PostgreSQL
// listening in it: it records the first bytes of every connection.
func listenLinkSocket(t *testing.T) (string, chan []byte) {
	t.Helper()
	dir := filepath.Join(sockettest.Dir(t), "db")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, pgLinkSocketName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	received := make(chan []byte, 4)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buffer := make([]byte, 256)
				n, _ := conn.Read(buffer)
				received <- buffer[:n]
			}()
		}
	}()
	return dir, received
}

// A relay client that does not negotiate TLS (an app's database link) reaches
// a database with the link socket over that socket: the opening goes there,
// the TCP connection to the bridge address is closed, and the connection is a
// plain socket a daemon update hands over.
func TestManagedPostgresLinkPrefersTheLinkSocket(t *testing.T) {
	dir, received := listenLinkSocket(t)
	bridge, engine := net.Pipe()
	defer engine.Close()
	startup := postgresStartupMessage("app")
	stream := &scriptedFrames{frames: []*relayv1.TunnelFrame{dataFrame(startup)}}
	plain := func(ctx context.Context) (net.Conn, error) { return dialSocketIn(ctx, dir, pgLinkSocketName) }

	linked, err := negotiateManagedPostgresLink(context.Background(), bridge, stream, func() {}, nil, plain)
	if err != nil {
		t.Fatal(err)
	}
	defer linked.Close()
	if _, ok := linked.(*net.UnixConn); !ok {
		t.Fatalf("link connection %T, want the link socket", linked)
	}
	select {
	case got := <-received:
		if !bytes.Equal(got, startup) {
			t.Fatalf("the engine got %q, want the startup packet", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the startup packet did not reach the link socket")
	}
	_ = engine.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := engine.Read(make([]byte, 1)); !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("the bridge connection stayed open: %v", err)
	}
	if class := linkCutClass(linked); class != "" {
		t.Fatalf("a socket link is cut as %q on an update", class)
	}
}

// Without an answering link socket (a container created before it, the engine
// not listening yet) the link uses TLS over the bridge, as before; a client
// that negotiates TLS itself never uses the socket.
func TestManagedPostgresLinkFallsBackToTLSOverTheBridge(t *testing.T) {
	bridge, engine := net.Pipe()
	defer engine.Close()
	dials := 0
	plain := func(context.Context) (net.Conn, error) { dials++; return nil, errNoLinkSocket }
	stream := &scriptedFrames{frames: []*relayv1.TunnelFrame{dataFrame(postgresStartupMessage("app"))}}
	go func() {
		// The engine refuses TLS: the daemon asked for it on the bridge.
		request := make([]byte, 8)
		if _, err := io.ReadFull(engine, request); err == nil && binary.BigEndian.Uint32(request[4:]) == postgresSSLRequestCode {
			_, _ = engine.Write([]byte{'N'})
		}
	}()
	_, err := negotiateManagedPostgresLink(context.Background(), bridge, stream, func() {}, nil, plain)
	if err == nil || !strings.Contains(err.Error(), "PostgreSQL refused TLS") || dials != 1 {
		t.Fatalf("fallback: %v after %d socket dials, want the TLS request on the bridge", err, dials)
	}

	// A client that negotiates TLS end to end keeps the bridge connection.
	bridge, engine = net.Pipe()
	defer engine.Close()
	go func() { _, _ = io.Copy(io.Discard, engine) }()
	sslRequest := make([]byte, 8)
	binary.BigEndian.PutUint32(sslRequest, 8)
	binary.BigEndian.PutUint32(sslRequest[4:], postgresSSLRequestCode)
	dials = 0
	stream = &scriptedFrames{frames: []*relayv1.TunnelFrame{dataFrame(sslRequest)}}
	linked, err := negotiateManagedPostgresLink(context.Background(), bridge, stream, func() {}, nil, plain)
	if err != nil || linked != bridge || dials != 0 {
		t.Fatalf("client TLS: %v, %v, %d socket dials", linked, err, dials)
	}
}

// The dial choice: a single-node database is dialed over its link socket
// when the socket answers, whatever the record says.
func TestLinkSocketDialChoice(t *testing.T) {
	root := sockettest.Dir(t)
	m := &managedDatabaseManager{root: root}
	record := managedDatabaseRecord{ID: "db1", Type: "postgres", TLSEnabled: true}
	if _, err := m.dialLinkSocket(context.Background(), record); !errors.Is(err, errNoLinkSocket) {
		t.Fatalf("a container without the link socket: %v", err)
	}
	record.PostgresLinkSocket = true
	if _, err := m.dialLinkSocket(context.Background(), record); err == nil {
		t.Fatal("a missing link socket directory was dialed")
	}
	savedChown := pgLinkSocketChown
	pgLinkSocketChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { pgLinkSocketChown = savedChown })
	dir, err := m.prepareLinkSocketDir(record)
	if err != nil {
		t.Fatal(err)
	}
	for path, mode := range map[string]os.FileMode{filepath.Dir(dir): 0o700, dir: 0o700} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != mode {
			t.Fatalf("%s: %v %v, want mode %o", path, info, err, mode)
		}
	}
	if _, err := m.dialLinkSocket(context.Background(), record); !errors.Is(err, errNoLinkSocket) {
		t.Fatalf("no engine listening yet: %v", err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, pgLinkSocketName))
	if err != nil {
		t.Skipf("socket path too long for this temp dir: %v", err)
	}
	defer listener.Close()
	conn, err := m.dialLinkSocket(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	// R-5: the record a relay dial reads during a recreate is still the
	// previous container's (no flag); the socket that answers decides.
	stale := record
	stale.PostgresLinkSocket = false
	conn, err = m.dialLinkSocket(context.Background(), stale)
	if err != nil {
		t.Fatalf("a record not yet saved after the recreate: %v", err)
	}
	conn.Close()
	record.AvailabilitySetID = "set1"
	if _, err := m.dialLinkSocket(context.Background(), record); !errors.Is(err, errNoLinkSocket) {
		t.Fatalf("an availability set member: %v", err)
	}
	m.removeLinkSocketDir(record)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the deleted database's socket directory stays: %v", err)
	}
}

// A link that falls back to TLS over the bridge is logged once per database
// and reason; a socket that answers again lets the next fallback be logged.
func TestLinkSocketFallbackIsLoggedOnce(t *testing.T) {
	var logs bytes.Buffer
	m := &managedDatabaseManager{logger: slog.New(slog.NewTextHandler(&logs, nil))}
	record := managedDatabaseRecord{ID: "db1", Type: "postgres", TLSEnabled: true}
	m.noteLinkSocketDial(record, errNoLinkSocket)
	m.noteLinkSocketDial(record, errNoLinkSocket)
	if got := strings.Count(logs.String(), "level=INFO"); got != 1 || !strings.Contains(logs.String(), "no link socket yet") {
		t.Fatalf("a container without the socket logged %d times:\n%s", got, logs.String())
	}
	logs.Reset()
	record.PostgresLinkSocket = true
	refused := errors.New("connection refused")
	m.noteLinkSocketDial(record, refused)
	m.noteLinkSocketDial(record, refused)
	if got := strings.Count(logs.String(), "level=WARN"); got != 1 || !strings.Contains(logs.String(), "connection refused") {
		t.Fatalf("a failing link socket logged %d times:\n%s", got, logs.String())
	}
	logs.Reset()
	m.noteLinkSocketDial(record, nil)
	m.noteLinkSocketDial(record, refused)
	if got := strings.Count(logs.String(), "level=WARN"); got != 1 {
		t.Fatalf("a fallback after the socket answered again logged %d times:\n%s", got, logs.String())
	}
}

// Which containers get the socket, and what the engine is started with.
func TestLinkSocketEngineSpec(t *testing.T) {
	savedRoot, savedConfirmed := pgLinkSocketRoot, pgLinkSocketConfirmed
	t.Cleanup(func() { pgLinkSocketRoot, pgLinkSocketConfirmed = savedRoot, savedConfirmed })
	pgLinkSocketRoot, pgLinkSocketConfirmed = func() bool { return true }, func() bool { return true }
	tlsPostgres := managedDatabaseCommand{Type: "postgres", TLSEnabled: true}
	if !linkSocketWanted(managedDatabaseRecord{}, tlsPostgres) {
		t.Fatal("a TLS-enabled single-node PostgreSQL gets the socket")
	}
	for name, tc := range map[string]struct {
		record managedDatabaseRecord
		input  managedDatabaseCommand
		edit   func()
	}{
		"no TLS":      {managedDatabaseRecord{}, managedDatabaseCommand{Type: "postgres"}, nil},
		"redis":       {managedDatabaseRecord{}, managedDatabaseCommand{Type: "redis", TLSEnabled: true}, nil},
		"set member":  {managedDatabaseRecord{AvailabilitySetID: "s"}, tlsPostgres, nil},
		"unconfirmed": {managedDatabaseRecord{}, tlsPostgres, func() { pgLinkSocketConfirmed = func() bool { return false } }},
		"not root":    {managedDatabaseRecord{}, tlsPostgres, func() { pgLinkSocketRoot = func() bool { return false } }},
	} {
		pgLinkSocketRoot, pgLinkSocketConfirmed = func() bool { return true }, func() bool { return true }
		if tc.edit != nil {
			tc.edit()
		}
		if linkSocketWanted(tc.record, tc.input) {
			t.Fatalf("%s: got the link socket", name)
		}
	}
	command := strings.Join(managedPostgresCommandWith(tlsPostgres, true), " ")
	if !strings.Contains(command, "unix_socket_directories=/var/run/postgresql,"+pgLinkSocketContainerDir) {
		t.Fatalf("engine command %q", command)
	}
	if strings.Contains(strings.Join(managedPostgresCommand(tlsPostgres), " "), "unix_socket_directories") {
		t.Fatal("a container without the socket got its directory")
	}
	path := filepath.Join(t.TempDir(), "pg_hba.conf")
	if err := writeManagedPostgresTLSHBA(path, true); err != nil {
		t.Fatal(err)
	}
	hba, _ := os.ReadFile(path)
	if !strings.Contains(string(hba), "local all all scram-sha-256") || strings.Contains(string(hba), "trust") {
		t.Fatalf("link socket pg_hba:\n%s", hba)
	}
	if err := writeManagedPostgresTLSHBA(path, false); err != nil {
		t.Fatal(err)
	}
	if hba, _ := os.ReadFile(path); !strings.Contains(string(hba), "local all all trust") {
		t.Fatalf("pg_hba without the socket:\n%s", hba)
	}
}

// F-3: a database link that reaches its database over the link socket is
// handed to the next daemon process on an update, not cut.
func TestLiveHandoverKeepsALinkSocketDatabaseLink(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	kinds := routeKinds{connect: linkKindManagedDatabaseBinding, endpoint: "managed_database"}
	pair := newStreamPairFor(t, kinds, true, true)
	// The endpoint reaches the database through its link socket directory, as
	// dialLinkSocket does.
	dir := filepath.Dir(pair.backend.Addr().String())
	name := filepath.Base(pair.backend.Addr().String())
	dialer := func(ctx context.Context, _ *pb.RelayGrantAssignment) (dialedEndpoint, error) {
		pair.dials.Add(1)
		conn, err := dialSocketIn(ctx, dir, name)
		return dialedEndpoint{conn: conn}, err
	}
	pair.target.endpointDialer = dialer
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	if cut := pair.target.updateConnections().GetCut(); len(cut) != 0 {
		t.Fatalf("an update now would cut %v", cut)
	}
	_, targetBundle := testBundlesFor(kinds, 1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 1<<20, func() {
		pair.target = pair.update(t, keeper, pair.target, targetBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("the database was dialed %d times", pair.dials.Load())
	}
}
