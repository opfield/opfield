package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"sort"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Availability set members on a storage-profile daemon: the member runtime
// (internal/memberha) is the lease runtime's controller for the sets' lease
// policies, the relay paths (relay_lease_groups.go) follow its serving state,
// and Gateway configures it with AvailabilityMemberCommand and reads it from
// the health report.

// managedAvailabilityMemberCapability: this daemon runs availability set
// members (lease runtime with a live watchdog, the member runtime, and at least
// one engine). Gateway makes a node a candidate of a set only with it.
const managedAvailabilityMemberCapability = "managed_availability_member_v1"

// managedAvailabilityMemberLifecycleCapability: the member runtime also takes
// a paused set (AvailabilityMemberConfig.stopped), the restart command for
// every engine, and the member update rule (a copy's container is recreated
// for a new image or settings fixed at creation; the primary refuses with
// AVAILABILITY_SWITCHOVER_REQUIRED; a Postgres major change is refused with
// POSTGRES_MAJOR_CHANGE). Gateway pauses, restarts and rolls a set's engine
// only when every member node has it.
const managedAvailabilityMemberLifecycleCapability = "managed_availability_member_lifecycle_v1"

// SetMemberEngineFactory opens one member's engine on this daemon.
type SetMemberEngineFactory func(p *DockerPlugin, config memberha.Config) (memberha.Engine, error)

var (
	setMemberEnginesMu sync.RWMutex
	setMemberEngines   = map[string]SetMemberEngineFactory{}
)

// RegisterSetMemberEngine registers the member engine of one engine name
// ("postgres", "valkey", "seaweedfs", "clickhouse").
func RegisterSetMemberEngine(engine string, factory SetMemberEngineFactory) {
	setMemberEnginesMu.Lock()
	setMemberEngines[engine] = factory
	setMemberEnginesMu.Unlock()
}

func setMemberEngine(engine string) (SetMemberEngineFactory, bool) {
	setMemberEnginesMu.RLock()
	defer setMemberEnginesMu.RUnlock()
	factory, ok := setMemberEngines[engine]
	return factory, ok
}

