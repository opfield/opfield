package supervisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/daemon-shared/updateauth"
	"github.com/opfield/opfield/daemon-shared/witnessactivation"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

func witnessSHA(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func keeperSpec(id, version string, clientPort uint32) *pb.WitnessSpec {
	return &pb.WitnessSpec{
		Id: id, SetId: "set-1", Kind: witnessKindKeeper, Role: witnessRoleActive, ServerId: 3,
		ClientPort: clientPort, RaftPort: clientPort + 1,
		Artifact: &pb.WitnessArtifact{Version: version, DownloadUrl: "https://example.test/keeper-" + version, Sha256: witnessSHA(version), SignedManifest: "{}", Component: "witness-clickhouse-keeper"},
		Peers: []*pb.WitnessPeer{
			{ServerId: 1, Host: "127.0.1.1", Port: 39501, RouteId: "route-a"},
			{ServerId: 2, Host: "127.0.1.2", Port: 39502, RouteId: "route-b"},
		},
	}
}

// fakeWitnessRuntime runs witnesses in memory. A witness is healthy when
// its binary (artifact sha) is in healthy.
type fakeWitnessRuntime struct {
	mu        sync.Mutex
	fetchErr  map[string]error
	healthy   map[string]bool
	starts    []string
	running   map[string]*fakeWitnessProcess
	forwarded []string
	collected map[string]bool
}

func newFakeWitnessRuntime() *fakeWitnessRuntime {
	return &fakeWitnessRuntime{fetchErr: map[string]error{}, healthy: map[string]bool{}, running: map[string]*fakeWitnessProcess{}}
}

func (r *fakeWitnessRuntime) fetch(_ context.Context, artifact *pb.WitnessArtifact) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.fetchErr[artifact.GetSha256()]; err != nil {
		return "", err
	}
	return "/artifacts/" + artifact.GetSha256(), nil
}

func (r *fakeWitnessRuntime) start(launch witnessLaunch) (witnessProcess, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	proc := &fakeWitnessProcess{exited: make(chan struct{}), sha: filepath.Base(launch.binary), config: string(launch.config)}
	r.running[launch.id] = proc
	r.starts = append(r.starts, proc.sha)
	return proc, nil
}

func (r *fakeWitnessRuntime) probe(_ context.Context, clientPort uint32) (keeperProbe, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, proc := range r.running {
		if proc.alive() && strings.Contains(proc.config, fmt.Sprintf("<tcp_port>%d</tcp_port>", clientPort)) && r.healthy[proc.sha] {
			return keeperProbe{role: "follower", zxid: 42}, nil
		}
	}
	return keeperProbe{}, errors.New("connection refused")
}

func (r *fakeWitnessRuntime) forward(_ context.Context, peer *pb.WitnessPeer) (net.Listener, error) {
	r.mu.Lock()
	r.forwarded = append(r.forwarded, peer.GetRouteId())
	r.mu.Unlock()
	return &fakeListener{closed: make(chan struct{})}, nil
}

func (r *fakeWitnessRuntime) gcArtifacts(keep map[string]bool, _ time.Time) {
	r.mu.Lock()
	r.collected = keep
	r.mu.Unlock()
}

func (r *fakeWitnessRuntime) proc(id string) *fakeWitnessProcess {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running[id]
}

func (r *fakeWitnessRuntime) startedSHAs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.starts...)
}

type fakeWitnessProcess struct {
	once   sync.Once
	exited chan struct{}
	sha    string
	config string
	err    error
}

func (p *fakeWitnessProcess) done() <-chan struct{} { return p.exited }
func (p *fakeWitnessProcess) exitError() error      { return p.err }
func (p *fakeWitnessProcess) signal(os.Signal) error {
	p.exit(nil)
	return nil
}
func (p *fakeWitnessProcess) kill() error {
	p.exit(nil)
	return nil
}
func (p *fakeWitnessProcess) exit(err error) {
	p.once.Do(func() {
		p.err = err
		close(p.exited)
	})
}
func (p *fakeWitnessProcess) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

type fakeListener struct {
	once   sync.Once
	closed chan struct{}
}

