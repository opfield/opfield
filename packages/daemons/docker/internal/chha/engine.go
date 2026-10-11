package chha

import (
	"bytes"
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
	"sync/atomic"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/daemon-shared/witnessactivation"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Runtime is the docker side of one ClickHouse member: its container, files
// in its data mount, its SQL interface and the member mesh.
type Runtime interface {
	// Container samples the member's container and its main process id.
	Container(ctx context.Context) (memberha.ContainerState, int, error)
	// Address is the running container's address on the set's private bridge.
	Address(ctx context.Context) (string, error)
	Start(ctx context.Context) error
	StopClean(ctx context.Context, timeout time.Duration) error
	Kill(ctx context.Context) error
	CgroupEmpty(ctx context.Context) (bool, error)
	// Query runs SQL as the internal user over the HTTP interface.
	Query(ctx context.Context, query string) (string, error)
	// KeeperClient runs one clickhouse keeper-client command against the
	// member's own Keeper (inside the container).
	KeeperClient(ctx context.Context, command string) (string, error)
	// ReadFile/WriteFile access a file of the data mount (written in place:
	// the container sees it through a file bind mount).
	ReadFile(name string) ([]byte, error)
	WriteFile(name string, data []byte) error
	// Exists reports whether a path under the data mount exists.
	Exists(relative string) bool
	// InternalPasswordSHA256 is the internal user's password hash.
	InternalPasswordSHA256() (string, error)
	// Listen binds address in the network namespace of process pid.
	Listen(pid int, address string) (net.Listener, error)
	// Bridge carries a connection to a member mesh alias and returns when it ended.
	Bridge(connection net.Conn, alias string) error
	// Probe reports whether a member mesh alias accepts a connection now.
	Probe(ctx context.Context, alias string) error
	// Config is the member's current configuration (false once forgotten).
	Config() (memberha.Config, bool)
	// GatewayConnected reports the Gateway control session.
	GatewayConnected() bool
	// Sign signs a holder statement with the node's identity key.
	Sign(domain string, payload []byte) ([]byte, error)
	Logger() *slog.Logger
}

const (
	loopInterval       = 2 * time.Second
	profileSweepPeriod = 30 * time.Second
	switchoverWait     = 60 * time.Second
	promoteWait        = 15 * time.Second
	activationTimeout  = 15 * time.Second
)

// engine is one ClickHouse member (memberha.Engine).
type engine struct {
	rt     Runtime
	logger *slog.Logger

	// snapshot is the latest configuration, for the lease callbacks (which
	// must not call into the runtime).
	snapshot atomic.Pointer[configSnapshot]

	// roleMu orders every change of the client profile; roleGen grows with
	// each, so a convert run restores writes only if nothing changed meanwhile.
	roleMu  sync.Mutex
	roleGen uint64

	fw *forwarders

	mu           sync.Mutex
	tracker      degradeTracker
	certified    Value
	certifiedOK  bool
	lastSample   sample
	inConfig     map[uint32]time.Duration
	witnessDown  map[uint32]time.Duration
	gatewayDown  time.Duration
	voters       string
	convert      string
	lastSweep    time.Duration
	activated    *activation
	activationOK bool
	started      time.Time
	// lastConfigRead and lastRqld pace the Keeper configuration reads and
	// leadership requests (lease clock).
	lastConfigRead time.Duration
	lastRqld       time.Duration
	lastReconfig   time.Duration

	loopOnce sync.Once
	stopped  atomic.Bool
}

type configSnapshot struct {
	config memberha.Config
	ec     EngineConfig
}

// New opens a member's ClickHouse engine and starts its background work
// (mesh forwarders, Replicated databases, and on the holder the Keeper
// membership, insert quorum and convert).
func New(config memberha.Config, rt Runtime) (memberha.Engine, error) {
	ec, err := ParseEngineConfig(config)
	if err != nil {
		return nil, err
	}
	e := &engine{rt: rt, logger: rt.Logger(), inConfig: map[uint32]time.Duration{}, witnessDown: map[uint32]time.Duration{},
		started: time.Now()}
	if e.logger == nil {
		e.logger = slog.Default()
	}
	e.snapshot.Store(&configSnapshot{config: config, ec: ec})
	e.fw = newForwarders(rt.Listen, rt.Bridge, e.logger)
	if raw, err := rt.ReadFile(activationFile); err == nil {
		e.activated, _ = decodeActivation(raw)
	}
	e.loopOnce.Do(func() { go e.loop() })
	return e, nil
}

// refresh reads the current configuration; false once the member is gone.
func (e *engine) refresh() (*configSnapshot, bool) {
	config, ok := e.rt.Config()
	if !ok {
		return e.snapshot.Load(), false
	}
	current := e.snapshot.Load()
	if current != nil && current.config.ConfigRevision == config.ConfigRevision && bytes.Equal(current.config.EngineConfig, config.EngineConfig) &&
		current.config.Durability == config.Durability && current.config.SyncDegradeAfterSeconds == config.SyncDegradeAfterSeconds {
		return current, true
	}
	ec, err := ParseEngineConfig(config)
	if err != nil {
		e.logger.Warn("ClickHouse member configuration rejected; keeping the previous one", "set_id", config.SetID, "error", err)
		return current, true
	}
	next := &configSnapshot{config: config, ec: ec}
	e.snapshot.Store(next)
	return next, true
}

func (e *engine) Container(ctx context.Context) (memberha.ContainerState, error) {
	state, _, err := e.rt.Container(ctx)
	return state, err
}

// Status samples the engine: Keeper mode, replicas, profile, disk.
func (e *engine) Status(ctx context.Context) (memberha.EngineStatus, error) {
	snap, _ := e.refresh()
	state, pid, err := e.rt.Container(ctx)
	if err != nil {
		return memberha.EngineStatus{}, err
	}
	if state.Running {
		e.fw.ensure(state.ID, pid, desiredForwards(snap.config.MemberID, snap.ec))
	}
	text, err := e.rt.Query(ctx, statusQuery)
	if err != nil {
		return memberha.EngineStatus{Detail: err.Error()}, nil
	}
	row, err := parseStatusRow(text)
	if err != nil {
		return memberha.EngineStatus{Detail: err.Error()}, nil
	}
	mode := "unknown"
	if address, err := e.rt.Address(ctx); err == nil {
		if probed, err := probeKeeper(ctx, net.JoinHostPort(address, strconv.Itoa(KeeperClientPort))); err == nil {
			mode = probed
		}
	}
	syncing := false
	if keeperServing(mode) {
		syncing = e.databasesSyncing(ctx, snap.ec)
	}
	e.mu.Lock()
	extra := map[string]string{}
	if e.convert != "" {
		extra[posConvert] = e.convert
	}
	if e.activated != nil {
		extra[posActivated] = fmt.Sprintf("%s>%s", e.activated.StandbyWitnessID, e.activated.ReplacesWitness)
	}
	voters := e.voters
	e.mu.Unlock()
	status := toStatus(row, mode, syncing, voters, extra)
	e.mu.Lock()
	e.lastSample = sampleOf(status)
	e.mu.Unlock()
	return status, nil
}

// databasesSyncing: some database of the set is missing here, or has fewer
// tables than its Replicated metadata in Keeper (a member that joins).
func (e *engine) databasesSyncing(ctx context.Context, ec EngineConfig) bool {
	names, err := e.setDatabases(ctx, ec)
	if err != nil {
		return true
	}
	if len(names) == 0 {
		return false
	}
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, quoteLiteral(DatabasePathPrefix+"/"+name+"/metadata"))
	}
	expected, err := e.rt.Query(ctx, fmt.Sprintf(
		"SELECT path, count() FROM system.zookeeper WHERE path IN (%s) GROUP BY path FORMAT TabSeparatedRaw", strings.Join(paths, ", ")))
	if err != nil {
		return true
	}
	local, err := e.rt.Query(ctx, fmt.Sprintf(
		"SELECT database, count() FROM system.tables WHERE database IN (%s) AND NOT is_temporary GROUP BY database FORMAT TabSeparatedRaw",
		quotedList(names)))
	if err != nil {
		return true
	}
	have := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(local), "\n") {
		if name, count, ok := strings.Cut(line, "\t"); ok {
			have[name], _ = strconv.Atoi(count)
		}
	}
	engines, err := e.databaseEngines(ctx)
	if err != nil {
		return true
	}
	for _, name := range names {
		if engines[name] != "Replicated" {
			return true
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(expected), "\n") {
		path, count, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(path, DatabasePathPrefix+"/"), "/metadata")
		want, _ := strconv.Atoi(count)
		if have[name] < want {
			return true
		}
	}
	return false
}