func setMemberEngineNames() []string {
	setMemberEnginesMu.RLock()
	defer setMemberEnginesMu.RUnlock()
	names := make([]string, 0, len(setMemberEngines))
	for name := range setMemberEngines {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type bootWallClock struct{}

func (bootWallClock) Now() time.Duration { return leasefence.Now() }
func (bootWallClock) Wall() time.Time    { return time.Now() }

// setEndpointsAdapter re-registers the member's relay endpoints with the state
// the member runtime reports; a stop waits until the member's tunnels ended.
type setEndpointsAdapter struct{ plugin *DockerPlugin }

func (a setEndpointsAdapter) SetServing(_, _ string, serving bool) {
	closed := a.plugin.SetMemberServingChanged()
	if serving {
		return
	}
	timeout := time.NewTimer(endpointCloseWait)
	defer timeout.Stop()
	for _, done := range closed {
		select {
		case <-done:
		case <-timeout.C:
			return
		}
	}
}

// setMemberRuntimeAdapter is the relay side's view of the member runtime.
type setMemberRuntimeAdapter struct {
	manager *memberha.Manager
	plugin  *DockerPlugin
}

// setMemberBackupPort is the peer port a backup run reads a database member
// through (Gateway's backup source route of a copy, P3-T06): it reaches the
// member's own engine client port, whatever its role (a Postgres copy is a hot
// standby, a Valkey copy a replica, a ClickHouse copy read-only).
const setMemberBackupPort = "db-backup"

// managedAvailabilityBackupSourceCapability: database members serve
// setMemberBackupPort; Gateway backs a set up from a copy only on nodes with it.
const managedAvailabilityBackupSourceCapability = "managed_availability_backup_source_v1"

func (a setMemberRuntimeAdapter) MemberServing(setID, memberID string) (bool, bool) {
	return a.manager.MemberServing(setID, memberID)
}

func (a setMemberRuntimeAdapter) PeerServing(setID, memberID, port string) bool {
	return a.manager.PeerServing(setID, memberID, port)
}

// DialPeer serves the member-control port in this process and connects every
// other port to the member's engine.
func (a setMemberRuntimeAdapter) DialPeer(ctx context.Context, setID, memberID, port string) (net.Conn, error) {
	if port == setMemberBackupPort {
		return a.dialBackupSource(ctx, setID, memberID)
	}
	if port != memberha.MemberControlPort {
		return a.manager.DialPeer(ctx, setID, memberID, port)
	}
	state, ok := a.manager.PeerState(setID)
	if !ok || state.MemberID != memberID {
		return nil, errSetMemberNotServing
	}
	data, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	local, remote := net.Pipe()
	go func() {
		defer remote.Close()
		_ = remote.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, _ = remote.Write(append(data, '\n'))
	}()
	return local, nil
}

// dialBackupSource connects a backup run's tunnel to this node's database
// member's engine client port (the port a single-node backup route reaches).
func (a setMemberRuntimeAdapter) dialBackupSource(ctx context.Context, setID, memberID string) (net.Conn, error) {
	config, ok := a.manager.Config(setID)
	if !ok || config.MemberID != memberID {
		return nil, errSetMemberNotServing
	}
	if config.OwnerKind != "managed_database" || a.plugin == nil || a.plugin.databaseManager == nil {
		return nil, errors.New("only database members serve backup runs")
	}
	record, err := a.plugin.databaseManager.loadRecord(config.OwnerID)
	if err != nil {
		return nil, err
	}
	if record.AvailabilitySetID != setID && record.ClickhouseAvailabilitySetID != setID {
		return nil, errSetMemberNotServing
	}
	return a.plugin.databaseManager.dial(ctx, config.OwnerID)
}

// startSetMembers runs the availability set member runtime on a storage-profile
// daemon, as the lease runtime's controller. Call before the lease runtime's
// loop runs.
func (p *DockerPlugin) startSetMembers(runtime *lease.Runtime, fence lease.DirFence) error {
	store, err := memberha.NewStore(filepath.Join(p.cfg.StateDir, "availability-members"))
	if err != nil {
		return err
	}
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: runtime.Node(), Watchdog: fence, Endpoints: setEndpointsAdapter{plugin: p}, Gates: p.setGates.tracker(),
		Clock: bootWallClock{}, Logger: p.logger,
		Engine: func(config memberha.Config) (memberha.Engine, error) {
			factory, ok := setMemberEngine(config.Engine)
			if !ok {
				return nil, fmt.Errorf("this daemon cannot run %s availability members", config.Engine)
			}
			return factory(p, config)
		},
		GatewayConnected: p.sessionLive.Load,
		PeerState:        p.setPeerState,
		VerifyAssignment: func(setID string, assignment memberha.Assignment) error {
			return runtime.Node().VerifyGatewaySigned(memberha.AssignmentDomain, assignment.SigningKeyID,
				memberha.AssignmentStatement(setID, assignment), assignment.Signature)
		},
	}, store)
	if err != nil {
		return err
	}
	runtime.SetController(manager)
	p.setMembers = manager
	p.SetSetMemberRuntime(setMemberRuntimeAdapter{manager: manager, plugin: p})
	return nil
}

// setPeerState asks a manual pair's peer for its primary assignment over the
// member mesh (its member-control port).
func (p *DockerPlugin) setPeerState(ctx context.Context, setID, peerMemberID string) (memberha.PeerState, bool) {
	local, remote := net.Pipe()
	defer local.Close()
	done := make(chan error, 1)
	go func() { done <- p.BridgeSetPeer(remote, setID, "member-"+peerMemberID+"-"+memberha.MemberControlPort) }()
	if deadline, ok := ctx.Deadline(); ok {
		_ = local.SetReadDeadline(deadline)
	}
	var state memberha.PeerState
	if err := json.NewDecoder(local).Decode(&state); err != nil || state.MemberID != peerMemberID {
		return memberha.PeerState{}, false
	}
	return state, true
}

