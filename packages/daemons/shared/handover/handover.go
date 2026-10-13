// Package handover hands a daemon's live connections to its next process when
// it exits for an update (live handover, LH): the relay stream sessions
// (relayresume) it carries for local sockets, and the node-local link
// connections it copies between two local sockets.
//
// Before the process exits, every bridge stops at a point where each byte is
// either in its session or in the local socket (the stream freezes: the
// session hands the bridge nothing more and takes whatever it read). The local
// sockets go to the launcher's keeper (listenerkeep, as "conn/<n>"), and the
// sessions' state goes along in a sealed memory file ("state/handover"). The
// next process takes the snapshot once, before it registers anything with the
// relays, takes the sockets, drops the keeper's copies at once, and carries
// the streams on: a source resumes on a new path, a target waits for its
// source's RESUME, as after the loss of a path. For the peer and the local
// socket, the update is a pause.
//
// The handover commits when the snapshot reached the keeper; until then every
// bridge thaws and carries on in this process if anything fails, and the
// daemon drains as before. Once committed the old process never touches a
// handed over stream again, so a stream is carried by exactly one process: a
// crash of the next one before it took the snapshot leaves it to the rolled
// back binary; one after it cuts the streams, but never duplicates or loses a
// byte.
//
// What is not handed over is cut as before: raw streams of peers without
// RSv1, connections whose bytes the daemon itself transforms (TLS), a stream
// still in its handshake, and what does not fit the keeper (MaxConnections).
// An update that restarts the whole service for a newer launcher (one whose
// launcher predates self-update, lifecycle.ServiceRestartPending) hands
// nothing over: the launcher and what it keeps stop too.
package handover

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Capability is advertised by daemons whose update hands connections over.
const Capability = "daemon_stream_handover_v1"

const (
	// connPrefix and stateName name what a handover keeps in the launcher.
	connPrefix = "conn/"
	stateName  = "state/handover"

	// DefaultFreezeWait bounds how long the bridges get to stop at a safe
	// point (a write to a slow local socket, a stream still in its handshake).
	DefaultFreezeWait = time.Second
	// flushWait bounds the wait for the launcher to take every message.
	flushWait = 3 * time.Second
	// MaxSnapshotAge is the oldest snapshot a process takes over: its streams'
	// peers gave up after relayresume.TargetSuspendTimeout.
	MaxSnapshotAge = relayresume.TargetSuspendTimeout + 10*time.Second
	// maxSnapshotBytes bounds the snapshot: the window budget of the
	// process's streams, with room for the bytes in flight.
	maxSnapshotBytes = 2*relayresume.DefaultProcessBudget + 64<<20
	// snapshotReserve is the part of maxSnapshotBytes kept for what is not a
	// connection's bytes: the tombstones and the header.
	snapshotReserve = 32 << 20
)

// snapshotItemBytes bounds the connections' part of a snapshot (a variable for
// the tests). A stream's state holds up to its window of unacked bytes and its
// peer's window of received ones (32 MiB each with the window extension), and
// the next process refuses a snapshot over maxSnapshotBytes as a whole.
var snapshotItemBytes = maxSnapshotBytes - snapshotReserve

// Cut classes of connections a handover leaves out.
const (
	CutBusy       = "busy"        // did not stop at a safe point in time
	CutHandshake  = "handshake"   // its stream had no HELLO_ACK yet
	CutOverLimit  = "over_limit"  // beyond what the keeper or the snapshot can pass on
	CutNoSocket   = "no_socket"   // the daemon transforms its bytes (TLS)
	CutKeepFailed = "keep_failed" // the keeper did not take its socket
	CutNoHandover = "no_handover" // the update did not hand over at all
	// CutServiceRestart: the update restarted the whole service, launcher
	// included (a launcher that predates self-update): what the launcher
	// keeps stops with it, so the update hands nothing over.
	CutServiceRestart = "service_restart"
	// CutResumeFailed: handed over, but its stream did not resume in the
	// next process (no path within the budget, the peer refused it, or its
	// socket did not come over).
	CutResumeFailed = "resume_failed"
	// CutRevoked: handed over, but its route was revoked meanwhile.
	CutRevoked = "revoked"
	// CutLocalClosed: handed over, and its stream resumed or could have, but
	// its local connection ended before the stream resumed in the next
	// process, or failed before the update's counts were final: what the
	// stream carried did not reach it, so the update did not keep it.
	CutLocalClosed = "local_closed"
	// CutUncounted: an update that handed nothing over cut every connection
	// of the daemon, but the process that stopped (2.11.4-rc.7 or earlier)
	// counted only what was still open after its drain had closed the rest:
	// the number is a lower bound, "all connections of this node".
	CutUncounted = "uncounted"
	// CutOpenInFlight: a connection whose setup (its relay stream's open, a
	// peer's stream not bridged yet) did not end within the handover's wait
	// for it (Registry.Setup): the exit cuts it.
	CutOpenInFlight = "open_in_flight"
)

