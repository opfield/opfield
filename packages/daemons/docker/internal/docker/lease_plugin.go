package docker

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"google.golang.org/grpc"
)

const (
	// availabilityLeaseCapability is versioned (D3): v2 carries the sender
	// clock in lease frames (peer-time freeze detection, D4) and releases
	// after a confirmed local fence. Gateway treats v1 as outdated.
	availabilityLeaseCapability = "availability_lease_v2"
	// leaseWatchdogStartupWait lets a watchdog that boots after the daemon
	// prove itself before the registration capabilities are computed.
	leaseWatchdogStartupWait = 5 * time.Second
	// leaseStartupPrimeWait bounds how long the daemon start waits for the
	// lease runtime's first container view (a hung dockerd).
	leaseStartupPrimeWait = 5 * time.Second
	endpointCloseWait     = 5 * time.Second
)

// leaseIntegration wires the availability lease runtime into the plugin: the
// relay endpoint gate (D8), the local placement view (D12) and the serving
// flags the runtime flips.
type leaseIntegration struct {
	plugin  *DockerPlugin
	runtime *lease.Runtime
	fence   lease.DirFence
	// ctx lives as long as the lease integration: stop cancels it, which ends the runtime loop, the watchdog
	// bootstrap and every Coordinate lane.
	ctx    context.Context
	cancel context.CancelFunc
	// workers counts those goroutines (stop waits for them).
	workers sync.WaitGroup

	// watchdog bootstraps a missing lease watchdog (nodes installed before it).
	watchdog *watchdogBootstrap

	// keys is the node's identity (holder statements of availability set
	// members are signed with the key the node signs lease frames with).
	keys *identityKeys

	// identity returns the PKIX DER public key that signs lease frames,
	// for AvailabilityLeaseReport.identity_public_key.
	identity func() []byte

	mu      sync.Mutex
	serving map[string]bool
	// view answers the endpoint gate's lease questions: the runtime, or a
	// stand-in in tests.
	view endpointLeaseView
	// bootstrapServed marks policies whose endpoints serve as the named
	// bootstrap holder's legacy copy: after that holder acquires, they keep
	// serving until the runtime's SetServing takes over (see endpointAllowed).
	bootstrapServed map[string]bool
	// recovered marks policies whose copy this process found running on a
	// live lease record at start and kept serving (B-13); until the first
	// readiness probe of this process, that copy counts as ready.
	recovered map[string]bool
}

// initAvailabilityLease starts the lease runtime on a general Docker node.
// It runs for the life of the process, independent of the Gateway session:
// fencing and failover must keep working while the Gateway is down.
func (p *DockerPlugin) initAvailabilityLease() {
	stored, err := state.Load(p.cfg.StateDir)
	if err != nil || stored.NodeID == "" {
		p.logger.Info("availability lease disabled until the node is enrolled")
		return
	}
	keys, err := newIdentityKeys(p.cfg.TLS.ClientCert, p.cfg.TLS.ClientKey, filepath.Join(p.cfg.StateDir, "availability-lease", "previous-identity.json"))
	if err != nil {
		p.logger.Warn("availability lease disabled: node identity key unavailable", "error", err)
		return
	}
	root := p.cfg.Docker.LeaseWatchdogDir
	if root == "" {
		root = leasefence.DefaultRoot
	}
	integration := &leaseIntegration{
		plugin: p, fence: lease.DirFence{Dir: leasefence.Dir{Root: root}},
		identity: keys.publicKeyDER, keys: keys, serving: map[string]bool{},
	}
	runtime, err := lease.New(lease.Options{
		NodeID: stored.NodeID, StateDir: p.cfg.StateDir, Signer: keys.InitialSigner(), Identity: keys,
		Engine: &leaseEngine{
			client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot,
			composeProjects: p.availability.leaseComposeProjects, runtimeIdentities: p.availability.leaseRuntimeIdentities,
		},
		Fence: integration.fence, Endpoints: integration, Placements: integration, Logger: p.logger,
	})
	if err != nil {
		p.logger.Warn("availability lease disabled", "error", err)
		return
	}
	integration.runtime = runtime
	if p.cfg.Docker.IsStorageProfile() {
		// Availability set members: the member runtime owns their policies; it
		// is the controller before the runtime's first step.
		if err := p.startSetMembers(runtime, integration.fence); err != nil {
			p.logger.Warn("availability set members disabled", "error", err)
		}
	}
	if _, statErr := os.Stat(integration.fence.Dir.HeartbeatPath()); statErr == nil {
		for deadline := time.Now().Add(leaseWatchdogStartupWait); time.Now().Before(deadline) && !integration.watchdogReady(); {
			time.Sleep(250 * time.Millisecond)
		}
	}
	if !p.cfg.Docker.IsStorageProfile() {
		// Every user-workload start passes the lease start hook (A5, A12.1). A storage-profile daemon runs no
		// Availability workloads; its set members arm their deadline records themselves.
		p.client.beforeStart = integration.beforeStart
	}
	integration.ctx, integration.cancel = context.WithCancel(context.Background())
	// Recover copies that run on live records before any relay registration,
	// so they register serving, not dormant, after a daemon restart (B-13).
	runtime.Prime(leaseStartupPrimeWait)
	integration.goWorker(runtime.Run)
	p.lease = integration
	integration.watchdog = newWatchdogBootstrap(p.logger, integration.watchdogReady, p.cfg.Docker.LeaseWatchdogReleasesURL, p.cfg.Docker.LeaseWatchdogArtifactBaseURL)
	integration.watchdog.onPresent = p.signalRegistrationChanged
	integration.watchdog.Unavailable()
	integration.goWorker(integration.watchdog.Run)
	p.logger.Info("availability lease runtime started", "node_id", stored.NodeID, "watchdog_ready", integration.watchdogReady())
}

