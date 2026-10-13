package lease

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
)

const (
	// maxStepInterval bounds the loop period; the node needs Tick at least
	// every 250 ms.
	maxStepInterval = 250 * time.Millisecond
	minStepInterval = 10 * time.Millisecond
	observeInterval = time.Second
	// snapshotMaxAge is how old the container view may be for candidacy and
	// health evidence; an older view (dockerd hanging) is no evidence.
	snapshotMaxAge = 5 * time.Second
	// maxGracefulStop caps docker stop before the kill (D5).
	maxGracefulStop = 10 * time.Second
	// killMargin keeps the graceful stop inside the fence deadline.
	killMargin       = time.Second
	opTimeout        = 25 * time.Second
	dockerCallWait   = 5 * time.Second
	abandonRetry     = 2 * time.Second
	maxPendingEvents = 256
)

type Options struct {
	// NodeID is this daemon's voter/candidate id (its Opfield node id).
	NodeID string
	// StateDir holds the durable acceptor store.
	StateDir string
	// Clock is CLOCK_BOOTTIME; it must be the clock of the watchdog records.
	Clock availabilitylease.Clock
	// Wall is the wall clock, for event timestamps and the incarnation floor
	// only. It is never evidence of a freeze (D4): a VM freeze is detected
	// from the peers' clocks in lease frames (availabilitylease freeze.go).
	Wall func() time.Time
	// Suspends reports real host suspends (BOOTTIME over MONOTONIC) for the
	// log; nil uses the host clocks.
	Suspends *availabilitylease.SuspendWatch
	// Signer is the key the node starts with: after a restart inside a
	// rotation overlap, the previous key (Identity then rotates to the new).
	Signer availabilitylease.Signer
	// Identity hands later certificate renewals to the node (H3); optional.
	Identity   IdentityRotation
	Engine     Engine
	Fence      Fence
	Endpoints  Endpoints
	Placements Placements
	Logger     *slog.Logger
	// Store overrides the file store (tests).
	Store availabilitylease.Store
	// Transport overrides the relay transport (tests).
	Transport availabilitylease.Transport
	// Async runs background operations; default is a goroutine. Operations
	// never run on the loop, so a hung dockerd cannot stall renewals.
	Async func(func())
	// Controller owns the container side of some policies (the member runtime
	// of database and storage availability sets); optional, set with
	// SetController before the loop runs.
	Controller Controller
}

// Controller runs the container side of lease policies that are not Docker
// Availability workloads. The runtime drives the protocol node for them as for
// every policy but leaves their containers, deadline records, candidacy and
// startup recovery to the controller, and calls Step every loop iteration after
// its own work, outside its lock.
type Controller interface {
	Owns(policyID string) bool
	Step()
	// ObserveFreeze reports a freeze of this host detected from peer clocks (D4)
	// at local time at.
	ObserveFreeze(at time.Duration)
}

type bootClock struct{}

func (bootClock) Now() time.Duration { return leasefence.Now() }

// Origin names the boot of the BOOTTIME clock for peers' freeze detection.
func (bootClock) Origin() uint64 { return availabilitylease.BootOrigin() }

// Runtime is the lease side of a docker daemon.
type Runtime struct {
	opts      Options
	node      *availabilitylease.Node
	transport *RelayTransport
	logger    *slog.Logger
	wake      chan struct{}

	// ops counts the background operations in flight (Stop waits for them).
	ops sync.WaitGroup

	mu          sync.Mutex
	stopped     bool
	workloads   map[string]*workload
	results     []func()
	snapshot    *snapshot
	observing   bool
	nextObserve time.Duration
	records     map[string]leasefence.Record
	watchdog    watchdogState
	started     bool
	ready       map[string]bool
	events      []ReportEvent
	revision    uint64
	beaconAt    time.Duration

	// recordsUnreadable: the last read of the watchdog records failed (logged once per stretch).
	recordsUnreadable bool

	// heldSince is when each key held now was acquired (lease clock), kept
	// from the transitions even when their report events are dropped.
	heldSince map[availabilitylease.Key]time.Duration
	// recovering marks keys this process recovers for a copy that kept
	// running through a daemon restart: renewing one continues the holding
	// that started before the restart, at a time this process does not know.
	recovering map[availabilitylease.Key]bool
}

type snapshot struct {
	at       time.Duration
	byPolicy map[string][]Container
	byID     map[string]Container
}

