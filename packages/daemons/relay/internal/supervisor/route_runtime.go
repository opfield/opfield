package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

const (
	// relayRouteRuntimeCapability: the supervisor answers GetRelayRouteRuntimeCommand, so Opfield shows the runtime
	// of routes this relay carries instead of leaving its share unknown.
	relayRouteRuntimeCapability = "relay_route_runtime_v1"
	// maxRuntimeRoutes bounds one command: a link has one route per Availability placement, a route on an ingress
	// group one per member.
	maxRuntimeRoutes   = 256
	maxRuntimeRouteID  = 128
	routeRuntimeBudget = 2 * time.Second
)

// routeRuntimeReport is the JSON a GetRelayRouteRuntimeCommand answers with in CommandResult.detail.
type routeRuntimeReport struct {
	Runtimes []json.RawMessage `json:"runtimes"`
	Missing  []string          `json:"missing"`
}

// routeRuntime asks the worker for the runtime of each route. A route the worker's policy does not hold is missing;
// any other failure fails the whole answer, so Opfield never takes a partial one as complete.
func (m *workerManager) routeRuntime(ctx context.Context, routeIDs []string) (string, error) {
	if len(routeIDs) == 0 || len(routeIDs) > maxRuntimeRoutes {
		return "", fmt.Errorf("route runtime needs 1 to %d route ids", maxRuntimeRoutes)
	}
	for _, id := range routeIDs {
		if id == "" || len(id) > maxRuntimeRouteID {
			return "", fmt.Errorf("route runtime route id is invalid")
		}
	}
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, routeRuntimeBudget)
	defer cancel()
	report := routeRuntimeReport{Runtimes: []json.RawMessage{}, Missing: []string{}}
	encode := protojson.MarshalOptions{EmitUnpopulated: true}
	for _, id := range routeIDs {
		runtime, err := client.GetRouteRuntime(ctx, &relayv1.RouteRuntimeRequest{RouteId: id})
		if status.Code(err) == codes.NotFound {
			report.Missing = append(report.Missing, id)
			continue
		}
		if err != nil {
			return "", err
		}
		encoded, err := encode.Marshal(runtime)
		if err != nil {
			return "", err
		}
		report.Runtimes = append(report.Runtimes, encoded)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
