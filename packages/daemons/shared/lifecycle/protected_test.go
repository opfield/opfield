package lifecycle

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type protectedTestPlugin struct {
	protected bool
	allowed   map[string]bool
}

func (p *protectedTestPlugin) Type() string                         { return "relay" }
func (p *protectedTestPlugin) Init(*BaseConfig, *slog.Logger) error { return nil }
func (p *protectedTestPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	return &pb.RegisterMessage{NodeId: nodeID}
}
func (p *protectedTestPlugin) HandleCommand(cmd *pb.OpfieldCommand) *pb.CommandResult {
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
}
func (p *protectedTestPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport { return base }
func (p *protectedTestPlugin) CollectStats() *pb.StatsReport                        { return nil }
func (p *protectedTestPlugin) OnSessionStart(context.Context, *stream.Writer) error {
	return nil
}
func (p *protectedTestPlugin) OnSessionEnd()          {}
func (p *protectedTestPlugin) SetLogger(*slog.Logger) {}
func (p *protectedTestPlugin) ProtectedMode() bool    { return p.protected }
func (p *protectedTestPlugin) ProtectedCommandAllowed(cmd *pb.OpfieldCommand) bool {
	return p.allowed[commandKind(cmd)]
}

// everyOpfieldCommand returns one command per payload of OpfieldCommand, so a
// payload added later is covered without changing this test.
func everyOpfieldCommand(t *testing.T) []*pb.OpfieldCommand {
	t.Helper()
	descriptor := (&pb.OpfieldCommand{}).ProtoReflect().Descriptor()
	oneof := descriptor.Oneofs().ByName("payload")
	if oneof == nil {
		t.Fatal("OpfieldCommand has no payload oneof")
	}
	commands := make([]*pb.OpfieldCommand, 0, oneof.Fields().Len())
	for index := 0; index < oneof.Fields().Len(); index++ {
		field := oneof.Fields().Get(index)
		cmd := &pb.OpfieldCommand{CommandId: "cmd-" + string(field.Name())}
		message := cmd.ProtoReflect()
		if field.Kind() != protoreflect.MessageKind {
			t.Fatalf("payload %s is not a message", field.Name())
		}
		message.Set(field, protoreflect.ValueOfMessage(message.NewField(field).Message()))
		commands = append(commands, cmd)
	}
	return commands
}

// The only shared commands a protected node runs. Everything else must be
// allowed by the plugin.
var protectedSharedAllowed = map[string]bool{
	"request_health":           true,
	"request_stats":            true,
	"set_daemon_log_stream":    true,
	"update_daemon":            true,
	"set_opfield_next_address": true,
}

func TestProtectedModeRefusesEveryCommandNotAllowed(t *testing.T) {
	plugin := &protectedTestPlugin{protected: true}
	for _, cmd := range everyOpfieldCommand(t) {
		kind := commandKind(cmd)
		refused := refuseProtectedCommand(true, plugin, cmd)
		if protectedSharedAllowed[kind] {
			if refused != nil {
				t.Errorf("protected mode refused %s: %s", kind, refused.Error)
			}
			continue
		}
		if refused == nil {
			t.Errorf("protected mode let %s through", kind)
			continue
		}
		if refused.Success || refused.CommandId != cmd.CommandId || !strings.Contains(refused.Error, "protected mode") {
			t.Errorf("unexpected refusal of %s: %+v", kind, refused)
		}
	}
}

func TestProtectedModeRefusesHostAccessEvenWhenThePluginAllowsIt(t *testing.T) {
	plugin := &protectedTestPlugin{protected: true, allowed: map[string]bool{"node_exec": true, "exec_input": true, "node_file": true}}
	for _, action := range []string{"create", "resize", "run", "close"} {
		if refuseProtectedCommand(true, plugin, nodeExecCommand(action)) == nil {
			t.Errorf("protected mode let node_exec %s through", action)
		}
	}
	input := &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_ExecInput{ExecInput: &pb.ExecInput{ExecId: "exec-1", Data: []byte("id\n")}}}
	if refuseProtectedCommand(true, plugin, input) == nil {
		t.Error("protected mode let console input through")
	}
	for _, action := range []string{"list", "read", "write", "mkdir", "delete", "rename", "upload-init", "upload-chunk", "upload-finalize", "stat", ""} {
		if refuseProtectedCommand(true, plugin, nodeFileCommand(action)) == nil {
			t.Errorf("protected mode let node_file %q through", action)
		}
	}
}

