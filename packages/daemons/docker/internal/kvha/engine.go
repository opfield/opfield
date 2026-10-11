// Package kvha is the Valkey engine of availability set members (key-value
// store pairs and sets): it implements memberha.Engine on top of a Host the
// docker daemon provides (one Valkey container per member).
//
// Decision 15 of the plan:
//   - Standby at rest: every member container starts as a replica of
//     "primary-kv-repl" (the member mesh alias of the lease holder), with the
//     set's replication user; only the holder (or a manual pair's primary)
//     runs REPLICAOF NO ONE. A restarted primary comes back as a replica.
//   - Copies are read-only (replica-read-only yes); a returning old primary
//     resyncs (PSYNC keeps a partial resync possible through replid2).
//   - Certified state: {replid, offsetFloor, degraded}. The holder certifies a
//     new floor when its offset moved at least maxLagBytes/2 since the last
//     one, at most once a second. A copy may take over when it follows that
//     history (master_replid or master_replid2 is the certified replid) and
//     its offset is at least floor - maxLagBytes.
//   - ACL users do not replicate: every copy mirrors the primary's ACL list
//     (users and their password hashes) every few seconds, and is eligible
//     only after it mirrored it once since it started.
package kvha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	// ReplicationUser is the set's own ACL user: replication (masteruser),
	// promotion, status and the ACL mirror. Its password is the set's
	// (engine_config replicationPassword); copies never mirror it.
	ReplicationUser = "gateway-ha"
	// ServerPort is the plain Valkey port inside the member container.
	ServerPort = 6379
	// PortRepl is the primary's replication port on the member mesh.
	PortRepl     = "kv-repl"
	PrimaryHost  = "primary-kv-repl"
	callTimeout  = 3 * time.Second
	aclSyncEvery = 5 * time.Second
	// switchoverWait bounds how long writes stay paused for the successor.
	switchoverWait = 10 * time.Second
)

// EngineConfig is the set's Valkey configuration (engine_config JSON).
type EngineConfig struct {
	ReplicationPassword string `json:"replicationPassword"`
}

// ParseEngineConfig reads the engine configuration of a member.
func ParseEngineConfig(raw []byte) (EngineConfig, error) {
	var config EngineConfig
	if len(raw) == 0 {
		return config, errors.New("the Valkey member has no replication password")
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return config, fmt.Errorf("parse the Valkey member configuration: %w", err)
	}
	if len(config.ReplicationPassword) < 16 {
		return config, errors.New("the Valkey replication password is missing or too short")
	}
	return config, nil
}

// ContainerInfo is the Docker view of the member's container.
type ContainerInfo struct {
	Exists     bool
	Running    bool
	ID         string
	CgroupPath string
	StartedAt  time.Time
}

// Exposure is one mesh listener of the member's containers.
type Exposure struct {
	Host  string
	Port  uint16
	Alias string
}

// Exposures are the mesh listeners a Valkey member needs: the primary's
// replication port.
func Exposures() []Exposure {
	return []Exposure{{Host: PrimaryHost, Port: ServerPort, Alias: "primary-" + PortRepl}}
}

// Host is what the engine needs from the docker daemon for one member.
type Host interface {
	Config() memberha.Config
	Container(ctx context.Context) (ContainerInfo, error)
	// PrepareStandby makes sure the next start comes up as a replica of the
	// primary with the set's replication user (configuration and ACL file).
	PrepareStandby(ctx context.Context) error
	Start(ctx context.Context) error
	Stop(ctx context.Context, timeout time.Duration) error
	Kill(ctx context.Context) error
	CgroupEmpty(ctx context.Context) (bool, error)
	// DialServer connects to the member's own Valkey port.
	DialServer(ctx context.Context) (net.Conn, error)
	// DialAlias carries a connection through the member mesh.
	DialAlias(ctx context.Context, alias string) (net.Conn, error)
	Expose(exposures []Exposure)
	SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool))
	DiskFree() (free uint64, full bool, ok bool)
	Serve()
	Logger() *slog.Logger
}

