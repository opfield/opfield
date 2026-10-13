package broker

import (
	"context"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/admission"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/peer"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	DefaultMaxFrameBytes  = 1024 * 1024
	AcceptTimeout         = 30 * time.Second
	IdleTimeout           = 5 * time.Minute
	ProxyHalfCloseTimeout = 30 * time.Second
	// EndpointRestartCapability tells daemons that this relay keeps a
	// restarting endpoint's registration (ENDPOINT_SERVING_STATE_RESTARTING).
	EndpointRestartCapability = "endpoint_restart_v1"
	// DrainKeepsLocalServicesCapability tells Opfield that a draining relay
	// refuses new tunnels only to workload endpoints and keeps serving its
	// built-in local services (the internal registry), which no other relay
	// serves. Opfield drains the local relay for an update only then.
	DrainKeepsLocalServicesCapability = "drain_keeps_local_services_v1"
	// RegistryFairShareCapability tells Opfield that this relay shares the
	// registry traffic class fairly between its routes under pressure, as it
	// does the proxy class. Opfield moves container links into that class,
	// without a fixed session cap, only on relays that advertise it.
	RegistryFairShareCapability = "relay_registry_fair_share_v1"
	localServiceSubjectKind     = "local_service"
	// localServiceDialTimeout bounds the dial of a built-in local service: a
	// tunnel to a stopped registry fails at once instead of holding a session
	// for the operating system's connect timeout.
	localServiceDialTimeout = 5 * time.Second
)

// EndpointRestartGrace is how long a registration whose daemon announced a
// restart is kept after its stream ended, waiting for the daemon's next
// process to register again (B-13). A daemon that does not come back by then
// is treated as gone; one whose stream is still up by then is closed, so it
// registers again (F3).
var EndpointRestartGrace = 15 * time.Second

type endpointRegistration struct {
	endpointID string
	// subjectID is the daemon the registration's grant names (its node):
	// while a registration of a previous generation serves, the endpoint's
	// policy may already name another node.
	subjectID            string
	generation           uint64
	assignmentGeneration uint64
	// clientSubjectID and clientCertificate identify the connection that
	// registered (its verified certificate): the daemon accepts the
	// registration's tunnels with it, also while the endpoint's policy
	// already names a rotated certificate (F2).
	clientSubjectID   string
	clientCertificate string
	// admittedSeq orders the registration among admissions for lease gate
	// enforcement; guarded by the broker's mu.
	admittedSeq uint64
	expiresAt   atomic.Int64
	maxSessions atomic.Uint32
	incoming    chan *relayv1.IncomingTunnel
	// state is the relayv1.EndpointServingState the endpoint last sent (D6,
	// D7): UNSPECIFIED from endpoints built before serving states.
	state    atomic.Int32
	stop     chan struct{}
	stopOnce sync.Once
	// restartingSince is when a serving endpoint announced that its daemon
	// restarts (B-13), in Unix nanoseconds; 0 while it does not. restarting
	// closes at that moment, so tunnels waiting for the old process to accept
	// are answered at once; a restart called off replaces it (F3). The
	// channel is guarded by the broker's mu.
	restartingSince atomic.Int64
	restarting      chan struct{}
	// supersededAt is when the policy moved the endpoint to a newer
	// generation (certificate rotation, new target node) while this
	// registration of the previous one serves, in Unix nanoseconds; 0 while it
	// is current. It keeps serving until the new generation registers or its
	// grant expires (make-before-break).
	supersededAt atomic.Int64
	// pending is a renewal whose grant is ahead of this relay's policy (the
	// daemon got its grant before the relay got the policy): applied as soon
	// as the policy arrives. Guarded by the broker's mu; recheck wakes the
	// registration's stream handler to try it again.
	pending *relayv1.RenewEndpoint
	recheck chan struct{}
	// stopReason is written before stop closes, so readers of a closed stop
	// see it without a lock.
	stopReason string
}