// setMemberCapabilities advertises the member runtime when it runs with a live
// watchdog and at least one engine.
func (p *DockerPlugin) setMemberCapabilities() []string {
	if p.setMembers == nil || p.lease == nil || !p.lease.watchdogReady() || len(setMemberEngineNames()) == 0 {
		return nil
	}
	capabilities := []string{managedAvailabilityMemberCapability, managedAvailabilityMemberLifecycleCapability,
		managedAvailabilityBackupSourceCapability}
	for _, engine := range setMemberEngineNames() {
		// Gateway's preflight requires the set's engine on every member node.
		capabilities = append(capabilities, "managed_availability_"+engine+"_v1")
	}
	return capabilities
}

// handleAvailabilityMember applies Gateway's command for this node's member of a set.
func (p *DockerPlugin) handleAvailabilityMember(command *pb.AvailabilityMemberCommand) error {
	if p.setMembers == nil {
		return errors.New("this daemon does not run availability set members")
	}
	switch action := command.GetAction().(type) {
	case *pb.AvailabilityMemberCommand_Configure:
		config := memberConfigFromProto(action.Configure)
		if err := p.setMembers.Configure(config); err != nil {
			return err
		}
		p.syncSetMemberPublication(config.SetID)
		if primary := action.Configure.GetPrimary(); primary != nil && primary.GetGeneration() > 0 {
			return p.assignSetPrimary(primary)
		}
		return nil
	case *pb.AvailabilityMemberCommand_Remove:
		if config, ok := p.setMembers.Config(action.Remove.GetSetId()); ok && config.MemberID != action.Remove.GetMemberId() {
			return errors.New("the set has another member on this node")
		}
		return p.setMembers.Remove(action.Remove.GetSetId())
	case *pb.AvailabilityMemberCommand_AckEvents:
		return p.setMembers.AckEvents(action.AckEvents.GetSetId(), action.AckEvents.GetThroughSequence())
	case *pb.AvailabilityMemberCommand_AssignPrimary:
		return p.assignSetPrimary(action.AssignPrimary)
	case *pb.AvailabilityMemberCommand_Switchover:
		switchover := action.Switchover
		return p.setMembers.Switchover(switchover.GetSetId(), switchover.GetSuccessorMemberId(), switchover.GetOperationId())
	case *pb.AvailabilityMemberCommand_Restart:
		restart := action.Restart
		if restart.GetOperationId() == "" {
			return errors.New("a member restart needs its operation id")
		}
		config, ok := p.setMembers.Config(restart.GetSetId())
		if !ok {
			return errors.New("the set has no member on this node")
		}
		if config.MemberID != restart.GetMemberId() {
			return errors.New("the set has another member on this node")
		}
		return p.setMembers.RestartMember(restart.GetSetId(), restart.GetOperationId(), restart.GetAllowPrimary())
	}
	return errors.New("unknown availability member command")
}

func memberConfigFromProto(config *pb.AvailabilityMemberConfig) memberha.Config {
	members := make([]memberha.Peer, 0, len(config.GetMembers()))
	for _, peer := range config.GetMembers() {
		members = append(members, memberha.Peer{MemberID: peer.GetMemberId(), NodeID: peer.GetNodeId(),
			MemberIndex: peer.GetMemberIndex(), Priority: peer.GetPriority(), Removing: peer.GetRemoving()})
	}
	self := ""
	for _, peer := range members {
		if peer.MemberID == config.GetMemberId() {
			self = peer.NodeID
		}
	}
	return memberha.Config{
		SetID: config.GetSetId(), MemberID: config.GetMemberId(), NodeID: self, Engine: config.GetEngine(),
		OwnerKind: config.GetOwnerKind(), OwnerID: config.GetOwnerId(), Mode: config.GetMode(),
		LeasePolicyID: config.GetLeasePolicyId(), Durability: config.GetDurability(),
		SyncDegradeAfterSeconds: config.GetSyncDegradeAfterSeconds(), MaxLagBytes: config.GetMaxLagBytes(),
		Members: members, ConfigRevision: config.GetConfigRevision(), EngineConfig: config.GetEngineConfig(),
		PublishedPort: config.GetPublishedPort(), Stopped: config.GetStopped(),
	}
}

