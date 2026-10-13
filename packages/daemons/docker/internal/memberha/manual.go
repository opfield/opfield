package memberha

import (
	"context"
	"strconv"
	"time"
)

const (
	// selfFenceAfter: the manual primary demotes itself when it reached
	// neither the Gateway session nor its peer for this long (decision 6).
	selfFenceAfter = 30 * time.Second
	// peerProbeInterval is how often a manual member asks its peer.
	peerProbeInterval = 5 * time.Second
	peerProbeTimeout  = 3 * time.Second
)

type manualRuntime struct {
	// lastContact is when this member last reached Gateway or its peer.
	lastContact time.Duration
	probing     bool
	nextProbeAt time.Duration
	// peerReachable and peerGeneration are the last answer of the peer.
	peerReachable  bool
	peerGeneration uint64
	peerPrimary    string
	peerAt         time.Duration
	// confirmedGen is the assignment generation Gateway or the peer confirmed
	// to this process (in memory: a restart or a self-fence starts without
	// one). A member promotes only under a confirmed assignment.
	confirmedGen uint64
}

// manualStepLocked is the decision of one manual-pair member (decision 6):
// no lease, no watchdog deadline; the primary is the member Gateway names in
// the newest assignment this member knows.
func (m *Manager) manualStepLocked(mem *member, now time.Duration) {
	m.contactLocked(mem, now)
	if mem.obs.at == 0 {
		return
	}
	mem.started = true
	if mem.busy || !mem.fresh(now) {
		// Engine work running or an observation in flight (the primary's
		// holder work every few seconds, the observation right after it): no
		// role change, a serving primary keeps its listener and sessions. Only
		// the self-fence bound still applies; it stops admitting at once (the
		// demotion follows on the next fresh observation).
		if mem.serving.Load() && now-mem.manual.lastContact >= selfFenceAfter {
			m.closeServingLocked(mem)
		}
		return
	}
	if mem.cfg.Stopped && !mem.state.Stopped {
		// The set is paused: the primary keeps its assignment, every member's
		// engine stops cleanly and stays down; the primary starts (and is
		// promoted again) when the pause ends.
		m.closeServingLocked(mem)
		m.pausedRestartLocked(mem)
		if mem.obs.container.Running {
			m.pauseStopLocked(mem)
		}
		return
	}
	assignment := mem.state.Assignment
	// A peer that serves under a newer generation than this member knows:
	// this member steps down whatever it thought (the newer assignment
	// reaches it from Gateway later).
	newerPeer := mem.manual.peerReachable && mem.manual.peerGeneration > assignment.Generation
	primary := assignment.PrimaryMemberID == mem.cfg.MemberID && assignment.Generation > 0 && !newerPeer &&
		!mem.state.Stopped
	if primary && mem.state.SelfFenced == assignment.Generation {
		// A self-fenced member never promotes on its own: only once Gateway or
		// the peer confirmed that the newest assignment still names it (a
		// newer one naming the copy may exist that it has not heard of).
		if now-mem.manual.lastContact < selfFenceAfter && mem.manual.confirmedGen == assignment.Generation {
			// Gateway or the peer is back and confirmed the assignment: serve again.
			mem.state.SelfFenced = 0
			if m.saveLocked(mem) != nil {
				return
			}
			m.eventLocked(mem, Event{Kind: EventSelfFenceEnded,
				Detail: map[string]string{"generation": strconv.FormatUint(assignment.Generation, 10)}})
		} else {
			primary = false
		}
	}
	if primary {
		m.manualPrimaryStepLocked(mem, now)
		return
	}
	m.closeServingLocked(mem)
	if mem.primaryRunning() {
		// A writable member that is not (or no longer) the primary: stop it
		// and bring it back as a copy that rejoins the primary.
		reason := "stepped_down"
		if newerPeer {
			reason = "newer_generation_seen"
		}
		m.demoteLocked(mem, EventSteppedDown, reason)
		return
	}
	m.copyStepLocked(mem, now, assignment.PrimaryMemberID != "" && assignment.PrimaryMemberID != mem.cfg.MemberID)
}

