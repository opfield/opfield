package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaylocal"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Witness hosting: the relay supervisor runs witness processes for
// availability sets (a ClickHouse Keeper voter of a two-member set). Gateway
// sends the desired set (ApplyWitnesses); the supervisor fetches and verifies
// each artifact, runs it as an unprivileged user with a memory cap, restarts
// it with backoff, updates it with a rollback and reports it. The last applied
// set is kept on disk, so witnesses keep running while Gateway is down.
const (
	// RelayWitnessCapability: this supervisor runs witnesses.
	RelayWitnessCapability = "relay_witness_v1"

	witnessKindKeeper  = "clickhouse_keeper"
	witnessRoleActive  = "active"
	witnessRoleStandby = "standby"

	// Local hosting gate, as reported in RelayRuntimeStatus.witness_hosting.
	WitnessHostingAllowed             = "allowed"
	WitnessHostingProtectedNeedsOptIn = "protected_needs_opt_in"
	WitnessHostingDisabled            = "disabled"

	maxWitnesses = 20
	// Forwarder ports of witness peers (local only, never relay-local).
	witnessForwardPortMin = 39500
	witnessForwardPortMax = 39999
)

var (
	witnessTick = 5 * time.Second
	// witnessHealthyWithin bounds how long a started or updated witness may
	// take to answer its health check; an update that misses it rolls back.
	witnessHealthyWithin = 60 * time.Second
	// witnessStopGrace is the SIGTERM to SIGKILL delay.
	witnessStopGrace = 10 * time.Second
	// witnessBackoffMax caps the restart backoff; a witness that ran healthy
	// for witnessBackoffReset starts again from the shortest delay.
	witnessBackoffMax   = 60 * time.Second
	witnessBackoffReset = 5 * time.Minute
	witnessArtifactGC   = time.Hour
	// witnessFetchRetry is how long a refused or failed fetch is reported
	// before it is tried again (a new ApplyWitnesses retries at once).
	witnessFetchRetry = time.Minute
)

type fetchFailure struct {
	message string
	at      time.Time
}

// Witness states reported to Gateway.
const (
	witnessStateFetching = "fetching"
	witnessStateStaged   = "staged"
	witnessStateStarting = "starting"
	witnessStateRunning  = "running"
	witnessStateUpdating = "updating"
	witnessStateStopped  = "stopped"
	witnessStateError    = "error"
	witnessStateRefused  = "refused"
)

// witnessRuntime is what the manager needs from the host: fetch artifacts,
// start processes, probe health and open relay-originated tunnels. Tests
// replace it.
type witnessRuntime interface {
	fetch(ctx context.Context, artifact *pb.WitnessArtifact) (string, error)
	start(spec witnessLaunch) (witnessProcess, error)
	probe(ctx context.Context, clientPort uint32) (keeperProbe, error)
	forward(ctx context.Context, peer *pb.WitnessPeer) (net.Listener, error)
	gcArtifacts(keep map[string]bool, now time.Time)
}

type witnessLaunch struct {
	id      string
	binary  string
	dataDir string
	runDir  string
	config  []byte
}

type witnessProcess interface {
	// done closes when the process exited.
	done() <-chan struct{}
	exitError() error
	signal(os.Signal) error
	kill() error
}

type keeperProbe struct {
	role string
	zxid uint64
}

type witnessManager struct {
	// dir keeps the desired set; workRoot the witnesses' data and config.
	dir      string
	workRoot string
	logger   *slog.Logger
	gate     func() string
	runtime  witnessRuntime
	now      func() time.Time

	mu        sync.Mutex
	revision  uint64
	desired   map[string]*pb.WitnessSpec
	witnesses map[string]*witnessEntry
	fetching  map[string]bool
	fetched   map[string]string
	fetchErr  map[string]fetchFailure
	lastGC    time.Time
	wake      chan struct{}
	stop      chan struct{}
	stopped   chan struct{}
	started   bool
}