// item is a bridge or a pipe.
type item interface {
	freeze()
	thaw()
	handedOver()
	quiescent() (quiet, ok bool)
	// pinned: never handed over (it stays, and is cut, with this process).
	pinned() bool
}

type registryState int

const (
	stateRunning registryState = iota
	stateFreezing
	stateHandedOver
)

// Registry tracks the connections a daemon can hand over.
type Registry struct {
	mu    sync.Mutex
	items map[item]struct{}
	state registryState
	// handed are the items the last handover passed on, until they returned.
	handed map[item]bool
	// notHandedOver is the class an exit cuts what no handover left out
	// under (no_handover when empty).
	notHandedOver string
	// tracker hears of the local connections of handed over streams that
	// ended (Observe).
	tracker *Tracker
	// setups counts the connections being set up for the registry (Setup).
	// A bridge's registration ends its setup under mu (add), so a count taken
	// under mu sees the connection once: registered or still being set up.
	setups atomic.Int64
}

// setupWait bounds how long a handover waits for the connections being set
// up (a variable for tests). It stays below the relays' grace for a
// restarting endpoint (relay broker.EndpointRestartGrace, 15 s), so the next
// process registers again within it, and above the longest relay open of a
// source (docker relaySourceOpenBudget and the nginx daemon's restart hold,
// 8 s), so an open in flight ends on its own within it.
var setupWait = 10 * time.Second

// Setup marks a connection that is being set up and will be carried by the
// registry: a stream a peer opened, accepted and not bridged yet, or a client
// connection whose relay stream is still being opened. A handover first waits
// for it, at most setupWait, so it goes along instead of starting in a
// process that is exiting, where the exit cuts it (stand rc.13 O-a: a peer
// updated in the same batch opened streams to this node as it handed over).
// The daemon stops taking new connections before (its listeners went to the
// next process); the connections it carries keep moving during the wait, the
// freeze comes after. One still being set up when the wait ends is cut by
// the exit (CutOpenInFlight). An open that failed is no cut of this node:
// the client got its refusal as without an update. The returned func ends
// the setup: pass it as BridgeConfig.Started, and call it when the setup
// failed or the connection is carried another way. Calls after the first do
// nothing.
func (r *Registry) Setup() func() {
	if r == nil {
		return func() {}
	}
	r.setups.Add(1)
	var once sync.Once
	return func() {
		once.Do(func() { r.setups.Add(-1) })
	}
}

// SettingUp counts the connections being set up now (Setup).
func (r *Registry) SettingUp() int {
	if r == nil {
		return 0
	}
	return int(r.setups.Load())
}

// waitSetups waits, at most timeout, until no connection is being set up,
// and reports how many were being set up and how many still are.
func (r *Registry) waitSetups(timeout time.Duration) (awaited, left int) {
	deadline := time.Now().Add(timeout)
	awaited = int(r.setups.Load())
	for {
		left = int(r.setups.Load())
		if left <= 0 || time.Now().After(deadline) {
			return awaited, max(left, 0)
		}
		time.Sleep(time.Millisecond)
	}
}

// Observe tells tracker when the local connection of a stream it follows ends
// (Tracker.Track): one that ends before its stream resumed is cut, not kept.
func (r *Registry) Observe(tracker *Tracker) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.tracker = tracker
	r.mu.Unlock()
}

