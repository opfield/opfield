package relaybridge

import (
	"fmt"
	"net"
	"sort"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const PoolCapability = "relay_pool_v1"
const LegacyTargetID = "local"

type Target struct {
	ID                     string
	Addresses              []string
	Port                   uint32
	CertificateIdentity    string
	CertificateFingerprint string
}

func PoolCandidates(assignment *pb.RelayGrantAssignment, includeStaging bool) []*pb.RelayDataCandidate {
	return poolCandidates(assignment, includeStaging, false)
}

// PreparedCandidates keeps transport and target registrations alive for
// active, staging, and draining assignments. Callers must never use it to
// select a relay for a new source tunnel.
func PreparedCandidates(assignment *pb.RelayGrantAssignment) []*pb.RelayDataCandidate {
	return poolCandidates(assignment, true, true)
}

func poolCandidates(assignment *pb.RelayGrantAssignment, includeStaging, includeDraining bool) []*pb.RelayDataCandidate {
	if assignment == nil || assignment.GetSchemaVersion() < 2 || len(assignment.GetCandidates()) == 0 {
		return nil
	}
	// A candidate this daemon cannot use (malformed, a relay without the pool
	// capability, a state a newer Gateway added) is skipped on its own: the
	// assignment's other relays keep their lanes and carry its tunnels.
	result := make([]*pb.RelayDataCandidate, 0, len(assignment.GetCandidates()))
	for _, candidate := range assignment.GetCandidates() {
		if candidate == nil || candidate.GetRelayInstanceId() == "" || candidate.GetAssignmentGeneration() == 0 ||
			!hasCapability(candidate.GetCapabilities(), PoolCapability) || candidate.GetGrant() == nil {
			continue
		}
		if candidate.GetAssignmentState() == "draining" && !includeDraining {
			continue
		}
		if !includeStaging && candidate.GetAssignmentState() != "active" {
			continue
		}
		if candidate.GetAssignmentState() != "active" && candidate.GetAssignmentState() != "staging" && candidate.GetAssignmentState() != "draining" {
			continue
		}
		result = append(result, candidate)
	}
	return result
}

func RequiredTargets(bundle *pb.SyncRelayGrantsCommand) []Target {
	byID := map[string]Target{}
	for _, assignment := range withLeaseGroupRoutes(bundle.GetGrants()) {
		// Staging candidates need physical lanes on both sides before their
		// probes run. Normal tunnel selection still excludes them through
		// PoolCandidates(..., false); this only prepares the transport.
		for _, candidate := range PreparedCandidates(assignment) {
			if len(candidate.GetAddresses()) == 0 {
				byID[candidate.GetRelayInstanceId()] = Target{ID: candidate.GetRelayInstanceId()}
				continue
			}
			target := Target{
				ID: candidate.GetRelayInstanceId(), Addresses: append([]string(nil), candidate.GetAddresses()...),
				Port: candidate.GetPort(), CertificateIdentity: candidate.GetCertificateIdentity(),
				CertificateFingerprint: candidate.GetCertificateFingerprint(),
			}
			if target.Port == 0 || target.CertificateIdentity == "" || target.CertificateFingerprint == "" {
				continue
			}
			byID[target.ID] = target
		}
	}
	result := make([]Target, 0, len(byID))
	for _, target := range byID {
		result = append(result, target)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

// withLeaseGroupRoutes adds, after each assignment, one connect assignment per
// route of its lease group (an availability set's member routes), so the relays
// that carry only another member's route get transports as well.
func withLeaseGroupRoutes(assignments []*pb.RelayGrantAssignment) []*pb.RelayGrantAssignment {
	result := make([]*pb.RelayGrantAssignment, 0, len(assignments))
	for _, assignment := range assignments {
		result = append(result, assignment)
		for _, member := range assignment.GetLeaseGroup() {
			result = append(result, &pb.RelayGrantAssignment{
				Role: assignment.GetRole(), OwnerKind: assignment.GetOwnerKind(), OwnerId: assignment.GetOwnerId(),
				RouteId: member.GetRouteId(), TargetEndpointId: member.GetTargetEndpointId(), Grant: member.GetGrant(),
				Candidates: member.GetCandidates(), SchemaVersion: member.GetSchemaVersion(),
			})
		}
	}
	return result
}

func TargetAddresses(target Target) []string {
	result := make([]string, 0, len(target.Addresses))
	for _, address := range target.Addresses {
		if address == "" || target.Port == 0 {
			continue
		}
		result = append(result, net.JoinHostPort(address, fmt.Sprintf("%d", target.Port)))
	}
	return result
}

func GrantForCandidate(candidate *pb.RelayDataCandidate) *pb.RelaySignedGrant {
	if candidate == nil {
		return nil
	}
	return candidate.GetGrant()
}

func hasCapability(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
