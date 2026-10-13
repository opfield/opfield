package supervisor

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/protobuf/proto"
)

const protectedTestConfig = `gateway:
  address: gateway.example.com:9443
worker:
  advertised_addresses:
    - relay.example.com
`

func loadProtectedTestConfig(t *testing.T, extra string) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(protectedTestConfig+extra), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestProtectedModeComesFromTheLocalConfig(t *testing.T) {
	plain := New(loadProtectedTestConfig(t, ""))
	if plain.ProtectedMode() {
		t.Fatal("protected mode must default to off")
	}
	if caps := plain.protectedCapabilities(); len(caps) != 0 {
		t.Fatalf("unprotected relay advertises %v", caps)
	}
	if register := plain.BuildRegisterMessage("node-1"); slices.Contains(register.Capabilities, lifecycle.NodeProtectedCapability) {
		t.Fatal("unprotected relay registered as protected")
	}

	protected := New(loadProtectedTestConfig(t, "protected:\n  enabled: true\n"))
	if !protected.ProtectedMode() {
		t.Fatal("protected.enabled: true did not turn protected mode on")
	}
	register := protected.BuildRegisterMessage("node-1")
	// The shared lifecycle adds the protected marker to the registration of
	// every protected node; the relay listing it as well sent it twice.
	if slices.Contains(register.Capabilities, lifecycle.NodeProtectedCapability) {
		t.Fatalf("relay registration repeats %s the shared lifecycle adds: %v", lifecycle.NodeProtectedCapability, register.Capabilities)
	}
	if slices.Contains(register.Capabilities, RelayProtectedWitnessAllowedCapability) {
		t.Fatal("database witness must be off by default on a protected relay")
	}
	protected.cfg.StateDir = t.TempDir()
	protected.worker = newWorkerManager(protected.cfg.Worker, protected.cfg.StateDir)
	status := protected.collectRuntime(context.Background())
	if !slices.Contains(status.Capabilities, lifecycle.NodeProtectedCapability) {
		t.Fatalf("protected relay runtime status lacks %s: %+v", lifecycle.NodeProtectedCapability, status)
	}

	witness := New(loadProtectedTestConfig(t, "protected:\n  enabled: true\n  allow_database_witness: true\n"))
	if !slices.Contains(witness.BuildRegisterMessage("node-1").Capabilities, RelayProtectedWitnessAllowedCapability) {
		t.Fatal("allow_database_witness: true is not advertised")
	}
	// The witness switch means nothing without protected mode.
	unprotectedWitness := New(loadProtectedTestConfig(t, "protected:\n  allow_database_witness: true\n"))
	if caps := unprotectedWitness.protectedCapabilities(); len(caps) != 0 {
		t.Fatalf("unprotected relay advertises %v", caps)
	}
}

func TestProtectedRelayAllowsOnlyRelayOperation(t *testing.T) {
	p := New(loadProtectedTestConfig(t, "protected:\n  enabled: true\n"))
	allowed := []*pb.OpfieldCommand{
		{Payload: &pb.OpfieldCommand_SyncRelayPolicy{SyncRelayPolicy: &pb.SyncRelayPolicyCommand{}}},
		{Payload: &pb.OpfieldCommand_SetRelayDrain{SetRelayDrain: &pb.SetRelayDrainCommand{}}},
		{Payload: &pb.OpfieldCommand_UpdateRelayWorker{UpdateRelayWorker: &pb.UpdateRelayWorkerCommand{}}},
		{Payload: &pb.OpfieldCommand_RenewRelayIdentity{RenewRelayIdentity: &pb.RenewRelayIdentityCommand{}}},
		{Payload: &pb.OpfieldCommand_GetRelayRouteRuntime{GetRelayRouteRuntime: &pb.GetRelayRouteRuntimeCommand{}}},
	}
	for _, cmd := range allowed {
		if !p.ProtectedCommandAllowed(cmd) {
			t.Errorf("protected relay refuses relay operation %T", cmd.Payload)
		}
	}
	refused := []*pb.OpfieldCommand{
		{Payload: &pb.OpfieldCommand_NodeExec{NodeExec: &pb.NodeExecCommand{Action: "create"}}},
		{Payload: &pb.OpfieldCommand_ExecInput{ExecInput: &pb.ExecInput{}}},
		{Payload: &pb.OpfieldCommand_NodeFile{NodeFile: &pb.NodeFileCommand{Action: "read", Path: "/etc/shadow"}}},
		{Payload: &pb.OpfieldCommand_DockerExec{DockerExec: &pb.DockerExecCommand{}}},
		{Payload: &pb.OpfieldCommand_DockerFile{DockerFile: &pb.DockerFileCommand{}}},
		{Payload: &pb.OpfieldCommand_DockerLogs{DockerLogs: &pb.DockerLogsCommand{}}},
		{Payload: &pb.OpfieldCommand_ApplyConfig{ApplyConfig: &pb.ApplyConfigCommand{}}},
		{Payload: &pb.OpfieldCommand_ProbeRelayCandidate{ProbeRelayCandidate: &pb.ProbeRelayCandidateCommand{}}},
		{Payload: &pb.OpfieldCommand_ProbeProxySecureLink{ProbeProxySecureLink: &pb.ProbeProxySecureLinkCommand{}}},
		{Payload: &pb.OpfieldCommand_SyncRelayGrants{SyncRelayGrants: &pb.SyncRelayGrantsCommand{}}},
	}
	for _, cmd := range refused {
		if p.ProtectedCommandAllowed(cmd) {
			t.Errorf("protected relay allows %T", cmd.Payload)
		}
	}
}