// witnessEntry is the runtime of one witness; guarded by witnessManager.mu.
type witnessEntry struct {
	spec       *pb.WitnessSpec
	state      string
	err        string
	since      time.Time
	keeperRole string
	zxid       uint64
	restarts   uint32

	proc        witnessProcess
	procSHA     string
	procVersion string
	procSpec    *pb.WitnessSpec
	startedAt   time.Time
	healthyAt   time.Time
	forwarders  []net.Listener
	stopping    bool

	// update in progress: the binary to roll back to and the deadline.
	rollbackSHA     string
	rollbackVersion string
	updateDeadline  time.Time
	// failedSHA is an update that was rolled back; it is not retried until
	// Gateway names another artifact.
	failedSHA string

	backoff   time.Duration
	nextStart time.Time
}

func newWitnessManager(dir, workRoot string, logger *slog.Logger, gate func() string, rt witnessRuntime) *witnessManager {
	return &witnessManager{
		dir: dir, workRoot: workRoot, logger: logger, gate: gate, runtime: rt, now: time.Now,
		desired: map[string]*pb.WitnessSpec{}, witnesses: map[string]*witnessEntry{},
		fetching: map[string]bool{}, fetched: map[string]string{}, fetchErr: map[string]fetchFailure{},
		wake: make(chan struct{}, 1), stop: make(chan struct{}), stopped: make(chan struct{}),
	}
}

func (m *witnessManager) desiredPath() string { return filepath.Join(m.dir, "desired.json") }