// ACLMarker is a host that remembers, across restarts, that this member
// mirrored the primary's ACL list once (Valkey saves the mirrored list to its
// ACL file, so it survives the restart too). Without it a set whose members
// all restarted had no eligible member and no holder.
type ACLMarker interface {
	ACLMirrored() bool
	MarkACLMirrored() error
}

// Engine is one member's Valkey engine.
type Engine struct {
	host Host
	log  *slog.Logger

	mu        sync.Mutex
	role      string
	replID    string
	replID2   string
	offset    int64
	linked    bool
	replicas  []replicaInfo
	gateOpen  bool
	aclSynced time.Time
	aclErr    string
	// aclMirroredBefore: an earlier process of this member mirrored the ACL
	// list (ACLMarker).
	aclMirroredBefore bool
	// noCopiesSince: the primary had no online copy since then (zero: it has one).
	noCopiesSince time.Time
	lastFloorCert time.Duration
	workerStop    chan struct{}
}

var (
	_ memberha.Engine       = (*Engine)(nil)
	_ memberha.ForcedValuer = (*Engine)(nil)
)

// New opens the engine of one member.
func New(host Host) (*Engine, error) {
	cfg := host.Config()
	if _, err := ParseEngineConfig(cfg.EngineConfig); err != nil {
		return nil, err
	}
	logger := host.Logger()
	if logger == nil {
		logger = slog.Default()
	}
	e := &Engine{host: host, log: logger.With("set_id", cfg.SetID, "member_id", cfg.MemberID)}
	if marker, ok := host.(ACLMarker); ok {
		e.aclMirroredBefore = marker.ACLMirrored()
	}
	host.SetLocalPrimary(e.dialLocalPrimary)
	host.Expose(Exposures())
	return e, nil
}

func (e *Engine) password() string {
	config, _ := ParseEngineConfig(e.host.Config().EngineConfig)
	return config.ReplicationPassword
}

func (e *Engine) maxLag() int64 {
	if lag := e.host.Config().MaxLagBytes; lag > 0 {
		return int64(lag)
	}
	return 1 << 20
}

// open connects and authenticates as the replication user.
func (e *Engine) open(ctx context.Context, dial func(context.Context) (net.Conn, error)) (*conn, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	raw, err := dial(ctx)
	if err != nil {
		return nil, err
	}
	c := newConn(raw, callTimeout)
	if _, err := c.str("AUTH", ReplicationUser, e.password()); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("authenticate as %s: %w", ReplicationUser, err)
	}
	return c, nil
}

func (e *Engine) local(ctx context.Context) (*conn, error) { return e.open(ctx, e.host.DialServer) }

func (e *Engine) Container(ctx context.Context) (memberha.ContainerState, error) {
	info, err := e.host.Container(ctx)
	if err != nil {
		return memberha.ContainerState{}, err
	}
	return memberha.ContainerState{Exists: info.Exists, Running: info.Running, ID: info.ID, CgroupPath: info.CgroupPath, StartedAt: info.StartedAt}, nil
}

// Status samples the member's Valkey.
func (e *Engine) Status(ctx context.Context) (memberha.EngineStatus, error) {
	e.host.Expose(Exposures())
	e.host.Serve()
	status := memberha.EngineStatus{SyncState: "async", Position: map[string]string{}}
	if free, full, ok := e.host.DiskFree(); ok {
		status.DiskFreeBytes, status.DiskFull = free, full
	}
	c, err := e.local(ctx)
	if err != nil {
		status.Detail = err.Error()
		e.closeGate()
		return status, nil
	}
	defer c.Close()
	text, err := c.str("INFO", "replication")
	if err != nil {
		status.Detail = err.Error()
		e.closeGate()
		return status, nil
	}
	info := parseInfo(text)
	role := info["role"]
	status.Answering = true
	status.Writable = role == "master"
	offset := info["master_repl_offset"]
	if role != "master" {
		if value, ok := info["slave_repl_offset"]; ok {
			offset = value
		}
	}
	parsedOffset, _ := strconv.ParseInt(offset, 10, 64)
	linked := role != "master" && info["master_link_status"] == "up"
	status.Streaming = linked
	now := time.Now()
	e.mu.Lock()
	e.role, e.replID, e.replID2, e.offset, e.linked = role, info["master_replid"], info["master_replid2"], parsedOffset, linked
	if role == "master" {
		e.replicas = parseReplicas(info)
		online := 0
		for _, replica := range e.replicas {
			if replica.State == "online" {
				online++
			}
		}
		if online == 0 {
			if e.noCopiesSince.IsZero() {
				e.noCopiesSince = now
			}
		} else {
			e.noCopiesSince = time.Time{}
		}
		e.gateOpen = true
	} else {
		e.replicas, e.gateOpen, e.noCopiesSince = nil, false, time.Time{}
	}
	aclSynced := !e.aclSynced.IsZero() || e.aclMirroredBefore
	e.mu.Unlock()
	status.Position["role"] = role
	status.Position["replid"] = info["master_replid"]
	status.Position["offset"] = strconv.FormatInt(parsedOffset, 10)
	status.Position["linked"] = strconv.FormatBool(linked)
	status.Position["aclMirrored"] = strconv.FormatBool(aclSynced || role == "master")
	if role == "master" {
		e.stopWorker()
	} else {
		e.startWorker()
	}
	return status, nil
}

