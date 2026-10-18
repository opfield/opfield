package supervisor

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
)

const (
	relayPoolCapability = "relay_pool_v1"
	// RelayServicePortCapability: the supervisor moves its worker to another
	// TCP port on SetRelayServicePortCommand.
	RelayServicePortCapability = "relay_service_port_v1"
	// servicePortReadyTimeout is how long the worker has to become ready on a
	// new port, and again on the previous one when it is moved back.
	servicePortReadyTimeout = 20 * time.Second
)

type Plugin struct {
	cfg *config.Config
	// configPath resolves the config file a port change is written to, at the
	// time of the change: a root relay may move its directories to their
	// Opfield names while it runs.
	configPath func() string
	logger     *slog.Logger
	worker     *workerManager
	mu         sync.RWMutex
	last       *pb.RelayRuntimeStatus
	started    bool
	// lastAdminSync throttles the admin client certificate check.
	lastAdminSync time.Time
	// witnesses runs the witness processes this relay hosts.
	witnesses *witnessManager
}

func New(cfg *config.Config) *Plugin {
	return &Plugin{cfg: cfg, worker: newWorkerManager(cfg.Worker, cfg.StateDir)}
}

// WithConfigPath tells the plugin where its config file is; a port change
// is written there.
func (p *Plugin) WithConfigPath(resolve func() string) *Plugin {
	p.configPath = resolve
	return p
}

func (p *Plugin) Type() string { return "relay" }

func (p *Plugin) SetLogger(logger *slog.Logger) { p.logger = logger }

func (p *Plugin) Init(_ *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.logger = logger
	p.startWitnesses()
	p.scheduleHostNames()
	return nil
}

// startWitnesses restores the last applied witness set and runs it, with or
// without an Opfield session.
func (p *Plugin) startWitnesses() {
	if p.witnesses != nil {
		return
	}
	rt := newHostWitnessRuntime(p.cfg.StateDir, p.logger, func(ctx context.Context) (relayv1.RelayAdmin_DialRouteClient, error) {
		client, err := p.worker.connectAdmin(ctx)
		if err != nil {
			return nil, err
		}
		return client.DialRoute(ctx)
	})
	p.witnesses = newWitnessManager(filepath.Join(p.cfg.StateDir, "witness"), rt.root, p.logger, p.witnessHosting, rt)
	p.witnesses.verify = func(ctx context.Context, policyID string, slot uint32, domain string, payload, signature []byte) (string, error) {
		client, err := p.worker.connectAdmin(ctx)
		if err != nil {
			return "", err
		}
		response, err := client.VerifyHolderStatement(ctx, &relayv1.VerifyHolderStatementRequest{
			PolicyId: policyID, Slot: slot, Domain: domain, Payload: payload, Signature: signature})
		if err != nil {
			return "", err
		}
		return response.GetHolderId(), nil
	}
	if err := p.witnesses.load(); err != nil && p.logger != nil {
		p.logger.Warn("relay witness state could not be restored", "error", err)
	}
	p.witnesses.Start()
}

// PersistEnrollmentBundle stores a new enrollment, first or repeated. The
// worker starts over from the enrollment key: its previous policy trust is
// moved aside, which is how a re-enrollment repairs a relay that trusts only
// keys Opfield can no longer sign with.
func (p *Plugin) PersistEnrollmentBundle(response *pb.EnrollResponse) error {
	if _, err := validateEnrollmentBundle(response); err != nil {
		return err
	}
	// From here on Opfield considers the relay enrolled with this bundle; the
	// previous identity is superseded. Record the bundle first, so a failure
	// below is completed on the next start rather than leaving the relay half
	// re-enrolled.
	if err := savePendingEnrollment(p.cfg.StateDir, response); err != nil {
		return err
	}
	return p.completeEnrollment(response)
}

