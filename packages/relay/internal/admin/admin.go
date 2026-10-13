package admin

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/relaylocal"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/broker"
	"github.com/opfield/opfield/relay/internal/config"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/identity"
	"github.com/opfield/opfield/relay/internal/peer"
	"github.com/opfield/opfield/relay/internal/policy"
	"github.com/opfield/opfield/relay/internal/proxy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Service struct {
	relayv1.UnimplementedRelayAdminServer
	store        *policy.Store
	broker       *broker.Broker
	identity     *identity.Store
	reloadApp    func() error
	buildVersion string
	lease        LeaseReporter
	// snapshotRefusals rate-limits the log of refused snapshots.
	snapshotRefusals logLimiter
}

// logLimiter allows one log line per key and minute.
type logLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func (l *logLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.last == nil || len(l.last) > 256 {
		l.last = map[string]time.Time{}
	}
	if last, ok := l.last[key]; ok && now.Sub(last) < time.Minute {
		return false
	}
	l.last[key] = now
	return true
}

// LeaseReporter is the relay's availability lease coordinator.
type LeaseReporter interface {
	Report() *relayv1.AvailabilityLeaseReport
}

// HolderStatementVerifier checks holder statements of stateful lease keys
// (availabilitylease.Node.VerifyHolderStatement).
type HolderStatementVerifier interface {
	VerifyHolderStatement(key availabilitylease.Key, domain string, payload, signature []byte) (string, error)
}

// HolderStatementCapability: the relay verifies holder statements for its
// supervisor (VerifyHolderStatement).
const HolderStatementCapability = "relay_holder_statement_v1"

// SetLeaseReporter adds the availability lease view and capability to health.
func (s *Service) SetLeaseReporter(reporter LeaseReporter) { s.lease = reporter }

func New(store *policy.Store, broker *broker.Broker, identityStore *identity.Store, reloadApp func() error, buildVersion string) *Service {
	return &Service{store: store, broker: broker, identity: identityStore, reloadApp: reloadApp, buildVersion: buildVersion}
}

func (s *Service) caller(ctx context.Context) (peer.Identity, error) {
	caller, ok := peer.FromContext(ctx)
	if !ok {
		return peer.Identity{}, status.Error(codes.Unauthenticated, "Opfield app service certificate required")
	}
	if !s.identity.AuthorizeAppClient(caller.CertificateFingerprint) {
		return peer.Identity{}, status.Error(codes.PermissionDenied, "Opfield app service certificate required")
	}
	return caller, nil
}

func (s *Service) authorize(ctx context.Context) error {
	_, err := s.caller(ctx)
	return err
}

func (s *Service) GetHealth(ctx context.Context, _ *relayv1.HealthRequest) (*relayv1.HealthResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	current := s.store.Current()
	runtime := s.broker.RuntimeSnapshot()
	var policyExpiresAtUnix int64
	if !current.ExpiresAt.IsZero() {
		policyExpiresAtUnix = current.ExpiresAt.Unix()
	}
	ready := s.store.Ready(time.Now()) && len(current.PublicKeys) > 0
	reason := ""
	if !ready {
		if err := s.store.AdmissionError(time.Now()); err != nil {
			reason = err.Error()
		} else {
			reason = "grant_public_keys_required"
		}
	}
	return &relayv1.HealthResponse{
		BuildVersion: s.buildVersion, ProtocolMajor: 1, AppliedRevision: current.Revision,
		KeyIds: s.store.KeyIDs(), RegisteredEndpoints: runtime.RegisteredEndpoints,
		ActiveTunnels: runtime.ActiveTunnels, ActiveProxyTunnels: runtime.ActiveProxyTunnels,
		ActiveDatabaseTunnels:  runtime.ActiveDatabaseTunnels,
		ThrottledProxyTotal:    runtime.Admission.ThrottledProxyTotal,
		ThrottledDatabaseTotal: runtime.Admission.ThrottledDatabaseTotal,
		PressurePercent:        runtime.Admission.PressurePercent,
		CpuPressurePercent:     runtime.Admission.CPUPressurePercent,
		MemoryPressurePercent:  runtime.Admission.MemoryPressurePercent,
		FdPressurePercent:      runtime.Admission.FDPressurePercent,
		AdmissionState:         runtime.Admission.State,
		MemoryRssBytes:         runtime.Admission.MemoryRSSBytes,
		HeapInUseBytes:         runtime.Admission.HeapInUseBytes,
		MemoryLimitBytes:       runtime.Admission.MemoryLimitBytes,
		OpenFileDescriptors:    runtime.Admission.OpenFileDescriptors,
		FileDescriptorLimit:    runtime.Admission.FileDescriptorLimit,
		Liveness:               true, Readiness: ready, Reason: reason,
		PoolId: current.PoolID, RelayInstanceId: current.RelayInstanceID, Mode: current.Mode,
		PolicyExpiresAtUnix: policyExpiresAtUnix, Capabilities: healthCapabilities(current.Mode, s.lease != nil),
		AvailabilityLease: s.leaseReport(),
		Draining:          runtime.Draining,
		PolicyKeyIds:      s.store.PolicyKeyIDs(),
		AssignmentTunnels: func() []*relayv1.AssignmentTunnelCount {
			result := make([]*relayv1.AssignmentTunnelCount, 0, len(runtime.AssignmentTunnels))
			for _, count := range runtime.AssignmentTunnels {
				result = append(result, &relayv1.AssignmentTunnelCount{
					EndpointId: count.EndpointID, AssignmentGeneration: count.AssignmentGeneration, ActiveTunnels: count.ActiveTunnels,
				})
			}
			return result
		}(),
	}, nil
}