func quotedList(values []string) string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = quoteLiteral(value)
	}
	return strings.Join(quoted, ", ")
}

// setDatabases are the set's Replicated databases: the configured ones and
// every one registered in Keeper, except those still being converted.
func (e *engine) setDatabases(ctx context.Context, ec EngineConfig) ([]string, error) {
	text, err := e.rt.Query(ctx, fmt.Sprintf("SELECT name FROM system.zookeeper WHERE path = %s FORMAT TabSeparatedRaw",
		quoteLiteral(DatabasePathPrefix)))
	if err != nil && !strings.Contains(err.Error(), "No node") {
		return nil, err
	}
	converting := map[string]bool{}
	for _, name := range ec.ConvertDatabases {
		converting[name] = true
	}
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		if name == "" || seen[name] || converting[name] || !databasePattern.MatchString(name) || reservedDatabase(name) {
			return
		}
		seen[name] = true
		out = append(out, name)
	}
	for _, name := range ec.Databases {
		add(name)
	}
	for _, name := range strings.Fields(text) {
		add(name)
	}
	sort.Strings(out)
	return out, nil
}

// writeRole rewrites the client profile and reloads it in a running engine.
func (e *engine) writeRole(ctx context.Context, writable, running bool) error {
	e.roleGen++
	if err := e.rt.WriteFile(RoleConfigFile, RenderRoleConfig(writable)); err != nil {
		return err
	}
	if running {
		if _, err := e.rt.Query(ctx, "SYSTEM RELOAD CONFIG"); err != nil {
			return err
		}
	}
	return nil
}