func (p *Plugin) completeEnrollment(response *pb.EnrollResponse) error {
	p.worker.shutdown()
	if err := persistEnrollmentBundle(p.cfg.StateDir, p.cfg.Worker.IdentityDir, response); err != nil {
		return err
	}
	if err := resetWorkerPolicyState(p.cfg.Worker.StateDir, time.Now()); err != nil {
		return err
	}
	discardStashedIdentity(&p.cfg.BaseConfig)
	if err := removePendingEnrollment(p.cfg.StateDir); err != nil {
		return err
	}
	if err := RecordEnrollmentOutcome(p.cfg.StateDir, nil); err != nil && p.logger != nil {
		p.logger.Warn("record the relay enrollment outcome", "error", err)
	}
	return nil
}

// CompletePendingEnrollment finishes an enrollment whose bundle arrived but
// was not fully persisted. It reports whether there was one.
func CompletePendingEnrollment(cfg *config.Config) (bool, error) {
	response, err := loadPendingEnrollment(cfg.StateDir)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	return true, New(cfg).completeEnrollment(response)
}

func (p *Plugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	state, _ := loadEnrollmentState(p.cfg.StateDir)
	register := &pb.RegisterMessage{
		NodeId: nodeID, Hostname: hostname, DaemonVersion: lifecycle.Version,
		CpuModel: cpuModel, CpuCores: int32(cpuCores), Architecture: sysmetrics.GetArchitecture(),
		KernelVersion: sysmetrics.GetKernelVersion(), DaemonType: "relay",
		Capabilities: append([]string{relayPoolCapability, relayRouteRuntimeCapability, RelayWitnessCapability, RelayServicePortCapability}, p.protectedRegistrationCapabilities()...),
	}
	if state != nil {
		register.HostIdentityId = state.HostIdentityID
		register.RelayInstanceId = state.InstanceID
	}
	return register
}

func (p *Plugin) HandleCommand(command *pb.OpfieldCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: command.GetCommandId(), Success: true}
	var err error
	switch payload := command.GetPayload().(type) {
	case *pb.OpfieldCommand_SyncRelayPolicy:
		if refusal := p.protectedPolicyRefusal(payload.SyncRelayPolicy.GetApplySnapshotRequest()); refusal != "" {
			result.Success = false
			result.Error = refusal
			return result
		}
		var responseRevision uint64
		var responseUnchanged bool
		var responseExpiry int64
		var responsePool, responseInstance string
		applied, applyErr := p.worker.applyPolicy(context.Background(), payload.SyncRelayPolicy.GetApplySnapshotRequest())
		if applyErr == nil {
			responseRevision = applied.GetAppliedRevision()
			responseUnchanged = applied.GetUnchanged()
			responseExpiry = applied.GetPolicyExpiresAtUnix()
			responsePool = applied.GetPoolId()
			responseInstance = applied.GetRelayInstanceId()
			result.Detail = fmt.Sprintf("revision=%d unchanged=%t expires_at=%d pool=%s instance=%s", responseRevision, responseUnchanged, responseExpiry, responsePool, responseInstance)
		}
		err = applyErr
	case *pb.OpfieldCommand_SetRelayDrain:
		err = p.worker.setDrain(
			context.Background(),
			payload.SetRelayDrain.GetEnabled(),
			payload.SetRelayDrain.GetForceDisconnect(),
		)
		if err == nil {
			result.Detail = fmt.Sprintf(
				"draining=%t force_disconnect=%t",
				payload.SetRelayDrain.GetEnabled(),
				payload.SetRelayDrain.GetForceDisconnect(),
			)
		}
	case *pb.OpfieldCommand_UpdateRelayWorker:
		update := payload.UpdateRelayWorker
		if refusal := p.protectedWorkerUpdateRefusal(update.GetTargetVersion()); refusal != "" {
			result.Success = false
			result.Error = refusal
			return result
		}
		err = p.worker.update(
			context.Background(),
			update.GetDownloadUrl(),
			update.GetTargetVersion(),
			update.GetChecksum(),
			update.GetSignedManifest(),
			p.logger,
		)
		if err == nil {
			result.Detail = fmt.Sprintf("relay worker updated to %s", update.GetTargetVersion())
		}
	case *pb.OpfieldCommand_RenewRelayIdentity:
		var fingerprint string
		fingerprint, err = p.worker.renewIdentity(context.Background(), payload.RenewRelayIdentity, p.cfg.TLS.ClientCert, p.cfg.TLS.ClientKey)
		if err == nil {
			result.Detail = fmt.Sprintf("server_identity=%s server_fingerprint=%s", payload.RenewRelayIdentity.GetServerIdentity(), fingerprint)
		}
	case *pb.OpfieldCommand_GetRelayRouteRuntime:
		result.Detail, err = p.worker.routeRuntime(context.Background(), payload.GetRelayRouteRuntime.GetRouteIds())
	case *pb.OpfieldCommand_ApplyWitnesses:
		if p.witnesses == nil {
			p.startWitnesses()
		}
		result.Detail, err = p.witnesses.Apply(payload.ApplyWitnesses)
	case *pb.OpfieldCommand_SetRelayServicePort:
		result.Detail, err = p.changeServicePort(context.Background(), int(payload.SetRelayServicePort.GetServicePort()))
	case *pb.OpfieldCommand_SetDaemonLogStream:
		stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
	default:
		result.Success = false
		result.Error = "unsupported command for relay supervisor"
		return result
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
	}
	return result
}