// healthCapabilities lists what Gateway may rely on. Only the local relay
// advertises the trust reset: a remote relay refuses it.
func healthCapabilities(mode relayv1.RelayMode, availabilityLease bool) []string {
	capabilities := []string{
		policy.PoolCapability, "signed_policy_envelope_v1", identity.ServerCertificateRolloverCapability,
		policy.LongLeaseCapability, broker.EndpointRestartCapability, broker.DrainKeepsLocalServicesCapability,
		broker.RegistryFairShareCapability, relaylocal.EndpointsCapability, relaylocal.DialRouteCapability,
		grant.AudienceCapability, config.OpfieldRegistryCapability,
	}
	if mode == relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED {
		capabilities = append(capabilities, policy.TrustResetCapability, proxy.MetadataCapability)
	}
	if availabilityLease {
		capabilities = append(capabilities, AvailabilityLeaseCapability, availabilitylease.CapabilityV3, HolderStatementCapability)
	}
	return capabilities
}

// AvailabilityLeaseCapability tells Gateway the relay coordinates Docker
// Availability data-plane leases (Coordinate, gate fencing, lease view). It is
// versioned (D3): v2 sends clock beacons and carries its clock in lease frames
// for peer-time freeze detection (D4). Gateway treats v1 as outdated. Relays
// that run it also advertise availability_lease_v3 (availabilitylease.
// CapabilityV3): they accept, persist and report certified holder state of
// stateful policies.
const AvailabilityLeaseCapability = "availability_lease_v2"

func (s *Service) leaseReport() *relayv1.AvailabilityLeaseReport {
	if s.lease == nil {
		return nil
	}
	return s.lease.Report()
}

func (s *Service) GetRouteRuntime(ctx context.Context, request *relayv1.RouteRuntimeRequest) (*relayv1.RouteRuntimeResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	if request.GetRouteId() == "" {
		return nil, status.Error(codes.InvalidArgument, "route id is required")
	}
	runtime, found := s.broker.RouteRuntimeSnapshot(request.GetRouteId())
	if !found {
		return nil, status.Error(codes.NotFound, "relay route is not active")
	}
	return &relayv1.RouteRuntimeResponse{
		RouteId:                      runtime.RouteID,
		ActiveTunnels:                runtime.ActiveTunnels,
		OpenedTotal:                  runtime.OpenedTotal,
		CompletedTotal:               runtime.CompletedTotal,
		FailedTotal:                  runtime.FailedTotal,
		ThrottledTotal:               runtime.ThrottledTotal,
		SourceToTargetBytes:          runtime.SourceToTargetBytes,
		TargetToSourceBytes:          runtime.TargetToSourceBytes,
		SetupLatencyP95Microseconds:  runtime.SetupLatencyP95Micros,
		AverageDurationMilliseconds:  runtime.AverageDurationMillis,
		LastActivityUnixMilliseconds: runtime.LastActivityUnixMillis,
		MetricsSinceUnixMilliseconds: runtime.MetricsSinceUnixMillis,
	}, nil
}

