package relaybridge

import (
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ProbeReachedGatedEndpoint reports a source probe the relay refused only
// because the target is an Availability member that takes no traffic now: the
// lease gate is closed for it (a standby holds no committed slot) or it is
// registered dormant. The relay checks the connect grant and finds the route
// and its endpoint before it asks the gate, so such a refusal proves what the
// probe verifies: the source reaches the relay and the relay authorizes the
// staged route. A member is placed on every lease relay whatever its lease
// state; failing its move for being a standby kept the pool degraded (B-17).
//
// A refusal for the relay's admission pressure or a session limit proves the
// same: the relay decides it last, after the grant, the route, the endpoint,
// the lease gate and the target's registration. The probe loops retried such a
// refusal every 100 ms for 10 s, two probes per daemon at a time, so a staged
// generation sent a relay under pressure about 20 opens a second per daemon
// that it could only refuse (stand 2.12 N-1), and failed the placement for a
// load that passes by itself.
func ProbeReachedGatedEndpoint(err error) bool {
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.FailedPrecondition:
		return strings.Contains(current.Message(), "availability lease gate closed")
	case codes.Unavailable:
		return strings.Contains(current.Message(), "target endpoint is dormant")
	case codes.ResourceExhausted:
		if _, pressure := admissionPressureState(err); pressure {
			return true
		}
		return strings.Contains(current.Message(), "relay route session capacity reached") ||
			strings.Contains(current.Message(), "relay endpoint session capacity reached")
	}
	return false
}
