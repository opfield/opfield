package lease

import (
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

// startupFenceLocked treats every running lease-mode container as unfenced
// when the daemon starts (A2.3). A container keeps running only when every
// running container of its policy has a live watchdog record for one slot:
// the node then recovers that key with the recorded deadline and must renew
// within the remaining budget or fence. Anything else is killed now, as is
// everything when the watchdog is gone (a slow one still recovers).
//
// The named bootstrap holder's legacy copy is exempt while its reservation
// is pending (A5). A fresh process always reports the reservation pending
// until it learns a commit from the voters, so a policy whose containers
// carry live records is recovered even then: a live deadline is written only
// while holding, so it proves the bootstrap already committed. Skipping it
// left the holder's own copy unowned and stopped it on every restart.
func (r *Runtime) startupFenceLocked(now time.Duration, manifests []availabilitylease.ManifestInfo) {
	for _, manifest := range manifests {
		if manifest.Closed {
			r.startupRetainedLocked(now, manifest)
			continue
		}
		var running []Container
		for _, c := range r.snapshot.byPolicy[manifest.PolicyID] {
			if c.Running {
				running = append(running, c)
			}
		}
		if len(running) == 0 {
			continue
		}
		key, deadline, ok := r.recoverableLocked(running, now)
		if r.bootstrapPendingLocked(manifest) && (!ok || !r.watchdog.alive) {
			continue
		}
		wl := r.workloadLocked(manifest.PolicyID)
		if !ok || !r.watchdog.alive {
			r.logger.Warn("unfenced lease-mode container found at daemon start; killing it",
				"policy_id", manifest.PolicyID, "containers", len(running), "watchdog_alive", r.watchdog.alive)
			none := availabilitylease.HolderStatus{Key: availabilitylease.Key{PolicyID: manifest.PolicyID}}
			r.stopLocked(wl, none, running, purposeKill)
			continue
		}
		r.logger.Info("recovering an unconfirmed lease-mode container after a daemon start",
			"policy_id", key.PolicyID, "slot", key.Slot, "budget", deadline-now)
		r.node.Recover(key, deadline)
		r.markRecoveringLocked(key)
	}
}

// recoverableLocked returns the key and earliest deadline shared by the
// records of every running container, when all are live.
func (r *Runtime) recoverableLocked(running []Container, now time.Duration) (availabilitylease.Key, time.Duration, bool) {
	var key availabilitylease.Key
	var deadline time.Duration
	for i, c := range running {
		record, ok := r.records[c.ID]
		if !ok || record.Stale(now) {
			return key, 0, false
		}
		if i == 0 {
			key, deadline = availabilitylease.Key{PolicyID: c.PolicyID, Slot: record.Slot}, record.Deadline()
			continue
		}
		if record.Slot != key.Slot {
			return key, 0, false
		}
		deadline = min(deadline, record.Deadline())
	}
	return key, deadline, true
}

// startupRetainedLocked handles a closed policy at daemon start (graceful
// close). Legacy owns a closed policy's containers, except the copy of the
// slot the closed manifest names this node the retained holder of: with live
// deadline records it was still confirming the close when the daemon stopped,
// so it recovers on that budget and asks again (fencing if the voters do not
// confirm in time); without records it was already retained and only asks the
// voters to confirm it again, for the lease report.
func (r *Runtime) startupRetainedLocked(now time.Duration, manifest availabilitylease.ManifestInfo) {
	slot, named := manifest.RetainedSlot(r.opts.NodeID)
	if !named {
		return
	}
	var running []Container
	armed := false
	for _, c := range r.snapshot.byPolicy[manifest.PolicyID] {
		if !c.Running {
			continue
		}
		running = append(running, c)
		if _, ok := r.records[c.ID]; ok {
			armed = true
		}
	}
	if len(running) == 0 {
		return
	}
	key := availabilitylease.Key{PolicyID: manifest.PolicyID, Slot: slot}
	if !armed {
		r.logger.Info("reconfirming a retained copy of a closed availability lease after a daemon start", "policy_id", key.PolicyID, "slot", key.Slot)
		r.node.ReconfirmRetained(key)
		return
	}
	if recovered, deadline, ok := r.recoverableLocked(running, now); ok && recovered.Slot == slot && r.watchdog.alive {
		r.logger.Info("recovering a closing lease's retained copy after a daemon start", "policy_id", key.PolicyID, "slot", key.Slot, "budget", deadline-now)
		r.node.Recover(key, deadline)
		r.markRecoveringLocked(key)
	}
	// Otherwise its records are stale: the budget ran out before the close
	// was confirmed, and the watchdog fences it as before.
}
