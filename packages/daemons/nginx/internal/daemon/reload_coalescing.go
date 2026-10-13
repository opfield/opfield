package daemon

import (
	"fmt"
	"strings"
	"time"
)

// A reconnect resync re-applies every route of the node. Content equal to the file on disk is neither rewritten nor
// reloaded, and the changes of a batch Opfield marks as deferred are each tested and then loaded with one reload:
// the next command that reloads nginx (the resync ends with a full sync), or the daemon itself once the batch went
// quiet. A reload drops idle keep-alive client connections, so every reload saved is a reset a client never sees.
const (
	deferredReloadQuiet = 2 * time.Second
	deferredReloadMax   = 10 * time.Second
)

// commitChange makes a tested change live: at once, or with the reload of its batch.
func (h *Handler) commitChange(deferred bool) error {
	if deferred {
		h.scheduleDeferredReload()
		return nil
	}
	return h.reloadNow()
}

func (h *Handler) reloadNow() error {
	if err := h.mgr.Reload(); err != nil {
		return err
	}
	if !h.mgr.ReloadPending() {
		h.cancelDeferredReload()
	}
	return nil
}

// settleUnchanged answers a command whose content is already on disk: nothing is written. Earlier changes that
// still wait for their reload are loaded now, unless this command is deferred as well.
func (h *Handler) settleUnchanged(deferred bool) error {
	if !h.mgr.ReloadPending() {
		return nil
	}
	if deferred {
		h.scheduleDeferredReload()
		return nil
	}
	if valid, output := h.mgr.TestConfig(); !valid {
		h.logConfigTestFailure("load pending changes", output)
		return fmt.Errorf("nginx config test failed: %s", strings.TrimSpace(output))
	}
	if err := h.reloadNow(); err != nil {
		return fmt.Errorf("nginx reload failed: %w", err)
	}
	return nil
}

func (h *Handler) scheduleDeferredReload() {
	h.deferredMu.Lock()
	defer h.deferredMu.Unlock()
	now := time.Now()
	if h.deferredSince.IsZero() {
		h.deferredSince = now
	}
	delay := deferredReloadQuiet
	if latest := h.deferredSince.Add(deferredReloadMax).Sub(now); latest < delay {
		delay = max(latest, 0)
	}
	if h.deferredTimer != nil {
		h.deferredTimer.Stop()
	}
	h.deferredTimer = time.AfterFunc(delay, h.flushDeferredReload)
}

func (h *Handler) cancelDeferredReload() {
	h.deferredMu.Lock()
	defer h.deferredMu.Unlock()
	if h.deferredTimer != nil {
		h.deferredTimer.Stop()
		h.deferredTimer = nil
	}
	h.deferredSince = time.Time{}
}

// flushDeferredReload loads the deferred changes no command loaded.
func (h *Handler) flushDeferredReload() {
	h.mutationMu.Lock()
	defer h.mutationMu.Unlock()
	h.deferredMu.Lock()
	h.deferredSince = time.Time{}
	h.deferredMu.Unlock()
	if !h.mgr.ReloadPending() {
		return
	}
	if valid, output := h.mgr.TestConfig(); !valid {
		h.logConfigTestFailure("deferred reload", output)
		return
	}
	if err := h.mgr.Reload(); err != nil {
		h.logger.Error("nginx reload failed", "action", "deferred reload", "error", err)
		return
	}
	h.logger.Info("nginx reloaded with the deferred changes")
}
