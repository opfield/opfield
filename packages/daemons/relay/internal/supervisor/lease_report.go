package supervisor

import (
	"log/slog"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// forwardAvailabilityLease copies the worker's availability lease view into
// the runtime report. relay.v1 AvailabilityLeaseReport mirrors gateway.v1
// AvailabilityLeaseReport field for field, so the encoded bytes decode as the
// Gateway message; relay-only fields travel along as unknown fields.
func forwardAvailabilityLease(report *relayv1.AvailabilityLeaseReport, logger *slog.Logger) *pb.AvailabilityLeaseReport {
	if report == nil {
		return nil
	}
	encoded, err := proto.Marshal(report)
	if err != nil {
		return nil
	}
	forwarded := &pb.AvailabilityLeaseReport{}
	if err := proto.Unmarshal(encoded, forwarded); err != nil {
		if logger != nil {
			logger.Warn("relay availability lease view could not be forwarded", "error", err)
		}
		return nil
	}
	return forwarded
}