// load restores the last applied set (witnesses run without Gateway).
func (m *witnessManager) load() error {
	data, err := os.ReadFile(m.desiredPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	command := &pb.ApplyWitnessesCommand{}
	if err := protojson.Unmarshal(data, command); err != nil {
		return fmt.Errorf("decode witness state: %w", err)
	}
	if err := validateWitnesses(command.GetWitnesses()); err != nil {
		return fmt.Errorf("stored witness state: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.setDesiredLocked(command)
	return nil
}

// Apply validates and persists a desired set, then reconciles. An older or
// equal revision changes nothing.
func (m *witnessManager) Apply(command *pb.ApplyWitnessesCommand) (string, error) {
	if err := validateWitnesses(command.GetWitnesses()); err != nil {
		return "", err
	}
	m.mu.Lock()
	if command.GetRevision() <= m.revision && m.revision != 0 {
		revision := m.revision
		m.mu.Unlock()
		return fmt.Sprintf("witness revision %d already applied (current %d)", command.GetRevision(), revision), nil
	}
	m.mu.Unlock()
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return "", err
	}
	encoded, err := protojson.MarshalOptions{Multiline: true}.Marshal(command)
	if err != nil {
		return "", err
	}
	if err := atomicfile.WriteFile(m.desiredPath(), encoded, 0o600); err != nil {
		return "", fmt.Errorf("persist witness state: %w", err)
	}
	m.mu.Lock()
	m.setDesiredLocked(command)
	// A new desired set retries refused fetches at once.
	m.fetchErr = map[string]fetchFailure{}
	m.mu.Unlock()
	m.kick()
	return fmt.Sprintf("witness revision %d applied: %d witnesses", command.GetRevision(), len(command.GetWitnesses())), nil
}

func (m *witnessManager) setDesiredLocked(command *pb.ApplyWitnessesCommand) {
	m.revision = command.GetRevision()
	m.desired = map[string]*pb.WitnessSpec{}
	for _, spec := range command.GetWitnesses() {
		m.desired[spec.GetId()] = proto.Clone(spec).(*pb.WitnessSpec)
	}
}

func (m *witnessManager) kick() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Start runs the reconcile loop until Shutdown.
func (m *witnessManager) Start() {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return
	}
	m.started = true
	m.mu.Unlock()
	go m.loop()
}

func (m *witnessManager) loop() {
	defer close(m.stopped)
	ticker := time.NewTicker(witnessTick)
	defer ticker.Stop()
	for {
		m.reconcile()
		select {
		case <-m.stop:
			m.stopAll()
			return
		case <-ticker.C:
		case <-m.wake:
		}
	}
}

// Shutdown stops every witness (SIGTERM, then SIGKILL after the grace).
func (m *witnessManager) Shutdown() {
	m.mu.Lock()
	started := m.started
	m.mu.Unlock()
	if !started {
		return
	}
	select {
	case <-m.stop:
	default:
		close(m.stop)
	}
	<-m.stopped
}

func (m *witnessManager) stopAll() {
	m.mu.Lock()
	entries := make([]*witnessEntry, 0, len(m.witnesses))
	for _, entry := range m.witnesses {
		entries = append(entries, entry)
	}
	m.mu.Unlock()
	for _, entry := range entries {
		m.stopProcess(entry)
	}
}

// reconcile moves every witness one step toward its desired state. It is the
// only writer of process state.
func (m *witnessManager) reconcile() {
	now := m.now()
	hosting := m.gate()
	m.mu.Lock()
	ids := make([]string, 0, len(m.desired)+len(m.witnesses))
	seen := map[string]bool{}
	for id := range m.desired {
		ids, seen[id] = append(ids, id), true
	}
	for id := range m.witnesses {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		m.reconcileOne(id, hosting, now)
	}
	m.collectGarbage(now)
}

func (m *witnessManager) reconcileOne(id, hosting string, now time.Time) {
	m.mu.Lock()
	spec := m.desired[id]
	entry := m.witnesses[id]
	if entry == nil && spec != nil {
		entry = &witnessEntry{spec: spec, state: witnessStateFetching, since: now}
		m.witnesses[id] = entry
	}
	if spec != nil {
		entry.spec = spec
	}
	m.mu.Unlock()
	m.observeExit(entry, now)

	if spec == nil {
		// Removed from the desired set: stop it and drop its data.
		m.stopProcess(entry)
		_ = os.RemoveAll(m.dataDir(id))
		_ = os.RemoveAll(m.runDir(id))
		m.mu.Lock()
		delete(m.witnesses, id)
		m.mu.Unlock()
		return
	}
	if hosting != WitnessHostingAllowed {
		// Re-checked on every pass: a running witness stops once the local
		// gate closes.
		m.stopProcess(entry)
		m.setState(entry, witnessStateRefused, "witness hosting is not allowed on this relay: "+hosting, now)
		return
	}
	binary, ready := m.artifact(spec.GetArtifact(), now)
	if !ready {
		if failure := m.fetchFailure(spec.GetArtifact()); failure != "" {
			m.setState(entry, witnessStateError, failure, now)
		} else if entry.proc == nil {
			m.setState(entry, witnessStateFetching, "", now)
		}
		// A running witness keeps running on its binary meanwhile.
		if entry.proc != nil {
			m.checkHealth(entry, now)
		}
		return
	}
	config, err := renderKeeperConfig(spec, m.dataDir(id))
	if err != nil {
		m.setState(entry, witnessStateError, err.Error(), now)
		return
	}
	if err := m.stage(id, config); err != nil {
		m.setState(entry, witnessStateError, err.Error(), now)
		return
	}
	if spec.GetRole() == witnessRoleStandby {
		m.stopProcess(entry)
		m.setState(entry, witnessStateStaged, "", now)
		return
	}
	sha := spec.GetArtifact().GetSha256()
	switch {
	case entry.proc == nil:
		if now.Before(entry.nextStart) {
			return
		}
		launchSHA, launchVersion, launchBinary := sha, spec.GetArtifact().GetVersion(), binary
		if sha == entry.failedSHA && entry.rollbackSHA != "" {
			// The named artifact already failed to become healthy: stay on
			// the previous one until Gateway names another.
			if previous, ok := m.artifactBySHA(entry.rollbackSHA); ok {
				launchSHA, launchVersion, launchBinary = entry.rollbackSHA, entry.rollbackVersion, previous
			}
		}
		m.launch(entry, launchSHA, launchVersion, launchBinary, config, now)
	case entry.procSHA != sha && sha != entry.failedSHA && entry.updateDeadline.IsZero():
		// Update: stop, start the new binary, roll back unless it is
		// healthy within witnessHealthyWithin.
		previousSHA, previousVersion := entry.procSHA, entry.procVersion
		m.stopProcess(entry)
		m.launch(entry, sha, spec.GetArtifact().GetVersion(), binary, config, now)
		entry.rollbackSHA, entry.rollbackVersion = previousSHA, previousVersion
		entry.updateDeadline = now.Add(witnessHealthyWithin)
		m.setState(entry, witnessStateUpdating, "", now)
	case !proto.Equal(entry.procSpec, spec) && entry.procSHA == sha && entry.updateDeadline.IsZero():
		// Same binary, new config (peers, ports, server id): restart.
		m.stopProcess(entry)
		m.launch(entry, sha, spec.GetArtifact().GetVersion(), binary, config, now)
	default:
		if sha == entry.procSHA && entry.failedSHA != "" {
			// Gateway named the running artifact again: the failed update
			// is no longer wanted.
			m.mu.Lock()
			entry.failedSHA = ""
			m.mu.Unlock()
		}
		m.checkHealth(entry, now)
	}
}

// observeExit notices a process that ended on its own and schedules the
// restart with backoff; an update whose new binary ends rolls back.
func (m *witnessManager) observeExit(entry *witnessEntry, now time.Time) {
	if entry == nil || entry.proc == nil {
		return
	}
	select {
	case <-entry.proc.done():
	default:
		return
	}
	exitErr := entry.proc.exitError()
	m.closeForwarders(entry)
	entry.proc = nil
	message := "witness process exited"
	if exitErr != nil {
		message += ": " + exitErr.Error()
	}
	if !entry.updateDeadline.IsZero() {
		m.rollback(entry, message, now)
		return
	}
	m.mu.Lock()
	entry.restarts++
	m.mu.Unlock()
	if !entry.healthyAt.IsZero() && now.Sub(entry.healthyAt) >= witnessBackoffReset {
		entry.backoff = 0
	}
	entry.backoff = min(max(time.Second, entry.backoff*2), witnessBackoffMax)
	entry.nextStart = now.Add(entry.backoff)
	entry.healthyAt = time.Time{}
	m.setState(entry, witnessStateError, message, now)
	m.logWarn("witness exited; restarting with backoff", "witness", entry.spec.GetId(), "backoff", entry.backoff, "error", exitErr)
}

func (m *witnessManager) rollback(entry *witnessEntry, reason string, now time.Time) {
	failed := entry.procSHA
	m.stopProcess(entry)
	entry.failedSHA = failed
	entry.updateDeadline = time.Time{}
	message := fmt.Sprintf("update to %s failed (%s); rolled back to %s", entry.spec.GetArtifact().GetVersion(), reason, entry.rollbackVersion)
	binary, ok := m.artifactBySHA(entry.rollbackSHA)
	if !ok || entry.rollbackSHA == "" {
		m.setState(entry, witnessStateError, message+": previous binary is gone", now)
		return
	}
	config, err := renderKeeperConfig(entry.spec, m.dataDir(entry.spec.GetId()))
	if err == nil {
		err = m.stage(entry.spec.GetId(), config)
	}
	if err != nil {
		m.setState(entry, witnessStateError, message+": "+err.Error(), now)
		return
	}
	m.launch(entry, entry.rollbackSHA, entry.rollbackVersion, binary, config, now)
	m.mu.Lock()
	entry.err = message
	m.mu.Unlock()
	m.logWarn("witness update rolled back", "witness", entry.spec.GetId(), "reason", reason)
}

func (m *witnessManager) launch(entry *witnessEntry, sha, version, binary string, config []byte, now time.Time) {
	id := entry.spec.GetId()
	forwarders, err := m.startForwarders(entry.spec)
	if err != nil {
		m.scheduleRetry(entry, "witness peer forwarders: "+err.Error(), now)
		return
	}
	proc, err := m.runtime.start(witnessLaunch{id: id, binary: binary, dataDir: m.dataDir(id), runDir: m.runDir(id), config: config})
	if err != nil {
		for _, listener := range forwarders {
			_ = listener.Close()
		}
		m.scheduleRetry(entry, "start witness: "+err.Error(), now)
		return
	}
	m.mu.Lock()
	entry.proc, entry.procSHA, entry.procVersion, entry.procSpec = proc, sha, version, proto.Clone(entry.spec).(*pb.WitnessSpec)
	entry.forwarders, entry.startedAt, entry.healthyAt = forwarders, now, time.Time{}
	entry.keeperRole, entry.zxid = "", 0
	m.mu.Unlock()
	m.setState(entry, witnessStateStarting, entry.err, now)
	go func() {
		<-proc.done()
		m.kick()
	}()
}

func (m *witnessManager) scheduleRetry(entry *witnessEntry, message string, now time.Time) {
	entry.backoff = min(max(time.Second, entry.backoff*2), witnessBackoffMax)
	entry.nextStart = now.Add(entry.backoff)
	m.setState(entry, witnessStateError, message, now)
}

func (m *witnessManager) checkHealth(entry *witnessEntry, now time.Time) {
	if entry.proc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	probe, err := m.runtime.probe(ctx, entry.procSpec.GetClientPort())
	cancel()
	if err == nil {
		m.mu.Lock()
		entry.keeperRole, entry.zxid = probe.role, probe.zxid
		if entry.healthyAt.IsZero() {
			entry.healthyAt = now
		}
		if !entry.updateDeadline.IsZero() {
			// The update is healthy: nothing to roll back to any more.
			entry.updateDeadline, entry.failedSHA = time.Time{}, ""
		}
		// The running binary is the one a later update rolls back to.
		entry.rollbackSHA, entry.rollbackVersion = entry.procSHA, entry.procVersion
		message := ""
		if entry.failedSHA != "" {
			// Keep why the named artifact is not running visible.
			message = entry.err
		}
		m.mu.Unlock()
		m.setState(entry, witnessStateRunning, message, now)
		return
	}
	if !entry.updateDeadline.IsZero() {
		if !now.Before(entry.updateDeadline) {
			m.rollback(entry, "not healthy within "+witnessHealthyWithin.String(), now)
		}
		return
	}
	if entry.healthyAt.IsZero() && now.Sub(entry.startedAt) >= witnessHealthyWithin {
		m.setState(entry, witnessStateError, "witness does not answer its health check: "+err.Error(), now)
	}
}

// stopProcess ends a witness: SIGTERM, then SIGKILL after the grace.
func (m *witnessManager) stopProcess(entry *witnessEntry) {
	if entry == nil {
		return
	}
	m.closeForwarders(entry)
	proc := entry.proc
	if proc == nil {
		return
	}
	_ = proc.signal(sigterm)
	select {
	case <-proc.done():
	case <-time.After(witnessStopGrace):
		_ = proc.kill()
		<-proc.done()
	}
	m.mu.Lock()
	entry.proc = nil
	entry.keeperRole, entry.zxid = "", 0
	m.mu.Unlock()
	m.setState(entry, witnessStateStopped, entry.err, m.now())
}

func (m *witnessManager) closeForwarders(entry *witnessEntry) {
	m.mu.Lock()
	forwarders := entry.forwarders
	entry.forwarders = nil
	m.mu.Unlock()
	for _, listener := range forwarders {
		_ = listener.Close()
	}
}

func (m *witnessManager) startForwarders(spec *pb.WitnessSpec) ([]net.Listener, error) {
	listeners := make([]net.Listener, 0, len(spec.GetPeers()))
	for _, peer := range spec.GetPeers() {
		listener, err := m.runtime.forward(context.Background(), peer)
		if err != nil {
			for _, open := range listeners {
				_ = open.Close()
			}
			return nil, fmt.Errorf("peer %d: %w", peer.GetServerId(), err)
		}
		listeners = append(listeners, listener)
	}
	return listeners, nil
}

func (m *witnessManager) setState(entry *witnessEntry, state, message string, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.state != state {
		entry.since = now
	}
	entry.state, entry.err = state, message
}

// artifact returns the verified binary of an artifact, starting its fetch
// when it is not there yet.
func (m *witnessManager) artifact(artifact *pb.WitnessArtifact, now time.Time) (string, bool) {
	sha := artifact.GetSha256()
	m.mu.Lock()
	defer m.mu.Unlock()
	if path, ok := m.fetched[sha]; ok {
		return path, true
	}
	if m.fetching[sha] {
		return "", false
	}
	if failure, failed := m.fetchErr[sha]; failed {
		if now.Sub(failure.at) < witnessFetchRetry {
			return "", false
		}
		delete(m.fetchErr, sha)
	}
	m.fetching[sha] = true
	clone := proto.Clone(artifact).(*pb.WitnessArtifact)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		path, err := m.runtime.fetch(ctx, clone)
		cancel()
		m.mu.Lock()
		delete(m.fetching, sha)
		if err != nil {
			m.fetchErr[sha] = fetchFailure{message: "fetch witness artifact " + clone.GetVersion() + ": " + err.Error(), at: m.now()}
		} else {
			m.fetched[sha] = path
		}
		m.mu.Unlock()
		if err != nil {
			m.logWarn("witness artifact refused", "version", clone.GetVersion(), "sha256", sha, "error", err)
		}
		m.kick()
	}()
	return "", false
}

