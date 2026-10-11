package memberha

import (
	"sort"
)

// Member roles in reports.
const (
	ReportRolePrimary    = "primary"
	ReportRoleCopy       = "copy"
	ReportRoleRebuilding = "rebuilding"
	ReportRoleFenced     = "fenced"
	ReportRoleUnknown    = "unknown"
)

// Report is one member as the node reports it to Gateway (health report),
// with the events Gateway has not acknowledged yet.
type Report struct {
	SetID             string
	MemberID          string
	Role              string
	Serving           bool
	LeaseRole         string
	Eligible          bool
	EligibilityReason string
	LagBytes          uint64
	LagSeconds        float64
	SyncState         string
	Position          map[string]string
	DiskFreeBytes     uint64
	LastError         string
	ConfigRevision    uint64
	PrimaryGeneration uint64
	// Stopped: the set is paused (Config.Stopped) and this member's engine is
	// confirmed down.
	Stopped bool
	// PendingRestartOperationID is a requested restart that has not finished.
	PendingRestartOperationID string
	Events                    []Event
}

// Reports describes every member of the node.
func (m *Manager) Reports() []Report {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Report, 0, len(m.members))
	for _, mem := range m.members {
		report := Report{
			SetID: mem.cfg.SetID, MemberID: mem.cfg.MemberID, Serving: mem.serving.Load() || mem.legacy.Load(),
			LagBytes: mem.obs.status.LagBytes, LagSeconds: mem.obs.status.LagSeconds, SyncState: mem.obs.status.SyncState,
			Position: mem.obs.status.Position, DiskFreeBytes: mem.obs.status.DiskFreeBytes, LastError: mem.lastError,
			ConfigRevision: mem.cfg.ConfigRevision, PrimaryGeneration: mem.state.Assignment.Generation,
			Events: append([]Event(nil), mem.state.Events...),
		}
		if report.SyncState == "" {
			report.SyncState = "none"
		}
		mem.eligMu.Lock()
		report.Eligible, report.EligibilityReason = mem.eligible, mem.eligibleReason
		mem.eligMu.Unlock()
		if mem.cfg.Stopped {
			report.Eligible, report.EligibilityReason = false, "stopped"
			report.Stopped = !mem.busy && mem.obs.at > 0 && mem.obs.at > mem.lastOpDone && !mem.obs.container.Running
		}
		if r := mem.state.Restart; r != nil {
			report.PendingRestartOperationID = r.OperationID
		}
		if mem.cfg.Mode == ModeAutomatic {
			report.LeaseRole = m.deps.Lease.HolderStatus(mem.cfg.Key()).Role.String()
		}
		switch {
		case mem.dataBusy():
			report.Role = ReportRoleRebuilding
		case mem.obs.at == 0:
			report.Role = ReportRoleUnknown
		case mem.primaryRunning():
			report.Role = ReportRolePrimary
		case mem.copyRunning():
			report.Role = ReportRoleCopy
		case mem.op == opFence:
			report.Role = ReportRoleFenced
		default:
			report.Role = ReportRoleUnknown
		}
		out = append(out, report)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SetID < out[j].SetID })
	return out
}
