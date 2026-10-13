package availabilitylease

import (
	"time"
)

type faultKind int

const (
	faultPartition faultKind = iota
	faultIsolateHolder
	faultLossBurst
	faultDelaySpike
	faultAcceptorRestart
	faultProposerRestart
	faultFreeze
	faultHostReboot
	faultDockerHang
	faultEpochChange
	faultManifestBump
	faultHandoff
	faultHealthRelease
	faultKeyRotation
	faultRateChange
	faultSiteOutage
	faultClose
	faultKinds
)

var faultNames = [...]string{
	"partition", "isolate-holder", "loss-burst", "delay-spike", "acceptor-restart", "proposer-restart",
	"freeze", "host-reboot", "docker-hang", "epoch-change", "manifest-bump", "handoff", "health-release",
	"key-rotation", "rate-change", "site-outage", "close",
}

// scheduleChaos places random faults between 3 s and chaosEnd-5 s. The
// Opfield dies at a random time in 30% of seeds.
func scheduleChaos(w *simWorld, topo simTopology) {
	if w.rng.Float64() < 0.3 {
		w.at(w.randDuration(10*time.Second, chaosEnd), func() {
			w.gw.alive = false
			w.tracef("gateway dies")
		})
	}
	w.after(5*time.Second, func() { opfieldBootstrapLoop(w) })
	at := 3 * time.Second
	minGap, maxGap := 3*time.Second, 12*time.Second
	if w.rng.Float64() < 0.25 {
		// Fault storm.
		minGap, maxGap = 500*time.Millisecond, 4*time.Second
	}
	for {
		at += w.randDuration(minGap, maxGap)
		if at >= chaosEnd-5*time.Second {
			return
		}
		kind := faultKind(w.rng.Intn(int(faultKinds)))
		w.at(at, func() { applyFault(w, topo, kind) })
	}
}

// opfieldBootstrapLoop drops the bootstrap reservation once its holder
// reported acquiring (A5), like Opfield does on the lease report.
func opfieldBootstrapLoop(w *simWorld) {
	policy := w.gw.policies["p1"]
	if len(policy.bootstrap) == 0 || !w.gw.alive {
		return
	}
	// Per slot: a reservation is dropped once its named holder reported
	// acquiring that slot under it.
	dropped := false
	for slot, holder := range policy.bootstrap {
		key := Key{PolicyID: "p1", Slot: slot}
		for _, acquired := range w.acquired {
			if acquired.node == holder && acquired.key == key && acquired.at >= policy.bootstrapAt {
				delete(policy.bootstrap, slot)
				dropped = true
				break
			}
		}
	}
	if dropped {
		w.gw.republish("p1", 1)
		w.tracef("gateway drops bootstrap reservation")
	}
	if len(policy.bootstrap) > 0 {
		w.after(5*time.Second, func() { opfieldBootstrapLoop(w) })
	}
}

func (w *simWorld) pick(ids []string) string { return ids[w.rng.Intn(len(ids))] }

func (w *simWorld) currentHolderOr(topo simTopology) string {
	if holder := w.holder(w.keys[0]); holder != "" {
		return holder
	}
	return w.pick(topo.candidates)
}

func (w *simWorld) downLinks(links []*simLink, duration time.Duration) {
	for _, l := range links {
		l.downCount++
		l.up = false
	}
	w.after(duration, func() {
		for _, l := range links {
			if l.downCount > 0 {
				l.downCount--
			}
			l.up = l.downCount == 0
		}
	})
}

