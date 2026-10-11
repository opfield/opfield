package supervisor

import (
	"sort"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// report lists every witness the supervisor knows, desired or still
// stopping, for RelayRuntimeStatus.
func (m *witnessManager) report() (uint64, []*pb.WitnessStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	statuses := make([]*pb.WitnessStatus, 0, len(m.desired))
	for id, spec := range m.desired {
		status := &pb.WitnessStatus{
			Id: id, Kind: spec.GetKind(), Role: m.effectiveRoleLocked(id, spec.GetRole()), State: witnessStateFetching,
			Version: spec.GetArtifact().GetVersion(), ArtifactSha256: spec.GetArtifact().GetSha256(),
		}
		if entry := m.witnesses[id]; entry != nil {
			status.State, status.Error, status.Restarts = entry.state, entry.err, entry.restarts
			status.KeeperRole, status.LastZxid = entry.keeperRole, entry.zxid
			if !entry.since.IsZero() {
				status.SinceUnix = entry.since.Unix()
			}
			if entry.procSpec != nil && entry.proc != nil {
				// What actually runs (an update may be rolled back).
				status.Version, status.ArtifactSha256 = entry.procVersion, entry.procSHA
			}
		}
		statuses = append(statuses, status)
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Id < statuses[j].Id })
	return m.revision, statuses
}

// fillWitnessStatus adds witness hosting to a runtime report.
func (p *Plugin) fillWitnessStatus(status *pb.RelayRuntimeStatus) {
	status.WitnessHosting = p.witnessHosting()
	if p.witnesses == nil {
		return
	}
	status.AppliedWitnessRevision, status.Witnesses = p.witnesses.report()
}
