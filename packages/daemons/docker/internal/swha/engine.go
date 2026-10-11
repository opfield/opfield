package swha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	// bumpCollection holds the throw-away volumes of the volume-id gate.
	bumpCollection = "gwbump"
	// bumpBatch bounds the throw-away volumes grown at once (volume slots).
	bumpBatch = 8
	// degradedBumpMargin: while new volumes were created with one copy, the
	// primary may have grown one the certified state does not name yet; the
	// gate raises the counter past it.
	degradedBumpMargin = 8
	// registeredFor: a copy is eligible only while its volume server was
	// registered with the primary's master this recently.
	registeredFor = 2 * time.Minute
	// topologyQueryEvery: a copy asks the primary's master for the topology
	// at most this often.
	topologyQueryEvery = 5 * time.Second
	// masterReadyWait and registerWait bound the promotion's waits.
	masterReadyWait = time.Minute
	registerWait    = 90 * time.Second
	componentStop   = 2 * time.Second
	switchoverWait  = 15 * time.Second
	stateFileName   = "engine.json"
)

// persisted is the engine's own state on disk.
type persisted struct {
	// MasterStartedAt is the start of the master container whose promotion
	// passed the volume-id gate (unix ns); a master that started since (a
	// crash, a restart) is not writable until it is promoted again.
	MasterStartedAt int64 `json:"masterStartedAt,omitempty"`
	// KnownMaxVolumeID is the highest volume id this member saw.
	KnownMaxVolumeID uint32 `json:"knownMaxVolumeId,omitempty"`
	// DegradedSince (unix ms): new objects are written with one copy.
	DegradedSince int64 `json:"degradedSince,omitempty"`
}

// Engine is one member's SeaweedFS engine.
type Engine struct {
	host Host
	log  *slog.Logger

	mu sync.Mutex
	st persisted
	// gateOpen: the master takes connections from other members.
	gateOpen bool
	// masterLocal: the master runs here; primary aliases are dialed locally.
	masterLocal bool
	// restartWanted: the worker asks for a master restart (a lost volume
	// server); the master is not writable until it was promoted again.
	restartWanted bool
	// meta is the newest metadata heartbeat this member's filer holds.
	meta int64
	// heartbeat is the last heartbeat this member wrote as the primary.
	heartbeat    int64
	heartbeats   []int64
	topologyMax  uint32
	registeredAt time.Time
	lastTopology time.Time
	peersOK      map[string]time.Time
	workerStop   chan struct{}
	workerSince  time.Time
	lastMetaCert time.Duration
	timings      workerTimings
}

var _ memberha.Engine = (*Engine)(nil)

// New opens the engine of one member.
func New(host Host) (*Engine, error) {
	cfg := host.Config()
	self, ok := cfg.Peer(cfg.MemberID)
	if !ok {
		return nil, errors.New("the member is not listed in its set")
	}
	if _, err := SnowflakeID(self.MemberIndex); err != nil {
		return nil, err
	}
	logger := host.Logger()
	if logger == nil {
		logger = slog.Default()
	}
	e := &Engine{host: host, log: logger.With("set_id", cfg.SetID, "member_id", cfg.MemberID), peersOK: map[string]time.Time{},
		timings: currentWorkerTimings()}
	if err := e.load(); err != nil {
		return nil, err
	}
	host.SetLocalPrimary(e.dialLocalPrimary)
	host.Expose(Exposures(cfg.MemberID, members(cfg)))
	return e, nil
}

func members(cfg memberha.Config) []MemberRef {
	out := make([]MemberRef, 0, len(cfg.Members))
	for _, peer := range cfg.Members {
		out = append(out, MemberRef{ID: peer.MemberID, Index: peer.MemberIndex})
	}
	return out
}

func (e *Engine) self() (memberha.Config, memberha.Peer) {
	cfg := e.host.Config()
	self, _ := cfg.Peer(cfg.MemberID)
	return cfg, self
}