func TestProtectedModeKeepsTheHostIdentityReadAndPluginCommands(t *testing.T) {
	plugin := &protectedTestPlugin{protected: true, allowed: map[string]bool{"sync_relay_policy": true}}
	if refused := refuseProtectedCommand(true, plugin, nodeFileCommand("ensure-host-identity")); refused != nil {
		t.Fatalf("protected mode refused the fixed host identity read: %s", refused.Error)
	}
	policy := &pb.OpfieldCommand{CommandId: "policy", Payload: &pb.OpfieldCommand_SyncRelayPolicy{SyncRelayPolicy: &pb.SyncRelayPolicyCommand{}}}
	if refused := refuseProtectedCommand(true, plugin, policy); refused != nil {
		t.Fatalf("protected mode refused a command the plugin allows: %s", refused.Error)
	}
	drain := &pb.OpfieldCommand{CommandId: "drain", Payload: &pb.OpfieldCommand_SetRelayDrain{SetRelayDrain: &pb.SetRelayDrainCommand{}}}
	if refuseProtectedCommand(true, plugin, drain) == nil {
		t.Fatal("protected mode let a command the plugin does not allow through")
	}
}

func TestUnprotectedNodeRefusesNothingHere(t *testing.T) {
	plugin := &protectedTestPlugin{}
	for _, cmd := range everyOpfieldCommand(t) {
		if refused := refuseProtectedCommand(false, plugin, cmd); refused != nil {
			t.Fatalf("an unprotected node refused %s: %s", commandKind(cmd), refused.Error)
		}
	}
	if pluginProtected(plugin) {
		t.Fatal("plugin without protected mode reported as protected")
	}
	if pluginProtected(&protectedTestPlugin{protected: true}) != true {
		t.Fatal("protected plugin not reported as protected")
	}
}

func TestProtectedCapabilitiesAdvertiseDisabledHostAccess(t *testing.T) {
	if got := protectedCapabilities(false); len(got) != 0 {
		t.Fatalf("unprotected capabilities = %v", got)
	}
	got := strings.Join(protectedCapabilities(true), ",")
	for _, want := range []string{NodeProtectedCapability, NodeConsoleDisabledCapability, NodeFilesDisabledCapability} {
		if !strings.Contains(got, want) {
			t.Fatalf("protected capabilities %q lack %s", got, want)
		}
	}
}

func TestProtectedRegistrationDropsHostDetails(t *testing.T) {
	register := &pb.RegisterMessage{Hostname: "relay-1", CpuModel: "cpu", KernelVersion: "6.8", Architecture: "amd64", CpuCores: 4}
	protectRegistration(false, register)
	if register.CpuModel == "" || register.KernelVersion == "" {
		t.Fatal("an unprotected registration lost host details")
	}
	protectRegistration(true, register)
	if register.CpuModel != "" || register.KernelVersion != "" {
		t.Fatalf("protected registration kept host details: %+v", register)
	}
	if register.Hostname != "relay-1" || register.Architecture != "amd64" || register.CpuCores != 4 {
		t.Fatalf("protected registration lost what it keeps: %+v", register)
	}
}

func TestAggregateHealthHasNoHostInventory(t *testing.T) {
	report := sysmetrics.NewSystemReporter().CollectAggregateHealth(nil)
	if len(report.NetworkInterfaces) != 0 || len(report.LocalIpAddresses) != 0 ||
		len(report.PublicIpAddresses) != 0 || len(report.GpuDevices) != 0 || report.DiskReadBytes != 0 || report.DiskWriteBytes != 0 {
		t.Fatalf("aggregate health carries host inventory: %+v", report)
	}
	// Only the root mount, so the disk alert watches a protected node too: no
	// other mounts, and no device or filesystem type.
	if len(report.DiskMounts) != 1 {
		t.Fatalf("aggregate health reports %d disk mounts, want only /: %+v", len(report.DiskMounts), report.DiskMounts)
	}
	root := report.DiskMounts[0]
	if root.MountPoint != "/" || root.Role != sysmetrics.DiskRoleRoot || root.Device != "" || root.Filesystem != "" ||
		root.TotalBytes <= 0 || root.FreeBytes < 0 || root.UsedBytes != root.TotalBytes-root.FreeBytes {
		t.Fatalf("aggregate root mount = %+v", root)
	}
	if report.Timestamp == 0 {
		t.Fatal("aggregate health has no timestamp")
	}
}