// New opens the durable store, starts the protocol node (bumping and
// persisting its incarnation, A3) and prepares the relay transport.
func New(opts Options) (*Runtime, error) {
	if opts.NodeID == "" || opts.Signer == nil || opts.Engine == nil || opts.Fence == nil || opts.Endpoints == nil || opts.Placements == nil {
		return nil, errors.New("availability lease runtime needs node id, signer, engine, fence, endpoints and placements")
	}
	if opts.Clock == nil {
		opts.Clock = bootClock{}
	}
	if opts.Wall == nil {
		opts.Wall = func() time.Time { return time.Now().Round(0) }
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Async == nil {
		opts.Async = func(fn func()) { go fn() }
	}
	async := opts.Async
	if opts.Suspends == nil {
		opts.Suspends = availabilitylease.NewSuspendWatch()
	}
	if opts.Store == nil {
		store, err := OpenFileStore(filepath.Join(opts.StateDir, "availability-lease", "acceptor.json"))
		if err != nil {
			return nil, err
		}
		opts.Store = store
	}
	r := &Runtime{
		opts: opts, logger: opts.Logger, wake: make(chan struct{}, 1), workloads: map[string]*workload{},
		records: map[string]leasefence.Record{}, ready: map[string]bool{},
	}
	// Operations are counted so Stop can wait for them. Both callers hold r.mu, as Stop does when it sets stopped:
	// an operation is either counted before Stop waits or not started at all.
	r.opts.Async = func(fn func()) {
		if r.stopped {
			return
		}
		r.ops.Add(1)
		async(func() {
			defer r.ops.Done()
			fn()
		})
	}
	r.transport = NewRelayTransport(opts.Logger)
	var transport availabilitylease.Transport = r.transport
	if opts.Transport != nil {
		transport = opts.Transport
	}
	node, err := availabilitylease.NewNode(availabilitylease.Config{
		ID: opts.NodeID, Clock: opts.Clock, Store: opts.Store, Transport: transport, Signer: opts.Signer,
		Logf:             func(format string, args ...any) { r.logger.Debug(fmt.Sprintf(format, args...)) },
		IncarnationFloor: uint64(opts.Wall().UnixMilli()),
	})
	if err != nil {
		return nil, err
	}
	r.node = node
	r.transport.setReceiver(node.ReceiveFrame)
	return r, nil
}

// Stop starts no further background operation and waits for those in flight (Docker calls bounded by opTimeout,
// endpoint changes). Run and the relay lanes end with their context; after Stop and their end nothing of the runtime
// runs any more. The daemon process does not call it: its operations end with the process.
func (r *Runtime) Stop() {
	r.mu.Lock()
	r.stopped = true
	r.mu.Unlock()
	r.ops.Wait()
}

// Node exposes the protocol node (acceptor view, gate evaluation in tests).
func (r *Runtime) Node() *availabilitylease.Node { return r.node }

// Transport is attached to every relay connection by the daemon.
func (r *Runtime) Transport() *RelayTransport { return r.transport }

// Run drives the loop until ctx ends. It never waits on Docker.
func (r *Runtime) Run(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-r.wake:
		}
		r.Step()
		wait := r.node.NextWakeup() - r.opts.Clock.Now()
		if wait > maxStepInterval {
			wait = maxStepInterval
		}
		if wait < minStepInterval {
			wait = minStepInterval
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
	}
}

func (r *Runtime) kick() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// SetController installs the controller of non-Availability policies; call it
// before Run.
func (r *Runtime) SetController(controller Controller) {
	r.mu.Lock()
	r.opts.Controller = controller
	r.mu.Unlock()
}

// Step runs one loop iteration: protocol timers, completed operations, the
// container side of every Availability policy, then the controller.
func (r *Runtime) Step() {
	r.step()
	r.mu.Lock()
	controller := r.opts.Controller
	r.mu.Unlock()
	if controller != nil {
		controller.Step()
	}
}

// owned reports a policy the controller runs.
func (r *Runtime) owned(policyID string) bool {
	return r.opts.Controller != nil && r.opts.Controller.Owns(policyID)
}