func (p *Plugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	p.mu.RLock()
	last := p.last
	p.mu.RUnlock()
	if last != nil {
		base.ConfigValid = last.GetState() == "ready" || last.GetState() == "draining" || last.GetState() == "synchronizing"
		base.NginxRunning = last.GetState() != "offline" && last.GetState() != "error"
	}
	p.reportLegacyHostNames(base)
	return base
}

func (p *Plugin) CollectStats() *pb.StatsReport { return nil }

func (p *Plugin) OnSessionStart(ctx context.Context, writer *stream.Writer) error {
	p.mu.Lock()
	p.started = true
	p.mu.Unlock()
	go p.reportLoop(ctx, writer)
	return nil
}

func (p *Plugin) OnSessionEnd() {
	p.mu.Lock()
	p.started = false
	p.mu.Unlock()
}

func (p *Plugin) Shutdown() {
	if p.witnesses != nil {
		p.witnesses.Shutdown()
	}
	p.worker.shutdown()
}

func (p *Plugin) reportLoop(ctx context.Context, writer *stream.Writer) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		status := p.collectRuntime(ctx)
		p.mu.Lock()
		p.last = status
		p.mu.Unlock()
		if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_RelayRuntimeStatus{RelayRuntimeStatus: status}}); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// syncAdminClientIfDue moves the worker's admin client onto the supervisor's
// current certificate after the daemon lifecycle renewed it, before the one
// the worker trusts expires.
func (p *Plugin) syncAdminClientIfDue(ctx context.Context) {
	p.mu.Lock()
	due := time.Since(p.lastAdminSync) >= adminClientSyncInterval
	if due {
		p.lastAdminSync = time.Now()
	}
	p.mu.Unlock()
	if !due {
		return
	}
	if err := p.worker.syncAdminClient(ctx, p.cfg.TLS.ClientCert, p.cfg.TLS.ClientKey); err != nil && p.logger != nil {
		p.logger.Warn("relay worker admin client renewal deferred", "error", err)
	}
}