func (e *Engine) load() error {
	raw, err := os.ReadFile(filepath.Join(e.host.StateDir(), stateFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &e.st)
}

// saveLocked persists the engine state; callers hold e.mu.
func (e *Engine) saveLocked() error {
	if err := os.MkdirAll(e.host.StateDir(), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(e.st)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(e.host.StateDir(), stateFileName), raw, 0o600)
}

// MarkPrimary records the running master as one that serves without a
// promotion: the origin member of a single-node storage turned into a set,
// whose master already handed out every volume id. degraded: its volumes have
// one copy (a converted single node); the primary repairs them to two once
// another member registered.
func MarkPrimary(stateDir string, masterStartedAt time.Time, maxVolumeID uint32, degraded bool) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	var st persisted
	if raw, err := os.ReadFile(filepath.Join(stateDir, stateFileName)); err == nil {
		_ = json.Unmarshal(raw, &st)
	}
	st.MasterStartedAt = masterStartedAt.UnixNano()
	st.KnownMaxVolumeID = max(st.KnownMaxVolumeID, maxVolumeID)
	if degraded && st.DegradedSince == 0 {
		st.DegradedSince = time.Now().UnixMilli()
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(stateDir, stateFileName), raw, 0o600)
}

func (e *Engine) local(role Role, port uint16) dialFunc {
	return func(ctx context.Context) (net.Conn, error) { return e.host.DialContainer(ctx, role, port) }
}

func (e *Engine) mesh(alias string) dialFunc {
	return func(ctx context.Context) (net.Conn, error) { return e.host.DialAlias(ctx, alias) }
}

// Container samples the member: the master container is the engine container
// (record, kill, cgroup); the member runs while its volume server and filer do.
func (e *Engine) Container(ctx context.Context) (memberha.ContainerState, error) {
	master, err := e.host.Container(ctx, RoleMaster)
	if err != nil {
		return memberha.ContainerState{}, err
	}
	volume, err := e.host.Container(ctx, RoleVolume)
	if err != nil {
		return memberha.ContainerState{}, err
	}
	filer, err := e.host.Container(ctx, RoleFiler)
	if err != nil {
		return memberha.ContainerState{}, err
	}
	return memberha.ContainerState{
		Exists: master.Exists && volume.Exists && filer.Exists, Running: volume.Running && filer.Running,
		ID: master.ID, CgroupPath: master.CgroupPath, StartedAt: master.StartedAt,
	}, nil
}

