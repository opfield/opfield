package nginx

import "time"

// WithReloadLock runs fn while no reload through this manager can start: the nginx upgrade hands the running master
// over to a new binary with it held, so no reload signal reaches a master in the middle of the handover.
func (m *Manager) WithReloadLock(fn func() error) error {
	m.reloadMu.Lock()
	defer m.reloadMu.Unlock()
	return fn()
}

// ForgetMasterPID drops the cached master PID and pid-file path: after a binary handover another process is the
// master.
func (m *Manager) ForgetMasterPID() {
	m.pids.mu.Lock()
	m.pids.pid = 0
	m.pids.checkedAt = time.Time{}
	m.pids.pathStale = true
	m.pids.mu.Unlock()
}
