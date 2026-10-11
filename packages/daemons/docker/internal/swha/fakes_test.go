package swha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	testSet    = "11111111-1111-4111-8111-111111111111"
	testSelf   = "22222222-2222-4222-8222-222222222222"
	testPeer   = "33333333-3333-4333-8333-333333333333"
	testOwner  = "44444444-4444-4444-8444-444444444444"
	testPolicy = "55555555-5555-4555-8555-555555555555"
)

// connListener serves one http.Handler over in-memory connections.
type connListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
}

func newConnListener(handler http.Handler) *connListener {
	l := &connListener{conns: make(chan net.Conn), closed: make(chan struct{})}
	go func() { _ = http.Serve(l, handler) }()
	return l
}

func (l *connListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *connListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *connListener) Addr() net.Addr { return &net.TCPAddr{} }
func (l *connListener) dial(ctx context.Context) (net.Conn, error) {
	client, server := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

// fakeCluster is a SeaweedFS master + volume servers + filers in memory.
type fakeCluster struct {
	mu sync.Mutex
	// volumes by node url: id -> collection; replication by id.
	volumes     map[string]map[uint32]string
	replication map[uint32]string
	counter     uint32
	// registered: volume servers the master knows.
	registered map[string]bool
	// heartbeats per filer member id.
	heartbeats map[string]map[int64]bool
	tokens     []string
	scripts    []string
	growCalls  int
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{volumes: map[string]map[uint32]string{}, replication: map[uint32]string{},
		registered: map[string]bool{}, heartbeats: map[string]map[int64]bool{}}
}

func (c *fakeCluster) addVolume(node string, id uint32, collection, replication string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.volumes[node] == nil {
		c.volumes[node] = map[uint32]string{}
	}
	c.volumes[node][id] = collection
	c.replication[id] = replication
}

// restartMaster forgets the topology and the id counter (a fresh master).
func (c *fakeCluster) restartMaster() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.registered = map[string]bool{}
	c.counter = 0
}

func (c *fakeCluster) maxSeen() uint32 {
	var top uint32
	for node, ids := range c.volumes {
		if !c.registered[node] {
			continue
		}
		for id := range ids {
			top = max(top, id)
		}
	}
	return top
}

func (c *fakeCluster) master() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/dir/status", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		type node struct {
			URL       string `json:"Url"`
			VolumeIDs string `json:"VolumeIds"`
		}
		var nodes []node
		for url := range c.registered {
			var ids []string
			for id := range c.volumes[url] {
				ids = append(ids, strconv.Itoa(int(id)))
			}
			sort.Strings(ids)
			nodes = append(nodes, node{URL: url, VolumeIDs: " " + strings.Join(ids, " ") + " "})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Topology": map[string]any{"DataCenters": []any{
			map[string]any{"Racks": []any{map[string]any{"DataNodes": nodes}}}}}})
	})
	mux.HandleFunc("/vol/status", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		nodes := map[string][]map[string]any{}
		for url, ids := range c.volumes {
			if !c.registered[url] {
				continue
			}
			for id, collection := range ids {
				rp := map[string]int{}
				if c.replication[id] == "001" {
					rp["node"] = 1
				}
				nodes[url] = append(nodes[url], map[string]any{"Id": id, "Collection": collection, "ReplicaPlacement": rp})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Volumes": map[string]any{"DataCenters": map[string]any{
			"dc": map[string]any{"rack": nodes}}}})
	})
	mux.HandleFunc("/vol/grow", func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.growCalls++
		count, _ := strconv.Atoi(r.URL.Query().Get("count"))
		node := r.URL.Query().Get("dataNode")
		c.counter = max(c.counter, c.maxSeen())
		for range count {
			c.counter++
			if c.volumes[node] == nil {
				c.volumes[node] = map[uint32]string{}
			}
			c.volumes[node][c.counter] = r.URL.Query().Get("collection")
			c.replication[c.counter] = r.URL.Query().Get("replication")
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"count": count})
	})
	return mux
}