// attachRelay opens the Coordinate stream on a relay transport for as long
// as the transport lives: one stream per relay the daemon holds (D3).
func (l *leaseIntegration) attachRelay(ctx context.Context, conn grpc.ClientConnInterface, relayInstanceID string) {
	if l == nil || l.runtime == nil {
		return
	}
	laneCtx, cancel := context.WithCancel(ctx)
	detach := func() bool { return false }
	if l.ctx != nil {
		// The lane also ends when the lease integration stops, before the relay transport does.
		detach = context.AfterFunc(l.ctx, cancel)
	}
	l.goWorker(func(context.Context) {
		defer detach()
		defer cancel()
		l.runtime.Transport().Run(laneCtx, relayInstanceID, func(streamCtx context.Context) (lease.FrameStream, error) {
			return lease.OpenCoordinateStream(streamCtx, conn)
		})
	})
}

// goWorker runs work on the integration's context as a goroutine stop waits for.
func (l *leaseIntegration) goWorker(work func(context.Context)) {
	ctx := l.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	l.workers.Add(1)
	go func() {
		defer l.workers.Done()
		work(ctx)
	}()
}

// stop ends the lease integration: it cancels its context, waits until the runtime loop, the watchdog bootstrap
// and every relay lane returned (no lane delivers a frame any more), then stops the runtime's background
// operations. Nothing of the lease integration writes to the state directory afterwards. Lanes attached with a
// context of their own (tests) end with it.
func (l *leaseIntegration) stop() {
	if l == nil || l.runtime == nil {
		return
	}
	if l.cancel != nil {
		l.cancel()
	}
	l.workers.Wait()
	l.runtime.Stop()
}

// leaseCapabilities advertises availability_lease_v2 whenever the lease
// runtime runs: it names the protocol this daemon speaks, not the node's
// state. Watchdog readiness travels in every lease report (watchdog_ready)
// and Gateway excludes a node without a live watchdog from holding (D3,
// watchdog_missing), so a watchdog restart no longer changes the
// registration. The missing-watchdog marker is added when this daemon cannot
// install one, so the exclusion reason asks to re-run the node installer.
func (p *DockerPlugin) leaseCapabilities() []string {
	if p.lease == nil {
		return nil
	}
	// v3: this daemon accepts, persists and reports certified holder state of
	// stateful policies (a voter or witness of a DB HA lease). Candidacy for a
	// stateful policy additionally needs the member runtime's own capability.
	capabilities := []string{availabilityLeaseCapability, availabilitylease.CapabilityV3}
	if !p.lease.watchdogReady() {
		if unavailable, _ := p.lease.watchdog.Unavailable(); unavailable {
			capabilities = append(capabilities, watchdogMissingCapability)
		}
	}
	return capabilities
}

