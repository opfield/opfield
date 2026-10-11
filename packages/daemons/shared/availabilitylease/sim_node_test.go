package availabilitylease

import (
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// simNode is one host: a relay or a docker daemon with its containers and
// its independent watchdog (A2, A12).
type simNode struct {
	id    string
	relay bool
	w     *simWorld
	rate  float64

	baseReal, baseLocal time.Duration
	frozen              bool
	frozenAt            time.Duration
	resumedLocal        time.Duration
	frozenInbox         []func()
	beaconGen           uint64

	hostUp bool
	procUp bool
	gen    uint64
	store  *MemoryStore
	node   *Node
	signer Signer
	verify Verifier

	wakeToken     uint64
	wakeAt        time.Duration
	wakeScheduled bool

	containers  map[Key]*simContainer
	watchdog    map[Key]time.Duration
	hostGen     uint64
	wdSeq       uint64
	wdAt        time.Duration
	wdScheduled bool
	ready       bool
	hangUntil   time.Duration
	stopDelay   time.Duration
}

type simContainer struct {
	live, starting, stopping bool
	legacy                   bool
	residual                 bool

	draining     bool
	successor    string
	drainStarted bool
}

type simClock struct{ n *simNode }

func (c simClock) Now() time.Duration { return c.n.local() }

// Origin changes with every host boot, like the kernel boot id: bootHost
// jumps the local clock.
func (c simClock) Origin() uint64 {
	return uint64(len(c.n.id))<<48 ^ uint64(c.n.hostGen+1)*0x9e3779b97f4a7c15 ^ hashString(c.n.id)
}

func hashString(value string) uint64 {
	var h uint64 = 1469598103934665603
	for i := 0; i < len(value); i++ {
		h ^= uint64(value[i])
		h *= 1099511628211
	}
	return h
}

type simTransport struct{ n *simNode }

func (t simTransport) Send(frame *pb.CoordinationFrame) {
	batch := &pb.LeaseBatch{}
	if err := proto.Unmarshal(frame.GetPayload(), batch); err != nil {
		t.n.w.fail("transport decode: %v", err)
		return
	}
	payload, _ := proto.Marshal(frame)
	t.n.w.sendPayload(t.n.id, frame.GetDestinationId(), batch, payload)
}

func (n *simNode) local() time.Duration {
	if n.frozen {
		return n.baseLocal
	}
	return n.baseLocal + time.Duration(float64(n.w.now-n.baseReal)*n.rate)
}

// realAt converts a local clock target to the real time it is reached.
func (n *simNode) realAt(local time.Duration) time.Duration {
	current := n.local()
	if local <= current {
		return n.w.now
	}
	return n.w.now + time.Duration(float64(local-current)/n.rate) + time.Nanosecond
}

func (n *simNode) setRate(rate float64) {
	n.baseLocal, n.baseReal, n.rate = n.local(), n.w.now, rate
	n.armWatchdog(true)
	n.wakeScheduled = false
	n.scheduleWake()
}

func (n *simNode) processUp() bool { return n.hostUp && n.procUp }

// start launches the node process (daemon or relay) from its store.
func (n *simNode) start() {
	n.procUp = true
	n.gen++
	cfg := Config{
		ID: n.id, Clock: simClock{n}, Store: n.store, Signer: n.signer, Verifier: n.verify,
		IncarnationFloor: uint64(n.w.now / time.Millisecond), FreezeDriftRate: n.w.freezeDrift,
		FreezeSkewBudget: n.w.freezeBudget,
	}
	if n.w.wire {
		cfg.Transport = simTransport{n}
	}
	node, err := NewNode(cfg)
	if err != nil {
		n.w.fail("start %s: %v", n.id, err)
		return
	}
	if !n.w.wire {
		node.rawSend = func(to string, batch *pb.LeaseBatch) { n.w.send(n.id, to, batch) }
	}
	n.node = node
	n.w.tracef("%s start incarnation=%d", n.id, node.Incarnation())
	n.w.gw.onNodeStart(n)
	if n.w.state != nil {
		n.w.state.register(n)
	}
	if !n.w.noBeacons {
		n.beaconGen++
		n.scheduleBeacon(n.beaconGen, n.gen)
	}
	for _, key := range n.w.keys {
		if c := n.containers[key]; c != nil && (c.live || c.starting) && !c.legacy {
			if deadline, ok := n.watchdog[key]; ok {
				node.Recover(key, deadline)
			}
		}
	}
	n.after()
}

func (n *simNode) stopProcess() {
	n.procUp = false
	n.node = nil
	n.gen++
	n.wakeScheduled = false
}

// crashHost kills the host: containers die (RestartPolicy no), the tmpfs
// watchdog records are lost.
func (n *simNode) crashHost() {
	n.w.tracef("%s host crash", n.id)
	n.stopProcess()
	n.hostUp = false
	n.frozen = false
	n.resumedLocal = 0
	n.frozenInbox = nil
	n.containers = map[Key]*simContainer{}
	n.watchdog = map[Key]time.Duration{}
	n.hostGen++
}

func (n *simNode) bootHost() {
	n.hostUp = true
	n.baseLocal, n.baseReal = n.local()+time.Duration(n.w.rng.Int63n(int64(time.Hour))), n.w.now
	n.start()
}

func (n *simNode) freeze() {
	if n.frozen || !n.hostUp {
		return
	}
	n.w.tracef("%s freeze", n.id)
	n.baseLocal = n.local()
	n.frozen, n.frozenAt = true, n.w.now
}

func (n *simNode) resume() {
	if !n.frozen {
		return
	}
	n.w.tracef("%s resume", n.id)
	n.baseReal, n.frozen = n.w.now, false
	for _, key := range n.w.keys {
		// A container that was running or starting when the VM froze is
		// the A2.5 residual after the resume.
		if c := n.containers[key]; c != nil && (c.live || c.starting) {
			c.residual = true
		}
	}
	n.resumedLocal = n.local()
	inbox := n.frozenInbox
	n.frozenInbox = nil
	n.checkWatchdog()
	for _, fn := range inbox {
		fn()
	}
	// The resumed host learns of the freeze only from its peers' clocks
	// (D4): the first frame from a peer with a pre-freeze baseline.
	if n.processUp() {
		n.after()
	}
}

func (n *simNode) deliver(from string, batch *pb.LeaseBatch, payload []byte) {
	if !n.processUp() {
		return
	}
	if n.frozen {
		if n.w.rng.Intn(2) == 0 {
			gen := n.gen
			n.frozenInbox = append(n.frozenInbox, func() {
				if n.gen == gen {
					n.deliver(from, batch, payload)
				}
			})
		}
		return
	}
	n.w.delivered++
	if n.w.traceOn {
		n.w.tracef("%s -> %s: %s", from, n.id, n.w.describeBatch(batch))
	}
	if payload != nil {
		frame := &pb.CoordinationFrame{}
		if err := proto.Unmarshal(payload, frame); err != nil {
			n.w.fail("frame decode: %v", err)
			return
		}
		if err := n.node.ReceiveFrame(frame); err != nil && err != ErrUnknownSender {
			n.w.fail("receive frame at %s: %v", n.id, err)
			return
		}
	} else {
		_ = n.node.receive(batch)
	}
	n.after()
}

// after runs the daemon control loop and reschedules the node's wakeup.
func (n *simNode) after() {
	if !n.processUp() || n.frozen || n.node == nil {
		return
	}
	events := n.node.DrainEvents()
	for _, event := range events {
		n.w.tracef("%s event %s %s ballot=%s reason=%s succ=%s forced=%s", n.id, event.Kind, event.Key, event.Ballot, event.Reason, event.Successor, event.Forced)
		n.w.events2 = append(n.w.events2, simEvent2{node: n.id, event: event, at: n.w.now})
		if event.Kind == EventAcquired {
			n.w.acquired = append(n.w.acquired, simAcquire{node: n.id, key: event.Key, at: n.w.now})
		}
	}
	if n.w.state != nil && !n.relay {
		n.w.state.observe(n, events)
		if n.w.violation != "" {
			return
		}
	}
	if !n.relay {
		n.reconcile()
	}
	n.scheduleWake()
}

// scheduleBeacon models the clock beacons (D4): a relay coordinator beacons
// every daemon, a daemon every relay member. A frozen host sends none; lost
// links drop them.
func (n *simNode) scheduleBeacon(beaconGen, gen uint64) {
	n.w.after(BeaconInterval, func() {
		if n.beaconGen != beaconGen || n.gen != gen || !n.processUp() || n.node == nil {
			return
		}
		if !n.frozen {
			if n.relay {
				n.node.Beacon(n.w.daemons...)
			} else {
				n.node.BeaconRelays()
			}
		}
		n.scheduleBeacon(beaconGen, gen)
	})
}

func (n *simNode) scheduleWake() {
	if !n.processUp() || n.frozen || n.node == nil {
		return
	}
	at := n.realAt(n.node.NextWakeup())
	if n.wakeScheduled && n.wakeAt >= n.w.now && n.wakeAt <= at {
		return
	}
	n.wakeToken++
	token, gen := n.wakeToken, n.gen
	n.wakeAt, n.wakeScheduled = at, true
	n.w.at(at, func() {
		if n.wakeToken != token || n.gen != gen || !n.processUp() || n.frozen {
			return
		}
		n.wakeScheduled = false
		n.node.Tick()
		n.after()
	})
}

func (n *simNode) hung() bool { return n.w.now < n.hangUntil }

func (n *simNode) setWatchdog(key Key, deadline time.Duration) {
	if n.watchdog[key] == deadline {
		return
	}
	n.watchdog[key] = deadline
	n.armWatchdog(false)
}

// armWatchdog schedules one check at the earliest deadline of a running
// container; force re-arms after a clock rate change.
func (n *simNode) armWatchdog(force bool) {
	if !n.hostUp || n.frozen {
		return
	}
	var earliest time.Duration
	for _, key := range n.w.keys {
		c := n.containers[key]
		deadline, ok := n.watchdog[key]
		if c != nil && ok && !c.legacy && (c.live || c.starting) && (earliest == 0 || deadline < earliest) {
			earliest = deadline
		}
	}
	if earliest == 0 {
		return
	}
	at := n.realAt(earliest)
	if !force && n.wdScheduled && n.wdAt >= n.w.now && n.wdAt <= at {
		return
	}
	n.wdSeq++
	seq, gen := n.wdSeq, n.hostGen
	n.wdScheduled, n.wdAt = true, at
	n.w.at(at, func() {
		if n.hostGen == gen && n.wdSeq == seq {
			n.wdScheduled = false
			n.checkWatchdog()
		}
	})
}

// checkWatchdog kills every container whose deadline record is stale,
// without going through the daemon or dockerd (A2.2, A12.2).
func (n *simNode) checkWatchdog() {
	if !n.hostUp || n.frozen {
		return
	}
	now := n.local()
	for _, key := range n.w.keys {
		c := n.containers[key]
		deadline, ok := n.watchdog[key]
		if c == nil || c.legacy || !ok || !(c.live || c.starting) {
			continue
		}
		if now < deadline {
			continue
		}
		n.w.tracef("%s watchdog kills %s", n.id, key)
		if n.processUp() && n.node != nil && n.node.HolderStatus(key).Retained {
			n.w.fail("the watchdog killed the retained copy of %s on %s", key, n.id)
		}
		c.live, c.starting, c.stopping = false, false, false
	}
	n.armWatchdog(true)
	if n.processUp() && n.node != nil {
		n.after()
	}
}

// reconcile is the docker daemon's lease loop in the model.
func (n *simNode) reconcile() {
	for _, key := range n.w.keys {
		st := n.node.HolderStatus(key)
		switch st.Role {
		case RoleHolding, RoleRecovering, RoleFencing, RoleAbandoned:
			if st.Deadline > 0 {
				n.setWatchdog(key, st.Deadline)
			}
		case RoleRetained:
			// Graceful close: the copy runs on without a lease; legacy owns
			// it and the watchdog record is disarmed. A copy that is not
			// running after all (a start the close cut short) is released,
			// like the docker daemon does.
			delete(n.watchdog, key)
			if c := n.containers[key]; c != nil && c.live && !c.stopping {
				if !c.legacy {
					c.legacy = true
					n.w.tracef("%s retains %s: deadline disarmed", n.id, key)
				}
			} else if c == nil || !c.starting && !c.stopping {
				if err := n.node.Release(key, ""); err == nil {
					n.w.tracef("%s releases retained %s: no running copy", n.id, key)
				}
			}
		}
		c := n.containers[key]
		if c == nil {
			if st.Role == RoleFencing || st.Role == RoleAbandoned {
				n.node.FenceComplete(key)
				continue
			}
			if st.MayStart {
				c = &simContainer{}
				n.containers[key] = c
				n.startContainer(key, c)
			}
			continue
		}
		n.reconcileContainer(key, c, st)
	}
	n.armWatchdog(false)
}

func (n *simNode) reconcileContainer(key Key, c *simContainer, st HolderStatus) {
	switch {
	case c.starting || c.stopping:
	case c.live:
		// The A2.5 residual ends when a round sent after the resume
		// succeeds; a round sent before the freeze may complete right
		// after it with a deadline anchored in the frozen past.
		if c.residual && st.Holding && st.Deadline > n.resumedLocal+FenceCompleteAfter {
			c.residual = false
		}
		if c.legacy {
			if st.Holding {
				c.legacy = false
			}
			return
		}
		leased := st.Role == RoleHolding || st.Role == RoleRecovering
		if st.FenceNow || !leased || c.draining {
			n.stopContainer(key, c)
		}
	default:
		if c.draining {
			if c.successor != "" || c.drainStarted {
				successor := c.successor
				c.draining, c.successor, c.drainStarted = false, "", false
				if err := n.node.Release(key, successor); err == nil {
					n.w.tracef("%s release %s successor=%q", n.id, key, successor)
				}
			}
			return
		}
		switch st.Role {
		case RoleFencing, RoleAbandoned:
			n.node.FenceComplete(key)
		case RoleNone, RoleCandidate, RoleReleasing:
			if st.Role != RoleReleasing {
				delete(n.watchdog, key)
			}
		}
		if st.MayStart {
			n.startContainer(key, c)
		}
	}
}
