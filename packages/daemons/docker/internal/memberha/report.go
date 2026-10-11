package memberha

import (
	"sort"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
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

// CertifiedSyncStater is an engine whose copy learns from the certified
// state whether it replicates synchronously (a Postgres standby cannot see
// its own sync_state; the holder certifies the sync set).
type CertifiedSyncStater interface {
	CertifiedSyncState(value []byte) (string, bool)
}

// reportCheck is a copy whose eligibility and sync state the report takes
// from the latest verified commit, evaluated outside the manager's lock.
type reportCheck struct {
	index  int
	mem    *member
	commit CertifiedState
}

// Reports describes every member of the node.
func (m *Manager) Reports() []Report {
	out, checks := m.reportsLocked()
	for _, check := range checks {
		report := &out[check.index]
		if ok, reason, evaluated := m.reportEligibility(check.mem, check.commit); evaluated {
			report.Eligible, report.EligibilityReason = ok, reason
		}
		if stater, ok := check.mem.engine.(CertifiedSyncStater); ok && report.SyncState == "async" {
			if state, known := stater.CertifiedSyncState(check.commit.State.Value); known {
				report.SyncState = state
			}
		}
	}
	return out
}

// reportEligibility is whether a copy could take the primary role over now,
// under the latest verified commit (the lease asks only when it acquires, so
// the last answer it got can be stale or missing): the report and Gateway's
// view of eligible copies. It is informational; no decision rests on it.
func (m *Manager) reportEligibility(mem *member, commit CertifiedState) (bool, string, bool) {
	if mem.state.Detached != nil {
		return false, "", false
	}
	ok, reason := m.eligible(mem, EligibilityInput{
		Key: mem.cfg.Key(), Phase: availabilitylease.EligibilityQuery, Adopted: commit.State, AdoptedBallot: commit.Ballot,
		PreviousHolder: commit.State.Holder,
	})
	return ok, reason, true
}

func (m *Manager) reportsLocked() ([]Report, []reportCheck) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Report, 0, len(m.members))
	var checks []reportCheck
	members := make([]*member, 0, len(m.members))
	for _, mem := range m.members {
		members = append(members, mem)
	}
	sort.Slice(members, func(i, j int) bool { return members[i].cfg.SetID < members[j].cfg.SetID })
	for _, mem := range members {
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
			status := m.deps.Lease.HolderStatus(mem.cfg.Key())
			report.LeaseRole = status.Role.String()
			if !mem.cfg.Stopped && status.Role != RoleHolding && status.Role != RoleRetained {
				if commit, ok := m.deps.Lease.ObservedCommit(mem.cfg.Key()); ok && commit.State.Holder != "" &&
					commit.State.Holder != mem.cfg.NodeID {
					checks = append(checks, reportCheck{index: len(out), mem: mem, commit: commit})
				}
			}
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
	return out, checks
}