func (c *fakeCluster) filer(member string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if !strings.HasPrefix(r.URL.Path, heartbeatDir) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if c.heartbeats[member] == nil {
			c.heartbeats[member] = map[int64]bool{}
		}
		name := strings.TrimPrefix(r.URL.Path, heartbeatDir)
		switch r.Method {
		case http.MethodGet:
			var entries []map[string]string
			for ns := range c.heartbeats[member] {
				entries = append(entries, map[string]string{"FullPath": heartbeatDir + strconv.FormatInt(ns, 10)})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Entries": entries})
		case http.MethodPut, http.MethodDelete:
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if token == "" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			c.tokens = append(c.tokens, token)
			ns, _ := strconv.ParseInt(name, 10, 64)
			if r.Method == http.MethodPut {
				c.heartbeats[member][ns] = true
				w.WriteHeader(http.StatusCreated)
			} else {
				delete(c.heartbeats[member], ns)
				w.WriteHeader(http.StatusNoContent)
			}
		}
	})
}

// sync copies member from's heartbeats to member to (peer sync).
func (c *fakeCluster) syncFiler(from, to string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.heartbeats[to] == nil {
		c.heartbeats[to] = map[int64]bool{}
	}
	for ns := range c.heartbeats[from] {
		c.heartbeats[to][ns] = true
	}
}

var deletePattern = regexp.MustCompile(`volume\.delete -node=(\S+) -volumeId=(\d+)`)

func (c *fakeCluster) shell(script string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.scripts = append(c.scripts, script)
	for _, match := range deletePattern.FindAllStringSubmatch(script, -1) {
		id, _ := strconv.Atoi(match[2])
		delete(c.volumes[match[1]], uint32(id))
	}
	return nil
}

type fakeContainer struct {
	exists, running bool
	started         time.Time
	restartPolicy   string
}

// fakeHost is one member's Host.
type fakeHost struct {
	mu         sync.Mutex
	cfg        memberha.Config
	cluster    *fakeCluster
	containers map[Role]*fakeContainer
	dir        string
	exposed    []Exposure
	local      func(ctx context.Context, port string) (net.Conn, bool)
	master     *connListener
	filer      *connListener
	volume     *connListener
	peers      map[string]*fakeHost // by member id, for mesh dials
	primary    *fakeHost
	starts     map[Role]int
	stops      map[Role]int
	selfURL    string
}

func newFakeHost(cluster *fakeCluster, dir, self string, members []memberha.Peer) *fakeHost {
	cfg := memberha.Config{SetID: testSet, MemberID: self, NodeID: "node-" + self[:4], Engine: "seaweedfs",
		OwnerKind: "managed_storage", OwnerID: testOwner, Mode: memberha.ModeAutomatic, LeasePolicyID: testPolicy,
		Members: members}
	h := &fakeHost{cfg: cfg, cluster: cluster, dir: dir, peers: map[string]*fakeHost{},
		containers: map[Role]*fakeContainer{RoleVolume: {exists: true, running: true}, RoleFiler: {exists: true, running: true},
			RoleMaster: {exists: true, restartPolicy: "no"}},
		starts: map[Role]int{}, stops: map[Role]int{}}
	peer, _ := cfg.Peer(self)
	h.selfURL = VolumeURL(self, peer.MemberIndex)
	h.master = newConnListener(cluster.master())
	h.filer = newConnListener(cluster.filer(self))
	h.volume = newConnListener(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	return h
}

func (h *fakeHost) Config() memberha.Config { h.mu.Lock(); defer h.mu.Unlock(); return h.cfg }

func (h *fakeHost) Container(_ context.Context, role Role) (ContainerInfo, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.containers[role]
	return ContainerInfo{Exists: c.exists, Running: c.running, ID: strings.Repeat(string(role[0]), 64), StartedAt: c.started}, nil
}

func (h *fakeHost) Start(_ context.Context, role Role) error {
	h.mu.Lock()
	c := h.containers[role]
	h.starts[role]++
	if !c.running {
		c.running, c.started = true, time.Now().Add(time.Duration(h.starts[role])*time.Millisecond)
	}
	h.mu.Unlock()
	h.onStart(role)
	return nil
}

// onStart: a started volume server registers with the running master.
func (h *fakeHost) onStart(role Role) {
	switch role {
	case RoleMaster:
		h.cluster.restartMaster()
		h.register()
	case RoleVolume:
		h.register()
	}
}

func (h *fakeHost) register() {
	h.mu.Lock()
	master, volume := h.containers[RoleMaster].running, h.containers[RoleVolume].running
	h.mu.Unlock()
	if master && volume {
		h.cluster.mu.Lock()
		h.cluster.registered[h.selfURL] = true
		h.cluster.mu.Unlock()
	}
}

func (h *fakeHost) Stop(_ context.Context, role Role, _ time.Duration) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stops[role]++
	h.containers[role].running = false
	return nil
}