func (m *witnessManager) fetchFailure(artifact *pb.WitnessArtifact) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.fetchErr[artifact.GetSha256()].message
}

func (m *witnessManager) artifactBySHA(sha string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	path, ok := m.fetched[sha]
	return path, ok
}

// collectGarbage drops artifacts no witness uses, unused for 7 days.
func (m *witnessManager) collectGarbage(now time.Time) {
	m.mu.Lock()
	if now.Sub(m.lastGC) < witnessArtifactGC {
		m.mu.Unlock()
		return
	}
	m.lastGC = now
	keep := map[string]bool{}
	for _, spec := range m.desired {
		keep[spec.GetArtifact().GetSha256()] = true
	}
	for _, entry := range m.witnesses {
		keep[entry.procSHA], keep[entry.rollbackSHA] = true, true
	}
	m.mu.Unlock()
	m.runtime.gcArtifacts(keep, now)
}

// stage writes a witness's config, so a standby is ready to start.
func (m *witnessManager) stage(id string, config []byte) error {
	if err := os.MkdirAll(m.runDir(id), 0o750); err != nil {
		return err
	}
	path := filepath.Join(m.runDir(id), "keeper.xml")
	if current, err := os.ReadFile(path); err == nil && string(current) == string(config) {
		return nil
	}
	return os.WriteFile(path, config, 0o640)
}