// Status samples the member's components.
func (e *Engine) Status(ctx context.Context) (memberha.EngineStatus, error) {
	cfg, self := e.self()
	exposures := Exposures(cfg.MemberID, members(cfg))
	e.host.Expose(exposures)
	e.host.Serve()
	vh, _ := VolumePorts(self.MemberIndex)
	fh, _ := FilerPorts(self.MemberIndex)
	status := memberha.EngineStatus{SyncState: "sync", Position: map[string]string{}}
	if free, full, ok := e.host.DiskFree(); ok {
		status.DiskFreeBytes, status.DiskFull = free, full
	}
	if _, err := getOK(ctx, e.local(RoleVolume, vh), "/status"); err != nil {
		status.Detail = "volume server: " + err.Error()
		e.stopWorker()
		return status, nil
	}
	meta, err := readHeartbeat(ctx, e.local(RoleFiler, fh))
	if err != nil {
		status.Detail = "filer: " + err.Error()
		e.stopWorker()
		return status, nil
	}
	master, err := e.host.Container(ctx, RoleMaster)
	if err != nil {
		return status, err
	}
	status.Answering = true
	var topology *Topology
	if master.Running {
		raw, err := getOK(ctx, e.local(RoleMaster, MasterHTTPPort), "/dir/status")
		if err == nil {
			parsed, perr := ParseTopology(raw)
			if perr == nil {
				topology = &parsed
			}
		}
		if topology == nil {
			status.Answering = false
			status.Detail = "master does not answer"
		}
	}
	now := time.Now()
	e.mu.Lock()
	e.meta = meta
	writable := master.Running && topology != nil && !e.restartWanted && e.st.MasterStartedAt != 0 &&
		e.st.MasterStartedAt == master.StartedAt.UnixNano()
	if !master.Running {
		e.masterLocal = false
		e.gateOpen = false
	}
	if topology == nil && !master.Running && now.Sub(e.lastTopology) >= topologyQueryEvery {
		e.lastTopology = now
		e.mu.Unlock()
		if raw, err := getOK(ctx, e.mesh("primary-"+PortMaster), "/dir/status"); err == nil {
			if parsed, perr := ParseTopology(raw); perr == nil {
				topology = &parsed
			}
		}
		e.mu.Lock()
	}
	if topology != nil {
		e.topologyMax = topology.MaxVolumeID
		if topology.Registered(VolumeURL(cfg.MemberID, self.MemberIndex)) {
			e.registeredAt = now
		}
		if topology.MaxVolumeID > e.st.KnownMaxVolumeID {
			e.st.KnownMaxVolumeID = topology.MaxVolumeID
			if err := e.saveLocked(); err != nil {
				e.log.Warn("could not persist the SeaweedFS member state", "error", err)
			}
		}
	}
	status.Writable = writable
	status.Streaming = !writable && !e.registeredAt.IsZero() && now.Sub(e.registeredAt) <= registeredFor
	if !writable && meta > 0 {
		status.LagSeconds = max(0, float64(now.UnixNano()-meta)/1e9)
	}
	status.Position["volumeRegistered"] = fmt.Sprint(writable || status.Streaming)
	status.Position["maxVolumeId"] = fmt.Sprint(e.st.KnownMaxVolumeID)
	status.Position["metaProgressNs"] = fmt.Sprint(meta)
	if e.st.DegradedSince != 0 {
		status.Position["degradedSince"] = fmt.Sprint(e.st.DegradedSince)
		status.SyncState = "async"
	}
	e.mu.Unlock()
	if writable {
		e.startWorker()
	} else {
		e.stopWorker()
	}
	return status, nil
}

// PrepareStandby keeps the master from starting by itself: standby at rest is
// a member whose master does not run.
func (e *Engine) PrepareStandby(ctx context.Context) error {
	return e.host.EnsureNoRestart(ctx, RoleMaster)
}

// Start brings the member's volume server and filer up (never the master).
func (e *Engine) Start(ctx context.Context) error {
	cfg, _ := e.self()
	e.host.Expose(Exposures(cfg.MemberID, members(cfg)))
	if err := e.host.Start(ctx, RoleVolume); err != nil {
		return err
	}
	return e.host.Start(ctx, RoleFiler)
}

// StopClean stops the master when it runs (a release), else the member's
// volume server and filer (a removed copy).
func (e *Engine) StopClean(ctx context.Context, timeout time.Duration) error {
	master, err := e.host.Container(ctx, RoleMaster)
	if err != nil {
		return err
	}
	if master.Running {
		e.closeMaster()
		return e.host.Stop(ctx, RoleMaster, timeout)
	}
	if err := e.host.Stop(ctx, RoleFiler, timeout); err != nil {
		return err
	}
	return e.host.Stop(ctx, RoleVolume, timeout)
}

// Kill stops the master at once.
func (e *Engine) Kill(ctx context.Context) error {
	e.closeMaster()
	return e.host.Kill(ctx, RoleMaster)
}

func (e *Engine) closeMaster() {
	e.stopWorker()
	e.mu.Lock()
	e.gateOpen, e.masterLocal = false, false
	e.mu.Unlock()
}

// CgroupEmpty reports whether no process of the master remains.
func (e *Engine) CgroupEmpty(ctx context.Context) (bool, error) {
	return e.host.CgroupEmpty(ctx, RoleMaster)
}