// usersConfig renders the default profile and internal user for quorum.
func (e *engine) usersConfig(snap *configSnapshot, quorum int) ([]byte, error) {
	hash, err := e.rt.InternalPasswordSHA256()
	if err != nil {
		return nil, err
	}
	timeout := uint32(policyOf(snap.config).degradeAfter / time.Millisecond)
	return RenderUsersConfig(quorum, timeout, hash), nil
}

// writeIfChanged writes a mount file only when its content differs (every
// write of a config file makes a running ClickHouse reload it).
func (e *engine) writeIfChanged(name string, data []byte) (bool, error) {
	if current, err := e.rt.ReadFile(name); err == nil && bytes.Equal(current, data) {
		return false, nil
	}
	return true, e.rt.WriteFile(name, data)
}

func (e *engine) restQuorum(snap *configSnapshot) int {
	p := policyOf(snap.config)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.certifiedOK && e.certified.Degraded {
		return 1
	}
	return p.wantQuorum()
}

// PrepareStandby writes the standby-at-rest configuration. The client profile
// is set read-only only while the container is stopped: a running holder
// reloads profile files at once, so its next start is covered by Start.
func (e *engine) PrepareStandby(ctx context.Context) error {
	snap, _ := e.refresh()
	state, _, err := e.rt.Container(ctx)
	if err != nil {
		return err
	}
	logEmpty := !e.rt.Exists("coordination/log")
	if _, err := e.writeIfChanged(ServerConfigFile, RenderServerConfig(snap.config, snap.ec, logEmpty)); err != nil {
		return err
	}
	users, err := e.usersConfig(snap, e.restQuorum(snap))
	if err != nil {
		return err
	}
	if !state.Running {
		if _, err := e.writeIfChanged(UsersConfigFile, users); err != nil {
			return err
		}
		e.roleMu.Lock()
		defer e.roleMu.Unlock()
		return e.writeRole(ctx, false, false)
	}
	if !e.rt.Exists(UsersConfigFile) {
		_, err = e.writeIfChanged(UsersConfigFile, users)
	}
	return err
}

// Start starts the container as a copy (client profile read-only first).
func (e *engine) Start(ctx context.Context) error {
	state, _, err := e.rt.Container(ctx)
	if err != nil {
		return err
	}
	if !state.Running {
		e.roleMu.Lock()
		err := e.writeRole(ctx, false, false)
		e.roleMu.Unlock()
		if err != nil {
			return err
		}
	}
	return e.rt.Start(ctx)
}

func (e *engine) StopClean(ctx context.Context, timeout time.Duration) error {
	defer e.fw.close()
	return e.rt.StopClean(ctx, timeout)
}

func (e *engine) Kill(ctx context.Context) error {
	defer e.fw.close()
	return e.rt.Kill(ctx)
}