// RegistrationChanged implements lifecycle.RegistrationRefreshPlugin.
func (p *DockerPlugin) RegistrationChanged() <-chan struct{} {
	return p.registrationChanged
}

func (p *DockerPlugin) signalRegistrationChanged() {
	select {
	case p.registrationChanged <- struct{}{}:
	default:
	}
}

func (l *leaseIntegration) watchdogReady() bool {
	return lease.HeartbeatAlive(l.fence, leasefence.Now())
}

// SetServing implements lease.Endpoints: it flips the policy's endpoint gate,
// reconciles relay registrations and, when closing, waits until every
// registration stream of the policy has ended (A6).
func (l *leaseIntegration) SetServing(policyID string, serving bool) {
	l.mu.Lock()
	l.serving[policyID] = serving
	delete(l.bootstrapServed, policyID)
	if !serving {
		delete(l.recovered, policyID)
	}
	l.mu.Unlock()
	if serving && l.leaseView().Recovering(policyID) {
		l.mu.Lock()
		if l.recovered == nil {
			l.recovered = map[string]bool{}
		}
		l.recovered[policyID] = true
		l.mu.Unlock()
	}
	if !serving {
		// A member that stops serving registers dormant at once, and serving
		// again is probed from scratch (D6, D7). A holder that starts serving
		// keeps a readiness it already has: the bootstrap holder's copy never
		// stopped, and the probe re-checks a restarted container anyway.
		l.plugin.memberReadiness.reset(policyID)
	}
	if serving {
		// The deployment router is not lease-governed (ServeSet), so nothing
		// starts it with the workload: one that did not come back after a
		// reboot (restart policy "no") would leave the links without target.
		l.plugin.repairDeploymentRouters(policyID, deploymentRouterRepairLeaseTimeout)
	}
	if serving && l.plugin.secureLinks != nil {
		// A dormant target binding could not be prepared while its standby
		// was stopped; bind it now that the container runs.
		if err := l.plugin.secureLinks.restoreBindingsCoalesced(true); err != nil {
			l.plugin.logger.Warn("secure-link restore before serving failed", "policy_id", policyID, "error", err)
		}
	}
	// Dormant registrations stay on every relay (D7): stopping to serve renews
	// them dormant and ends the tunnels this node accepted for the policy.
	closed := l.plugin.reconcileRelayRegistrations()
	if serving {
		// The endpoints serve once the readiness probe finds the workload
		// ready; probe right away.
		l.plugin.memberReadiness.signal()
		return
	}
	closed = append(closed, l.plugin.closeMemberTunnels(l.plugin.memberEndpointIDs(policyID))...)
	timeout := time.NewTimer(endpointCloseWait)
	defer timeout.Stop()
	for _, done := range closed {
		select {
		case <-done:
		case <-timeout.C:
			l.plugin.logger.Warn("relay endpoint registration did not close in time", "policy_id", policyID)
			return
		}
	}
}

// endpointLeaseView is what the endpoint gate asks the lease runtime.
type endpointLeaseView interface {
	LeaseMode(policyID string) bool
	BootstrapPending(policyID string) bool
	Holds(policyID string) bool
	Recovering(policyID string) bool
}

func (l *leaseIntegration) leaseView() endpointLeaseView {
	if l.view != nil {
		return l.view
	}
	return l.runtime
}