func applyFault(w *simWorld, topo simTopology, kind faultKind) {
	w.tracef("fault %s", faultNames[kind])
	if w.state != nil && statefulFault(w, topo, kind) {
		return
	}
	switch kind {
	case faultPartition:
		isolated := map[string]bool{}
		for _, id := range w.ids {
			isolated[id] = w.rng.Float64() < 0.35
		}
		var links []*simLink
		for _, d := range w.daemons {
			for _, r := range w.relays {
				if isolated[d] != isolated[r] {
					links = append(links, w.link(d, r))
				}
			}
		}
		w.downLinks(links, w.randDuration(5*time.Second, 60*time.Second))
	case faultIsolateHolder:
		holder := w.currentHolderOr(topo)
		keep := ""
		if w.rng.Intn(2) == 0 {
			keep = w.pick(w.relays)
		}
		var links []*simLink
		for _, r := range w.relays {
			if r != keep {
				links = append(links, w.link(holder, r))
			}
		}
		w.tracef("isolate %s keep=%q", holder, keep)
		w.downLinks(links, w.randDuration(5*time.Second, 60*time.Second))
	case faultLossBurst:
		w.net.loss += 0.3
		w.after(w.randDuration(5*time.Second, 20*time.Second), func() { w.net.loss -= 0.3 })
	case faultDelaySpike:
		var links []*simLink
		for _, d := range w.daemons {
			for _, r := range w.relays {
				if w.rng.Intn(3) == 0 {
					links = append(links, w.link(d, r))
				}
			}
		}
		for _, l := range links {
			l.minDelay, l.maxDelay = 500*time.Millisecond, w.randDuration(time.Second, 4*time.Second)
		}
		w.after(w.randDuration(5*time.Second, 30*time.Second), func() {
			for _, l := range links {
				l.minDelay, l.maxDelay = w.net.minDelay, w.net.maxDelay
			}
		})
	case faultAcceptorRestart:
		policy := w.gw.policies[w.pick(sortedKeys(w.gw.policies))]
		n := w.nodes[w.pick(policy.sets[len(policy.sets)-1])]
		wipe := w.rng.Float64() < 0.4
		restartProcess(w, n, wipe, w.randDuration(500*time.Millisecond, 15*time.Second))
	case faultProposerRestart:
		restartProcess(w, w.nodes[w.pick(topo.candidates)], false, w.randDuration(500*time.Millisecond, 30*time.Second))
	case faultFreeze:
		id := w.pick(topo.candidates)
		if w.rng.Float64() < 0.7 {
			id = w.currentHolderOr(topo)
		}
		n := w.nodes[id]
		n.freeze()
		w.after(w.randDuration(2*time.Second, 60*time.Second), n.resume)
	case faultHostReboot:
		n := w.nodes[w.pick(w.daemons)]
		if !n.hostUp {
			return
		}
		n.crashHost()
		w.after(w.randDuration(5*time.Second, 40*time.Second), func() {
			if !n.hostUp && !w.chaosOver {
				n.bootHost()
			}
		})
	case faultDockerHang:
		n := w.nodes[w.pick(topo.candidates)]
		n.hangUntil = w.now + w.randDuration(5*time.Second, 30*time.Second)
	case faultEpochChange:
		// A witness (or voter) change of one policy, mid-lease (A18).
		policy := w.gw.policies[w.pick(sortedKeys(w.gw.policies))]
		w.gw.changeVoters(policy.id, policyVoters(w, policy.candidates), 0.6)
	case faultManifestBump:
		policy := w.gw.policies["p1"]
		if w.rng.Intn(2) == 0 {
			order := append([]string(nil), policy.candidates...)
			w.rng.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
			policy.candidates = order
		}
		w.gw.republish("p1", 0.5)
	case faultHandoff, faultHealthRelease:
		if !w.gw.alive && kind == faultHandoff {
			return
		}
		holder := w.holder(w.keys[0])
		if holder == "" {
			return
		}
		successor := ""
		if kind == faultHandoff {
			for _, id := range w.rng.Perm(len(topo.candidates)) {
				if c := topo.candidates[id]; c != holder && w.nodes[c].processUp() {
					successor = c
					break
				}
			}
		}
		if w.nodes[holder].beginDrain(w.keys[0], successor) {
			w.tracef("drain %s successor=%q", holder, successor)
		}
	case faultKeyRotation:
		w.gw.rotateKey(0.7)
		if w.rng.Float64() < 0.4 {
			// A14 scenario: Opfield signs one manifest with the new key,
			// reaches only a few nodes, and dies.
			w.after(w.randDuration(2*time.Second, 6*time.Second), func() {
				if w.gw.alive && w.gw.signIdx == len(w.gw.keys)-1 {
					w.gw.republish("p1", 0.25)
					w.gw.alive = false
					w.tracef("gateway dies after rotated manifest")
				}
			})
		}
	case faultSiteOutage:
		// A whole site goes dark: one daemon and one relay together.
		site := []*simNode{w.nodes[w.pick(w.daemons)], w.nodes[w.pick(w.relays)]}
		for _, n := range site {
			if n.hostUp {
				n.crashHost()
			}
		}
		w.after(w.randDuration(10*time.Second, 60*time.Second), func() {
			for _, n := range site {
				if !n.hostUp && !w.chaosOver {
					n.bootHost()
				}
			}
		})
	case faultRateChange:
		n := w.nodes[w.pick(w.ids)]
		n.setRate(1 - MaxClockDrift + w.rng.Float64()*2*MaxClockDrift)
	case faultClose:
		// Graceful close and re-entry: leave lease mode (naming the holder
		// Opfield sees, sometimes a stale one), then enter it again.
		stale := w.rng.Float64() < 0.2
		w.gw.closeLease("p1", stale, 0.4+0.6*w.rng.Float64())
		w.after(w.randDuration(5*time.Second, 40*time.Second), func() {
			if !w.chaosOver {
				w.gw.reopenLease("p1", 0.4+0.6*w.rng.Float64())
			}
		})
	}
}