func (e *engine) CgroupEmpty(ctx context.Context) (bool, error) { return e.rt.CgroupEmpty(ctx) }

// Promote makes the running copy writable under the certified value: the
// insert quorum first, then the client profile, then it waits until the
// engine reports itself writable.
func (e *engine) Promote(ctx context.Context, certified []byte) error {
	snap, _ := e.refresh()
	value, err := DecodeValue(certified)
	if err != nil {
		return err
	}
	quorum := policyOf(snap.config).wantQuorum()
	if value.Degraded || snap.config.Mode == memberha.ModeManual {
		quorum = 1
	}
	if certified != nil {
		e.mu.Lock()
		e.certified, e.certifiedOK = value, true
		e.mu.Unlock()
	}
	users, err := e.usersConfig(snap, quorum)
	if err != nil {
		return err
	}
	if _, err := e.writeIfChanged(UsersConfigFile, users); err != nil {
		return err
	}
	e.roleMu.Lock()
	err = e.writeRole(ctx, true, true)
	e.roleMu.Unlock()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(promoteWait)
	for {
		text, err := e.rt.Query(ctx, statusQuery)
		if err == nil {
			if row, parseErr := parseStatusRow(text); parseErr == nil && row.writable() {
				return nil
			}
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return errors.New("the ClickHouse client profile did not become writable")
		}
		select {
		case <-ctx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// Rejoin: a ClickHouse copy catches up from the Keeper log by itself; a
// member whose databases are missing joins them in the background loop.
func (e *engine) Rejoin(context.Context) error { return nil }

// Switchover stops client writes on the holder and waits until the successor
// has fetched every replication log entry of every replicated table.
func (e *engine) Switchover(ctx context.Context, successorMemberID string) error {
	e.roleMu.Lock()
	err := e.writeRole(ctx, false, true)
	e.roleMu.Unlock()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(switchoverWait)
	for {
		caught, err := e.caughtUp(ctx, successorMemberID)
		if err == nil && caught {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			e.roleMu.Lock()
			restoreErr := e.writeRole(context.Background(), true, true)
			e.roleMu.Unlock()
			if err == nil {
				err = errors.New("the successor did not catch up in time")
			}
			if restoreErr != nil {
				return fmt.Errorf("%w (writes stay stopped: %v)", err, restoreErr)
			}
			return err
		}
		select {
		case <-ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// caughtUp: for every replicated table, the successor's log pointer reached
// the log's end and its queue is empty.
func (e *engine) caughtUp(ctx context.Context, replica string) (bool, error) {
	text, err := e.rt.Query(ctx, "SELECT zookeeper_path, log_max_index FROM system.replicas FORMAT TabSeparatedRaw")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		path, maxIndex, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		base := strings.TrimSuffix(path, "/") + "/replicas/" + replica
		pointer, err := e.rt.Query(ctx, fmt.Sprintf(
			"SELECT value FROM system.zookeeper WHERE path = %s AND name = 'log_pointer' FORMAT TabSeparatedRaw", quoteLiteral(base)))
		if err != nil {
			return false, err
		}
		have, _ := strconv.ParseUint(strings.TrimSpace(pointer), 10, 64)
		want, _ := strconv.ParseUint(strings.TrimSpace(maxIndex), 10, 64)
		if have < want {
			return false, nil
		}
		queue, err := e.rt.Query(ctx, fmt.Sprintf("SELECT count() FROM system.zookeeper WHERE path = %s FORMAT TabSeparatedRaw",
			quoteLiteral(base+"/queue")))
		if err != nil {
			return false, err
		}
		if strings.TrimSpace(queue) != "0" {
			return false, nil
		}
	}
	return true, nil
}

// Eligible is the lease eligibility callback (decision 12).
func (e *engine) Eligible(input memberha.EligibilityInput, status memberha.EngineStatus) (bool, string) {
	snap := e.snapshot.Load()
	value, err := DecodeValue(input.Adopted.Value)
	if err != nil {
		return false, "certified_state_unreadable"
	}
	return eligible(policyOf(snap.config), value, input.Adopted.Holder == snap.config.NodeID, sampleOf(status))
}

func (e *engine) BootstrapValue(status memberha.EngineStatus) ([]byte, error) {
	snap := e.snapshot.Load()
	p := policyOf(snap.config)
	s := sampleOf(status)
	value := Value{Quorum: p.wantQuorum()}
	if p.wantQuorum() > 1 && !s.copiesActive(p) {
		value = Value{Quorum: 1, Degraded: true, DegradedSinceMs: time.Now().UnixMilli()}
	}
	return value.encode()
}

func (e *engine) PromotedValue(certified []byte, _ memberha.EngineStatus) ([]byte, error) {
	value, err := DecodeValue(certified)
	if err != nil {
		return nil, err
	}
	return value.encode()
}

func (e *engine) NextValue(certified []byte, status memberha.EngineStatus, now time.Duration) ([]byte, string, bool, error) {
	snap := e.snapshot.Load()
	value, err := DecodeValue(certified)
	if err != nil {
		return nil, "", false, err
	}
	e.mu.Lock()
	e.certified, e.certifiedOK = value, true
	next, kind, changed := e.tracker.next(policyOf(snap.config), value, sampleOf(status), now, time.Now())
	e.mu.Unlock()
	if !changed {
		return nil, "", false, nil
	}
	encoded, err := next.encode()
	return encoded, kind, err == nil, err
}

// ReleaseTarget names the copy a failed holder hands over to: the first other
// member by priority, unless the set is degraded (no copy has every
// acknowledged insert).
func (e *engine) ReleaseTarget(certified []byte) (string, bool) {
	snap := e.snapshot.Load()
	value, err := DecodeValue(certified)
	if err != nil || (value.Degraded && policyOf(snap.config).synchronous) {
		return "", false
	}
	others := snap.config.Others()
	sort.SliceStable(others, func(i, j int) bool {
		if others[i].Priority != others[j].Priority {
			return others[i].Priority > others[j].Priority
		}
		return others[i].MemberIndex < others[j].MemberIndex
	})
	for _, peer := range others {
		if !peer.Removing {
			return peer.MemberID, true
		}
	}
	return "", false
}

// DialPeer connects an incoming peer tunnel to this member's Keeper raft or
// interserver port on the private bridge.
func (e *engine) DialPeer(ctx context.Context, port string) (net.Conn, error) {
	snap := e.snapshot.Load()
	var target uint32
	switch port {
	case "ch-keeper":
		target = snap.ec.Self().Port
	case "ch-interserver":
		target = snap.ec.InterserverPort(snap.config.MemberID)
	default:
		return nil, fmt.Errorf("ClickHouse members have no peer port %q", port)
	}
	address, err := e.rt.Address(ctx)
	if err != nil {
		return nil, err
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", net.JoinHostPort(address, strconv.FormatUint(uint64(target), 10)))
}

// loop is the member's background work, every loopInterval until the member
// is forgotten.
func (e *engine) loop() {
	ticker := time.NewTicker(loopInterval)
	defer ticker.Stop()
	for range ticker.C {
		snap, ok := e.refresh()
		if !ok {
			e.stopped.Store(true)
			e.fw.close()
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		e.reconcile(ctx, snap)
		cancel()
	}
}

// bootNow is the lease clock (CLOCK_BOOTTIME), the clock NextValue's now is on.
func bootNow() time.Duration { return leasefence.Now() }

var errSkipped = errors.New("skipped this pass")

func keeperFollower(s sample) bool { return s.keeperMode == "follower" }

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

// reconcile runs one pass of the background work.
func (e *engine) reconcile(ctx context.Context, snap *configSnapshot) {
	state, pid, err := e.rt.Container(ctx)
	if err != nil || !state.Running {
		e.fw.close()
		return
	}
	e.fw.ensure(state.ID, pid, desiredForwards(snap.config.MemberID, snap.ec))
	text, err := e.rt.Query(ctx, statusQuery)
	if err != nil {
		return
	}
	row, err := parseStatusRow(text)
	if err != nil {
		return
	}
	now := bootNow()
	e.trackGateway(now)
	e.ensureDatabases(ctx, snap)
	var current map[uint32]string
	e.mu.Lock()
	readConfig := row.writable() || e.lastConfigRead == 0 || now-e.lastConfigRead >= copyKeeperConfigPeriod
	e.mu.Unlock()
	if readConfig {
		current, err = e.keeperConfig(ctx)
	} else {
		err = errSkipped
	}
	if err == nil {
		e.mu.Lock()
		e.lastConfigRead = now
		e.voters = voterList(current)
		for id := range current {
			if _, ok := e.inConfig[id]; !ok {
				e.inConfig[id] = now
			}
		}
		for id := range e.inConfig {
			if _, ok := current[id]; !ok {
				delete(e.inConfig, id)
			}
		}
		e.mu.Unlock()
	}
	if !row.writable() {
		return
	}
	e.requestLeadership(ctx, now)
	e.holderQuorum(ctx, snap, row, now)
	if current != nil {
		e.holderKeeper(ctx, snap, current, now)
	}
	e.holderProfiles(ctx, now)
	e.holderConvert(ctx, snap)
}

func (e *engine) trackGateway(now time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.rt.GatewayConnected() {
		e.gatewayDown = 0
	} else if e.gatewayDown == 0 {
		e.gatewayDown = now
	}
}

// ensureDatabases creates (joins) every Replicated database of the set that
// this member does not have yet.
func (e *engine) ensureDatabases(ctx context.Context, snap *configSnapshot) {
	names, err := e.setDatabases(ctx, snap.ec)
	if err != nil || len(names) == 0 {
		return
	}
	engines, err := e.databaseEngines(ctx)
	if err != nil {
		return
	}
	for _, name := range names {
		switch engines[name] {
		case "Replicated":
			continue
		case "":
			if _, err := e.rt.Query(ctx, createDatabaseSQL(name, name)); err != nil {
				e.logger.Warn("ClickHouse member could not join a Replicated database", "database", name, "error", err)
			}
		default:
			e.logger.Warn("a database of the availability set exists here with another engine; it is left alone",
				"database", name, "engine", engines[name])
		}
	}
}

// holderQuorum keeps the holder's insert quorum in line with the certified
// value (degraded → 1 only after the lease certified it; 2 again before the
// healthy state is certified).
func (e *engine) holderQuorum(ctx context.Context, snap *configSnapshot, row engineRow, now time.Duration) {
	e.mu.Lock()
	value, ok := e.certified, e.certifiedOK
	activeFor := time.Duration(0)
	if e.tracker.activeSince > 0 {
		activeFor = now - e.tracker.activeSince
	}
	s := e.lastSample
	e.mu.Unlock()
	if snap.config.Mode == memberha.ModeManual {
		value, ok = Value{Quorum: 1}, true
	}
	if !ok {
		return
	}
	want := engineQuorum(policyOf(snap.config), value, s, activeFor)
	if snap.config.Mode == memberha.ModeManual {
		want = 1
	}
	if row.quorum == want {
		return
	}
	users, err := e.usersConfig(snap, want)
	if err != nil {
		return
	}
	if changed, err := e.writeIfChanged(UsersConfigFile, users); err == nil && changed {
		_, _ = e.rt.Query(ctx, "SYSTEM RELOAD CONFIG")
		e.logger.Info("ClickHouse holder changed its insert quorum", "set_id", snap.config.SetID, "insert_quorum", want)
	}
}

// keeperConfig reads the Keeper's cluster configuration.
func (e *engine) keeperConfig(ctx context.Context) (map[uint32]string, error) {
	text, err := e.rt.KeeperClient(ctx, keeperConfigCommand)
	if err != nil {
		return nil, err
	}
	return parseKeeperConfig(text)
}

// requestLeadership asks this member's Keeper to become the leader (4lw
// rqld): when Keeper started before the members' forwarders were up, the
// witness can win the first election, and Keeper never hands leadership back
// to a higher priority by itself; a leading witness stalls inserts for ~30 s
// when it dies.
func (e *engine) requestLeadership(ctx context.Context, now time.Duration) {
	e.mu.Lock()
	due := keeperFollower(e.lastSample) && (e.lastRqld == 0 || now-e.lastRqld >= leadershipRequestPeriod)
	if due {
		e.lastRqld = now
	}
	e.mu.Unlock()
	if !due {
		return
	}
	address, err := e.rt.Address(ctx)
	if err != nil {
		return
	}
	answer, err := keeperFourLetter(ctx, net.JoinHostPort(address, strconv.Itoa(KeeperClientPort)), "rqld")
	if err == nil {
		e.logger.Info("ClickHouse holder asked its Keeper to lead", "answer", strings.TrimSpace(answer))
	}
}

// holderKeeper moves the Keeper membership toward the desired voters and,
// while Gateway is down, activates the standby witness when the active one
// is dead (decision 8).
func (e *engine) holderKeeper(ctx context.Context, snap *configSnapshot, current map[uint32]string, now time.Duration) {
	e.mu.Lock()
	act := e.activated
	since := make(map[uint32]time.Duration, len(e.inConfig))
	for id, at := range e.inConfig {
		since[id] = at
	}
	gatewayDown := time.Duration(0)
	if e.gatewayDown > 0 {
		gatewayDown = now - e.gatewayDown
	}
	keeperQuorum := e.lastSample.keeperQuorum
	e.mu.Unlock()
	if act != nil && act.adopted(snap.ec) {
		e.clearActivation()
		act = nil
	}
	if act == nil && gatewayDown >= gatewayDownFor && len(standbys(snap.ec)) > 0 {
		for _, voter := range snap.ec.Voters() {
			if !voter.Witness() {
				continue
			}
			down := e.witnessDownFor(ctx, voter, now)
			if activationDue(gatewayDown, down, keeperQuorum, nil, snap.ec) {
				if next, err := e.activate(ctx, snap, voter); err != nil {
					e.logger.Warn("standby Keeper witness could not be activated", "set_id", snap.config.SetID, "error", err)
				} else {
					act = next
				}
				break
			}
		}
	}
	probe := map[uint32]bool{}
	reachable := func(server KeeperServer) bool {
		if ok, done := probe[server.ID]; done {
			return ok
		}
		ok := e.rt.Probe(ctx, server.Alias()) == nil
		probe[server.ID] = ok
		return ok
	}
	e.mu.Lock()
	settling := e.lastReconfig > 0 && now-e.lastReconfig < reconfigSettle
	e.mu.Unlock()
	if settling {
		// The configuration read may predate the last reconfiguration.
		return
	}
	action, ok := planKeeper(snap.ec.KeeperServerID, current, desiredVoters(snap.ec, act), reachable, since, now)
	if !ok {
		return
	}
	e.mu.Lock()
	e.lastReconfig = now
	e.mu.Unlock()
	output, err := e.rt.KeeperClient(ctx, action.command(snap.ec))
	if err != nil {
		e.logger.Warn("Keeper reconfiguration failed", "set_id", snap.config.SetID, "command", action.command(snap.ec),
			"error", err, "output", strings.TrimSpace(output))
		return
	}
	e.logger.Info("Keeper reconfigured", "set_id", snap.config.SetID, "command", action.command(snap.ec))
}

// witnessDownFor tracks how long an active witness has been unreachable.
func (e *engine) witnessDownFor(ctx context.Context, witness KeeperServer, now time.Duration) time.Duration {
	reachable := e.rt.Probe(ctx, witness.Alias()) == nil
	e.mu.Lock()
	defer e.mu.Unlock()
	if reachable {
		delete(e.witnessDown, witness.ID)
		return 0
	}
	if _, ok := e.witnessDown[witness.ID]; !ok {
		e.witnessDown[witness.ID] = now
	}
	return now - e.witnessDown[witness.ID]
}

// activate asks the standby witness's relay to start it: a holder statement
// over its witness route; on success the activation is persisted and the
// Keeper membership reconcile adds it and removes the dead witness.
func (e *engine) activate(ctx context.Context, snap *configSnapshot, dead KeeperServer) (*activation, error) {
	var lastErr error
	for _, standby := range standbys(snap.ec) {
		request := witnessactivation.Request{
			Version: 1, WitnessID: standby.WitnessID, SetID: snap.config.SetID, LeasePolicyID: snap.config.LeasePolicyID,
			HolderNodeID: snap.config.NodeID, IssuedAtUnixMs: time.Now().UnixMilli(),
		}
		signature, err := e.rt.Sign(witnessactivation.Domain, request.Payload())
		if err != nil {
			return nil, err
		}
		request.Signature = signature
		if err := e.sendActivation(ctx, standby, request); err != nil {
			lastErr = err
			continue
		}
		act := &activation{StandbyID: standby.ID, StandbyWitnessID: standby.WitnessID, ReplacesID: dead.ID,
			ReplacesWitness: dead.WitnessID, AtUnixMs: time.Now().UnixMilli()}
		if err := e.rt.WriteFile(activationFile, mustJSON(act)); err != nil {
			return nil, err
		}
		e.mu.Lock()
		e.activated = act
		e.mu.Unlock()
		e.logger.Warn("Gateway is down and the Keeper witness is dead: standby witness activated by the holder",
			"set_id", snap.config.SetID, "standby_witness_id", standby.WitnessID, "dead_witness_id", dead.WitnessID)
		return act, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no standby witness")
	}
	return nil, lastErr
}

func (e *engine) sendActivation(ctx context.Context, standby KeeperServer, request witnessactivation.Request) error {
	local, remote := net.Pipe()
	defer local.Close()
	done := make(chan error, 1)
	go func() { done <- e.rt.Bridge(remote, standby.Alias()) }()
	deadline := time.Now().Add(activationTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = local.SetDeadline(deadline)
	if err := witnessactivation.Write(local, request); err != nil {
		select {
		case bridgeErr := <-done:
			if bridgeErr != nil {
				return bridgeErr
			}
		default:
		}
		return err
	}
	var response witnessactivation.Response
	if err := witnessactivation.Read(local, &response); err != nil {
		return err
	}
	if !response.OK {
		return fmt.Errorf("the relay refused the activation: %s", response.Error)
	}
	return nil
}

func (e *engine) clearActivation() {
	e.mu.Lock()
	e.activated = nil
	e.mu.Unlock()
	if err := e.rt.WriteFile(activationFile, nil); err != nil {
		e.logger.Warn("could not clear the standby witness activation record", "error", err)
	}
}

// holderProfiles gives every replicated client user the client profile (a
// copy's read-only guard), whatever path created it.
func (e *engine) holderProfiles(ctx context.Context, now time.Duration) {
	e.mu.Lock()
	due := e.lastSweep == 0 || now-e.lastSweep >= profileSweepPeriod
	if due {
		e.lastSweep = now
	}
	e.mu.Unlock()
	if !due {
		return
	}
	text, err := e.rt.Query(ctx, "SELECT name FROM system.users WHERE storage = 'replicated' AND name NOT IN "+
		"(SELECT user_name FROM system.settings_profile_elements WHERE inherit_profile = '"+ClientProfile+"' AND isNotNull(user_name)) FORMAT TabSeparatedRaw")
	if err != nil {
		return
	}
	for _, name := range strings.Fields(text) {
		if _, err := e.rt.Query(ctx, fmt.Sprintf("ALTER USER %s SETTINGS PROFILE '%s'", quoteIdent(name), ClientProfile)); err != nil {
			e.logger.Warn("could not give a ClickHouse user the client profile", "user", name, "error", err)
		}
	}
}

// holderConvert moves the databases named for conversion, holding client
// writes while it runs.
func (e *engine) holderConvert(ctx context.Context, snap *configSnapshot) {
	if len(snap.ec.ConvertDatabases) == 0 {
		return
	}
	engines, err := e.databaseEngines(ctx)
	if err != nil {
		return
	}
	pending := []string{}
	for _, name := range snap.ec.ConvertDatabases {
		if engines[name] != "Replicated" {
			pending = append(pending, name)
		}
	}
	if len(pending) == 0 {
		e.setConvert(fmt.Sprintf("done:%s", snap.ec.ConvertOperationID))
		return
	}
	e.roleMu.Lock()
	defer e.roleMu.Unlock()
	if err := e.writeRole(ctx, false, true); err != nil {
		return
	}
	generation := e.roleGen
	left := []string{}
	var failure error
	for _, name := range pending {
		behind, err := e.convertDatabase(ctx, name)
		if err != nil {
			failure = fmt.Errorf("%s: %w", name, err)
			break
		}
		for _, object := range behind {
			left = append(left, name+"."+object)
		}
	}
	if e.roleGen == generation {
		if err := e.writeRole(context.Background(), true, true); err != nil {
			e.logger.Error("ClickHouse convert could not resume client writes", "set_id", snap.config.SetID, "error", err)
		}
	}
	if failure != nil {
		e.setConvert("error:" + snap.ec.ConvertOperationID + ":" + truncate(failure.Error(), 300))
		e.logger.Warn("ClickHouse convert step failed; it is retried", "set_id", snap.config.SetID, "error", failure)
		return
	}
	status := "done:" + snap.ec.ConvertOperationID
	if len(left) > 0 {
		status += ":kept=" + strings.Join(left, ",")
	}
	e.setConvert(status)
}

func (e *engine) setConvert(status string) {
	e.mu.Lock()
	e.convert = truncate(status, 1000)
	e.mu.Unlock()
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
