package chha

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

const (
	testSet     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testMemberA = "11111111-1111-4111-8111-111111111111"
	testMemberB = "22222222-2222-4222-8222-222222222222"
	testMemberC = "33333333-3333-4333-8333-333333333333"
	testWitness = "44444444-4444-4444-8444-444444444444"
	testStandby = "55555555-5555-4555-8555-555555555555"
	testPolicy  = "66666666-6666-4666-8666-666666666666"
)

func testConfig(mode string, ec EngineConfig, members ...string) memberha.Config {
	config := memberha.Config{SetID: testSet, MemberID: members[0], NodeID: "node-" + members[0][:1], Engine: Engine,
		OwnerKind: "managed_database", OwnerID: "db1", Mode: mode, Durability: "synchronous", SyncDegradeAfterSeconds: 10}
	if mode == memberha.ModeAutomatic {
		config.LeasePolicyID = testPolicy
	}
	for i, id := range members {
		config.Members = append(config.Members, memberha.Peer{MemberID: id, NodeID: "node-" + id[:1], MemberIndex: uint32(i)})
	}
	config.EngineConfig = mustJSON(ec)
	return config
}

// pairConfig: members A (Keeper 1) and B (Keeper 2), active witness 101,
// standby witness 102.
func pairEngineConfig() EngineConfig {
	return EngineConfig{
		Version: 1, LoopbackHost: "127.12.34.1", KeeperServerID: 1,
		KeeperServers: []KeeperServer{
			{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleVoter},
			{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleVoter},
			{ID: 101, Port: 39433, WitnessID: testWitness, Role: RoleVoter},
			{ID: 102, Port: 39437, WitnessID: testStandby, Role: RoleStandby},
		},
		Interserver: []InterserverPeer{{MemberID: testMemberA, Port: 39001}, {MemberID: testMemberB, Port: 39002}},
		Databases:   []string{"app"},
	}
}

// fakeRuntime is an in-memory chha.Runtime.
type fakeRuntime struct {
	mu        sync.Mutex
	config    memberha.Config
	known     bool
	running   bool
	files     map[string][]byte
	exists    map[string]bool
	queries   []string
	answers   func(query string) (string, error)
	keeper    []string
	probeOK   map[string]bool
	gateway   bool
	bridged   []string
	bridge    func(connection net.Conn, alias string) error
	started   int
	listening []string
	moved     []string
	peers     map[string]map[string]string
}

func newFakeRuntime(config memberha.Config) *fakeRuntime {
	return &fakeRuntime{config: config, known: true, files: map[string][]byte{}, exists: map[string]bool{},
		probeOK: map[string]bool{}, gateway: true}
}

func (f *fakeRuntime) Container(context.Context) (memberha.ContainerState, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return memberha.ContainerState{Exists: true, Running: f.running, ID: strings.Repeat("c", 64)}, 4242, nil
}

func (f *fakeRuntime) Address(context.Context) (string, error) { return "127.0.0.1", nil }

func (f *fakeRuntime) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = true
	f.started++
	return nil
}

func (f *fakeRuntime) StopClean(context.Context, time.Duration) error { return f.stop() }
func (f *fakeRuntime) Kill(context.Context) error                     { return f.stop() }
func (f *fakeRuntime) stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.running = false
	return nil
}
func (f *fakeRuntime) CgroupEmpty(context.Context) (bool, error) { return true, nil }

func (f *fakeRuntime) Query(_ context.Context, query string) (string, error) {
	f.mu.Lock()
	f.queries = append(f.queries, query)
	answers := f.answers
	f.mu.Unlock()
	if answers != nil {
		return answers(query)
	}
	return "", nil
}

func (f *fakeRuntime) KeeperClient(_ context.Context, command string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keeper = append(f.keeper, command)
	return "", nil
}

func (f *fakeRuntime) ReadFile(name string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[name]
	if !ok {
		return nil, errors.New("no such file")
	}
	return append([]byte(nil), data...), nil
}

func (f *fakeRuntime) WriteFile(name string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[name] = append([]byte(nil), data...)
	return nil
}

func (f *fakeRuntime) file(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.files[name])
}

func (f *fakeRuntime) Exists(relative string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, file := f.files[relative]
	return f.exists[relative] || file
}

func (f *fakeRuntime) MoveAside(relative string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.moved = append(f.moved, relative)
	delete(f.exists, relative)
	return nil
}

func (f *fakeRuntime) PeerEngineState(_ context.Context, memberID string) (map[string]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state, ok := f.peers[memberID]
	return state, ok
}

func (f *fakeRuntime) InternalPasswordSHA256() (string, error) { return strings.Repeat("ab", 32), nil }

func (f *fakeRuntime) Listen(_ int, address string) (net.Listener, error) {
	f.mu.Lock()
	f.listening = append(f.listening, address)
	f.mu.Unlock()
	return newFakeListener(), nil
}

// fakeListener accepts nothing until closed (no socket: the tests run in
// sandboxes without local binding).
type fakeListener struct {
	closed chan struct{}
	once   sync.Once
}

func newFakeListener() *fakeListener { return &fakeListener{closed: make(chan struct{})} }

func (l *fakeListener) Accept() (net.Conn, error) {
	<-l.closed
	return nil, net.ErrClosed
}

func (l *fakeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *fakeListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }

func (f *fakeRuntime) Bridge(connection net.Conn, alias string) error {
	f.mu.Lock()
	f.bridged = append(f.bridged, alias)
	bridge := f.bridge
	f.mu.Unlock()
	if bridge != nil {
		return bridge(connection, alias)
	}
	_ = connection.Close()
	return errors.New("no route")
}

func (f *fakeRuntime) Probe(_ context.Context, alias string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.probeOK[alias] {
		return nil
	}
	return errors.New("unreachable")
}

func (f *fakeRuntime) Config() (memberha.Config, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.config, f.known
}

func (f *fakeRuntime) OpfieldConnected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gateway
}

func (f *fakeRuntime) Sign(domain string, payload []byte) ([]byte, error) {
	return []byte("sig:" + domain), nil
}

func (f *fakeRuntime) Logger() *slog.Logger { return slog.New(slog.DiscardHandler) }