// endpointAllowed is the serving gate (D8, A8): the Secure Link endpoint of
// an availability member (T3's binding availability_policy_id, set for
// serving and dormant members alike, deployment routers included) serves only
// while this node serves the policy's lease; otherwise it stays registered
// dormant (D7). Links of policies outside lease mode serve as before, once
// their workload is ready (D6).
func (l *leaseIntegration) endpointAllowed(linkID string) bool {
	if l == nil || l.runtime == nil {
		return true
	}
	view := l.leaseView()
	policyID := l.linkPolicy(linkID)
	if policyID == "" || !view.LeaseMode(policyID) {
		return true
	}
	// The named bootstrap holder keeps its legacy registration until its
	// first commit; relays admit it the same way (A5, T2).
	if view.BootstrapPending(policyID) {
		l.mu.Lock()
		if l.bootstrapServed == nil {
			l.bootstrapServed = map[string]bool{}
		}
		l.bootstrapServed[policyID] = true
		l.mu.Unlock()
		return true
	}
	// Once it acquired, the runtime opens the endpoints (SetServing) a step or
	// two later, after its readiness check; the copy that served all along
	// keeps serving in between instead of going dormant for that gap (an
	// enable must not produce a 502 window). Only while this node holds the
	// slot: a lost bootstrap race ends it.
	holds := view.Holds(policyID)
	recovering := view.Recovering(policyID)
	l.mu.Lock()
	defer l.mu.Unlock()
	serving, decided := l.serving[policyID]
	if serving {
		return true
	}
	if !decided && recovering {
		// B-13: a copy recovered after a same-boot daemon restart on a live
		// lease record keeps serving from its first registration, before
		// the runtime's SetServing(true); an explicit SetServing(false)
		// (a stop under way) always wins.
		if l.recovered == nil {
			l.recovered = map[string]bool{}
		}
		l.recovered[policyID] = true
		return true
	}
	if l.bootstrapServed[policyID] {
		if holds {
			return true
		}
		delete(l.bootstrapServed, policyID)
	}
	return false
}

func (l *leaseIntegration) linkPolicy(linkID string) string {
	return l.plugin.availabilityLinkPolicy(linkID)
}

// Local implements lease.Placements from the persisted availability state.
func (l *leaseIntegration) Local(policyID string) (lease.Placement, bool) {
	placement, ok := l.plugin.availability.leasePlacement(policyID)
	if !ok {
		return lease.Placement{}, false
	}
	return lease.Placement{PlacementID: placement.PlacementID, Generation: placement.HighestGeneration}, true
}

// ServeSet keeps the containers of this node's current placement and, for
// deployments, only the active slot's app container (the router is not
// lease-governed: without the app it serves nothing).
func (l *leaseIntegration) ServeSet(policyID string, containers []lease.Container) []lease.Container {
	placement, known := l.plugin.availability.leasePlacement(policyID)
	activeSlot := ""
	if known {
		if slot, ok := availabilityRuntimeIdentity(placement.RuntimeMetadata)["activeSlot"].(string); ok {
			activeSlot = slot
		}
	}
	var out []lease.Container
	for _, c := range containers {
		if known && c.PlacementID != "" && c.PlacementID != placement.PlacementID {
			continue
		}
		out = append(out, c)
	}
	if activeSlot == "" {
		activeSlot = lastStartedDeploymentSlot(out)
	}
	if activeSlot == "" {
		return out
	}
	serve := out[:0:0]
	for _, c := range out {
		if c.Labels[deploymentRoleLabel] == "app" && c.Labels[deploymentSlotLabel] != activeSlot {
			continue
		}
		serve = append(serve, c)
	}
	return serve
}

// lastStartedDeploymentSlot picks the active blue/green slot when the placement
// record does not name it (a placement recorded by the legacy path): the slot
// whose app container Docker started last, since a switch starts the new slot
// before it stops the old one. Without it both slots would start after a host
// reboot (stand run c2). Blue, the deployment default, when neither ever ran.
func lastStartedDeploymentSlot(containers []lease.Container) string {
	slot, latest, slots := "", time.Time{}, map[string]bool{}
	for _, c := range containers {
		if c.Labels[deploymentRoleLabel] != "app" || c.Labels[deploymentSlotLabel] == "" {
			continue
		}
		slots[c.Labels[deploymentSlotLabel]] = true
		if slot == "" || c.StartedAt.After(latest) {
			slot, latest = c.Labels[deploymentSlotLabel], c.StartedAt
		}
	}
	if len(slots) < 2 {
		return ""
	}
	if latest.IsZero() {
		return "blue"
	}
	return slot
}

// MarkServing implements lease.Placements (T6 §3.1).
func (l *leaseIntegration) MarkServing(policyID string, serving bool) {
	if err := l.plugin.availability.markLeaseLifecycle(policyID, serving); err != nil {
		l.plugin.logger.Warn("could not record the availability placement lifecycle", "policy_id", policyID, "serving", serving, "error", err)
	}
}

// recoveredUnprobed reports whether policyID's copy was recovered serving
// after this daemon's start and no readiness probe has judged it yet: it was
// serving before the restart and keeps doing so (B-13).
func (l *leaseIntegration) recoveredUnprobed(policyID string, probed bool) bool {
	if l == nil || probed {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.recovered[policyID]
}