// Rejoin: a SeaweedFS copy needs none (its filer catches up by peer sync, its
// volumes are repaired by the primary).
func (e *Engine) Rejoin(context.Context) error { return nil }

// DialPeer connects an incoming peer tunnel to a component port. The master
// takes other members only once its promotion passed the volume-id gate.
func (e *Engine) DialPeer(ctx context.Context, port string) (net.Conn, error) {
	_, self := e.self()
	vh, vg := VolumePorts(self.MemberIndex)
	fh, fg := FilerPorts(self.MemberIndex)
	switch port {
	case PortMaster, PortMasterGRPC:
		e.mu.Lock()
		open := e.gateOpen && e.masterLocal
		e.mu.Unlock()
		if !open {
			return nil, errors.New("the SeaweedFS master does not take other members now")
		}
		if port == PortMaster {
			return e.host.DialContainer(ctx, RoleMaster, MasterHTTPPort)
		}
		return e.host.DialContainer(ctx, RoleMaster, MasterGRPCPort)
	case PortVolume:
		return e.host.DialContainer(ctx, RoleVolume, vh)
	case PortVolumeGRPC:
		return e.host.DialContainer(ctx, RoleVolume, vg)
	case PortFiler:
		return e.host.DialContainer(ctx, RoleFiler, fh)
	case PortFilerGRPC:
		return e.host.DialContainer(ctx, RoleFiler, fg)
	}
	return nil, fmt.Errorf("unknown SeaweedFS peer port %q", port)
}

// dialLocalPrimary serves the member's own primary aliases while its master
// runs here, whether or not the master takes other members yet.
func (e *Engine) dialLocalPrimary(ctx context.Context, port string) (net.Conn, bool) {
	e.mu.Lock()
	local := e.masterLocal
	e.mu.Unlock()
	if !local {
		return nil, false
	}
	target := uint16(MasterHTTPPort)
	switch port {
	case PortMaster:
	case PortMasterGRPC:
		target = MasterGRPCPort
	default:
		return nil, false
	}
	conn, err := e.host.DialContainer(ctx, RoleMaster, target)
	if err != nil {
		return nil, false
	}
	return conn, true
}

// Eligible: the copy's volume server registered with the primary recently and
// its filer's metadata is within metaTolerance of the certified progress.
func (e *Engine) Eligible(input memberha.EligibilityInput, _ memberha.EngineStatus) (bool, string) {
	value, err := decodeValue(input.Adopted.Value)
	if err != nil {
		return false, "no_certified_state"
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.registeredAt.IsZero() || time.Since(e.registeredAt) > registeredFor {
		return false, "volume_not_registered"
	}
	if value.MetaProgressNs > 0 && e.meta < value.MetaProgressNs-int64(metaTolerance) {
		return false, "metadata_behind"
	}
	return true, ""
}

// BootstrapValue is the first certified state, from the member that served
// the storage as a single node.
func (e *Engine) BootstrapValue(memberha.EngineStatus) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return Value{MaxVolumeID: max(e.topologyMax, e.st.KnownMaxVolumeID), MetaProgressNs: max(e.heartbeat, e.meta),
		DegradedSince: e.st.DegradedSince}.encode()
}

// PromotedValue certifies this member's promotion.
func (e *Engine) PromotedValue(certified []byte, _ memberha.EngineStatus) ([]byte, error) {
	value, _ := decodeValue(certified)
	e.mu.Lock()
	defer e.mu.Unlock()
	value.MaxVolumeID = max(value.MaxVolumeID, e.topologyMax, e.st.KnownMaxVolumeID)
	value.MetaProgressNs = max(value.MetaProgressNs, e.heartbeat)
	value.DegradedSince = e.st.DegradedSince
	return value.encode()
}

