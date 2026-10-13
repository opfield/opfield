package availabilitylease

import (
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// Freeze detection from peer time (D4).
//
// A VM that its hypervisor pauses (or RAM-snapshots) does not see the pause on
// any of its own clocks: CLOCK_BOOTTIME, CLOCK_MONOTONIC and the wall clock
// all stand still, and the wall clock is stepped later by NTP, minutes after
// the resume or never. The wall clock is therefore never evidence of a freeze
// (a step fenced a lease acquired minutes after a resume, stand run B-7).
//
// The evidence is the peers' lease clocks. Every batch carries the sender's
// lease clock and its origin (BootOrigin), plus an echo of the destination's
// own clock from the newest batch the sender received from it and how long it
// held that batch. The receiver keeps, per sender, the offset between its own
// lease clock and the sender's. Without a freeze that offset only grows with
// message delay and moves slowly with clock rate drift; when this host lost d
// of local time since the sender's previous frame it drops by d.
//
// Only batches whose delay the echo bounds by a short round trip
// (maxBoundedRTT) form the reference: the lowest of their offsets over the
// last freezeWindow of local time, less a drift allowance. Any batch is then
// tested against it, and a drop beyond the skew budget is a freeze of this
// host. Because the reference is at most one short round trip above the true
// offset, frames held up anywhere (a stalled stream, a relay queue, a replay)
// can never look like a freeze: they only raise offsets. Offsets that grow (a
// peer that froze, rebooted or restarted with a new origin) are never
// evidence either.
//
// On the first detection of a freeze every lease this node holds may have been
// held across it: its budget ran on a clock that lost d. Those keys fence at
// once (FenceFrozen) with their deadlines moved back by d, so the stop grace
// and the watchdog record follow real time; rounds in flight are dropped and
// observations taken before the detection discarded. The relay gate stays
// closed for every accept anchored before the detection until this node
// promises afresh. Every sender's window is then shifted by d, so the first
// frames from the other peers, which show the same drop, are explained by the
// known freeze and change nothing: leases acquired after a detected freeze are
// never fenced for it. Freezes shorter than the budget stay inside the timing
// margins of the lease term (doc.go).
const (
	// DefaultFreezeSkewBudget is how far the offset to a peer's lease clock
	// may drop below the window's reference before it is a freeze. The lease
	// timing absorbs an undetected freeze below it: a holder is dead 24 s
	// (local) after its last round's send time, an acceptor refuses others for
	// 33 s after the accept.
	DefaultFreezeSkewBudget = 2 * time.Second
	// DefaultFreezeDriftRate is the clock rate difference the detector allows
	// between two hosts, far above what NTP permits (0.05% per host).
	DefaultFreezeDriftRate = 0.01
	// freezeWindow is how much local time of offsets a sender's reference
	// covers. Relays send a clock beacon every second, holders renew every
	// RenewInterval, so a window holds many frames.
	freezeWindow = 30 * time.Second
	// freezeBucket merges samples of one sender closer than this.
	freezeBucket = 500 * time.Millisecond
	// maxBoundedRTT is the longest round trip whose echo makes a batch part
	// of the reference: its delay is at most that round trip, well inside
	// the skew budget.
	maxBoundedRTT = time.Second
	// BeaconInterval is how often a relay sends each member an empty,
	// signed batch, so a resumed host sees a peer's clock within a second of
	// reaching any relay.
	BeaconInterval = time.Second
)

type clockSample struct {
	at     time.Duration // local receive time
	offset time.Duration // local receive time minus the sender's clock
}

// peerClock is the offset history of one sender's clock origin.
type peerClock struct {
	origin uint64
	// samples are the round-trip bounded offsets, ascending by at, one per
	// freezeBucket.
	samples []clockSample
	// lastAt is the local receive time of the sender's latest batch.
	lastAt time.Duration
	// newest is the sender clock of its newest batch, received at newestAt:
	// echoed back so the sender can bound our batches' delay.
	newest   time.Duration
	newestAt time.Duration
}

// FreezeEvent reports a freeze of this host detected from a peer's clock.
type FreezeEvent struct {
	// Peer whose frame showed the drop.
	Peer string
	// Frozen is the estimated local time the host lost.
	Frozen time.Duration
	// Since is the local time of the previous frame from Peer: the freeze
	// happened after it.
	Since time.Duration
	// At is the local time of the detection.
	At time.Duration
	// Fenced lists the keys fenced for it.
	Fenced []Key
}

// observePeerClock records the sender clock of an authenticated batch and
// handles a detected freeze. It runs before the batch's items.
func (n *Node) observePeerClock(from string, batch *pb.LeaseBatch, now time.Duration) {
	sent := batch.GetSenderClockMs()
	if sent == 0 || from == n.id {
		return
	}
	senderClock := time.Duration(sent) * time.Millisecond
	offset := now - senderClock
	origin := batch.GetSenderClockOrigin()
	pc := n.peerClocks[from]
	if pc == nil || pc.origin != origin {
		pc = &peerClock{origin: origin}
		n.peerClocks[from] = pc
	}
	pc.prune(now)
	if len(pc.samples) > 0 {
		reference := pc.samples[0].offset - n.driftAllowance(now-pc.samples[0].at)
		for _, sample := range pc.samples[1:] {
			reference = min(reference, sample.offset-n.driftAllowance(now-sample.at))
		}
		if drop := reference - offset; drop > n.freezeBudget {
			n.onFreeze(FreezeEvent{Peer: from, Frozen: drop, Since: pc.lastAt, At: now})
		}
	}
	pc.lastAt = now
	if senderClock > pc.newest {
		pc.newest, pc.newestAt = senderClock, now
	}
	if n.roundTripBounded(batch, now) {
		pc.add(now, offset)
	}
	n.sweepPeerClocks(now)
}

// roundTripBounded reports whether the batch echoes a recent batch of ours:
// then its delay is at most the round trip, which is short.
func (n *Node) roundTripBounded(batch *pb.LeaseBatch, now time.Duration) bool {
	echo := batch.GetEchoClockMs()
	if echo == 0 || batch.GetEchoClockOrigin() != n.clockOrigin {
		return false
	}
	rtt := now - time.Duration(echo)*time.Millisecond - time.Duration(batch.GetEchoAgeMs())*time.Millisecond
	return rtt >= 0 && rtt <= maxBoundedRTT
}

// echoFor fills the echo of dest's newest clock into a batch for dest.
func (n *Node) echoFor(batch *pb.LeaseBatch, dest string, now time.Duration) {
	pc := n.peerClocks[dest]
	if pc == nil || pc.newest <= 0 {
		return
	}
	batch.EchoClockMs = uint64(pc.newest.Milliseconds())
	batch.EchoClockOrigin = pc.origin
	batch.EchoAgeMs = uint64(max(now-pc.newestAt, 0).Milliseconds())
}

func (n *Node) driftAllowance(age time.Duration) time.Duration {
	if age <= 0 {
		return 0
	}
	return time.Duration(float64(age) * n.freezeDrift)
}

func (pc *peerClock) prune(now time.Duration) {
	keep := 0
	for keep < len(pc.samples) && now-pc.samples[keep].at > freezeWindow {
		keep++
	}
	pc.samples = pc.samples[keep:]
}

func (pc *peerClock) add(now, offset time.Duration) {
	if last := len(pc.samples) - 1; last >= 0 && now-pc.samples[last].at < freezeBucket {
		pc.samples[last].at = now
		pc.samples[last].offset = min(pc.samples[last].offset, offset)
		return
	}
	pc.samples = append(pc.samples, clockSample{at: now, offset: offset})
}

// sweepPeerClocks forgets senders not heard from for a whole window, at most
// once per window.
func (n *Node) sweepPeerClocks(now time.Duration) {
	if now < n.peerClockSweepAt {
		return
	}
	n.peerClockSweepAt = now + freezeWindow
	for id, pc := range n.peerClocks {
		if now-pc.lastAt > freezeWindow {
			delete(n.peerClocks, id)
		}
	}
}

// onFreeze fences every key held across a detected freeze of this host and
// rebases every sender's offsets on the post-freeze clock (D4).
func (n *Node) onFreeze(event FreezeEvent) {
	now, d := event.At, event.Frozen
	for _, pc := range n.peerClocks {
		for i := range pc.samples {
			pc.samples[i].offset -= d
		}
	}
	n.freezeBoundary, n.frozeOnce = now, true
	n.logf("availability lease host freeze detected from %s: lost about %s since %s", event.Peer, d, event.Since)
	for _, key := range sortKeys(proposerKeySet(n.proposers)) {
		pk := n.proposers[key]
		// Observations and quiet periods were timed on the frozen clock.
		pk.obs = map[string]observation{}
		pk.expiredSeen = false
		pk.freshCommitAt -= d
		pk.lastProposeAt -= d
		pk.proposeFloor -= d
		for id := range pk.proposedAt {
			pk.proposedAt[id] -= d
		}
		switch pk.role {
		case RoleHolding, RoleRecovering:
			n.shiftDeadline(pk, d, now)
			n.fence(pk, FenceFrozen, now)
			event.Fenced = append(event.Fenced, key)
		case RoleFencing, RoleAbandoned, RoleReleasing:
			n.shiftDeadline(pk, d, now)
		case RoleAcquiring, RoleBootstrapping:
			// A round sent before the freeze may complete with a deadline
			// anchored in the frozen past: drop it and start afresh.
			if pk.round != nil {
				n.finishRound(pk, now)
			}
		}
	}
	n.freezes = append(n.freezes, event)
	if len(n.freezes) > maxPendingFreezes {
		n.freezes = n.freezes[len(n.freezes)-maxPendingFreezes:]
	}
}

const maxPendingFreezes = 16

// shiftDeadline moves a key's local deadlines back by the frozen time, never
// before now: the budget ran in real time while the clock stood still.
func (n *Node) shiftDeadline(pk *proposerKey, d, now time.Duration) {
	if pk.deadline != 0 {
		pk.deadline = max(pk.deadline-d, now)
	}
	if pk.softAt != 0 && pk.softAt != noDeadline {
		pk.softAt = max(pk.softAt-d, now)
	}
}

func proposerKeySet(proposers map[Key]*proposerKey) map[Key]bool {
	set := make(map[Key]bool, len(proposers))
	for key := range proposers {
		set[key] = true
	}
	return set
}

// DrainFreezes returns the freezes of this host detected since the last call,
// for logs and reports.
func (n *Node) DrainFreezes() []FreezeEvent {
	n.mu.Lock()
	defer n.mu.Unlock()
	events := n.freezes
	n.freezes = nil
	return events
}

// Beacon sends each destination an empty batch that carries only this node's
// clock (D4). Relays call it every BeaconInterval for their connected members
// and when a member connects.
func (n *Node) Beacon(destinations ...string) {
	n.run(func(time.Duration) {
		for _, dest := range destinations {
			if dest != "" && dest != n.id {
				n.beacons[dest] = true
			}
		}
	})
}

// BeaconRelays sends a clock beacon to every relay member of the adopted
// lease-mode manifests, so a relay learns of its own freeze within a second of
// hearing from any daemon (D4). Daemons call it every BeaconInterval.
func (n *Node) BeaconRelays() {
	n.run(func(time.Duration) {
		for _, manifest := range n.manifests {
			// Relays accept Coordinate frames only from members and
			// candidates of the policies they carry.
			if manifest.Closed || manifest.Voters == nil || !(manifest.Voters.isMember(n.id) || manifest.isCandidate(n.id)) {
				continue
			}
			for _, id := range manifest.Voters.relayIDs {
				if id != n.id {
					n.beacons[id] = true
					// Like any first frame to a relay after it (re)started,
					// carry the manifest that names this node, so the relay
					// authorizes the stream it arrives on (D3).
					n.forwardOnce(id, manifest.PolicyID)
				}
			}
		}
	})
}