// localEnded passes the end of a bridge's local connection on to the tracker:
// err nil for its end of stream.
func (r *Registry) localEnded(session *relayresume.Session, err error) {
	if r == nil {
		return
	}
	r.mu.Lock()
	tracker := r.tracker
	r.mu.Unlock()
	tracker.localEnded(session, err)
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{items: map[item]struct{}{}}
}

// add registers an item and returns its removal. An item that starts while a
// handover collects starts frozen: it moved no byte yet, and goes along.
// started, if set, ends the item's setup (Setup) with its registration.
func (r *Registry) add(it item, started func()) func() {
	r.mu.Lock()
	r.items[it] = struct{}{}
	if started != nil {
		started()
	}
	freezing := r.state == stateFreezing
	r.mu.Unlock()
	if freezing && !it.pinned() {
		it.freeze()
	}
	return func() {
		r.mu.Lock()
		delete(r.items, it)
		r.mu.Unlock()
	}
}

func (r *Registry) snapshotItems() []item {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]item, 0, len(r.items))
	for it := range r.items {
		items = append(items, it)
	}
	return items
}

// Options configure a handover.
type Options struct {
	DaemonType string
	Version    string
	// Tables are the process's target tables: once committed, a RESUME that
	// reaches this process is dropped without an answer (the next one
	// answers it).
	Tables []*relayresume.TargetTable
	// FreezeWait: DefaultFreezeWait when 0.
	FreezeWait time.Duration
	Logger     *slog.Logger
	// Keeper: LauncherKeeper when nil.
	Keeper Keeper
	// Repeatable lets a later handover take what this one left, or all of it
	// when it did not commit (the secure-link connector, which carries on what
	// it could not pass on). A daemon hands over once, as it exits.
	Repeatable bool
}

// Result is what a handover did.
type Result struct {
	// Committed: the snapshot reached the keeper; the next process carries
	// the HandedOver connections.
	Committed  bool
	HandedOver int
	// Cut counts the connections left out, by class: the daemon's drain ends
	// them as before.
	Cut map[string]int
	// StartedAt is when the bridges began to stop.
	StartedAt time.Time
	// SetupsAwaited counts the connections being set up when the handover
	// began, SetupsLeft those still being set up when its wait for them
	// (SetupWait) ended (Setup).
	SetupsAwaited, SetupsLeft int
	SetupWait                 time.Duration
	Err                       error
}

// SetupAttrs are the log attributes of the handover's wait for the
// connections being set up (none when there were none).
func (r Result) SetupAttrs() []any {
	if r.SetupsAwaited == 0 {
		return nil
	}
	return []any{"opens_awaited", r.SetupsAwaited, "open_in_flight", r.SetupsLeft, "opens_waited",
		r.SetupWait.Round(time.Millisecond).String()}
}

// errNoKeeper: the running launcher has no keeper (it started before it had
// one and was not restarted since): the update cuts as before.
var errNoKeeper = errors.New("handover: the launcher keeps no connections")

// ErrServiceRestart: the update restarts the whole service, launcher included
// (a launcher that predates self-update), so nothing the launcher keeps
// reaches the next process: the update cuts as before, once.
var ErrServiceRestart = errors.New("handover: the update restarts the whole service for a newer launcher")

// serviceRestartPending tells an update that restarts the whole service, and
// serviceRestartExpected one an update now would restart (the health report's
// preview); both are replaced in tests.
var (
	serviceRestartPending  = lifecycle.ServiceRestartPending
	serviceRestartExpected = lifecycle.ServiceRestartExpected
)

// HandsOverNow reports whether the update this process exits for hands
// connections over through keeper.
func HandsOverNow(keeper Keeper) bool { return !serviceRestartPending() && keeper.HandsOver() }

// Preview tells whether an update now would hand connections over through
// keeper, and else the class it would cut them under: service_restart when it
// would restart the whole service, no_handover without a keeper.
func Preview(keeper Keeper) (available bool, notHandedOver string) {
	switch {
	case serviceRestartExpected():
		return false, CutServiceRestart
	case !keeper.HandsOver():
		return false, CutNoHandover
	}
	return true, ""
}

// Available reports whether an update now hands connections over.
func Available() bool {
	available, _ := Preview(LauncherKeeper)
	return available
}

type candidate struct {
	it       item
	snapshot SnapshotItem
	files    int
}

