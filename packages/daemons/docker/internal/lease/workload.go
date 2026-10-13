package lease

import (
	"context"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
)

type phase int

const (
	// phaseIdle: this node runs nothing of the policy on the lease's behalf.
	phaseIdle phase = iota
	// phaseServing: the serving set was started (or adopted) under a lease;
	// health watch runs and endpoints open once it is ready.
	phaseServing
)

type stopPurpose string

const (
	purposeRelease stopPurpose = "release" // planned handoff or health release (A6, D6, D9)
	purposeFence   stopPurpose = "fence"   // timer, other holder, lease closed
	purposeAbandon stopPurpose = "abandon" // renewals stopped; kill and confirm
	purposeUnowned stopPurpose = "unowned" // running without a lease (A5)
	purposeKill    stopPurpose = "kill"    // unfenced at daemon start (A2.3)
)

type releaseIntent struct {
	successor   string
	operationID string
	reason      string
}

// workload is the container side of one policy on this node.
type workload struct {
	policyID      string
	phase         phase
	busy          bool
	op            string
	lastOpDone    time.Duration
	servingSince  time.Duration
	endpointsOn   bool
	release       *releaseIntent
	retryAt       time.Duration
	cooldownUntil time.Duration
	// healthReleases counts the health releases since the copy last stayed
	// up for healthStableAfter (the cooldown backoff); healthReleasedIDs is
	// the serving set of the last one, so a new copy starts over.
	healthReleases    int
	healthReleasedIDs map[string]bool
	// healthRequest is a release Opfield asked for (the copy fails its HTTP
	// health check), with when it was asked; served by the next step that
	// finds the copy serving under the lease.
	healthRequest   string
	healthRequestAt time.Duration
	health          healthTracker
	serveIDs        map[string]bool
	// retainChecked: the copy was found running (or released) once after
	// the lease closed and this node was confirmed retained.
	retainChecked bool
	// bootstrapWait is why this node, the named bootstrap holder, is not
	// ready to acquire; logged when it changes (B-23: it was silent).
	bootstrapWait string
}

func (r *Runtime) workloadLocked(policyID string) *workload {
	wl := r.workloads[policyID]
	if wl == nil {
		wl = &workload{policyID: policyID}
		r.workloads[policyID] = wl
	}
	return wl
}

// launch runs op in the background; its completion is applied by the next
// Step under the runtime lock. One operation per policy at a time keeps
// start, stop and endpoint changes ordered.
func (r *Runtime) launch(wl *workload, name string, op func(ctx context.Context) func()) {
	wl.busy, wl.op = true, name
	r.opts.Async(func() {
		ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
		done := op(ctx)
		cancel()
		at := r.opts.Clock.Now()
		r.mu.Lock()
		r.results = append(r.results, func() {
			wl.busy, wl.op = false, ""
			wl.lastOpDone = at
			r.nextObserve = 0
			if done != nil {
				done()
			}
		})
		r.mu.Unlock()
		r.kick()
	})
}