func restartProcess(w *simWorld, n *simNode, wipe bool, downtime time.Duration) {
	if !n.processUp() {
		return
	}
	w.tracef("%s process restart wipe=%v downtime=%s", n.id, wipe, downtime)
	n.stopProcess()
	if wipe {
		n.store.Wipe()
	}
	w.after(downtime, func() {
		if n.hostUp && !n.procUp && !w.chaosOver {
			n.start()
		}
	})
}

// quiet heals every fault: links, loss, freezes, crashed hosts and processes.
func quiet(w *simWorld, topo simTopology) {
	w.tracef("quiet phase")
	w.chaosOver = true
	w.net.loss, w.net.dup = 0, 0
	for _, l := range w.links {
		l.downCount = 0
	}
	w.healAll()
	for _, id := range w.ids {
		n := w.nodes[id]
		n.hangUntil = 0
		if n.frozen {
			n.resume()
		}
		if !n.hostUp {
			n.bootHost()
		} else if !n.procUp {
			n.start()
		}
	}
	if w.gw.alive {
		// Reconnected streams get the current state again.
		for _, id := range w.ids {
			if n := w.nodes[id]; n.processUp() {
				w.gw.onNodeStart(n)
				n.after()
			}
		}
	}
	policy := w.gw.policies["p1"]
	if policy.closed {
		// Only Opfield enters lease mode again (a dead one leaves the
		// policy closed: runRandomSeed then checks no failover).
		w.gw.reopenLease("p1", 1)
	}
	if policy.stateful {
		// A stateful bootstrap depends on the named holder's data, not on its
		// container; the reservation stays until the holder acquired (A5).
		return
	}
	// Opfield drops a slot's bootstrap reservation once its named holder
	// no longer runs the legacy copy (it acquired, or the copy is gone); a
	// holder that still runs it keeps its reservation.
	dropped := false
	for slot, holder := range policy.bootstrap {
		key := Key{PolicyID: "p1", Slot: slot}
		if c := w.nodes[holder].containers[key]; holder != "" && w.gw.alive && (c == nil || !c.live || !c.legacy) {
			delete(policy.bootstrap, slot)
			dropped = true
		}
	}
	if dropped {
		w.gw.republish("p1", 1)
	}
}