func (r *endpointRegistration) close() { r.closeWith("") }

func (r *endpointRegistration) servingState() relayv1.EndpointServingState {
	return relayv1.EndpointServingState(r.state.Load())
}

// stateful reports a registration that states whether it serves: it is kept
// whatever the lease gate says, and only SERVING receives tunnels (D7).
func (r *endpointRegistration) stateful() bool {
	return r.servingState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
}

func (r *endpointRegistration) dormant() bool {
	return r.servingState() == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

// nudge wakes the registration's stream handler to retry a pending renewal.
func (r *endpointRegistration) nudge() {
	if r.recheck == nil {
		return
	}
	select {
	case r.recheck <- struct{}{}:
	default:
	}
}

// announceRestart marks a registration whose daemon restarts and reports
// whether this announcement started the restart. A dormant registration
// takes no traffic either way and is left as it is. Called with the broker's
// mu held.
func (r *endpointRegistration) announceRestart(now time.Time) bool {
	if r.dormant() || !r.restartingSince.CompareAndSwap(0, now.UnixNano()) {
		return false
	}
	if r.restarting != nil {
		close(r.restarting)
	}
	return true
}

// callOffRestart ends an announced restart: the daemon serves on. Tunnels
// admitted from now wait on a fresh channel. Called with the broker's mu held.
func (r *endpointRegistration) callOffRestart() {
	if r.restartingSince.Swap(0) != 0 && r.restarting != nil {
		r.restarting = make(chan struct{})
	}
}

// restartingAt reports a registration whose daemon announced a restart less
// than EndpointRestartGrace ago.
func (r *endpointRegistration) restartingAt(now time.Time) bool {
	since := r.restartingSince.Load()
	return since != 0 && now.Sub(time.Unix(0, since)) < EndpointRestartGrace
}

func (r *endpointRegistration) closeWith(reason string) {
	r.stopOnce.Do(func() {
		r.stopReason = reason
		close(r.stop)
	})
}

func (r *endpointRegistration) revokedMessage() string {
	if r.stopReason != "" {
		return r.stopReason
	}
	return "endpoint policy was revoked"
}

type acceptedConnection struct {
	stream relayv1.TunnelBroker_AcceptTunnelServer
	result chan error
}

type pendingTunnel struct {
	endpoint *relayv1.EndpointPolicy
	session  *activeTunnel
	accepted chan acceptedConnection
}

// acceptedBy reports whether client may accept the tunnel: it holds the
// certificate the tunnel's registration was verified with, or the one the
// endpoint's policy names. While the endpoint's certificate rotates, the
// previous registration serves on its connection's old certificate
// (make-before-break) and its daemon accepts with that one (F2).
func (p *pendingTunnel) acceptedBy(client peer.Identity) bool {
	if registration := p.session.registration; registration != nil && registration.clientCertificate != "" &&
		registration.clientSubjectID == client.SubjectID && registration.clientCertificate == client.CertificateFingerprint {
		return true
	}
	return p.endpoint.SubjectId == client.SubjectID && p.endpoint.CertificateSha256 == client.CertificateFingerprint
}

// tunnelRevokedMessage ends a tunnel whose route or endpoint policy was
// revoked: the one refusal openers must not retry.
const tunnelRevokedMessage = "tunnel policy was revoked"

var errTunnelRevoked = status.Error(codes.PermissionDenied, tunnelRevokedMessage)

type activeTunnel struct {
	routeID              string
	routeGeneration      uint64
	sourceKind           string
	sourceID             string
	endpointID           string
	endpointGeneration   uint64
	assignmentGeneration uint64
	trafficClass         string
	metrics              *routeMetrics
	// registration is the endpoint registration the tunnel was bridged
	// through (nil for built-in local services).
	registration *endpointRegistration
	// admittedSeq orders the tunnel among admissions for lease gate
	// enforcement; guarded by the broker's mu.
	admittedSeq uint64
	stop        chan struct{}
	stopOnce    sync.Once
	// stopCode and stopMessage are what the tunnel's opener and acceptor get
	// when it is closed; written before stop closes, read after.
	stopCode    codes.Code
	stopMessage string
}

// close ends a tunnel whose policy was revoked.
func (t *activeTunnel) close() { t.closeWith(codes.PermissionDenied, tunnelRevokedMessage) }

// closeWith ends the tunnel with the status its opener and acceptor get. A
// tunnel whose path went away (its target disconnected, reconnected or did
// not come back from a restart, the relay drains) ends Unavailable, which
// daemons retry and fail over on; a closed lease gate FailedPrecondition; a
// revoked policy PermissionDenied, which they do not retry (F1).
func (t *activeTunnel) closeWith(code codes.Code, message string) {
	t.stopOnce.Do(func() {
		t.stopCode, t.stopMessage = code, message
		close(t.stop)
	})
}

// stopError is the status of a closed tunnel.
func (t *activeTunnel) stopError() error {
	if t.stopMessage == "" || (t.stopCode == codes.PermissionDenied && t.stopMessage == tunnelRevokedMessage) {
		return errTunnelRevoked
	}
	return status.Error(t.stopCode, t.stopMessage)
}

type Broker struct {
	relayv1.UnimplementedTunnelBrokerServer
	store            *policy.Store
	verifier         grant.Verifier
	mu               sync.Mutex
	endpoints        map[string]*endpointRegistration
	pending          map[string]*pendingTunnel
	active           map[string]*activeTunnel
	admission        *admission.Controller
	activeProxy      uint64
	activeDatabase   uint64
	activeRegistry   uint64
	proxyByRoute     map[string]uint64
	registryByRoute  map[string]uint64
	activeByRoute    map[string]uint64
	activeByTarget   map[string]uint64
	routeMetrics     map[string]*routeMetrics
	metricsSince     time.Time
	draining         atomic.Bool
	dialLocalService func(context.Context, string) (net.Conn, error)
	laneCollapsed    func(context.Context) bool
	lease            LeaseGate
	// admissions numbers registrations and tunnels as they are admitted;
	// guarded by mu. leaseEpoch counts lease gate enforcement runs; written
	// under mu, read without it by lease checks taken before mu (F4).
	admissions uint64
	leaseEpoch atomic.Uint64
	refusals   *refusalLog
	// policyChanged closes, and is replaced, whenever a new policy snapshot
	// applies: registrations waiting for the policy their grant needs retry.
	policyChanged chan struct{}
}

func New(store *policy.Store) *Broker {
	controller := admission.New()
	controller.UpdatePolicy(store.Current().Admission)
	dialer := net.Dialer{Timeout: localServiceDialTimeout}
	return &Broker{store: store, verifier: grant.Verifier{Store: store}, endpoints: map[string]*endpointRegistration{}, pending: map[string]*pendingTunnel{}, active: map[string]*activeTunnel{}, admission: controller, proxyByRoute: map[string]uint64{}, registryByRoute: map[string]uint64{}, activeByRoute: map[string]uint64{}, activeByTarget: map[string]uint64{}, routeMetrics: map[string]*routeMetrics{}, metricsSince: time.Now(), refusals: newRefusalLog(), policyChanged: make(chan struct{}), dialLocalService: func(ctx context.Context, target string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp", target)
	}}
}

func (b *Broker) SetLocalServiceDialer(dial func(context.Context, string) (net.Conn, error)) {
	if dial != nil {
		b.dialLocalService = dial
	}
}

// nextAdmissionLocked numbers an admitted registration or tunnel.
func (b *Broker) nextAdmissionLocked() uint64 {
	b.admissions++
	return b.admissions
}

func (b *Broker) Counts() (uint64, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return uint64(len(b.endpoints)), uint64(len(b.active))
}

type RuntimeSnapshot struct {
	RegisteredEndpoints   uint64
	ActiveTunnels         uint64
	ActiveProxyTunnels    uint64
	ActiveDatabaseTunnels uint64
	ActiveRegistryTunnels uint64
	Admission             admission.Snapshot
	Draining              bool
	AssignmentTunnels     []AssignmentTunnelCount
}

type AssignmentTunnelCount struct {
	EndpointID           string
	AssignmentGeneration uint64
	ActiveTunnels        uint64
}

func (b *Broker) RuntimeSnapshot() RuntimeSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	usage := b.usageLocked()
	assignmentCounts := make(map[string]AssignmentTunnelCount)
	for _, tunnel := range b.active {
		key := policyAssignmentKey(tunnel.endpointID, tunnel.assignmentGeneration)
		count := assignmentCounts[key]
		count.EndpointID = tunnel.endpointID
		count.AssignmentGeneration = tunnel.assignmentGeneration
		count.ActiveTunnels++
		assignmentCounts[key] = count
	}
	assignmentTunnels := make([]AssignmentTunnelCount, 0, len(assignmentCounts))
	for _, count := range assignmentCounts {
		assignmentTunnels = append(assignmentTunnels, count)
	}
	sort.Slice(assignmentTunnels, func(i, j int) bool {
		if assignmentTunnels[i].EndpointID == assignmentTunnels[j].EndpointID {
			return assignmentTunnels[i].AssignmentGeneration < assignmentTunnels[j].AssignmentGeneration
		}
		return assignmentTunnels[i].EndpointID < assignmentTunnels[j].EndpointID
	})
	return RuntimeSnapshot{
		RegisteredEndpoints:   uint64(len(b.endpoints)),
		ActiveTunnels:         uint64(len(b.active)),
		ActiveProxyTunnels:    usage.ActiveProxy,
		ActiveDatabaseTunnels: usage.ActiveDatabase,
		ActiveRegistryTunnels: usage.ActiveRegistry,
		Admission:             b.admission.GetSnapshot(),
		Draining:              b.draining.Load(),
		AssignmentTunnels:     assignmentTunnels,
	}
}