func (r *Runtime) reconcileLocked(manifest availabilitylease.ManifestInfo, status availabilitylease.HolderStatus, now time.Duration) {
	wl := r.workloadLocked(manifest.PolicyID)
	containers := r.snapshot.byPolicy[manifest.PolicyID]
	serve := r.opts.Placements.ServeSet(manifest.PolicyID, containers)
	// Decisions that depend on container state wait for a view taken after
	// the last operation of this policy completed.
	fresh := r.snapshot.at >= wl.lastOpDone
	bootstrap := r.bootstrapPendingLocked(manifest)
	held := status.Role == availabilitylease.RoleHolding || status.Role == availabilitylease.RoleRecovering
	if wl.healthRequest != "" && (status.Role != availabilitylease.RoleHolding || now-wl.healthRequestAt > healthRequestTTL) {
		wl.healthRequest = ""
	}
	if held && status.Key.Slot >= manifest.Slots && wl.release == nil {
		// Scale-down: the slot left the manifest (surge lowered, replicas
		// reduced). Acceptors refuse its renewals, so the holder stops,
		// confirms the cgroup is empty and releases (A6) instead of waiting
		// for its renewal timer.
		wl.release = &releaseIntent{reason: "slot removed from the manifest"}
		r.logger.Info("availability lease slot left the manifest; releasing it", "policy_id", manifest.PolicyID, "slot", status.Key.Slot)
	}
	if manifest.Closed && held && !status.FenceNow && !r.watchdog.lost && wl.release == nil {
		// Graceful close: the retained holder named by the closed manifest
		// keeps its copy running on its lease budget while the voters
		// confirm the close; nothing starts, no health release, endpoints
		// stay as they are. It fences like any holder if they do not
		// confirm in time.
		r.armRecordsLocked(status, serve, containers)
		r.updateReadyLocked(manifest, wl, serve, containers, now)
		return
	}
	if status.Role != availabilitylease.RoleRetained {
		wl.retainChecked = false
	}
	if manifest.Closed && (status.Role == availabilitylease.RoleNone || status.Role == availabilitylease.RoleRetained) {
		endLeasePeriodLocked(wl)
	}
	switch status.Role {
	case availabilitylease.RoleRetained:
		r.disarmRetainedLocked(wl, containers)
		if !wl.retainChecked && !wl.busy && fresh {
			wl.retainChecked = true
			if !anyRunning(serve) {
				// A start the close cut short: there is no serving copy to
				// keep, so the slot is released for the legacy heal instead
				// of being reported as a running retained copy.
				r.logger.Warn("availability lease closed, but this node's retained copy is not running; releasing the slot",
					"policy_id", manifest.PolicyID, "slot", status.Key.Slot)
				wl.release = &releaseIntent{reason: "retained copy not running"}
				r.stopLocked(wl, status, containers, purposeRelease)
			}
		}
	case availabilitylease.RoleHolding:
		switch {
		case r.watchdog.lost:
			r.abandonLocked(wl, status, "watchdog heartbeat is lost")
		case wl.release != nil:
			r.stopLocked(wl, status, containers, purposeRelease)
		case status.FenceNow:
			r.stopLocked(wl, status, containers, purposeFence)
		default:
			r.serveLocked(wl, status, serve, containers, fresh, now)
		}
	case availabilitylease.RoleRecovering:
		if r.watchdog.lost {
			r.abandonLocked(wl, status, "watchdog heartbeat is lost")
			break
		}
		if wl.release != nil {
			r.stopLocked(wl, status, containers, purposeRelease)
			break
		}
		// Unconfirmed container after a restart (A2.3): it keeps running on
		// its recorded budget, which proves the lease is still this node's
		// until then, and nothing starts until a renewal succeeds. A copy
		// that runs keeps serving meanwhile (B-13): its endpoints never go
		// dormant for a same-boot daemon restart (a new boot has no records).
		r.armRecordsLocked(status, serve, containers)
		if anyRunning(serve) && wl.phase == phaseIdle {
			adoptServingLocked(wl, serve, now-stableBeforeReady)
		}
		if anyRunning(serve) && !wl.endpointsOn && !wl.busy && !status.FenceNow {
			r.setEndpointsLocked(wl, true)
		}
	case availabilitylease.RoleFencing:
		// A freeze of this host moves the deadline back (D4): the watchdog
		// record follows, so a stop that hangs is still killed in time.
		if status.Deadline > 0 {
			r.armRecordsLocked(status, serve, containers)
		}
		r.stopLocked(wl, status, containers, purposeFence)
	case availabilitylease.RoleAbandoned:
		if status.Deadline > 0 {
			r.armRecordsLocked(status, serve, containers)
		}
		if !wl.busy && now >= wl.retryAt {
			r.stopLocked(wl, status, containers, purposeAbandon)
		}
	case availabilitylease.RoleReleasing:
	case availabilitylease.RoleBootstrapping:
		// The named initial holder's legacy copy runs while it acquires (A5).
	default:
		// Legacy owns a closed policy's containers; a pending bootstrap
		// holder's legacy copy keeps running (A5).
		if bootstrap || manifest.Closed {
			break
		}
		if fresh && anyRunning(containers) && !wl.busy {
			r.stopLocked(wl, status, containers, purposeUnowned)
		} else if wl.endpointsOn && !wl.busy {
			r.setEndpointsLocked(wl, false)
		}
		wl.phase = phaseIdle
	}
	if !bootstrap && !manifest.Closed {
		r.armStandbyRecordsLocked(manifest.PolicyID, containers)
	}
	r.updateReadyLocked(manifest, wl, serve, containers, now)
	r.noteBootstrapWaitLocked(manifest, wl, bootstrap, serve, containers, now)
}

