package relaybridge

import (
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A source probe that reached the relay's last decision proves the path: a lease gate or dormant member (B-17), and
// an admission-pressure or session-limit refusal (stand 2.12 N-1: the probe loops retried those every 100 ms). A
// refusal before that (no registration, a revoked grant, a transport error, an oversized message) does not.
func TestProbeReachedGatedEndpoint(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{status.Error(codes.FailedPrecondition, "availability lease gate closed"), true},
		{status.Error(codes.Unavailable, "target endpoint is dormant"), true},
		{status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: database_reserve"), true},
		{status.Error(codes.ResourceExhausted, "relay adaptive admission rejected registry tunnel: hard_pressure"), true},
		{status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: fair_share"), true},
		{status.Error(codes.ResourceExhausted, "relay route session capacity reached"), true},
		{status.Error(codes.ResourceExhausted, "relay endpoint session capacity reached"), true},
		{status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: unknown_traffic_class"), false},
		{status.Error(codes.ResourceExhausted, "grpc: received message larger than max"), false},
		{status.Error(codes.Unavailable, "target endpoint is not registered"), false},
		{status.Error(codes.PermissionDenied, "connect grant route was revoked"), false},
		{status.Error(codes.Unavailable, "relay is draining"), false},
	} {
		if got := ProbeReachedGatedEndpoint(tc.err); got != tc.want {
			t.Errorf("%v: reached=%t, want %t", tc.err, got, tc.want)
		}
	}
}