// HandOver stops every connection of the registry and hands the ones that
// stopped at a safe point to the next process. On success the handed over
// bridges and pipes return ErrHandedOver; the others thawed and carry on, for
// the daemon's drain. On failure (no keeper, the snapshot could not be kept)
// everything thawed and Result.Err says why.
func (r *Registry) HandOver(opts Options) Result {
	result := Result{Cut: map[string]int{}, StartedAt: time.Now()}
	if r == nil {
		result.Err = errNoKeeper
		return result
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	keeper := opts.Keeper
	if keeper == nil {
		keeper = LauncherKeeper
	}
	if serviceRestartPending() {
		r.mu.Lock()
		r.notHandedOver = CutServiceRestart
		r.mu.Unlock()
		result.Err = ErrServiceRestart
		return result
	}
	if !keeper.HandsOver() {
		result.Err = errNoKeeper
		return result
	}
	waitStarted := time.Now()
	result.SetupsAwaited, result.SetupsLeft = r.waitSetups(setupWait)
	result.SetupWait = time.Since(waitStarted)
	result.StartedAt = time.Now()
	r.mu.Lock()
	if r.state != stateRunning {
		r.mu.Unlock()
		result.Err = errors.New("handover: already handed over")
		return result
	}
	r.state = stateFreezing
	r.mu.Unlock()
	for _, it := range r.snapshotItems() {
		if !it.pinned() {
			it.freeze()
		}
	}
	wait := opts.FreezeWait
	if wait <= 0 {
		wait = DefaultFreezeWait
	}
	deadline := time.Now().Add(wait)
	for {
		stopped := true
		for _, it := range r.snapshotItems() {
			if it.pinned() {
				continue
			}
			quiet, ok := it.quiescent()
			if ok && (!quiet || inHandshake(it)) {
				stopped = false
				break
			}
		}
		if stopped || time.Now().After(deadline) {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	// The streams stopped carrying local bytes when the freeze began.
	frozenAt := result.StartedAt
	candidates, excluded := r.collect(frozenAt, result.Cut)
	kept, snapshot := keepSockets(keeper, candidates, result.Cut, opts, frozenAt)
	for _, table := range opts.Tables {
		if table != nil {
			snapshot.Tombstones = append(snapshot.Tombstones, table.HandoverTombstones()...)
		}
	}
	commit := len(kept) > 0
	if commit {
		data := snapshot.Encode()
		file, err := sealedFile(data)
		if err == nil {
			err = keeper.Keep(stateName, file)
			_ = file.Close()
		}
		if err != nil {
			commit = false
			result.Err = fmt.Errorf("keep the handover snapshot: %w", err)
			for _, c := range kept {
				for _, name := range c.snapshot.Conns {
					_ = keeper.Drop(name)
				}
				setExcluded(c.it, CutKeepFailed)
				result.Cut[CutKeepFailed]++
			}
		}
	}
	if commit {
		// Committed: the next process carries these connections.
		if err := keeper.Flush(flushWait); err != nil {
			logger.Warn("the launcher did not take the handed over connections in time; the next process may cut some", "error", err)
		}
		for _, table := range opts.Tables {
			if table != nil {
				table.HandOver()
			}
		}
		r.mu.Lock()
		r.handed = map[item]bool{}
		for _, c := range kept {
			r.handed[c.it] = true
		}
		r.mu.Unlock()
		for _, c := range kept {
			c.it.handedOver()
		}
		result.Committed, result.HandedOver = true, len(kept)
	} else {
		excluded = append(excluded, itemsOf(kept)...)
	}
	r.mu.Lock()
	r.state = stateHandedOver
	if opts.Repeatable {
		r.state = stateRunning
	}
	r.mu.Unlock()
	// Everything not handed over carries on here for the daemon's drain,
	// including what started meanwhile.
	handed := map[item]bool{}
	if commit {
		for _, c := range kept {
			handed[c.it] = true
		}
	}
	for _, it := range r.snapshotItems() {
		if !handed[it] {
			it.thaw()
		}
	}
	for _, it := range excluded {
		if !handed[it] {
			it.thaw()
		}
	}
	return result
}

// WaitHandedOver waits, at most timeout, until every bridge and pipe the last
// handover passed on returned: what the daemon drains afterwards is only what
// it still carries.
func (r *Registry) WaitHandedOver(timeout time.Duration) {
	if r == nil {
		return
	}
	deadline := time.Now().Add(timeout)
	for {
		r.mu.Lock()
		waiting := 0
		for it := range r.handed {
			if _, live := r.items[it]; live {
				waiting++
			}
		}
		r.mu.Unlock()
		if waiting == 0 || time.Now().After(deadline) {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func itemsOf(candidates []candidate) []item {
	items := make([]item, 0, len(candidates))
	for _, c := range candidates {
		items = append(items, c.it)
	}
	return items
}

// inHandshake reports a bridge whose stream has no HELLO_ACK yet: it cannot be
// handed over until it has.
func inHandshake(it item) bool {
	bridge, ok := it.(*Bridge)
	return ok && bridge.session.State() == relayresume.StateHandshake
}

// collect reads out every item that stopped at a safe point, and counts the
// others by why they are left out.
func (r *Registry) collect(frozenAt time.Time, cut map[string]int) ([]candidate, []item) {
	var candidates []candidate
	var excluded []item
	for _, it := range r.snapshotItems() {
		leave := func(class string) {
			excluded = append(excluded, it)
			setExcluded(it, class)
			cut[class]++
		}
		if bridge, ok := it.(*Bridge); ok && bridge.pinned() {
			leave(bridge.cutClass())
			continue
		}
		if pipe, ok := it.(*Pipe); ok && pipe.pinned() {
			leave(CutNoSocket)
			continue
		}
		quiet, ok := it.quiescent()
		if !ok {
			continue // ending on its own
		}
		if !quiet {
			leave(CutBusy)
			continue
		}
		switch current := it.(type) {
		case *Bridge:
			state, err := current.session.HandoverState(frozenAt)
			if err != nil {
				switch current.session.State() {
				case relayresume.StateHandshake:
					leave(CutHandshake)
				default:
					excluded = append(excluded, it) // ended meanwhile
				}
				continue
			}
			candidates = append(candidates, candidate{it: it, files: 1, snapshot: SnapshotItem{Kind: KindSession,
				Labels: current.cfg.Labels, Session: relayresume.AppendSessionState(nil, state)}})
		case *Pipe:
			done := current.stop.ended()
			labels := current.cfg.Labels
			if current.cfg.SnapshotLabels != nil {
				labels = Labels{}
				for key, value := range current.cfg.Labels {
					labels[key] = value
				}
				for key, value := range current.cfg.SnapshotLabels() {
					labels[key] = value
				}
			}
			snapshot := SnapshotItem{Kind: KindPipe, Labels: labels, Done: done}
			for d := range current.pending {
				snapshot.Pending[d] = append([]byte(nil), current.pending[d]...)
			}
			candidates = append(candidates, candidate{it: it, files: 2, snapshot: snapshot})
		}
	}
	// A stable order: the keeper names follow it.
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].files < candidates[j].files })
	return candidates, excluded
}

// keepSockets hands each candidate's sockets to the keeper, as far as the
// keeper can pass them on, and builds the snapshot of the ones it took.
func keepSockets(keeper Keeper, candidates []candidate, cut map[string]int, opts Options, frozenAt time.Time) ([]candidate, *Snapshot) {
	snapshot := &Snapshot{DaemonType: opts.DaemonType, FromVersion: opts.Version, CreatedAt: frozenAt}
	budget := listenerkeep.MaxEnvBytes - keeper.EnvBytes([]string{stateName})
	if unbounded, ok := keeper.(UnboundedKeeper); ok && unbounded.Unbounded() {
		budget = math.MaxInt
	}
	bytes := snapshotItemBytes
	var kept []candidate
	next := 1
	for index, c := range candidates {
		size := c.snapshot.sizeEstimate()
		if size > bytes {
			// Over what the next process reads: this one carries it on, the
			// others still go.
			cut[CutOverLimit]++
			setExcluded(c.it, CutOverLimit)
			c.it.thaw()
			continue
		}
		names := make([]string, c.files)
		cost := 0
		for i := range names {
			names[i] = connPrefix + strconv.Itoa(next+i)
			cost += listenerkeep.EnvEntryBytes(names[i])
		}
		if cost > budget {
			cut[CutOverLimit] += len(candidates) - index
			for _, rest := range candidates[index:] {
				setExcluded(rest.it, CutOverLimit)
				rest.it.thaw()
			}
			break
		}
		sockets := socketsOf(c.it)
		ok := true
		var inodes []uint64
		var keptNames []string
		for i, socket := range sockets {
			file, inode, err := duplicate(socket)
			if err == nil {
				err = keeper.Keep(names[i], file)
				_ = file.Close()
			}
			if err != nil {
				ok = false
				break
			}
			keptNames = append(keptNames, names[i])
			inodes = append(inodes, inode)
		}
		if !ok {
			for _, name := range keptNames {
				_ = keeper.Drop(name)
			}
			cut[CutKeepFailed]++
			setExcluded(c.it, CutKeepFailed)
			c.it.thaw()
			continue
		}
		budget -= cost
		bytes -= size
		next += c.files
		c.snapshot.Conns, c.snapshot.Inodes = names, inodes
		snapshot.Items = append(snapshot.Items, c.snapshot)
		kept = append(kept, c)
	}
	return kept, snapshot
}

func socketsOf(it item) []net.Conn {
	var connections []net.Conn
	switch current := it.(type) {
	case *Bridge:
		connections = []net.Conn{current.conn}
	case *Pipe:
		connections = current.conns[:]
	}
	sockets := make([]net.Conn, 0, len(connections))
	for _, connection := range connections {
		if socket, err := socketOf(connection); err == nil {
			sockets = append(sockets, socket)
		}
	}
	return sockets
}

// Live counts what an update now would keep and cut among the registry's
// connections (the daemon adds what it carries outside it); available and
// notHandedOver come from Preview.
func (r *Registry) Live(available bool, notHandedOver string) (kept int, cut map[string]int) {
	cut = map[string]int{}
	if r == nil {
		return 0, cut
	}
	for _, it := range r.snapshotItems() {
		class := ""
		switch current := it.(type) {
		case *Bridge:
			if class = current.cutClass(); class == "" && current.session.State().Terminal() {
				continue
			}
		case *Pipe:
			if current.pinned() {
				class = CutNoSocket
			}
		}
		switch {
		case class != "":
			cut[class]++
		case !available:
			cut[firstNonEmpty(notHandedOver, CutNoHandover)]++
		default:
			kept++
		}
	}
	return kept, cut
}

// Remaining counts the registry's connections that are still carried by this
// process, by the class an exit now cuts them under: why the handover left
// them out, service_restart when the update restarts the whole service, or
// no_handover without a handover.
func (r *Registry) Remaining() map[string]int {
	cut := map[string]int{}
	if r == nil {
		return cut
	}
	r.mu.Lock()
	notHandedOver := firstNonEmpty(r.notHandedOver, CutNoHandover)
	// Counted with the items under one lock: a bridge whose setup ends with
	// its registration is one or the other.
	if setups := r.setups.Load(); setups > 0 {
		cut[CutOpenInFlight] = int(setups)
	}
	items := make([]item, 0, len(r.items))
	for it := range r.items {
		items = append(items, it)
	}
	r.mu.Unlock()
	for _, it := range items {
		switch current := it.(type) {
		case *Bridge:
			if current.session.Detached() {
				continue
			}
			if class := current.cutClass(); class != "" {
				cut[class]++
				continue
			}
			if current.session.State().Terminal() {
				// Ended already: nothing left to cut.
				continue
			}
			current.stop.mu.Lock()
			excluded := current.excluded
			current.stop.mu.Unlock()
			cut[firstNonEmpty(excluded, notHandedOver)]++
		case *Pipe:
			if handed, _ := current.stop.verdictIs(verdictHanded); handed {
				continue
			}
			current.stop.mu.Lock()
			excluded := current.excluded
			current.stop.mu.Unlock()
			cut[firstNonEmpty(excluded, notHandedOver)]++
		}
	}
	return cut
}

// setExcluded records why a handover left it out.
func setExcluded(it item, class string) {
	switch current := it.(type) {
	case *Bridge:
		current.stop.mu.Lock()
		current.excluded = class
		current.stop.mu.Unlock()
	case *Pipe:
		current.stop.mu.Lock()
		current.excluded = class
		current.stop.mu.Unlock()
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