func (s *Service) ApplySnapshot(ctx context.Context, request *relayv1.ApplySnapshotRequest) (*relayv1.ApplySnapshotResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	next, unchanged, err := s.broker.ApplySnapshot(request)
	if err != nil {
		// Gateway retries every few seconds: one line per reason a minute (F8).
		if s.snapshotRefusals.allow(err.Error(), time.Now()) {
			slog.Warn("relay refused a policy snapshot", "applied_revision", s.store.Current().Revision, "error", err)
		}
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	if !unchanged {
		slog.Info("relay applied a policy snapshot", "revision", next.Revision, "endpoints", len(next.Endpoints),
			"routes", len(next.Routes), "policy_expires_at", next.ExpiresAt)
	}
	var policyExpiresAtUnix int64
	if !next.ExpiresAt.IsZero() {
		policyExpiresAtUnix = next.ExpiresAt.Unix()
	}
	return &relayv1.ApplySnapshotResponse{
		AppliedRevision: next.Revision, Unchanged: unchanged, PoolId: next.PoolID,
		RelayInstanceId: next.RelayInstanceID, PolicyExpiresAtUnix: policyExpiresAtUnix,
	}, nil
}

func (s *Service) BootstrapPolicyTrust(ctx context.Context, request *relayv1.BootstrapPolicyTrustRequest) (*relayv1.BootstrapPolicyTrustResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	unchanged, err := s.store.BootstrapPolicyTrust(request.KeyId, request.PublicKey, request.PublicKeyFingerprint)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &relayv1.BootstrapPolicyTrustResponse{
		KeyId: request.KeyId, PublicKeyFingerprint: request.PublicKeyFingerprint, Unchanged: unchanged,
	}, nil
}

// ResetLocalPolicyTrust lets the co-located Gateway re-pin policy trust on the
// local combined relay, for example after relay.db was restored from a backup
// older than every key Gateway can still sign with. The store refuses it in
// remote mode, where trust changes only through signed rotation.
func (s *Service) ResetLocalPolicyTrust(ctx context.Context, request *relayv1.ResetLocalPolicyTrustRequest) (*relayv1.ResetLocalPolicyTrustResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	replaced, err := s.store.ResetLocalPolicyTrust(request.KeyId, request.PublicKey, request.PublicKeyFingerprint)
	if err != nil {
		slog.Warn("refused policy trust reset", "key_id", request.KeyId, "error", err)
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	slog.Warn("Opfield reset pinned policy trust", "key_id", request.KeyId, "fingerprint", request.PublicKeyFingerprint, "replaced_key_ids", replaced)
	return &relayv1.ResetLocalPolicyTrustResponse{
		KeyId: request.KeyId, PublicKeyFingerprint: request.PublicKeyFingerprint, ReplacedKeyIds: replaced,
	}, nil
}

// DialRoute opens a relay-originated tunnel for the relay supervisor's witness
// processes (relaylocal). Only the admin identity may call it.
func (s *Service) DialRoute(stream relayv1.RelayAdmin_DialRouteServer) error {
	if err := s.authorize(stream.Context()); err != nil {
		return err
	}
	return s.broker.DialRoute(stream)
}

// VerifyHolderStatement checks a holder statement for the relay supervisor
// (activation of a staged standby Keeper witness). Only the admin identity may
// call it.
func (s *Service) VerifyHolderStatement(ctx context.Context, request *relayv1.VerifyHolderStatementRequest) (*relayv1.VerifyHolderStatementResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	verifier, ok := s.lease.(HolderStatementVerifier)
	if s.lease == nil || !ok {
		return nil, status.Error(codes.FailedPrecondition, "this relay does not run the availability lease")
	}
	holder, err := verifier.VerifyHolderStatement(availabilitylease.Key{PolicyID: request.GetPolicyId(), Slot: request.GetSlot()},
		request.GetDomain(), request.GetPayload(), request.GetSignature())
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	return &relayv1.VerifyHolderStatementResponse{HolderId: holder}, nil
}

func (s *Service) SetDrain(ctx context.Context, request *relayv1.SetDrainRequest) (*relayv1.SetDrainResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	s.broker.SetDraining(request.Draining)
	var disconnected uint64
	if request.GetForceDisconnect() {
		if !request.GetDraining() {
			return nil, status.Error(codes.FailedPrecondition, "force disconnect requires drain mode")
		}
		disconnected = s.broker.ForceDisconnect()
	}
	return &relayv1.SetDrainResponse{Draining: s.broker.Draining(), DisconnectedTunnels: disconnected}, nil
}

func (s *Service) ReloadIdentity(ctx context.Context, request *relayv1.ReloadIdentityRequest) (*relayv1.ReloadIdentityResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	if err := s.identity.Reload(request.OperationId); err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	// Existing upstream transports presented the previous relay client leaf.
	// Force the next proxied RPC to establish TLS with the newly loaded leaf
	// before Gateway commits its staged fingerprint trust.
	if err := s.reloadApp(); err != nil {
		return nil, status.Error(codes.Unavailable, "relay app client identity reload failed")
	}
	external, relayClient, appClient := s.identity.Current().LoadedFingerprints()
	return &relayv1.ReloadIdentityResponse{
		Reloaded:                     true,
		ExternalCertificateSha256:    external,
		RelayClientCertificateSha256: relayClient,
		AppClientCertificateSha256:   appClient,
	}, nil
}

func (s *Service) CommitIdentityRotation(ctx context.Context, request *relayv1.CommitIdentityRotationRequest) (*relayv1.CommitIdentityRotationResponse, error) {
	caller, err := s.caller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.identity.CommitAppClientRotation(request.OperationId, caller.CertificateFingerprint); err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &relayv1.CommitIdentityRotationResponse{Committed: true}, nil
}