func (l *fakeListener) Accept() (net.Conn, error) {
	<-l.closed
	return nil, net.ErrClosed
}
func (l *fakeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}
func (l *fakeListener) Addr() net.Addr { return &net.TCPAddr{} }

type witnessHarness struct {
	t       *testing.T
	manager *witnessManager
	rt      *fakeWitnessRuntime
	now     time.Time
	hosting string
}

func newWitnessHarness(t *testing.T) *witnessHarness {
	t.Helper()
	h := &witnessHarness{t: t, rt: newFakeWitnessRuntime(), now: time.Unix(1_800_000_000, 0), hosting: WitnessHostingAllowed}
	dir := t.TempDir()
	h.manager = newWitnessManager(filepath.Join(dir, "state"), filepath.Join(dir, "work"), nil, func() string { return h.hosting }, h.rt)
	h.manager.now = func() time.Time { return h.now }
	return h
}

func (h *witnessHarness) apply(revision uint64, specs ...*pb.WitnessSpec) {
	h.t.Helper()
	if _, err := h.manager.Apply(&pb.ApplyWitnessesCommand{Revision: revision, Witnesses: specs}); err != nil {
		h.t.Fatal(err)
	}
}

// pass runs one reconcile after the given time, waiting for fetches.
func (h *witnessHarness) pass(after time.Duration) {
	h.t.Helper()
	h.now = h.now.Add(after)
	h.manager.reconcile()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.manager.mu.Lock()
		busy := len(h.manager.fetching) > 0
		h.manager.mu.Unlock()
		if !busy {
			break
		}
		if time.Now().After(deadline) {
			h.t.Fatal("artifact fetch did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

func (h *witnessHarness) status(id string) *pb.WitnessStatus {
	h.t.Helper()
	_, statuses := h.manager.report()
	for _, status := range statuses {
		if status.GetId() == id {
			return status
		}
	}
	h.t.Fatalf("no status for %s", id)
	return nil
}

func TestWitnessStartsRestartsWithBackoffAndStops(t *testing.T) {
	h := newWitnessHarness(t)
	spec := keeperSpec("w1", "25.3.1", 39410)
	h.rt.healthy[spec.GetArtifact().GetSha256()] = true
	h.apply(1, spec)
	h.pass(0) // fetch
	h.pass(0) // start
	if status := h.status("w1"); status.GetState() != witnessStateStarting {
		t.Fatalf("after start: %v", status)
	}
	h.pass(time.Second)
	if status := h.status("w1"); status.GetState() != witnessStateRunning || status.GetKeeperRole() != "follower" || status.GetLastZxid() != 42 {
		t.Fatalf("running witness reports %v", status)
	}
	if got := len(h.rt.forwarded); got != 2 {
		t.Fatalf("forwarders = %d, want one per peer", got)
	}

	// Crashes restart with growing backoff.
	for i, backoff := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		h.rt.proc("w1").exit(errors.New("exit status 70"))
		h.pass(0)
		status := h.status("w1")
		if status.GetState() != witnessStateError || status.GetRestarts() != uint32(i+1) || !strings.Contains(status.GetError(), "exit status 70") {
			t.Fatalf("crash %d: %v", i, status)
		}
		h.pass(backoff - time.Millisecond)
		if h.rt.proc("w1").alive() {
			t.Fatalf("crash %d: restarted before the %s backoff", i, backoff)
		}
		h.pass(time.Millisecond)
		if !h.rt.proc("w1").alive() {
			t.Fatalf("crash %d: not restarted after the %s backoff", i, backoff)
		}
		h.pass(0)
	}
	// Healthy for the reset period: the next crash starts from 1 s again.
	h.pass(witnessBackoffReset)
	h.rt.proc("w1").exit(errors.New("exit status 70"))
	h.pass(0)
	h.pass(time.Second)
	if !h.rt.proc("w1").alive() {
		t.Fatal("backoff did not reset after a healthy period")
	}

	// Removed from the desired set: stopped, data dropped.
	data := h.manager.dataDir("w1")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	proc := h.rt.proc("w1")
	h.apply(2)
	h.pass(0)
	if proc.alive() {
		t.Fatal("a removed witness still runs")
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Fatalf("a removed witness kept its data: %v", err)
	}
	if _, statuses := h.manager.report(); len(statuses) != 0 {
		t.Fatalf("removed witness still reported: %v", statuses)
	}
}

func TestWitnessUpdateRollsBackWhenNotHealthy(t *testing.T) {
	h := newWitnessHarness(t)
	old := keeperSpec("w1", "25.3.1", 39410)
	h.rt.healthy[old.GetArtifact().GetSha256()] = true
	h.apply(1, old)
	h.pass(0)
	h.pass(0)
	h.pass(time.Second)
	if h.status("w1").GetState() != witnessStateRunning {
		t.Fatalf("old version not running: %v", h.status("w1"))
	}

	broken := keeperSpec("w1", "25.8.1", 39410)
	h.apply(2, broken)
	h.pass(0) // fetch
	h.pass(0) // stop old, start new
	if status := h.status("w1"); status.GetState() != witnessStateUpdating || status.GetVersion() != "25.8.1" {
		t.Fatalf("during the update: %v", status)
	}
	h.pass(witnessHealthyWithin - time.Second)
	if status := h.status("w1"); status.GetState() != witnessStateUpdating {
		t.Fatalf("rolled back before the deadline: %v", status)
	}
	h.pass(time.Second)
	h.pass(time.Second)
	status := h.status("w1")
	if status.GetState() != witnessStateRunning || status.GetVersion() != "25.3.1" || !strings.Contains(status.GetError(), "rolled back to 25.3.1") {
		t.Fatalf("after the failed update: %v", status)
	}
	starts := h.rt.startedSHAs()
	if len(starts) != 3 || starts[0] != old.GetArtifact().GetSha256() || starts[1] != broken.GetArtifact().GetSha256() || starts[2] != old.GetArtifact().GetSha256() {
		t.Fatalf("starts %v, want old, new, old", starts)
	}
	// The failed artifact is not retried until Gateway names another one.
	h.pass(time.Minute)
	h.pass(time.Minute)
	if got := len(h.rt.startedSHAs()); got != 3 {
		t.Fatalf("the failed update was retried: %v", h.rt.startedSHAs())
	}

	// A new binary that exits during the update window rolls back at once.
	crashing := keeperSpec("w1", "25.8.2", 39410)
	h.apply(3, crashing)
	h.pass(0)
	h.pass(0)
	h.rt.proc("w1").exit(errors.New("exit status 1"))
	h.pass(0)
	h.pass(time.Second)
	if status := h.status("w1"); status.GetVersion() != "25.3.1" || status.GetState() != witnessStateRunning {
		t.Fatalf("a crashing update was not rolled back: %v", status)
	}

	// A healthy update sticks and becomes the next rollback target.
	good := keeperSpec("w1", "25.8.3", 39410)
	h.rt.healthy[good.GetArtifact().GetSha256()] = true
	h.apply(4, good)
	h.pass(0)
	h.pass(0)
	h.pass(time.Second)
	if status := h.status("w1"); status.GetVersion() != "25.8.3" || status.GetState() != witnessStateRunning || status.GetError() != "" {
		t.Fatalf("a healthy update: %v", status)
	}
}

func TestWitnessStandbyStagesWithoutRunning(t *testing.T) {
	h := newWitnessHarness(t)
	spec := keeperSpec("w1", "25.3.1", 39410)
	spec.Role = witnessRoleStandby
	h.apply(1, spec)
	h.pass(0)
	h.pass(0)
	if status := h.status("w1"); status.GetState() != witnessStateStaged {
		t.Fatalf("standby: %v", status)
	}
	if len(h.rt.startedSHAs()) != 0 {
		t.Fatal("a standby witness was started")
	}
	if config, err := os.ReadFile(filepath.Join(h.manager.runDir("w1"), "keeper.xml")); err != nil || !strings.Contains(string(config), "<server_id>3</server_id>") {
		t.Fatalf("standby config not staged: %v", err)
	}
	active := keeperSpec("w1", "25.3.1", 39410)
	h.rt.healthy[active.GetArtifact().GetSha256()] = true
	h.apply(2, active)
	h.pass(0)
	h.pass(time.Second)
	if status := h.status("w1"); status.GetState() != witnessStateRunning {
		t.Fatalf("activated standby: %v", status)
	}
}

// The local gate is re-checked on every pass: a protected relay without the
// owner's opt-in stops its witnesses and says why.
func TestWitnessGateStopsWitnesses(t *testing.T) {
	h := newWitnessHarness(t)
	spec := keeperSpec("w1", "25.3.1", 39410)
	h.rt.healthy[spec.GetArtifact().GetSha256()] = true
	h.apply(1, spec)
	h.pass(0)
	h.pass(0)
	proc := h.rt.proc("w1")
	h.hosting = WitnessHostingProtectedNeedsOptIn
	h.pass(time.Second)
	if proc.alive() {
		t.Fatal("a witness kept running after the local gate closed")
	}
	status := h.status("w1")
	if status.GetState() != witnessStateRefused || !strings.Contains(status.GetError(), WitnessHostingProtectedNeedsOptIn) {
		t.Fatalf("gated witness: %v", status)
	}
	h.pass(time.Minute)
	if got := len(h.rt.startedSHAs()); got != 1 {
		t.Fatalf("a gated witness was started again: %d starts", got)
	}
}

func TestWitnessFetchFailureIsReported(t *testing.T) {
	h := newWitnessHarness(t)
	spec := keeperSpec("w1", "25.3.1", 39410)
	h.rt.fetchErr[spec.GetArtifact().GetSha256()] = errors.New("update manifest signature is invalid")
	h.apply(1, spec)
	h.pass(0)
	h.pass(0)
	status := h.status("w1")
	if status.GetState() != witnessStateError || !strings.Contains(status.GetError(), "signature is invalid") {
		t.Fatalf("refused artifact: %v", status)
	}
	if len(h.rt.startedSHAs()) != 0 {
		t.Fatal("a witness started without a verified artifact")
	}
}

func TestWitnessDesiredSetSurvivesRestart(t *testing.T) {
	h := newWitnessHarness(t)
	h.apply(5, keeperSpec("w1", "25.3.1", 39410))
	restarted := newWitnessManager(h.manager.dir, h.manager.workRoot, nil, func() string { return WitnessHostingAllowed }, h.rt)
	if err := restarted.load(); err != nil {
		t.Fatal(err)
	}
	revision, statuses := restarted.report()
	if revision != 5 || len(statuses) != 1 || statuses[0].GetId() != "w1" {
		t.Fatalf("restored revision %d statuses %v", revision, statuses)
	}
	if detail, err := restarted.Apply(&pb.ApplyWitnessesCommand{Revision: 4}); err != nil || !strings.Contains(detail, "already applied") {
		t.Fatalf("an older revision was applied: %q %v", detail, err)
	}
}

func TestValidateWitnessesRefusesUnsafeSpecs(t *testing.T) {
	valid := keeperSpec("w1", "25.3.1", 39410)
	if err := validateWitnesses([]*pb.WitnessSpec{valid}); err != nil {
		t.Fatalf("valid spec refused: %v", err)
	}
	mutate := func(change func(*pb.WitnessSpec)) []*pb.WitnessSpec {
		spec := keeperSpec("w1", "25.3.1", 39410)
		change(spec)
		return []*pb.WitnessSpec{spec}
	}
	cases := map[string][]*pb.WitnessSpec{
		"unknown kind":        mutate(func(s *pb.WitnessSpec) { s.Kind = "shell" }),
		"client port outside": mutate(func(s *pb.WitnessSpec) { s.ClientPort = 22 }),
		"peer not loopback":   mutate(func(s *pb.WitnessSpec) { s.Peers[0].Host = "10.0.0.1" }),
		"peer port outside":   mutate(func(s *pb.WitnessSpec) { s.Peers[0].Port = 39410 }),
		"raft host public":    mutate(func(s *pb.WitnessSpec) { s.RaftHost = "203.0.113.1" }),
		"path in id":          mutate(func(s *pb.WitnessSpec) { s.Id = "../etc" }),
		"bad sha":             mutate(func(s *pb.WitnessSpec) { s.Artifact.Sha256 = "x" }),
		"duplicate server id": mutate(func(s *pb.WitnessSpec) { s.Peers[1].ServerId = 1 }),
		"ports shared by two": {keeperSpec("w1", "25.3.1", 39410), keeperSpec("w2", "25.3.1", 39411)},
		"no route for a peer": mutate(func(s *pb.WitnessSpec) { s.Peers[0].RouteId = "" }),
	}
	for name, specs := range cases {
		if err := validateWitnesses(specs); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	many := make([]*pb.WitnessSpec, maxWitnesses+1)
	for i := range many {
		many[i] = keeperSpec(fmt.Sprintf("w%d", i), "25.3.1", 39400+uint32(i)*2)
		many[i].Peers = nil
	}
	if err := validateWitnesses(many); err == nil {
		t.Error("more than the witness cap accepted")
	}
}

func TestKeeperConfigAndProbe(t *testing.T) {
	spec := keeperSpec("w1", "25.3.1", 39410)
	spec.RaftHost = "127.0.2.3"
	config, err := renderKeeperConfig(spec, "/var/lib/gateway-relay-witness/data/w1")
	if err != nil {
		t.Fatal(err)
	}
	text := string(config)
	for _, want := range []string{
		"<listen_host>127.0.0.1</listen_host>", "<tcp_port>39410</tcp_port>", "<server_id>3</server_id>",
		"<enable_reconfiguration>true</enable_reconfiguration>",
		"<id>3</id>\n                <hostname>127.0.2.3</hostname>\n                <port>39411</port>\n                <priority>1</priority>",
		"<id>1</id>\n                <hostname>127.0.1.1</hostname>\n                <port>39501</port>\n                <priority>3</priority>",
		"<log_storage_path>/var/lib/gateway-relay-witness/data/w1/coordination/log</log_storage_path>",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("keeper config lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "can_become_leader") {
		t.Errorf("can_become_leader=false makes a learner that does not vote:\n%s", text)
	}
	probe, err := parseKeeperSrvr("ClickHouse Keeper version: v25.3.1\nLatency min/avg/max: 0/0/0\nZxid: 0x1a2b\nMode: follower\nNode count: 4\n")
	if err != nil || probe.role != "follower" || probe.zxid != 0x1a2b {
		t.Fatalf("probe %+v %v", probe, err)
	}
	if _, err := parseKeeperSrvr("This instance is not currently serving requests\n"); err == nil {
		t.Fatal("a Keeper without quorum counted as healthy")
	}
}

func TestWitnessFetcherVerifiesManifestAndChecksum(t *testing.T) {
	binary := "keeper-binary"
	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = io.WriteString(w, binary)
	}))
	defer server.Close()
	fetcher := newWitnessFetcher(filepath.Join(t.TempDir(), "artifacts"))
	fetcher.client = server.Client()
	artifact := &pb.WitnessArtifact{Version: "25.3.1", DownloadUrl: server.URL + "/keeper", Sha256: witnessSHA(binary), SignedManifest: "{}", Component: "witness-clickhouse-keeper"}

	// The compiled update key: an unsigned manifest is refused before any download.
	if _, err := fetcher.fetch(context.Background(), artifact); err == nil || requests != 0 {
		t.Fatalf("unsigned manifest: err %v, %d downloads", err, requests)
	}

	var seen updateauth.WitnessExpectation
	fetcher.verify = func(_ string, expected updateauth.WitnessExpectation) error {
		seen = expected
		return nil
	}
	path, err := fetcher.fetch(context.Background(), artifact)
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != binary || filepath.Base(path) != artifact.GetSha256() {
		t.Fatalf("artifact at %s holds %q", path, data)
	}
	if seen.Component != "witness-clickhouse-keeper" || seen.SHA256 != artifact.GetSha256() || seen.DownloadURL != artifact.GetDownloadUrl() {
		t.Fatalf("manifest checked against %+v", seen)
	}
	if _, err := fetcher.fetch(context.Background(), artifact); err != nil || requests != 1 {
		t.Fatalf("cached artifact: err %v, %d downloads", err, requests)
	}

	// A download that does not match the signed sha256 is dropped.
	wrong := &pb.WitnessArtifact{Version: "25.3.2", DownloadUrl: server.URL + "/other", Sha256: witnessSHA("something else"), SignedManifest: "{}", Component: "witness-clickhouse-keeper"}
	if _, err := fetcher.fetch(context.Background(), wrong); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("wrong checksum: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fetcher.dir, wrong.GetSha256())); !os.IsNotExist(err) {
		t.Fatal("a mismatching download was kept")
	}

	// GC: unused for 7 days goes, used is kept and touched.
	old := time.Now().Add(-8 * 24 * time.Hour)
	unused := filepath.Join(fetcher.dir, witnessSHA("unused"))
	if err := os.WriteFile(unused, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(unused, old, old)
	_ = os.Chtimes(path, old, old)
	fetcher.collect(map[string]bool{artifact.GetSha256(): true}, time.Now())
	if _, err := os.Stat(unused); !os.IsNotExist(err) {
		t.Fatal("an unused artifact outlived its retention")
	}
	if info, err := os.Stat(path); err != nil || time.Since(info.ModTime()) > time.Hour {
		t.Fatalf("an artifact in use was removed or not touched: %v", err)
	}
}

// fakeDialStream is the client side of RelayAdmin.DialRoute.
type fakeDialStream struct {
	grpc.ClientStream
	mu     sync.Mutex
	sent   []*relayv1.TunnelFrame
	recv   chan *relayv1.TunnelFrame
	closed chan struct{}
}

func (s *fakeDialStream) Send(frame *relayv1.TunnelFrame) error {
	s.mu.Lock()
	s.sent = append(s.sent, frame)
	s.mu.Unlock()
	return nil
}
func (s *fakeDialStream) Recv() (*relayv1.TunnelFrame, error) {
	select {
	case frame := <-s.recv:
		return frame, nil
	case <-s.closed:
		return nil, io.EOF
	}
}
func (s *fakeDialStream) CloseSend() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	return nil
}
func (s *fakeDialStream) Header() (metadata.MD, error) { return nil, nil }
func (s *fakeDialStream) Trailer() metadata.MD         { return nil }
func (s *fakeDialStream) Context() context.Context     { return context.Background() }

// A peer forwarder carries a local connection over a relay-originated
// tunnel on the peer's route.
func TestWitnessForwarderDialsThePeerRoute(t *testing.T) {
	stream := &fakeDialStream{recv: make(chan *relayv1.TunnelFrame, 4), closed: make(chan struct{})}
	rt := &hostWitnessRuntime{dialRoute: func(context.Context) (relayv1.RelayAdmin_DialRouteClient, error) { return stream, nil }}
	listener, err := rt.forward(context.Background(), &pb.WitnessPeer{ServerId: 1, Host: "127.0.0.1", Port: 0, RouteId: "route-a", AssignmentGeneration: 7})
	if err != nil {
		t.Skipf("loopback listen unavailable here: %v", err)
	}
	defer listener.Close()
	stream.recv <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 65536}}}
	stream.recv <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("imok")}}}
	connection, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := connection.Write([]byte("ruok")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != "imok" {
		t.Fatalf("reply %q %v", reply, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stream.mu.Lock()
		sent := append([]*relayv1.TunnelFrame(nil), stream.sent...)
		stream.mu.Unlock()
		if len(sent) >= 2 {
			dial := sent[0].GetDial()
			if dial.GetRouteId() != "route-a" || dial.GetAssignmentGeneration() != 7 || string(sent[1].GetData().GetData()) != "ruok" {
				t.Fatalf("frames sent %v", sent)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the forwarder did not send the dial and the data")
}

func TestApplyWitnessesCommandAndProtectedGate(t *testing.T) {
	plain := &Plugin{cfg: &config.Config{}}
	if plain.witnessHosting() == WitnessHostingProtectedNeedsOptIn {
		t.Fatal("an unprotected relay needs an opt-in")
	}
	protected := &Plugin{cfg: &config.Config{Protected: config.ProtectedConfig{Enabled: true}}}
	optedIn := &Plugin{cfg: &config.Config{Protected: config.ProtectedConfig{Enabled: true, AllowDatabaseWitness: true}}}
	command := &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_ApplyWitnesses{ApplyWitnesses: &pb.ApplyWitnessesCommand{}}}
	if protected.ProtectedCommandAllowed(command) {
		t.Fatal("a protected relay without the opt-in accepts witnesses")
	}
	if !optedIn.ProtectedCommandAllowed(command) {
		t.Fatal("a protected relay with the opt-in refuses witnesses")
	}
	if got := protected.witnessHosting(); got != WitnessHostingProtectedNeedsOptIn && got != WitnessHostingDisabled {
		t.Fatalf("protected without opt-in reports %q", got)
	}
}

// Gateway down: the set's lease holder activates a staged standby over its
// raft port; the relay worker checks the holder statement, the standby runs
// as an active witness on the same port, survives a restart, and Gateway's
// later set (standby made active) ends the local activation.
func TestStandbyWitnessActivationByTheHolder(t *testing.T) {
	h := newWitnessHarness(t)
	listened := []string{}
	h.manager.listen = func(_, address string) (net.Listener, error) {
		listened = append(listened, address)
		return &fakeListener{closed: make(chan struct{})}, nil
	}
	var verified []string
	h.manager.verify = func(_ context.Context, policyID string, slot uint32, domain string, payload, signature []byte) (string, error) {
		if string(signature) != "holder-signature" || domain != witnessactivation.Domain || slot != 0 {
			return "", errors.New("not the committed holder")
		}
		verified = append(verified, policyID+":"+string(payload))
		return "node-a", nil
	}
	const witnessID = "11111111-1111-4111-8111-111111111111"
	const setID = "22222222-2222-4222-8222-222222222222"
	const policyID = "33333333-3333-4333-8333-333333333333"
	spec := keeperSpec(witnessID, "25.3.1", 39410)
	spec.Role, spec.SetId, spec.LeasePolicyId = witnessRoleStandby, setID, policyID
	h.rt.healthy[spec.GetArtifact().GetSha256()] = true
	h.apply(1, spec)
	h.pass(0)
	h.pass(0)
	if status := h.status(witnessID); status.GetState() != witnessStateStaged || len(listened) != 1 || listened[0] != "127.0.0.1:39411" {
		t.Fatalf("staged standby: %v, listened %v", status, listened)
	}
	request := witnessactivation.Request{Version: 1, WitnessID: witnessID, SetID: setID, LeasePolicyID: policyID,
		HolderNodeID: "node-a", IssuedAtUnixMs: h.now.UnixMilli(), Signature: []byte("holder-signature")}
	forged := request
	forged.Signature = []byte("someone else")
	if err := h.manager.activate(witnessID, forged); err == nil {
		t.Fatal("a statement the worker refused activated the standby")
	}
	wrongSet := request
	wrongSet.SetID = "44444444-4444-4444-8444-444444444444"
	if err := h.manager.activate(witnessID, wrongSet); err == nil {
		t.Fatal("a request for another set activated the standby")
	}
	otherHolder := request
	otherHolder.HolderNodeID = "node-b"
	if err := h.manager.activate(witnessID, otherHolder); err == nil {
		t.Fatal("a request naming another holder than the signer was accepted")
	}
	if err := h.manager.activate(witnessID, request); err != nil {
		t.Fatal(err)
	}
	if len(verified) != 2 {
		t.Fatalf("verified %v", verified)
	}
	h.pass(0)
	h.pass(time.Second)
	if status := h.status(witnessID); status.GetState() != witnessStateRunning || status.GetRole() != witnessRoleActive {
		t.Fatalf("activated standby: %v", status)
	}
	// A supervisor restart keeps running it.
	restarted := newWitnessManager(h.manager.dir, h.manager.workRoot, nil, func() string { return WitnessHostingAllowed }, h.rt)
	if err := restarted.load(); err != nil {
		t.Fatal(err)
	}
	restarted.mu.Lock()
	role := restarted.effectiveRoleLocked(witnessID, witnessRoleStandby)
	restarted.mu.Unlock()
	if role != witnessRoleActive {
		t.Fatal("activation lost on restart")
	}
	// Gateway makes it active itself: the local activation is dropped.
	active := keeperSpec(witnessID, "25.3.1", 39410)
	active.SetId, active.LeasePolicyId = setID, policyID
	h.apply(2, active)
	h.manager.mu.Lock()
	still := h.manager.activated[witnessID]
	h.manager.mu.Unlock()
	if still {
		t.Fatal("activation kept after Gateway adopted it")
	}
}