func (h *fakeHost) Kill(ctx context.Context, role Role) error { return h.Stop(ctx, role, 0) }

func (h *fakeHost) CgroupEmpty(_ context.Context, role Role) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.containers[role].running, nil
}

func (h *fakeHost) EnsureNoRestart(_ context.Context, role Role) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.containers[role].restartPolicy = "no"
	return nil
}

func (h *fakeHost) DialContainer(ctx context.Context, role Role, _ uint16) (net.Conn, error) {
	h.mu.Lock()
	running := h.containers[role].running
	h.mu.Unlock()
	if !running {
		return nil, errors.New("connection refused")
	}
	switch role {
	case RoleMaster:
		return h.master.dial(ctx)
	case RoleFiler:
		return h.filer.dial(ctx)
	default:
		return h.volume.dial(ctx)
	}
}

func (h *fakeHost) Exec(_ context.Context, role Role, command []string, stdin string) ([]byte, error) {
	if role != RoleMaster || len(command) < 3 || command[2] != "shell" {
		return nil, fmt.Errorf("unexpected exec %v in %s", command, role)
	}
	return nil, h.cluster.shell(stdin)
}

func (h *fakeHost) DialAlias(ctx context.Context, alias string) (net.Conn, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if strings.HasPrefix(alias, "primary-") {
		if h.primary == nil {
			return nil, errors.New("no primary")
		}
		return h.primary.master.dial(ctx)
	}
	for id, peer := range h.peers {
		if strings.HasPrefix(alias, "member-"+id+"-") {
			if strings.HasSuffix(alias, PortFiler) {
				return peer.DialContainer(ctx, RoleFiler, 0)
			}
			return peer.DialContainer(ctx, RoleVolume, 0)
		}
	}
	return nil, errors.New("unreachable")
}

func (h *fakeHost) Expose(exposures []Exposure) { h.mu.Lock(); h.exposed = exposures; h.mu.Unlock() }
func (h *fakeHost) SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool)) {
	h.local = dial
}
func (h *fakeHost) FilerToken() (string, error)    { return "token", nil }
func (h *fakeHost) DiskFree() (uint64, bool, bool) { return 1 << 30, false, true }
func (h *fakeHost) StateDir() string               { return h.dir }
func (h *fakeHost) Serve()                         {}
func (h *fakeHost) Logger() *slog.Logger           { return slog.New(slog.DiscardHandler) }
func (h *fakeHost) setRunning(role Role, running bool) {
	h.mu.Lock()
	h.containers[role].running = running
	h.mu.Unlock()
}

func testMembers() []memberha.Peer {
	return []memberha.Peer{{MemberID: testSelf, NodeID: "node-2222", MemberIndex: 0}, {MemberID: testPeer, NodeID: "node-3333", MemberIndex: 1}}
}
