package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// runtimeAdmin answers GetRouteRuntime from a fixed table; a route without an entry is not in the policy.
type runtimeAdmin struct {
	relayv1.RelayAdminClient
	runtimes map[string]*relayv1.RouteRuntimeResponse
	err      error
}

func (a *runtimeAdmin) GetRouteRuntime(_ context.Context, request *relayv1.RouteRuntimeRequest, _ ...grpc.CallOption) (*relayv1.RouteRuntimeResponse, error) {
	if a.err != nil {
		return nil, a.err
	}
	if runtime, ok := a.runtimes[request.GetRouteId()]; ok {
		return runtime, nil
	}
	return nil, status.Error(codes.NotFound, "relay route is not active")
}

func runtimePlugin(admin relayv1.RelayAdminClient) *Plugin {
	plugin := New(&config.Config{})
	plugin.worker.client = admin
	return plugin
}

func TestRouteRuntimeAnswersHeldRoutesAndListsMissingOnes(t *testing.T) {
	admin := &runtimeAdmin{runtimes: map[string]*relayv1.RouteRuntimeResponse{
		"route-1": {RouteId: "route-1", ActiveTunnels: 3, OpenedTotal: 9, FailedTotal: 1, SetupLatencyP95Microseconds: 4000, LastActivityUnixMilliseconds: 1787932800000},
	}}
	result := runtimePlugin(admin).HandleCommand(&pb.OpfieldCommand{CommandId: "c1", Payload: &pb.OpfieldCommand_GetRelayRouteRuntime{
		GetRelayRouteRuntime: &pb.GetRelayRouteRuntimeCommand{RouteIds: []string{"route-1", "route-2"}},
	}})
	if !result.GetSuccess() {
		t.Fatalf("command failed: %s", result.GetError())
	}
	var report struct {
		Runtimes []map[string]any `json:"runtimes"`
		Missing  []string         `json:"missing"`
	}
	if err := json.Unmarshal([]byte(result.GetDetail()), &report); err != nil {
		t.Fatalf("detail is not JSON: %v (%s)", err, result.GetDetail())
	}
	if len(report.Runtimes) != 1 || report.Runtimes[0]["routeId"] != "route-1" || report.Runtimes[0]["openedTotal"] != "9" {
		t.Fatalf("unexpected runtimes: %v", report.Runtimes)
	}
	// Zero counters are present, so Opfield reads them as zero rather than missing.
	if report.Runtimes[0]["completedTotal"] != "0" || report.Runtimes[0]["setupLatencyP95Microseconds"] != "4000" {
		t.Fatalf("unexpected counters: %v", report.Runtimes[0])
	}
	if len(report.Missing) != 1 || report.Missing[0] != "route-2" {
		t.Fatalf("unexpected missing routes: %v", report.Missing)
	}
}

func TestRouteRuntimeFailsWholeWhenTheWorkerDoesNotAnswer(t *testing.T) {
	admin := &runtimeAdmin{err: status.Error(codes.Unavailable, "relay worker is not running")}
	result := runtimePlugin(admin).HandleCommand(&pb.OpfieldCommand{Payload: &pb.OpfieldCommand_GetRelayRouteRuntime{
		GetRelayRouteRuntime: &pb.GetRelayRouteRuntimeCommand{RouteIds: []string{"route-1"}},
	}})
	if result.GetSuccess() || result.GetDetail() != "" || !strings.Contains(result.GetError(), "not running") {
		t.Fatalf("expected a failed command, got %+v", result)
	}
}

func TestRouteRuntimeRefusesMalformedRequests(t *testing.T) {
	worker := runtimePlugin(&runtimeAdmin{}).worker
	tooMany := make([]string, maxRuntimeRoutes+1)
	for index := range tooMany {
		tooMany[index] = "route"
	}
	for _, routeIDs := range [][]string{nil, {""}, {strings.Repeat("r", maxRuntimeRouteID+1)}, tooMany} {
		if _, err := worker.routeRuntime(context.Background(), routeIDs); err == nil {
			t.Fatalf("expected a refusal for %d route ids", len(routeIDs))
		}
	}
}

func TestRegisterAdvertisesRouteRuntime(t *testing.T) {
	cfg := &config.Config{}
	cfg.StateDir = t.TempDir()
	register := New(cfg).BuildRegisterMessage("node-1")
	found := false
	for _, capability := range register.GetCapabilities() {
		found = found || capability == relayRouteRuntimeCapability
	}
	if !found {
		t.Fatalf("register capabilities %v lack %s", register.GetCapabilities(), relayRouteRuntimeCapability)
	}
}