func (r *Runtime) step() {
	if suspended := r.opts.Suspends.Check(); suspended > 0 {
		// BOOTTIME counted the suspend, so the lease timers already did:
		// a holder whose budget ran out fences on its timer below.
		r.logger.Warn("host resumed from a suspend; lease timers counted it", "suspended_for", suspended)
	}
	r.node.Tick()
	now := r.opts.Clock.Now()
	if now >= r.beaconAt {
		// Relays learn of their own freezes from daemons' clocks (D4); the
		// watchdog learns that a lease-aware daemon keeps its records.
		r.beaconAt = now + availabilitylease.BeaconInterval
		r.node.BeaconRelays()
		if err := r.opts.Fence.DaemonAlive(now); err != nil {
			r.logger.Debug("could not write the lease daemon heartbeat", "error", err)
		}
	}
	for _, freeze := range r.node.DrainFreezes() {
		keys := make([]string, 0, len(freeze.Fenced))
		for _, key := range freeze.Fenced {
			keys = append(keys, key.String())
		}
		r.logger.Warn("host was frozen: a peer's clock moved on while this host's clocks stood still; fencing every lease held across it",
			"peer", freeze.Peer, "frozen_for", freeze.Frozen, "fenced", keys)
		if r.opts.Controller != nil {
			r.opts.Controller.ObserveFreeze(freeze.At)
		}
	}
	var manifests []availabilitylease.ManifestInfo
	for _, manifest := range r.node.Manifests() {
		if !r.owned(manifest.PolicyID) {
			manifests = append(manifests, manifest)
		}
	}
	holders := map[string]availabilitylease.HolderStatus{}
	for _, status := range r.node.Holders() {
		if r.owned(status.Key.PolicyID) {
			continue
		}
		if current, ok := holders[status.Key.PolicyID]; !ok || rolePriority(status.Role) > rolePriority(current.Role) {
			holders[status.Key.PolicyID] = status
		}
	}
	hbAge, hbPresent := r.opts.Fence.HeartbeatAge(now)
	r.rotateIdentity()

	r.mu.Lock()
	defer r.mu.Unlock()
	results := r.results
	r.results = nil
	for _, done := range results {
		done()
	}
	r.observeWatchdogLocked(now, hbAge, hbPresent)
	r.collectEventsLocked()
	readable := r.loadRecordsLocked()
	r.maybeObserveLocked(now, manifests, holders)
	if r.snapshot == nil {
		return
	}
	if !r.started {
		if !readable && r.watchdog.alive {
			// The records tell which running copy is fenced (A2.3): without them every copy would look unfenced and
			// be killed. The watchdog goes on enforcing them meanwhile; the start waits until they can be read.
			// Without a watchdog nothing fences a copy, and the start kills them whatever the records say.
			return
		}
		// Recovered keys show up in the next step's holder view.
		r.started = true
		r.startupFenceLocked(now, manifests)
		return
	}
	for _, manifest := range manifests {
		status, held := holders[manifest.PolicyID]
		if !held {
			status = availabilitylease.HolderStatus{Role: availabilitylease.RoleNone}
		}
		r.reconcileLocked(manifest, status, now)
	}
}

// rolePriority picks the most significant key of a policy on this node;
// one node holds at most one slot per policy.
func rolePriority(role availabilitylease.Role) int {
	switch role {
	case availabilitylease.RoleHolding, availabilitylease.RoleRecovering, availabilitylease.RoleRetained:
		return 5
	case availabilitylease.RoleFencing, availabilitylease.RoleAbandoned:
		return 4
	case availabilitylease.RoleReleasing:
		return 3
	case availabilitylease.RoleBootstrapping, availabilitylease.RoleAcquiring:
		return 2
	}
	return 1
}

// rotateIdentity hands a renewed identity key to the node, which then
// dual-signs until the manifests list the new key or the overlap ends (H3).
func (r *Runtime) rotateIdentity() {
	if r.opts.Identity == nil {
		return
	}
	if next, publicKey, ok := r.opts.Identity.PendingRotation(); ok {
		if err := r.node.RotateIdentityKey(next, publicKey); err != nil {
			r.logger.Warn("availability lease identity rotation failed", "error", err)
		} else {
			r.opts.Identity.RotationApplied(publicKey)
			r.logger.Info("availability lease identity key renewed; dual-signing until every manifest lists the new key")
		}
	}
	if !r.node.IdentityOverlap() {
		r.opts.Identity.OverlapEnded()
	}
}

