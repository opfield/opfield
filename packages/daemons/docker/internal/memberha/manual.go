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
		m.closeServingLocked(mem)
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
		if now-mem.manual.lastContact < selfFenceAfter {
			// Gateway or the peer is back and no newer assignment exists: serve again.
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
	m.openServingLocked(mem)
}

// demoteLocked stops a writable member and restarts it as a copy (standby at
// rest first); the copy path rejoins it to the primary when it diverged.
func (m *Manager) demoteLocked(mem *member, kind, reason string) {
	m.launch(mem, opFence, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, true)
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
	if m.deps.GatewayConnected() {
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
		at := m.deps.Clock.Now()
		m.mu.Lock()
		m.results = append(m.results, func() {
			mem.manual.probing = false
			mem.manual.nextProbeAt = at + peerProbeInterval
			mem.manual.peerReachable = ok
			if ok {
				mem.manual.peerGeneration, mem.manual.peerPrimary, mem.manual.peerAt = state.Generation, state.Primary, at
			}
		})
		m.mu.Unlock()
	})
}