func (b *Broker) SetDraining(value bool) { b.draining.Store(value) }

// SetLaneHint sets how the broker learns that a tunnel's lane connection has
// a collapsed sending side (see hintLane).
func (b *Broker) SetLaneHint(collapsed func(context.Context) bool) { b.laneCollapsed = collapsed }

// hintLane tells the node on the other end of stream, with the stream's
// response header, that the relay's sending side of the lane collapsed: the
// node replaces the lane's connection and moves its resumable streams there
// (connector.LaneRenewHeader). Nodes that predate it ignore the header.
func (b *Broker) hintLane(stream grpc.ServerStream) {
	if b.laneCollapsed != nil && b.laneCollapsed(stream.Context()) {
		_ = stream.SetHeader(metadata.Pairs(connector.LaneRenewHeader, "1"))
	}
}

func (b *Broker) Draining() bool { return b.draining.Load() }

// ForceDisconnect closes established streams only after the control plane has
// explicitly placed the worker in drain mode. It never changes policy or
// resumes admission by itself. The tunnels end Unavailable "relay is
// draining", which daemons fail over on.
func (b *Broker) ForceDisconnect() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.draining.Load() {
		return 0
	}
	count := uint64(len(b.active))
	for _, tunnel := range b.active {
		tunnel.closeWith(codes.Unavailable, "relay is draining")
	}
	return count
}