// loadRecordsLocked reads the watchdog records and reports whether it could. Unreadable records (a switch of the
// daemon's user the watchdog has not followed yet) keep the ones read before.
func (r *Runtime) loadRecordsLocked() bool {
	records, err := r.opts.Fence.Records()
	if err != nil {
		if !r.recordsUnreadable {
			r.recordsUnreadable = true
			r.logger.Warn("lease watchdog records unreadable; lease-mode containers found running at daemon start wait until they can be read",
				"error", err)
		}
		return false
	}
	if r.recordsUnreadable {
		r.recordsUnreadable = false
		r.logger.Info("lease watchdog records readable again")
	}
	r.records = records
	return true
}

func (r *Runtime) snapshotFreshLocked(now time.Duration) bool {
	return r.snapshot != nil && now-r.snapshot.at <= snapshotMaxAge
}

// maybeObserveLocked refreshes the container view in the background, forces
// RestartPolicy "no" on every container of a lease-mode policy (A2.1) and
// confirms which stale records may be deleted (A12.3).
func (r *Runtime) maybeObserveLocked(now time.Duration, manifests []availabilitylease.ManifestInfo, holders map[string]availabilitylease.HolderStatus) {
	if r.observing || now < r.nextObserve {
		return
	}
	leasePolicies := map[string]bool{}
	for _, manifest := range manifests {
		if !manifest.Closed {
			leasePolicies[manifest.PolicyID] = true
		}
	}
	gc := r.recordGCCandidatesLocked(leasePolicies, holders)
	r.observing = true
	r.opts.Async(func() {
		ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
		defer cancel()
		containers, err := r.opts.Engine.ListLeaseContainers(ctx)
		var deletable []string
		if err == nil {
			for i := range containers {
				c := &containers[i]
				if leasePolicies[c.PolicyID] && c.RestartPolicy != "no" {
					if updateErr := r.opts.Engine.DisableRestart(ctx, c.ID); updateErr != nil {
						r.logger.Warn("could not force restart policy no on a lease-mode container", "container_id", c.ID, "error", updateErr)
					} else {
						c.RestartPolicy = "no"
					}
				}
			}
			deletable = r.confirmDeletable(ctx, containers, gc)
		}
		at := r.opts.Clock.Now()
		r.mu.Lock()
		r.results = append(r.results, func() {
			r.observing = false
			r.nextObserve = at + observeInterval
			if err != nil {
				r.logger.Debug("lease container observation failed", "error", err)
				return
			}
			r.applySnapshotLocked(at, containers, deletable)
		})
		r.mu.Unlock()
		r.kick()
	})
}

func (r *Runtime) applySnapshotLocked(at time.Duration, containers []Container, deletable []string) {
	next := &snapshot{at: at, byPolicy: map[string][]Container{}, byID: map[string]Container{}}
	for _, c := range containers {
		next.byPolicy[c.PolicyID] = append(next.byPolicy[c.PolicyID], c)
		next.byID[c.ID] = c
	}
	r.snapshot = next
	for _, id := range deletable {
		if err := r.opts.Fence.DeleteRecord(id); err != nil {
			r.logger.Warn("could not delete a lease deadline record", "container_id", id, "error", err)
			continue
		}
		delete(r.records, id)
	}
}

// recordGCCandidatesLocked lists records that may go once their cgroup is
// confirmed empty: the container is gone, or its policy left lease mode and
// this node does not hold it (A12.3).
func (r *Runtime) recordGCCandidatesLocked(leasePolicies map[string]bool, holders map[string]availabilitylease.HolderStatus) []leasefence.Record {
	var out []leasefence.Record
	for _, record := range r.records {
		if r.owned(record.PolicyID) {
			// The controller writes and removes its own records.
			continue
		}
		if leasePolicies[record.PolicyID] {
			if r.snapshot == nil || r.snapshot.byID[record.ContainerID].ID != "" {
				continue
			}
		} else if status, held := holders[record.PolicyID]; held && rolePriority(status.Role) >= 3 {
			continue
		}
		out = append(out, record)
	}
	return out
}

func (r *Runtime) confirmDeletable(ctx context.Context, containers []Container, candidates []leasefence.Record) []string {
	byID := map[string]Container{}
	for _, c := range containers {
		byID[c.ID] = c
	}
	var out []string
	for _, record := range candidates {
		c, exists := byID[record.ContainerID]
		if exists && c.Running {
			continue
		}
		if !exists {
			c = Container{ID: record.ContainerID, CgroupPath: record.CgroupPath}
		}
		if empty, err := r.opts.Engine.CgroupEmpty(ctx, c); err == nil && empty {
			out = append(out, record.ContainerID)
		}
	}
	return out
}