func (e *Engine) closeGate() {
	e.mu.Lock()
	e.gateOpen = false
	e.mu.Unlock()
}

func (e *Engine) PrepareStandby(ctx context.Context) error { return e.host.PrepareStandby(ctx) }
func (e *Engine) Start(ctx context.Context) error          { return e.host.Start(ctx) }

func (e *Engine) StopClean(ctx context.Context, timeout time.Duration) error {
	e.closeGate()
	return e.host.Stop(ctx, timeout)
}

func (e *Engine) Kill(ctx context.Context) error {
	e.closeGate()
	return e.host.Kill(ctx)
}

func (e *Engine) CgroupEmpty(ctx context.Context) (bool, error) { return e.host.CgroupEmpty(ctx) }

// Promote makes the copy the primary (REPLICAOF NO ONE).
func (e *Engine) Promote(ctx context.Context, _ []byte) error {
	c, err := e.local(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.str("REPLICAOF", "NO", "ONE"); err != nil {
		return fmt.Errorf("REPLICAOF NO ONE: %w", err)
	}
	role, err := c.strings("ROLE")
	if err != nil {
		return err
	}
	if len(role) == 0 || role[0] != "master" {
		return errors.New("the member did not become the primary")
	}
	e.log.Info("Valkey member promoted")
	return nil
}

// Rejoin: Valkey resyncs a copy itself (partial through replid2, else full).
func (e *Engine) Rejoin(context.Context) error { return nil }

// DialPeer serves the replication port only while this member is the primary.
func (e *Engine) DialPeer(ctx context.Context, port string) (net.Conn, error) {
	if port != PortRepl {
		return nil, fmt.Errorf("unknown Valkey peer port %q", port)
	}
	e.mu.Lock()
	open := e.gateOpen
	e.mu.Unlock()
	if !open {
		return nil, errors.New("this Valkey member is not the primary")
	}
	return e.host.DialServer(ctx)
}

func (e *Engine) dialLocalPrimary(ctx context.Context, port string) (net.Conn, bool) {
	if port != PortRepl {
		return nil, false
	}
	e.mu.Lock()
	open := e.gateOpen
	e.mu.Unlock()
	if !open {
		return nil, false
	}
	conn, err := e.host.DialServer(ctx)
	return conn, err == nil
}

// Eligible: the copy follows the certified primary's history, is within
// maxLagBytes of the certified floor and mirrored the ACL list.
func (e *Engine) Eligible(input memberha.EligibilityInput, _ memberha.EngineStatus) (bool, string) {
	value, err := decodeValue(input.Adopted.Value)
	if err != nil {
		return false, "no_certified_state"
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// The previous holder's ACL list is the set's (it was the primary); a member
	// that mirrored it in an earlier process kept it in its ACL file.
	previousHolder := input.PreviousHolder != "" && input.PreviousHolder == e.host.Config().NodeID && !input.PreviousReleased
	if e.aclSynced.IsZero() && !e.aclMirroredBefore && !previousHolder {
		return false, "acl_not_mirrored"
	}
	if value.ReplID != "" && e.replID != value.ReplID && e.replID2 != value.ReplID {
		return false, "other_history"
	}
	if e.offset < value.OffsetFloor-e.maxLag() {
		return false, "behind"
	}
	return true, ""
}

// ForcedValue is the value a forced promotion certifies (AS10): this copy's
// own history and offset. An operator promotes it although it is not eligible
// (another history, ACLs not mirrored): its data becomes the set's, and
// Gateway applies the store's users to it again once it serves.
func (e *Engine) ForcedValue(string, memberha.EngineStatus) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.role == "master" {
		return nil, errors.New("this member already runs as the primary")
	}
	return Value{ReplID: e.replID, OffsetFloor: e.offset}.encode()
}

func (e *Engine) BootstrapValue(memberha.EngineStatus) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.role != "master" {
		return nil, errors.New("the bootstrap member is not the primary")
	}
	return Value{ReplID: e.replID, OffsetFloor: e.offset}.encode()
}