func TestProtectedUpdateAcceptsOnlyTheSameOrANewerRelease(t *testing.T) {
	for _, tc := range []struct {
		running, target string
		allowed         bool
	}{
		{"v2.12.0", "v2.12.0", true},
		{"v2.12.0", "v2.12.1", true},
		{"v2.12.0", "v2.13.0-rc.1", true},
		{"v2.12.0-rc.2", "v2.12.0-rc.10", true},
		{"v2.12.0-rc.3", "v2.12.0", true},
		{"2.12.0", "v2.12.0+build.7", true},
		{"v2.12.0", "v2.11.4", false},
		{"v2.12.0", "v2.12.0-rc.9", false},
		{"v2.12.0-rc.10", "v2.12.0-rc.2", false},
		{"v2.12.0", "v1.99.99", false},
		{"v2.12.0", "latest", false},
		{"v2.12.0", "", false},
		{"dev", "v2.12.0", false},
	} {
		refusal := ProtectedUpdateRefusal(tc.running, tc.target)
		if (refusal == "") != tc.allowed {
			t.Errorf("update %s -> %s: allowed=%t, refusal %q", tc.running, tc.target, tc.allowed, refusal)
		}
	}
}

func TestDaemonBaseRefusesProtectedDowngradeOnly(t *testing.T) {
	previous := Version
	Version = "v2.12.0"
	defer func() { Version = previous }()
	protected := &DaemonBase{protected: true}
	if protected.protectedUpdateRefusal("v2.11.4") == "" {
		t.Fatal("protected daemon accepted a downgrade")
	}
	if refusal := protected.protectedUpdateRefusal("v2.12.1"); refusal != "" {
		t.Fatalf("protected daemon refused an upgrade: %s", refusal)
	}
	if refusal := (&DaemonBase{}).protectedUpdateRefusal("v2.11.4"); refusal != "" {
		t.Fatalf("unprotected daemon refused a downgrade: %s", refusal)
	}
}

// protectedMarkerPlugin reports the protected marker in its own registration,
// as the relay supervisor did.
type protectedMarkerPlugin struct {
	protectedTestPlugin
}

func (p *protectedMarkerPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	return &pb.RegisterMessage{NodeId: nodeID, Capabilities: []string{"relay_pool_v1", NodeProtectedCapability, NodeConsoleDisabledCapability}}
}

func TestProtectedRegistrationListsEachCapabilityOnce(t *testing.T) {
	disabled := false
	d := &DaemonBase{
		plugin:    &protectedMarkerPlugin{protectedTestPlugin{protected: true}},
		protected: true,
		cfg:       &BaseConfig{Console: ConsoleConfig{Enabled: &disabled}},
		state:     &state.State{NodeID: "node-1"},
	}
	register := d.buildRegistration()
	counts := map[string]int{}
	for _, capability := range register.Capabilities {
		counts[capability]++
	}
	for capability, count := range counts {
		if count != 1 {
			t.Fatalf("registration lists %s %d times: %v", capability, count, register.Capabilities)
		}
	}
	for _, want := range []string{"relay_pool_v1", NodeProtectedCapability, NodeConsoleDisabledCapability, NodeFilesDisabledCapability, CommandResultsResentCapability} {
		if counts[want] != 1 {
			t.Fatalf("registration lacks %s: %v", want, register.Capabilities)
		}
	}
	if register.Capabilities[0] != "relay_pool_v1" {
		t.Fatalf("registration reordered the plugin's capabilities: %v", register.Capabilities)
	}
}
