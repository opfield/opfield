package broker

import (
	"log/slog"
	"sync"
	"time"
)

const (
	// refusalLogInterval is how often one subject and reason is logged; the
	// line carries how many refusals it stands for.
	refusalLogInterval = time.Minute
	// refusalLogEntries bounds the subjects remembered between lines.
	refusalLogEntries = 4096
)

// Refusal reasons, the per-reason counters and the reason field of the log.
const (
	refusalGrant          = "grant"
	refusalPolicy         = "policy"
	refusalPolicyMissing  = "policy_unavailable"
	refusalDraining       = "draining"
	refusalLeaseGate      = "lease_gate"
	refusalLocalService   = "local_service"
	refusalRelayLocal     = "relay_local"
	refusalNotRegistered  = "not_registered"
	refusalRestarting     = "restarting"
	refusalDormant        = "dormant"
	refusalSessionCap     = "session_cap"
	refusalAdmission      = "admission"
	refusalAcceptTimeout  = "accept_timeout"
	refusalAcceptIdentity = "accept_identity"
	refusalRegistration   = "registration"
)

// refusalLog makes refusals visible without flooding the log (F8): one
// structured line per subject (route, endpoint or source) and reason per
// refusalLogInterval, with the count since the previous line and the total
// for the reason. Before, a relay refused tunnels, registrations and
// snapshots without a trace.
type refusalLog struct {
	mu      sync.Mutex
	entries map[refusalKey]*refusalEntry
	totals  map[string]uint64
}

type refusalKey struct{ subject, reason string }

type refusalEntry struct {
	loggedAt time.Time
	count    uint64
}

func newRefusalLog() *refusalLog {
	return &refusalLog{entries: map[refusalKey]*refusalEntry{}, totals: map[string]uint64{}}
}

// note records one refusal. kind names the subject ("route", "endpoint",
// "source"); err is the status the caller returns.
func (l *refusalLog) note(kind, subject, reason string, err error) {
	if l == nil {
		return
	}
	now := time.Now()
	key := refusalKey{subject: subject, reason: reason}
	l.mu.Lock()
	l.totals[reason]++
	total := l.totals[reason]
	entry := l.entries[key]
	if entry == nil {
		if len(l.entries) >= refusalLogEntries {
			l.pruneLocked(now)
		}
		entry = &refusalEntry{}
		l.entries[key] = entry
	}
	entry.count++
	if !entry.loggedAt.IsZero() && now.Sub(entry.loggedAt) < refusalLogInterval {
		l.mu.Unlock()
		return
	}
	count := entry.count
	entry.loggedAt, entry.count = now, 0
	l.mu.Unlock()
	message := ""
	if err != nil {
		message = err.Error()
	}
	slog.Info("relay refused", kind+"_id", subject, "reason", reason, "error", message, "count", count, "reason_total", total)
}

// pruneLocked forgets subjects not logged within the interval, or all of
// them when every one is recent (the counts restart).
func (l *refusalLog) pruneLocked(now time.Time) {
	for key, entry := range l.entries {
		if now.Sub(entry.loggedAt) >= refusalLogInterval {
			delete(l.entries, key)
		}
	}
	if len(l.entries) >= refusalLogEntries {
		l.entries = map[refusalKey]*refusalEntry{}
	}
}

// Totals returns the refusals per reason since the relay started.
func (l *refusalLog) Totals() map[string]uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	totals := make(map[string]uint64, len(l.totals))
	for reason, count := range l.totals {
		totals[reason] = count
	}
	return totals
}

// RefusalTotals returns the broker's refusals per reason since the relay
// started (HealthResponse has no field for them; they reach the log).
func (b *Broker) RefusalTotals() map[string]uint64 { return b.refusals.Totals() }