// manualPrimaryStepLocked keeps the assigned primary writable and serving,
// and demotes it once it lost both Gateway and its peer for selfFenceAfter.
func (m *Manager) manualPrimaryStepLocked(mem *member, now time.Duration) {
	assignment := mem.state.Assignment
	if now-mem.manual.lastContact >= selfFenceAfter {
		// One failure never stops writes; Gateway down and the peer down does.
		mem.state.SelfFenced = assignment.Generation
		mem.manual.confirmedGen = 0
		if m.saveLocked(mem) != nil {
			return
		}
		m.closeServingLocked(mem)
		if mem.obs.container.Running && mem.obs.status.Writable {
			m.demoteLocked(mem, EventSelfFenced, "gateway_and_peer_unreachable")
		} else {
			m.eventLocked(mem, Event{Kind: EventSelfFenced, Reason: "gateway_and_peer_unreachable"})
		}
		return
	}
	obs := mem.obs
	if !obs.container.Running {
		m.closeServingLocked(mem)
		m.startStandbyLocked(mem, now)
		return
	}
	if !obs.status.Answering {
		m.closeServingLocked(mem)
		return
	}
	if !obs.status.Writable {
		m.closeServingLocked(mem)
		if now < mem.holder.nextPromoteAt {
			return
		}
		if mem.manual.confirmedGen != assignment.Generation {
			// Promote only under an assignment Gateway or the peer confirmed to
			// this process (after a restart or a fence the stored one may be
			// stale); Gateway sends it again to an assigned primary that does
			// not serve, the peer answers within peerProbeInterval.
			return
		}
		generation := assignment.Generation
		m.launch(mem, opPromote, opTimeout, func(ctx context.Context) func() {
			err := mem.engine.Promote(ctx, nil)
			if err == nil {
				err = mem.engine.PrepareStandby(ctx)
			}
			return func() {
				if err != nil {
					mem.holder.nextPromoteAt = m.deps.Clock.Now() + promoteRetry
					m.setErrorLocked(mem, "promotion failed: "+err.Error())
					return
				}
				m.eventLocked(mem, Event{Kind: EventPromoted,
					Detail: map[string]string{"generation": strconv.FormatUint(generation, 10)}})
			}
		})
		return
	}
	if mem.state.Restart != nil {
		// A restart Gateway asked for: a clean stop, standby at rest and a
		// start; the assigned primary is promoted again right after.
		m.closeServingLocked(mem)
		m.restartCopyLocked(mem)
		return
	}
	m.openServingLocked(mem)
	m.manualHolderWorkLocked(mem, now)
}

// demoteLocked stops a writable member and restarts it as a copy (standby at
// rest first); the copy path rejoins it to the primary when it diverged.
func (m *Manager) demoteLocked(mem *member, kind, reason string) {
	// A primary that steps down for a newer assignment stops cleanly: the
	// engine hands its last writes to the copy that is connected (a planned
	// switch loses nothing); an isolated primary is killed.
	kill := kind != EventSteppedDown
	m.launch(mem, opFence, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, kill)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		return func() {
			if err != nil {
				m.setErrorLocked(mem, "could not demote the member: "+err.Error())
				return
			}
			m.eventLocked(mem, Event{Kind: kind, Reason: reason})
		}
	})
}

// contactLocked tracks the last contact with Gateway or the peer, and asks the
// peer for its assignment every peerProbeInterval.
func (m *Manager) contactLocked(mem *member, now time.Duration) {
	if mem.manual.lastContact == 0 {
		// A start counts as contact: the member does not self-fence before it
		// could reach anyone.
		mem.manual.lastContact = now
	}
	if m.deps.OpfieldContactAt != nil {
		// The last command that arrived from Gateway: a session that is dead
		// without knowing it yet (keepalive) is no contact.
		if at := m.deps.OpfieldContactAt(); at > 0 && at <= now && at > mem.manual.lastContact {
			mem.manual.lastContact = at
		}
	} else if m.deps.OpfieldConnected() {
		mem.manual.lastContact = now
	}
	if mem.manual.peerReachable && now-mem.manual.peerAt <= peerProbeInterval+peerProbeTimeout {
		mem.manual.lastContact = max(mem.manual.lastContact, mem.manual.peerAt)
	}
	if mem.manual.probing || now < mem.manual.nextProbeAt {
		return
	}
	others := mem.cfg.Others()
	if len(others) == 0 {
		return
	}
	peer := others[0]
	mem.manual.probing = true
	setID := mem.cfg.SetID
	m.deps.Async(func() {
		ctx, cancel := context.WithTimeout(context.Background(), peerProbeTimeout)
		state, ok := m.deps.PeerState(ctx, setID, peer.MemberID)
		cancel()
		// Only an assignment Gateway signed counts, whoever relays it.
		var verified *Assignment
		if ok && state.Assignment != nil && m.deps.VerifyAssignment(setID, *state.Assignment) == nil {
			assignment := *state.Assignment
			verified = &assignment
		}
		at := m.deps.Clock.Now()
		m.mu.Lock()
		m.results = append(m.results, func() {
			mem.manual.probing = false
			mem.manual.nextProbeAt = at + peerProbeInterval
			mem.manual.peerReachable = ok
			if ok {
				mem.manual.peerGeneration, mem.manual.peerPrimary, mem.manual.peerAt = 0, "", at
				if verified != nil {
					mem.manual.peerGeneration, mem.manual.peerPrimary = verified.Generation, verified.PrimaryMemberID
					if verified.Generation >= mem.state.Assignment.Generation {
						if err := m.adoptAssignmentLocked(mem, *verified, "peer"); err != nil {
							m.setErrorLocked(mem, "could not adopt the peer's primary assignment: "+err.Error())
						}
					}
				}
			}
		})
		m.mu.Unlock()
	})
}