func (e *Engine) PromotedValue(certified []byte, _ memberha.EngineStatus) ([]byte, error) {
	value, _ := decodeValue(certified)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.role != "master" {
		return nil, errors.New("the member is not the primary yet")
	}
	value.ReplID, value.OffsetFloor, value.Degraded = e.replID, max(value.OffsetFloor, e.offset), false
	return value.encode()
}

// NextValue certifies a new replication id, a floor that moved at least
// maxLagBytes/2 (at most once a second), or a degraded change.
func (e *Engine) NextValue(certified []byte, _ memberha.EngineStatus, now time.Duration) ([]byte, string, bool, error) {
	value, err := decodeValue(certified)
	if err != nil {
		return nil, "", false, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.role != "master" {
		return nil, "", false, nil
	}
	next, kind := value, ""
	if e.replID != value.ReplID {
		next.ReplID, next.OffsetFloor, kind = e.replID, e.offset, "replid"
	} else if e.offset-value.OffsetFloor >= e.maxLag()/2 && now-e.lastFloorCert >= time.Second {
		next.OffsetFloor, kind = e.offset, "floor"
	}
	degradeAfter := time.Duration(max(e.host.Config().SyncDegradeAfterSeconds, 1)) * time.Second
	degraded := !e.noCopiesSince.IsZero() && time.Since(e.noCopiesSince) >= degradeAfter
	if degraded != value.Degraded {
		next.Degraded = degraded
		if kind == "" {
			kind = "degraded"
		}
	}
	if kind == "" {
		return nil, "", false, nil
	}
	if next.OffsetFloor != value.OffsetFloor {
		e.lastFloorCert = now
	}
	raw, err := next.encode()
	return raw, kind, err == nil, err
}

// ReleaseTarget is an online copy within maxLagBytes of the floor (copies
// announce their member id as replica-announce-ip).
func (e *Engine) ReleaseTarget(certified []byte) (string, bool) {
	value, _ := decodeValue(certified)
	cfg := e.host.Config()
	e.mu.Lock()
	replicas := append([]replicaInfo(nil), e.replicas...)
	e.mu.Unlock()
	sort.Slice(replicas, func(i, j int) bool { return replicas[i].Offset > replicas[j].Offset })
	for _, replica := range replicas {
		if replica.State != "online" || replica.Offset < value.OffsetFloor-e.maxLag() {
			continue
		}
		if peer, ok := cfg.Peer(replica.IP); ok && peer.MemberID != cfg.MemberID && !peer.Removing {
			return peer.MemberID, true
		}
	}
	return "", false
}

// Switchover pauses writes and waits until the successor has every write.
func (e *Engine) Switchover(ctx context.Context, successorMemberID string) error {
	c, err := e.local(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.str("CLIENT", "PAUSE", strconv.Itoa(int((switchoverWait+5*time.Second)/time.Millisecond)), "WRITE"); err != nil {
		return fmt.Errorf("pause writes: %w", err)
	}
	deadline := time.Now().Add(switchoverWait)
	for {
		_ = c.SetDeadline(time.Now().Add(callTimeout))
		text, err := c.str("INFO", "replication")
		if err == nil {
			info := parseInfo(text)
			target, _ := strconv.ParseInt(info["master_repl_offset"], 10, 64)
			for _, replica := range parseReplicas(info) {
				if replica.IP == successorMemberID && replica.State == "online" && replica.Offset >= target {
					return nil
				}
			}
		}
		if time.Now().After(deadline) {
			_, _ = c.str("CLIENT", "UNPAUSE")
			return errors.New("the successor did not catch up with the primary")
		}
		select {
		case <-ctx.Done():
			_, _ = c.str("CLIENT", "UNPAUSE")
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// --- ACL mirror (copies) ------------------------------------------------------------------------------------------

func (e *Engine) startWorker() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workerStop != nil {
		return
	}
	stop := make(chan struct{})
	e.workerStop = stop
	go e.mirrorLoop(stop)
}

func (e *Engine) stopWorker() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workerStop != nil {
		close(e.workerStop)
		e.workerStop = nil
	}
}

func (e *Engine) mirrorLoop(stop chan struct{}) {
	ticker := time.NewTicker(aclSyncEvery)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*callTimeout)
		err := e.MirrorACL(ctx)
		cancel()
		e.mu.Lock()
		if err != nil {
			if e.aclErr != err.Error() {
				e.log.Debug("Valkey ACL list not mirrored from the primary", "error", err)
			}
			e.aclErr = err.Error()
		} else {
			e.aclErr = ""
		}
		e.mu.Unlock()
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
	}
}

// MirrorACL makes the member's ACL users those of the primary (except the
// set's replication user) and saves them.
func (e *Engine) MirrorACL(ctx context.Context) error {
	primary, err := e.open(ctx, func(ctx context.Context) (net.Conn, error) { return e.host.DialAlias(ctx, "primary-"+PortRepl) })
	if err != nil {
		return err
	}
	defer primary.Close()
	want, err := primary.strings("ACL", "LIST")
	if err != nil {
		return err
	}
	local, err := e.local(ctx)
	if err != nil {
		return err
	}
	defer local.Close()
	have, err := local.strings("ACL", "LIST")
	if err != nil {
		return err
	}
	plan := planACLMirror(want, have)
	for _, rules := range plan.set {
		if _, err := local.str(append([]string{"ACL", "SETUSER"}, rules...)...); err != nil {
			return fmt.Errorf("ACL SETUSER %s: %w", rules[0], err)
		}
	}
	for _, name := range plan.remove {
		if _, err := local.do("ACL", "DELUSER", name); err != nil {
			return fmt.Errorf("ACL DELUSER %s: %w", name, err)
		}
	}
	if len(plan.set)+len(plan.remove) > 0 {
		if _, err := local.str("ACL", "SAVE"); err != nil {
			return fmt.Errorf("ACL SAVE: %w", err)
		}
	}
	e.mu.Lock()
	first := e.aclSynced.IsZero() && !e.aclMirroredBefore
	e.aclSynced = time.Now()
	e.mu.Unlock()
	if marker, ok := e.host.(ACLMarker); ok && first {
		if err := marker.MarkACLMirrored(); err != nil {
			e.log.Warn("could not remember that the Valkey ACL list was mirrored", "error", err)
		}
	}
	return nil
}

type aclPlan struct {
	// set: ACL SETUSER arguments (name, "reset", rules...).
	set    [][]string
	remove []string
}

// planACLMirror compares ACL LIST lines ("user <name> <rules...>").
func planACLMirror(want, have []string) aclPlan {
	parse := func(lines []string) map[string][]string {
		out := map[string][]string{}
		for _, line := range lines {
			fields := strings.Fields(line)
			if len(fields) < 2 || fields[0] != "user" || fields[1] == ReplicationUser {
				continue
			}
			out[fields[1]] = fields[2:]
		}
		return out
	}
	wanted, existing := parse(want), parse(have)
	var plan aclPlan
	names := make([]string, 0, len(wanted))
	for name := range wanted {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		rules := wanted[name]
		if strings.Join(existing[name], " ") == strings.Join(rules, " ") {
			continue
		}
		plan.set = append(plan.set, append([]string{name, "reset"}, rules...))
	}
	for name := range existing {
		if _, ok := wanted[name]; !ok && name != "default" {
			plan.remove = append(plan.remove, name)
		}
	}
	sort.Strings(plan.remove)
	return plan
}
