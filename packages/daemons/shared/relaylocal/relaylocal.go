// Package relaylocal names the contract between Opfield, the relay worker and
// the relay supervisor for traffic that starts or ends on the relay itself:
// witness processes the supervisor runs (a ClickHouse Keeper voter of an
// availability set) are reached through relay-local endpoints and reach the
// set's members through relay-originated tunnels (RelayAdmin.DialRoute).
package relaylocal

import "fmt"

const (
	// SubjectKind is the endpoint subject kind of a relay-local endpoint and
	// the route source kind of a relay-originated route. The subject or
	// source id is the relay instance id.
	SubjectKind = "relay_instance"

	// PortMin and PortMax bound the loopback ports a relay-local endpoint may
	// name. The supervisor binds witness listeners only inside this range,
	// and the worker dials nothing outside it, so a policy cannot turn the
	// relay into a dialer of other local services.
	PortMin = 39400
	PortMax = 39499

	// EndpointsCapability: the worker serves relay-local endpoints.
	EndpointsCapability = "relay_local_endpoints_v1"
	// DialRouteCapability: the worker offers RelayAdmin.DialRoute.
	DialRouteCapability = "relay_dial_route_v1"
)

// Target returns the loopback address of a relay-local endpoint's port, or an
// error for a port outside the witness range.
func Target(port uint32) (string, error) {
	if port < PortMin || port > PortMax {
		return "", fmt.Errorf("relay-local port %d is outside %d-%d", port, PortMin, PortMax)
	}
	return fmt.Sprintf("127.0.0.1:%d", port), nil
}