// availabilityMemberReports are this node's members for the health report.
func (p *DockerPlugin) availabilityMemberReports() []*pb.AvailabilityMemberReport {
	if p.setMembers == nil {
		return nil
	}
	reports := p.setMembers.Reports()
	out := make([]*pb.AvailabilityMemberReport, 0, len(reports))
	for _, report := range reports {
		events := make([]*pb.AvailabilityMemberEvent, 0, len(report.Events))
		for _, event := range report.Events {
			events = append(events, &pb.AvailabilityMemberEvent{Sequence: event.Seq, Kind: event.Kind, AtUnixMs: event.AtUnixMs,
				Reason: event.Reason, OperationId: event.OperationID, Detail: event.Detail})
		}
		out = append(out, &pb.AvailabilityMemberReport{
			SetId: report.SetID, MemberId: report.MemberID, Role: report.Role, Serving: report.Serving, LeaseRole: report.LeaseRole,
			Eligible: report.Eligible, EligibilityReason: report.EligibilityReason, LagBytes: report.LagBytes,
			LagSeconds: report.LagSeconds, SyncState: report.SyncState, Position: report.Position,
			DiskFreeBytes: report.DiskFreeBytes, LastError: report.LastError, ConfigRevision: report.ConfigRevision,
			PrimaryGeneration: report.PrimaryGeneration, Events: events,
			Stopped: report.Stopped, PendingRestartOperationId: report.PendingRestartOperationID,
		})
	}
	return out
}

// assignSetPrimary records a manual pair's primary assignment Gateway signed:
// the policy keys it carries come over this authenticated stream and are
// trusted directly (as in SyncAvailabilityLeaseCommand); the signature is
// verified by the member runtime.
func (p *DockerPlugin) assignSetPrimary(assignment *pb.AvailabilityPrimaryAssignment) error {
	if p.lease != nil && p.lease.runtime != nil {
		for _, key := range assignment.GetPolicyKeys() {
			if err := p.lease.runtime.Node().TrustPolicyKey(key.GetKeyId(), key.GetPublicKey()); err != nil {
				return fmt.Errorf("policy key %s: %w", key.GetKeyId(), err)
			}
		}
	}
	return p.setMembers.AssignPrimary(assignment.GetSetId(), memberha.Assignment{
		PrimaryMemberID: assignment.GetPrimaryMemberId(), Generation: assignment.GetGeneration(),
		SigningKeyID: assignment.GetSigningKeyId(), Signature: assignment.GetSignature()})
}

// syncSetMemberPublication applies the published port of a member's
// configuration at once (the app kill switch suspends a set's publication with
// published_port 0 and resumes it with the port): 0 detaches the member proxy
// of every engine; a Postgres member attaches it again here, Valkey and
// SeaweedFS members on their next status sample. ClickHouse publishes from
// its database record (managed database update).
func (p *DockerPlugin) syncSetMemberPublication(setID string) {
	config, ok := p.setMembers.Config(setID)
	if !ok {
		return
	}
	if config.PublishedPort == 0 {
		if config.Engine != "clickhouse" {
			p.setMembers.DetachProxy(setID)
		}
		return
	}
	if config.Engine == "postgres" && p.databaseManager != nil {
		p.databaseManager.syncPGMemberProxy(p.setMembers, config)
	}
}