// noteBootstrapWaitLocked logs why the named bootstrap holder does not try to
// acquire its reserved key, once per reason: without its copy it waits
// forever, and Opfield sees only a bootstrap that never completes.
func (r *Runtime) noteBootstrapWaitLocked(manifest availabilitylease.ManifestInfo, wl *workload, pending bool, serve, containers []Container, now time.Duration) {
	reason := ""
	if pending && !r.ready[manifest.PolicyID] {
		reason = "not ready"
		switch {
		case len(serve) == 0:
			reason = "no copy of the workload was found on this node"
		case !r.watchdog.fresh:
			reason = "the lease watchdog is not running"
		case !r.snapshotFreshLocked(now):
			reason = "the container view is outdated"
		default:
			for _, c := range containers {
				if c.RestartPolicy != "no" {
					reason = "the copy still has restart policy " + c.RestartPolicy
					break
				}
			}
		}
	}
	if reason == wl.bootstrapWait {
		return
	}
	wl.bootstrapWait = reason
	if reason == "" {
		return
	}
	r.logger.Warn("availability lease bootstrap holder is not ready to acquire its reserved slot",
		"policy_id", manifest.PolicyID, "reason", reason, "containers", len(containers))
}

func anyRunning(containers []Container) bool {
	for _, c := range containers {
		if c.Running {
			return true
		}
	}
	return false
}

func (r *Runtime) bootstrapPendingLocked(manifest availabilitylease.ManifestInfo) bool {
	for slot, holder := range manifest.Bootstrap {
		if holder == r.opts.NodeID && r.node.BootstrapPending(availabilitylease.Key{PolicyID: manifest.PolicyID, Slot: slot}) {
			return true
		}
	}
	return false
}

// serveLocked keeps the serving set running while the lease is held: deadline
// records first, then start, then endpoints once the set is ready.
func (r *Runtime) serveLocked(wl *workload, status availabilitylease.HolderStatus, serve, containers []Container, fresh bool, now time.Duration) {
	r.armRecordsLocked(status, serve, containers)
	if wl.busy || !fresh {
		return
	}
	if wl.phase == phaseIdle {
		var stopped []Container
		for _, c := range serve {
			if !c.Running {
				stopped = append(stopped, c)
			}
		}
		if len(serve) > 0 && len(stopped) == 0 {
			adoptServingLocked(wl, serve, now-stableBeforeReady)
			return
		}
		if len(stopped) > 0 {
			// No start without a live deadline record; retry next step.
			if r.recordsArmed(stopped, status.Deadline) {
				r.startLocked(wl, status.Key, serve, stopped)
			}
			return
		}
		adoptServingLocked(wl, serve, now)
		return
	}
	if wl.healthRequest != "" {
		issue := wl.healthRequest
		wl.healthRequest = ""
		r.releaseUnhealthyLocked(wl, status, containers, now, issue)
		return
	}
	if r.sampleHealthLocked(wl, serve, now) {
		r.releaseUnhealthyLocked(wl, status, containers, now, wl.health.lastIssue)
		return
	}
	if !wl.endpointsOn && r.readyLocked(wl, serve, now) {
		r.setEndpointsLocked(wl, true)
	}
}

// releaseUnhealthyLocked is the health release (D6): the copy stops, the slot
// is released for the next candidate by rank, and this node is no candidate
// for the backoff cooldown, after which it takes the slot back itself when
// nobody else did (a restart in place).
func (r *Runtime) releaseUnhealthyLocked(wl *workload, status availabilitylease.HolderStatus, containers []Container, now time.Duration, issue string) {
	cooldown := healthCooldown(wl, now)
	wl.release = &releaseIntent{reason: "unhealthy"}
	wl.cooldownUntil = now + cooldown
	r.logger.Warn("availability lease holder is unhealthy; releasing the lease", "policy_id", wl.policyID, "issue", issue, "cooldown", cooldown)
	r.stopLocked(wl, status, containers, purposeRelease)
}