func (m *witnessManager) dataDir(id string) string { return filepath.Join(m.workRoot, "data", id) }
func (m *witnessManager) runDir(id string) string  { return filepath.Join(m.workRoot, "run", id) }

func (m *witnessManager) logWarn(message string, args ...any) {
	if m.logger != nil {
		m.logger.Warn(message, args...)
	}
}

// validateWitnesses refuses a desired set the supervisor would not run as
// given: unknown kinds, ports outside their ranges or used twice, peers that
// are not loopback, too many witnesses.
func validateWitnesses(specs []*pb.WitnessSpec) error {
	if len(specs) > maxWitnesses {
		return fmt.Errorf("at most %d witnesses per relay, got %d", maxWitnesses, len(specs))
	}
	ids := map[string]bool{}
	ports := map[string]string{}
	use := func(address, owner string) error {
		if other, taken := ports[address]; taken {
			return fmt.Errorf("%s and %s both use %s", other, owner, address)
		}
		ports[address] = owner
		return nil
	}
	for _, spec := range specs {
		id := spec.GetId()
		if !validWitnessID(id) || ids[id] {
			return fmt.Errorf("witness id %q is invalid or repeated", id)
		}
		ids[id] = true
		if spec.GetKind() != witnessKindKeeper {
			return fmt.Errorf("witness %s: unknown kind %q", id, spec.GetKind())
		}
		if spec.GetRole() != witnessRoleActive && spec.GetRole() != witnessRoleStandby {
			return fmt.Errorf("witness %s: unknown role %q", id, spec.GetRole())
		}
		artifact := spec.GetArtifact()
		if artifact == nil || !validSHA256(artifact.GetSha256()) || artifact.GetDownloadUrl() == "" || artifact.GetSignedManifest() == "" || artifact.GetComponent() == "" {
			return fmt.Errorf("witness %s: artifact is incomplete", id)
		}
		if spec.GetServerId() == 0 {
			return fmt.Errorf("witness %s: server id is required", id)
		}
		for _, port := range []uint32{spec.GetClientPort(), spec.GetRaftPort()} {
			if _, err := relaylocal.Target(port); err != nil {
				return fmt.Errorf("witness %s: %w", id, err)
			}
			if err := use(fmt.Sprintf("127.0.0.1:%d", port), id); err != nil {
				return err
			}
		}
		if spec.GetClientPort() == spec.GetRaftPort() {
			return fmt.Errorf("witness %s: client and raft ports are the same", id)
		}
		if host := spec.GetRaftHost(); host != "" && !loopbackIPv4(host) {
			return fmt.Errorf("witness %s: raft host %q is not a loopback address", id, host)
		}
		servers := map[uint32]bool{spec.GetServerId(): true}
		for _, peer := range spec.GetPeers() {
			if peer.GetServerId() == 0 || servers[peer.GetServerId()] {
				return fmt.Errorf("witness %s: peer server id %d is invalid or repeated", id, peer.GetServerId())
			}
			servers[peer.GetServerId()] = true
			if !loopbackIPv4(peer.GetHost()) {
				return fmt.Errorf("witness %s: peer host %q is not a loopback address", id, peer.GetHost())
			}
			if peer.GetPort() < witnessForwardPortMin || peer.GetPort() > witnessForwardPortMax {
				return fmt.Errorf("witness %s: peer port %d is outside %d-%d", id, peer.GetPort(), witnessForwardPortMin, witnessForwardPortMax)
			}
			if peer.GetRouteId() == "" {
				return fmt.Errorf("witness %s: peer %d has no route", id, peer.GetServerId())
			}
			if err := use(net.JoinHostPort(peer.GetHost(), fmt.Sprint(peer.GetPort())), id); err != nil {
				return err
			}
		}
	}
	return nil
}

func validWitnessID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

func loopbackIPv4(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.To4() != nil && ip.IsLoopback()
}

// witnessHosting is the local gate (decision 9). A protected relay hosts
// witnesses only with its owner's opt-in (protected.allow_database_witness,
// fixed for the process life); a host the supervisor cannot run witnesses on
// reports disabled.
func (p *Plugin) witnessHosting() string {
	if runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return WitnessHostingDisabled
	}
	if p.cfg.Protected.Enabled && !p.cfg.Protected.AllowDatabaseWitness {
		return WitnessHostingProtectedNeedsOptIn
	}
	return WitnessHostingAllowed
}