func (b *Broker) Reconcile(previous, next *policy.Snapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reconcileLocked(next)
}

// ApplySnapshot serializes the policy swap with endpoint and tunnel
// admission: the snapshot becomes current under mu, where every admission
// validates its grant. A grant can therefore never pass against one revision
// and be admitted after a newer revision has become current. Validation and
// the fsync run before, without mu, so admission does not wait for the disk
// (F4); concurrent applies are serialized by the store.
func (b *Broker) ApplySnapshot(request *relayv1.ApplySnapshotRequest) (*policy.Snapshot, bool, error) {
	next, unchanged, err := b.store.ApplyStaged(request, func(next *policy.Snapshot, makeCurrent func()) {
		if b.lease != nil {
			// Adopt the snapshot's lease blocks before the new policy admits
			// anything. Outside mu: the lease node persists what it adopts.
			// The store already trusts the snapshot's policy keys.
			b.lease.ApplyPolicy(next)
		}
		b.mu.Lock()
		makeCurrent()
		b.reconcileLocked(next)
		b.mu.Unlock()
	})
	if err != nil {
		return nil, false, err
	}
	if !unchanged && b.lease != nil {
		// Drop registrations and tunnels the new view no longer admits.
		b.EnforceLeaseGates()
	}
	return next, unchanged, nil
}