// ReleaseUnhealthy asks the holder of a policy's slot on this node to release
// it for health, as its own health watch does after two bad samples (D6):
// Opfield found the copy failing its HTTP health check while another copy
// serves. False when this node does not serve the policy under a lease now.
func (r *Runtime) ReleaseUnhealthy(policyID, issue string) bool {
	holding := false
	for _, status := range r.node.Holders() {
		if status.Key.PolicyID == policyID && status.Role == availabilitylease.RoleHolding {
			holding = true
		}
	}
	if !holding {
		return false
	}
	r.mu.Lock()
	wl := r.workloads[policyID]
	accepted := wl != nil && wl.phase == phaseServing && wl.release == nil
	if accepted {
		wl.healthRequest, wl.healthRequestAt = issue, r.opts.Clock.Now()
	}
	r.mu.Unlock()
	if accepted {
		r.kick()
	}
	return accepted
}

// disarmRetainedLocked removes the watchdog deadline records of this node's
// containers of a retained policy: the lease closed and a majority of every
// quorum set confirmed this copy retained, so no other node can acquire the
// key and the watchdog must never kill the copy. Nothing re-arms them while
// the manifest stays closed; the endpoints and the copy are left as they are.
func (r *Runtime) disarmRetainedLocked(wl *workload, containers []Container) {
	for _, c := range containers {
		if _, armed := r.records[c.ID]; !armed {
			continue
		}
		if err := r.opts.Fence.DeleteRecord(c.ID); err != nil {
			r.logger.Error("could not disarm the lease deadline of a retained copy; retrying", "policy_id", wl.policyID, "container_id", c.ID, "error", err)
			continue
		}
		delete(r.records, c.ID)
		r.logger.Info("lease closed; the retained copy keeps running without a lease deadline", "policy_id", wl.policyID, "container_id", c.ID)
	}
}

// armRecordsLocked writes the watchdog deadline of every container of a held
// policy before the runtime starts any of them (A12.1).
func (r *Runtime) armRecordsLocked(status availabilitylease.HolderStatus, _, containers []Container) {
	// Every container of the policy is bound to the lease while this node
	// holds it: the serving set, and anything a gated backend start (rollout
	// slot, recreate, compose) started under BeforeStart. None may outlive
	// the lease, and a record is never lowered to 0 under a running copy.
	for _, c := range containers {
		r.writeRecordLocked(c, status.Key.Slot, status.Deadline)
	}
}

// armStandbyRecordsLocked gives every container of a lease-mode policy a
// record right after create: 0 (stale) until this node holds the lease, so a
// late or foreign docker start is killed by the watchdog (A12.1, A12.2).
func (r *Runtime) armStandbyRecordsLocked(policyID string, containers []Container) {
	for _, c := range containers {
		if _, ok := r.records[c.ID]; !ok {
			r.writeRecordLocked(c, 0, 0)
		}
	}
}

func (r *Runtime) writeRecordLocked(c Container, slot uint32, deadline time.Duration) {
	if !leasefence.ValidContainerID(c.ID) {
		return
	}
	current, ok := r.records[c.ID]
	if ok && c.CgroupPath == "" {
		c.CgroupPath = current.CgroupPath
	}
	if ok && current.CgroupPath == c.CgroupPath && current.Slot == slot {
		delta := deadline - current.Deadline()
		// Lower deadlines are always written (a detected freeze moves them
		// back); raising by less than a second is not worth a write.
		if delta >= 0 && delta < time.Second {
			return
		}
	}
	record := leasefence.Record{
		ContainerID: c.ID, CgroupPath: c.CgroupPath, PolicyID: c.PolicyID, Slot: slot,
		DeadlineNs: int64(deadline), WrittenNs: int64(r.opts.Clock.Now()),
	}
	if err := r.opts.Fence.WriteRecord(record); err != nil {
		r.logger.Error("could not write a lease deadline record", "container_id", c.ID, "error", err)
		return
	}
	r.records[c.ID] = record
}

// recordsArmed confirms each container to start has a live record.
func (r *Runtime) recordsArmed(containers []Container, deadline time.Duration) bool {
	for _, c := range containers {
		record, ok := r.records[c.ID]
		if !ok || record.Deadline() <= r.opts.Clock.Now() || record.Deadline() > deadline {
			return false
		}
	}
	return true
}