func (p *Plugin) collectRuntime(ctx context.Context) *pb.RelayRuntimeStatus {
	state, _ := loadEnrollmentState(p.cfg.StateDir)
	status := &pb.RelayRuntimeStatus{
		State: "joining", Capabilities: append([]string{relayPoolCapability, RelayWitnessCapability, RelayServicePortCapability}, p.protectedCapabilities()...),
		AdvertisedAddresses: append([]string(nil), p.cfg.Worker.AdvertisedAddresses...), ServicePort: uint32(p.worker.servicePort()),
	}
	p.fillWitnessStatus(status)
	if state != nil {
		status.RelayInstanceId = state.InstanceID
	}
	if err := p.worker.keepRunning(); err != nil {
		status.State = "error"
		status.Error = err.Error()
		return status
	}
	p.syncAdminClientIfDue(ctx)
	health, err := p.worker.health(ctx)
	if err != nil {
		status.State = "offline"
		status.Error = err.Error()
		return status
	}
	// Bootstrap only a relay without policy trust, and keep reporting when it
	// fails: an early return here hid the relay's real state and trusted keys,
	// which dropped it from placement and stalled key rotation for the pool.
	var bootstrapErr error
	if len(health.GetPolicyKeyIds()) == 0 {
		if bootstrapErr = p.worker.ensurePolicyTrust(ctx, health); bootstrapErr == nil {
			if refreshed, refreshErr := p.worker.health(ctx); refreshErr == nil {
				health = refreshed
			}
		}
	}
	status.BuildVersion = health.GetBuildVersion()
	status.ProtocolMajor = health.GetProtocolMajor()
	status.Capabilities = append(append(append([]string(nil), health.GetCapabilities()...), RelayWitnessCapability, RelayServicePortCapability), p.protectedCapabilities()...)
	status.AppliedPolicyRevision = health.GetAppliedRevision()
	status.PolicyExpiresAtUnix = health.GetPolicyExpiresAtUnix()
	status.RegisteredEndpoints = health.GetRegisteredEndpoints()
	status.ActiveTunnels = health.GetActiveTunnels()
	status.PressurePercent = uint32(max(0, health.GetPressurePercent()))
	status.Draining = health.GetDraining()
	status.PolicySigningKeyIds = append([]string(nil), health.GetPolicyKeyIds()...)
	status.AssignmentTunnels = make([]*pb.RelayAssignmentTunnelCount, 0, len(health.GetAssignmentTunnels()))
	for _, count := range health.GetAssignmentTunnels() {
		status.AssignmentTunnels = append(status.AssignmentTunnels, &pb.RelayAssignmentTunnelCount{
			EndpointId: count.GetEndpointId(), AssignmentGeneration: count.GetAssignmentGeneration(), ActiveTunnels: count.GetActiveTunnels(),
		})
	}
	status.AvailabilityLease = forwardAvailabilityLease(health.GetAvailabilityLease(), p.logger)
	status.Error = health.GetReason()
	if bootstrapErr != nil && status.Error == "" {
		status.Error = "bootstrap policy trust: " + bootstrapErr.Error()
	} else if bootstrapErr != nil {
		status.Error += "; bootstrap policy trust: " + bootstrapErr.Error()
	}
	switch {
	case health.GetDraining():
		status.State = "draining"
	case health.GetReadiness():
		status.State = "ready"
	default:
		status.State = "synchronizing"
	}
	return status
}

// changeServicePort moves the worker to another TCP port on Opfield's
// command and keeps it in the config file. Protected mode refuses it: the
// owner of the machine sets the port there (setup-relay-node.sh
// --service-port), and Opfield never writes the config file of a protected
// relay.
func (p *Plugin) changeServicePort(ctx context.Context, port int) (string, error) {
	if p.cfg.Protected.Enabled {
		return "", fmt.Errorf("this relay runs in protected mode: change its port on the relay host with setup-relay-node.sh --service-port")
	}
	if p.configPath == nil || p.configPath() == "" {
		return "", fmt.Errorf("the relay supervisor does not know its config file")
	}
	detail, err := p.worker.changeServicePort(ctx, port, func(port int) error {
		return config.SetWorkerServicePort(p.configPath(), port)
	}, servicePortReadyTimeout)
	if p.logger != nil {
		if err != nil {
			p.logger.Warn("relay port change failed", "service_port", port, "error", err)
		} else {
			p.logger.Info("relay worker listens on a new port", "detail", detail)
		}
	}
	return detail, err
}

// HasPendingEnrollment reports a received but not fully persisted enrollment.
func HasPendingEnrollment(cfg *config.Config) bool {
	_, err := os.Stat(filepath.Join(cfg.StateDir, pendingEnrollmentFile))
	return err == nil
}