func localServicePolicy(t *testing.T, signed bool) []byte {
	t.Helper()
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-registry", Generation: 1, SubjectKind: "local_service", SubjectId: "gateway-internal-registry"}
	request := &relayv1.ApplySnapshotRequest{}
	if signed {
		payload, err := proto.Marshal(&relayv1.PolicyEnvelopePayload{SchemaVersion: 2, Endpoints: []*relayv1.EndpointPolicy{endpoint}})
		if err != nil {
			t.Fatal(err)
		}
		request.SignedEnvelope = &relayv1.SignedPolicyEnvelope{SigningKeyId: "policy-1", Payload: payload}
	} else {
		request.Endpoints = []*relayv1.EndpointPolicy{endpoint}
	}
	encoded, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestProtectedRelayRefusesPoliciesWithBuiltinLocalServices(t *testing.T) {
	protected := New(loadProtectedTestConfig(t, "protected:\n  enabled: true\n"))
	for _, signed := range []bool{true, false} {
		result := protected.HandleCommand(&pb.OpfieldCommand{CommandId: "policy", Payload: &pb.OpfieldCommand_SyncRelayPolicy{
			SyncRelayPolicy: &pb.SyncRelayPolicyCommand{ApplySnapshotRequest: localServicePolicy(t, signed)},
		}})
		if result.Success || !strings.Contains(result.Error, "protected mode") || result.CommandId != "policy" {
			t.Fatalf("protected relay accepted a policy with a built-in local service (signed=%t): %+v", signed, result)
		}
	}
	workload, err := proto.Marshal(&relayv1.ApplySnapshotRequest{Endpoints: []*relayv1.EndpointPolicy{{EndpointId: "endpoint-1", SubjectKind: "daemon"}}})
	if err != nil {
		t.Fatal(err)
	}
	if refusal := protected.protectedPolicyRefusal(workload); refusal != "" {
		t.Fatalf("protected relay refused a workload policy: %s", refusal)
	}
	if refusal := New(loadProtectedTestConfig(t, "")).protectedPolicyRefusal(localServicePolicy(t, true)); refusal != "" {
		t.Fatalf("unprotected supervisor refused the policy itself (the worker decides): %s", refusal)
	}
}

func TestProtectedRelayRefusesWorkerDowngrades(t *testing.T) {
	p := New(loadProtectedTestConfig(t, "protected:\n  enabled: true\n"))
	replaced := 0
	p.worker.replaceBinary = func(string, string, string, string, string, string, *slog.Logger) error {
		replaced++
		return os.ErrPermission
	}
	p.last = &pb.RelayRuntimeStatus{BuildVersion: "v2.12.0"}
	result := p.HandleCommand(&pb.OpfieldCommand{CommandId: "update", Payload: &pb.OpfieldCommand_UpdateRelayWorker{
		UpdateRelayWorker: &pb.UpdateRelayWorkerCommand{TargetVersion: "v2.11.4", DownloadUrl: "https://updates.example/relay-worker", Checksum: strings.Repeat("a", 64), SignedManifest: "{}"},
	}})
	if result.Success || !strings.Contains(result.Error, "older release") {
		t.Fatalf("protected relay accepted a worker downgrade: %+v", result)
	}
	if replaced != 0 {
		t.Fatal("a refused worker downgrade still downloaded a binary")
	}
	if refusal := p.protectedWorkerUpdateRefusal("v2.12.1"); refusal != "" {
		t.Fatalf("protected relay refused a worker upgrade: %s", refusal)
	}
	p.last = nil
	if refusal := p.protectedWorkerUpdateRefusal("v2.11.4"); refusal != "" {
		t.Fatalf("a worker that does not answer must take any signed release: %s", refusal)
	}
	if refusal := p.protectedWorkerUpdateRefusal("latest"); refusal == "" {
		t.Fatal("protected relay accepted a worker update to a non-release version")
	}

	unprotected := New(loadProtectedTestConfig(t, ""))
	unprotected.last = &pb.RelayRuntimeStatus{BuildVersion: "v2.12.0"}
	if refusal := unprotected.protectedWorkerUpdateRefusal("v2.11.4"); refusal != "" {
		t.Fatalf("unprotected relay refused a worker downgrade: %s", refusal)
	}
}

func TestProtectedConfigToggleRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	original := "# relay supervisor\n" + protectedTestConfig + "console:\n  user: ops # console user\n"
	if err := os.WriteFile(path, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := config.SetProtected(path, true, true); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Protected.Enabled || !cfg.Protected.AllowDatabaseWitness {
		t.Fatalf("protected mode not written: %+v", cfg.Protected)
	}
	if cfg.Control.Address != "gateway.example.com:9443" || cfg.Console.User != "ops" || len(cfg.Worker.AdvertisedAddresses) != 1 {
		t.Fatalf("other settings changed: %+v", cfg)
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), "# relay supervisor") || !strings.Contains(string(encoded), "# console user") {
		t.Fatalf("comments were lost:\n%s", encoded)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode changed to %v", info.Mode().Perm())
	}
	if err := config.SetProtected(path, false, false); err != nil {
		t.Fatal(err)
	}
	if cfg, err = config.Load(path); err != nil {
		t.Fatal(err)
	}
	if cfg.Protected.Enabled || cfg.Protected.AllowDatabaseWitness {
		t.Fatalf("protected mode not turned off: %+v", cfg.Protected)
	}
	if New(cfg).ProtectedMode() {
		t.Fatal("relay still protected after the owner turned it off")
	}
}