// endLeasePeriodLocked forgets the serving set this node ran under a lease
// that closed while it holds no key of the policy (legacy runs the policy, or
// the copy is retained). The legacy path may replace or remove those
// containers (a disable keeps a copy under the workload's own name and
// removes the others): when the policy enters lease mode again, its holder
// adopts the copy it finds then. Watching the previous period's container ids
// released every holder at once for containers that no longer exist. The
// health backoff of that period ends with it too.
func endLeasePeriodLocked(wl *workload) {
	if wl.busy {
		return
	}
	wl.phase, wl.serveIDs, wl.health = phaseIdle, nil, healthTracker{}
	wl.healthReleases, wl.cooldownUntil = 0, 0
	wl.healthRequest, wl.healthRequestAt = "", 0
}

// adoptServingLocked starts the health watch and readiness clock for the
// serving set this node now runs under its lease.
func adoptServingLocked(wl *workload, serve []Container, now time.Duration) {
	wl.phase, wl.servingSince = phaseServing, now
	wl.health = healthTracker{lastSampleAt: now}
	wl.serveIDs = map[string]bool{}
	for _, c := range serve {
		wl.serveIDs[c.ID] = true
	}
}

func (r *Runtime) startLocked(wl *workload, key availabilitylease.Key, serve, containers []Container) {
	r.launch(wl, "start", func(ctx context.Context) func() {
		// Re-check right before starting: the lease or the watchdog may have
		// gone while the operation waited (A12.4).
		status := r.node.HolderStatus(key)
		if !status.MayStart || !HeartbeatFresh(r.opts.Fence, r.opts.Clock.Now()) {
			return nil
		}
		var failed []string
		gone := false
		for _, c := range containers {
			callCtx, cancel := context.WithTimeout(ctx, dockerCallWait*2)
			if err := r.opts.Engine.Start(callCtx, c.ID); err != nil {
				failed = append(failed, c.ID)
				r.logger.Warn("availability lease holder could not start its container", "policy_id", key.PolicyID, "container_id", c.ID, "error", err)
				if _, found, inspectErr := r.opts.Engine.Inspect(callCtx, c.ID); inspectErr == nil && !found {
					gone = true
				}
			}
			cancel()
		}
		if len(failed) < len(containers) {
			// T6 §3.1: the started standby placement becomes active.
			r.opts.Placements.MarkServing(key.PolicyID, true)
		}
		return func() {
			if gone {
				// The view listed a container that was removed since (its placement was prepared again): the next
				// step starts the copy the node has now. Serving the old view would release the slot for a
				// container that no longer exists and leave the new one never started.
				r.logger.Info("availability lease holder found its container replaced; starting the current copy", "policy_id", key.PolicyID, "slot", key.Slot)
				return
			}
			adoptServingLocked(wl, serve, r.opts.Clock.Now())
			r.logger.Info("availability lease holder started its workload", "policy_id", key.PolicyID, "slot", key.Slot, "failed", len(failed))
		}
	})
}

func (r *Runtime) setEndpointsLocked(wl *workload, serving bool) {
	policyID := wl.policyID
	r.launch(wl, "endpoints", func(context.Context) func() {
		r.opts.Endpoints.SetServing(policyID, serving)
		return func() { wl.endpointsOn = serving }
	})
}

// abandonLocked stops renewing at once when the watchdog is gone (A12.4):
// without it a hung daemon could not be fenced. The container is then killed
// by the daemon itself and the key released once its cgroup is empty, so the
// successor starts at once (B-9); never before the stop is confirmed.
func (r *Runtime) abandonLocked(wl *workload, status availabilitylease.HolderStatus, reason string) {
	r.logger.Warn("availability lease holder stops renewing", "policy_id", status.Key.PolicyID, "slot", status.Key.Slot, "reason", reason)
	r.node.AbandonFor(status.Key, availabilitylease.FenceWatchdogLost)
	if !wl.busy {
		r.stopLocked(wl, status, r.snapshot.byPolicy[wl.policyID], purposeAbandon)
	}
}

