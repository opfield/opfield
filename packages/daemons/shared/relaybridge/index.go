package relaybridge

import pb "github.com/opfield/opfield/daemon-shared/opfieldv1"

// AssignmentKey names one assignment of a grant bundle.
type AssignmentKey struct {
	Role, OwnerKind, OwnerID string
}

// IndexAssignments maps a bundle's assignments by key; the first of duplicates
// wins, as in a scan. Grant stores build it once per bundle: a lookup runs for
// every relayed connection, and a scan was linear in the node's links.
func IndexAssignments(bundle *pb.SyncRelayGrantsCommand) map[AssignmentKey]*pb.RelayGrantAssignment {
	index := make(map[AssignmentKey]*pb.RelayGrantAssignment, len(bundle.GetGrants()))
	for _, assignment := range bundle.GetGrants() {
		key := AssignmentKey{Role: assignment.GetRole(), OwnerKind: assignment.GetOwnerKind(), OwnerID: assignment.GetOwnerId()}
		if _, seen := index[key]; !seen {
			index[key] = assignment
		}
	}
	return index
}