// NextValue certifies a grown volume id, a degraded change, or metadata
// progress (at most once a second).
func (e *Engine) NextValue(certified []byte, _ memberha.EngineStatus, now time.Duration) ([]byte, string, bool, error) {
	value, err := decodeValue(certified)
	if err != nil {
		return nil, "", false, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	next, kind := value, ""
	if e.topologyMax > value.MaxVolumeID {
		next.MaxVolumeID, kind = e.topologyMax, "volumes"
	}
	if e.st.DegradedSince != value.DegradedSince {
		next.DegradedSince, kind = e.st.DegradedSince, "degraded"
	}
	if e.heartbeat-value.MetaProgressNs >= int64(time.Second) && (kind != "" || now-e.lastMetaCert >= time.Second) {
		next.MetaProgressNs = e.heartbeat
		if kind == "" {
			kind = "metadata"
		}
	}
	if kind == "" {
		return nil, "", false, nil
	}
	if next.MetaProgressNs != value.MetaProgressNs {
		e.lastMetaCert = now
	}
	raw, err := next.encode()
	return raw, kind, err == nil, err
}

// ReleaseTarget is a member whose volume server answered the primary within
// the last 10 s (its filer follows by peer sync).
func (e *Engine) ReleaseTarget([]byte) (string, bool) {
	cfg, _ := e.self()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.st.DegradedSince != 0 {
		// Objects written with one copy live only here.
		return "", false
	}
	for _, peer := range cfg.Others() {
		if peer.Removing {
			continue
		}
		if at, ok := e.peersOK[peer.MemberID]; ok && time.Since(at) <= e.timings.lost {
			return peer.MemberID, true
		}
	}
	return "", false
}

// Switchover lets the successor's filer catch up with this member's metadata
// before the release; refused while objects exist with one copy only.
func (e *Engine) Switchover(ctx context.Context, successorMemberID string) error {
	cfg, self := e.self()
	successor, ok := cfg.Peer(successorMemberID)
	if !ok {
		return errors.New("the successor is no member of the set")
	}
	e.mu.Lock()
	degraded := e.st.DegradedSince != 0
	e.mu.Unlock()
	if degraded {
		return errors.New("some objects have one copy only; the switch waits until the replication is repaired")
	}
	fh, _ := FilerPorts(self.MemberIndex)
	ns, err := e.writeHeartbeat(ctx, e.local(RoleFiler, fh))
	if err != nil {
		return fmt.Errorf("write the last metadata heartbeat: %w", err)
	}
	deadline := time.Now().Add(switchoverWait)
	alias := "member-" + successor.MemberID + "-" + PortFiler
	for {
		got, err := readHeartbeat(ctx, e.mesh(alias))
		if err == nil && got >= ns {
			return nil
		}
		if time.Now().After(deadline) {
			if err == nil {
				err = errors.New("its metadata is behind")
			}
			return fmt.Errorf("the successor's filer did not catch up: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// writeHeartbeat writes a new metadata heartbeat into the member's filer.
func (e *Engine) writeHeartbeat(ctx context.Context, filer dialFunc) (int64, error) {
	token, err := e.host.FilerToken()
	if err != nil {
		return 0, err
	}
	ns := time.Now().UnixNano()
	e.mu.Lock()
	if ns <= e.heartbeat {
		ns = e.heartbeat + 1
	}
	older := append([]int64(nil), e.heartbeats...)
	e.mu.Unlock()
	if len(older) == 0 {
		// The first heartbeat of a holding period removes what earlier
		// primaries left.
		if data, status, err := request(ctx, filer, "GET", heartbeatDir+"?limit=1000", "", nil); err == nil && status == 200 {
			older, _ = heartbeatNames(data)
		}
	}
	if err := writeHeartbeat(ctx, filer, token, ns, older); err != nil {
		return 0, err
	}
	e.mu.Lock()
	e.heartbeat, e.heartbeats = ns, []int64{ns}
	e.mu.Unlock()
	return ns, nil
}