// stopLocked ends the workload: endpoints are deregistered first, then every
// container is stopped (graceful within the fence budget, then killed), then
// the cgroups are confirmed empty. Only then is the lease released or the
// fence completed (A6). A stop that cannot be confirmed abandons the key: no
// release, the watchdog fences at the deadline.
func (r *Runtime) stopLocked(wl *workload, status availabilitylease.HolderStatus, containers []Container, purpose stopPurpose) {
	if wl.busy {
		return
	}
	key, policyID := status.Key, wl.policyID
	intent := wl.release
	grace := maxGracefulStop
	if purpose == purposeAbandon || purpose == purposeKill {
		grace = 0
	} else if status.Deadline > 0 {
		if budget := status.Deadline - r.opts.Clock.Now() - killMargin; budget < grace {
			grace = max(budget, 0)
		}
	}
	targets := append([]Container(nil), containers...)
	r.launch(wl, "stop", func(ctx context.Context) func() {
		r.opts.Endpoints.SetServing(policyID, false)
		// The snapshot may predate a container a gated backend start created
		// moments ago: re-list the policy and stop and confirm that list too
		// (A6). A failed re-list leaves the stop unconfirmed: no release.
		targets, listErr := r.relistPolicy(ctx, policyID, targets)
		for _, c := range targets {
			if !c.Running && purpose != purposeAbandon && purpose != purposeKill {
				continue
			}
			limit := grace
			if c.StopTimeout > 0 && c.StopTimeout < limit {
				limit = c.StopTimeout
			}
			callCtx, cancel := context.WithTimeout(ctx, limit+dockerCallWait)
			err := r.opts.Engine.Stop(callCtx, c.ID, limit)
			cancel()
			if err != nil {
				killCtx, cancelKill := context.WithTimeout(ctx, dockerCallWait)
				_ = r.opts.Engine.Kill(killCtx, c.ID)
				cancelKill()
			}
		}
		confirmed := listErr == nil
		for _, c := range targets {
			empty, err := r.opts.Engine.CgroupEmpty(ctx, c)
			if err != nil || !empty {
				confirmed = false
			}
		}
		if confirmed {
			// T6 §3.1: a released or fenced placement is marked stopped
			// before the release leaves.
			r.opts.Placements.MarkServing(policyID, false)
		}
		var releaseErr error
		if confirmed && purpose == purposeRelease {
			successor := ""
			if intent != nil {
				successor = intent.successor
			}
			releaseErr = r.node.Release(key, successor)
		} else if confirmed && (purpose == purposeFence || purpose == purposeAbandon) {
			r.node.FenceComplete(key)
		} else if !confirmed && (purpose == purposeRelease || purpose == purposeFence) {
			r.node.Abandon(key)
		}
		return func() {
			wl.endpointsOn, wl.phase = false, phaseIdle
			if purpose == purposeRelease {
				wl.release = nil
			}
			if !confirmed {
				wl.retryAt = r.opts.Clock.Now() + abandonRetry
				r.logger.Error("availability lease workload stop not confirmed; renewals stopped, the watchdog fences", "policy_id", policyID, "purpose", purpose)
				return
			}
			if releaseErr != nil {
				r.logger.Warn("availability lease release refused", "policy_id", policyID, "error", releaseErr)
			}
			r.logger.Info("availability lease workload stopped", "policy_id", policyID, "slot", key.Slot, "purpose", purpose)
		}
	})
}

// relistPolicy merges the policy's current containers into the stop targets;
// the fresh state wins for containers present in both.
func (r *Runtime) relistPolicy(ctx context.Context, policyID string, targets []Container) ([]Container, error) {
	current, err := r.opts.Engine.ListLeaseContainers(ctx)
	if err != nil {
		r.logger.Warn("availability lease stop could not re-list the workload; the stop stays unconfirmed", "policy_id", policyID, "error", err)
		return targets, err
	}
	merged := make([]Container, 0, len(targets))
	index := map[string]int{}
	for _, c := range targets {
		index[c.ID] = len(merged)
		merged = append(merged, c)
	}
	for _, c := range current {
		if c.PolicyID != policyID {
			continue
		}
		if i, ok := index[c.ID]; ok {
			merged[i] = c
			continue
		}
		index[c.ID] = len(merged)
		merged = append(merged, c)
	}
	return merged, nil
}

func (r *Runtime) updateReadyLocked(manifest availabilitylease.ManifestInfo, wl *workload, serve, containers []Container, now time.Duration) {
	ready := !manifest.Closed && manifest.IsCandidate(r.opts.NodeID) && r.watchdog.fresh && now >= wl.cooldownUntil &&
		len(serve) > 0 && r.snapshotFreshLocked(now) && !(wl.busy && wl.op == "stop")
	for _, c := range containers {
		if c.RestartPolicy != "no" {
			ready = false
		}
	}
	if r.ready[manifest.PolicyID] != ready {
		r.ready[manifest.PolicyID] = ready
		r.node.SetCandidateReady(manifest.PolicyID, ready)
	}
}