func (b *Broker) reconcileLocked(next *policy.Snapshot) {
	b.admission.UpdatePolicy(next.Admission)
	for routeID, metrics := range b.routeMetrics {
		if next.Routes[routeID] == nil && metrics.active.Load() == 0 {
			delete(b.routeMetrics, routeID)
		}
	}
	now := time.Now().UnixNano()
	for id, registration := range b.endpoints {
		endpoint := next.Endpoint(registration.endpointID, registration.assignmentGeneration)
		if endpoint == nil || endpoint.AssignmentGeneration != registration.assignmentGeneration || endpoint.Generation < registration.generation {
			registration.close()
			delete(b.endpoints, id)
			continue
		}
		if endpoint.Generation > registration.generation {
			// The endpoint moved to a newer generation (its target's
			// certificate rotated, or its target node changed) while this
			// registration serves: it keeps serving, bounded by its grant,
			// until the new generation registers, instead of leaving a gap of
			// one grant sync (make-before-break).
			registration.supersededAt.CompareAndSwap(0, now)
		}
		if registration.pending != nil || registration.supersededAt.Load() != 0 {
			registration.nudge()
		}
	}
	for _, tunnel := range b.active {
		route := next.Route(tunnel.routeID, tunnel.assignmentGeneration)
		endpoint := next.Endpoint(tunnel.endpointID, tunnel.assignmentGeneration)
		// A newer endpoint generation alone does not end a tunnel: it keeps
		// running on the registration it was bridged through until that ends.
		if route == nil || route.AssignmentGeneration != tunnel.assignmentGeneration || route.Generation != tunnel.routeGeneration || endpoint == nil || endpoint.AssignmentGeneration != tunnel.assignmentGeneration || endpoint.Generation < tunnel.endpointGeneration {
			tunnel.close()
		}
	}
	if b.policyChanged != nil {
		close(b.policyChanged)
	}
	b.policyChanged = make(chan struct{})
}

// policyAhead reports a grant that names an endpoint generation or assignment
// this relay's policy does not have yet: the daemon got its grant before the
// relay got the policy, which follows within seconds.
func policyAhead(claims grant.Claims, snapshot *policy.Snapshot) bool {
	endpoint := snapshot.Endpoint(claims.EndpointID, claims.AssignmentGeneration)
	return endpoint == nil || endpoint.Generation < claims.EndpointGeneration ||
		(claims.AssignmentGeneration > 0 && endpoint.AssignmentGeneration < claims.AssignmentGeneration)
}

// routePolicyAhead is policyAhead for a connect grant: its route, or the
// route's generation or assignment, is not in this relay's policy yet.
func routePolicyAhead(claims grant.Claims, snapshot *policy.Snapshot) bool {
	route := snapshot.Route(claims.RouteID, claims.AssignmentGeneration)
	return route == nil || route.Generation < claims.RouteGeneration ||
		(claims.AssignmentGeneration > 0 && route.AssignmentGeneration < claims.AssignmentGeneration)
}
