// Package leasegate holds what a daemon knows about relay lease gates: the most
// recent WatchLeaseGates view each relay reported for each lease key, aged out
// locally. nginx daemons open Availability member sockets from it; docker
// daemons pick the lease holder among the member routes of a database or
// storage availability set from it.
package leasegate

import (
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// MaxTTL bounds every relay gate view regardless of what the relay reports,
// so a daemon never trusts a broadcast older than one lease term (D8, A8).
const MaxTTL = availabilitylease.LeaseTerm

// key identifies one lease key's gate, independent of which relay
// reported it: several relays may report the same (policy, slot).
type key struct {
	policyID string
	slot     uint32
}

// entry is one relay's most recent view of one key's gate, aged out
// locally instead of waiting for that relay to say the view is gone.
type entry struct {
	leaseMode bool
	open      bool
	holderID  string
	// holderEndpoint is whether the holder takes traffic through that relay
	// (D6): UNKNOWN from relays that do not report it.
	holderEndpoint relayv1.LeaseHolderEndpoint
	ballot         ballot
	expiresAt      time.Time
}

type ballot struct {
	round       uint64
	incarnation uint64
	proposer    string
}

func (b ballot) less(other ballot) bool {
	if b.round != other.round {
		return b.round < other.round
	}
	if b.incarnation != other.incarnation {
		return b.incarnation < other.incarnation
	}
	return b.proposer < other.proposer
}

// Tracker holds the most recent gate view every connected relay reported for
// every lease key, each aged out on its own (A8): a member for (policy,
// candidate node N) is open iff some relay's latest view has lease_mode &&
// open && holder_id == N, and that view is younger than min(remaining_ms,
// 30000) ms since receipt on the daemon's own monotonic clock. When the stream
// breaks, views age out by that TTL; they are never extended.
//
// A view with lease_mode=false additionally opens every member of that
// policy: it means the policy is not lease-bound (legacy, or lease-closed),
// so legacy admission applies and nothing about it is gated (B2 fix). A
// missing or expired view never opens anything by itself: a lease-bound
// member with no fresh view at all stays closed (fail closed).
type Tracker struct {
	mu      sync.Mutex
	entries map[key]map[string]entry // key -> relay member id -> entry
	changed chan struct{}
}

// NewTracker returns an empty tracker.
func NewTracker() *Tracker {
	return &Tracker{entries: map[key]map[string]entry{}, changed: make(chan struct{})}
}

// Apply records one relay's gate snapshot, timestamped at receipt. A
// lease_mode=false gate's remaining_ms is not meaningful (the relay only
// fills it in while it is admitting a holder), so that view is trusted for
// the full lease term instead, refreshed by the relay's own at-least-once-
// per-second broadcast; it is still aged out at no more than T (B2, D8, A8).
func (t *Tracker) Apply(relayID string, snapshot *relayv1.LeaseGateSnapshot, now time.Time) {
	if snapshot == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	changed := false
	for _, gate := range snapshot.GetGates() {
		k := key{policyID: gate.GetPolicyId(), slot: gate.GetSlot()}
		ttl := MaxTTL
		if gate.GetLeaseMode() {
			ttlMs := gate.GetRemainingMs()
			if maxMs := uint64(MaxTTL.Milliseconds()); ttlMs > maxMs {
				ttlMs = maxMs
			}
			ttl = time.Duration(ttlMs) * time.Millisecond
		}
		byRelay := t.entries[k]
		if byRelay == nil {
			byRelay = map[string]entry{}
			t.entries[k] = byRelay
		}
		next := entry{
			leaseMode:      gate.GetLeaseMode(),
			open:           gate.GetOpen(),
			holderID:       gate.GetHolderId(),
			holderEndpoint: gate.GetHolderEndpoint(),
			expiresAt:      now.Add(ttl),
		}
		if b := gate.GetBallot(); b != nil {
			next.ballot = ballot{round: b.GetRound(), incarnation: b.GetIncarnation(), proposer: b.GetProposerId()}
		}
		previous, known := byRelay[relayID]
		if !known || previous.leaseMode != next.leaseMode || previous.open != next.open ||
			previous.holderID != next.holderID || previous.holderEndpoint != next.holderEndpoint || previous.ballot != next.ballot {
			changed = true
		}
		byRelay[relayID] = next
	}
	if changed {
		close(t.changed)
		t.changed = make(chan struct{})
	}
}

// Changed returns a channel that closes the next time a relay reports a gate
// view that differs from what it reported before (holder, openness, lease
// mode, readiness or ballot). Views that only refresh their TTL do not close it.
func (t *Tracker) Changed() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.changed
}

// OpenFor reports whether policyID currently admits candidateID (D8, A8,
// B2, D6). It is open when some relay's latest, unexpired view either:
//   - says the policy is not lease-bound (lease_mode=false: legacy or
//     lease-closed), so legacy admission applies to every member; or
//   - says the lease is open, candidateID holds it and its endpoint takes
//     traffic through that relay (holder_endpoint READY).
//
// A holder whose workload is not ready yet registers dormant, and every relay
// carrying its endpoint says NOT_READY: the member stays closed, so the
// daemon moves on to the next member before sending a byte, even for a POST (D6).
// Views without the readiness (UNKNOWN: an older relay, or one that carries no
// endpoint of the holder) open on the gate alone as before, unless another
// relay says the holder is not ready.
//
// A stale or absent view never opens anything by itself: a genuinely
// lease-bound member with no fresh view at all stays closed, and the caller
// never waits for a broadcast to say a view is gone.
func (t *Tracker) OpenFor(policyID, candidateID string, now time.Time) bool {
	if policyID == "" || candidateID == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	unknown, notReady, restarting, otherServing := false, false, false, false
	for k, byRelay := range t.entries {
		if k.policyID != policyID {
			continue
		}
		for _, entry := range byRelay {
			if !now.Before(entry.expiresAt) {
				continue
			}
			if !entry.leaseMode {
				return true
			}
			if !entry.open {
				continue
			}
			if entry.holderID != candidateID {
				if entry.holderEndpoint == relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
					otherServing = true
				}
				continue
			}
			switch entry.holderEndpoint {
			case relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY:
				return true
			case relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY:
				notReady = true
			case relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_RESTARTING:
				restarting = true
			default:
				unknown = true
			}
		}
	}
	if restarting {
		// The holder's daemon restarts gracefully (B-13): its socket stays
		// open and its connections are held until it serves again, unless
		// another member of the policy serves meanwhile. A relay that does
		// not know restarts only lost the registration: RESTARTING wins over
		// its NOT_READY.
		return !otherServing
	}
	return unknown && !notReady
}

// OtherMemberServes reports whether some relay's unexpired view says a member
// of policyID other than candidateID holds an open slot and serves.
func (t *Tracker) OtherMemberServes(policyID, candidateID string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, byRelay := range t.entries {
		if k.policyID != policyID {
			continue
		}
		for _, entry := range byRelay {
			if now.Before(entry.expiresAt) && entry.leaseMode && entry.open && entry.holderID != candidateID &&
				entry.holderEndpoint == relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
				return true
			}
		}
	}
	return false
}

// Reported reports whether some relay's unexpired view covers policyID at all.
func (t *Tracker) Reported(policyID string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, byRelay := range t.entries {
		if k.policyID != policyID {
			continue
		}
		for _, entry := range byRelay {
			if now.Before(entry.expiresAt) {
				return true
			}
		}
	}
	return false
}

// HolderView is what fresh gate views say about one lease policy.
type HolderView struct {
	// HolderID is the candidate the relays admit (OpenFor would be true for
	// it), or "" when no fresh view names an admitted holder. When views
	// disagree (a takeover the relays have not all seen yet), the holder of the
	// highest ballot wins: a higher ballot's commit supersedes the older one.
	HolderID string
	// Ready is true when some relay reports the holder's endpoint READY.
	Ready bool
	// Legacy is true when a fresh view says the policy is not lease-bound
	// (lease_mode=false): the relays admit every serving member.
	Legacy bool
}

// Holder summarises the fresh views of policyID (every slot; a failover
// policy has one) into the admitted holder, if any.
func (t *Tracker) Holder(policyID string, now time.Time) HolderView {
	var view HolderView
	if policyID == "" {
		return view
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	type candidate struct {
		ready, unknown, notReady bool
		ballot                   ballot
	}
	candidates := map[string]*candidate{}
	for k, byRelay := range t.entries {
		if k.policyID != policyID {
			continue
		}
		for _, e := range byRelay {
			if !now.Before(e.expiresAt) {
				continue
			}
			if !e.leaseMode {
				view.Legacy = true
				continue
			}
			if !e.open || e.holderID == "" {
				continue
			}
			c := candidates[e.holderID]
			if c == nil {
				c = &candidate{}
				candidates[e.holderID] = c
			}
			if c.ballot.less(e.ballot) {
				c.ballot = e.ballot
			}
			switch e.holderEndpoint {
			case relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY:
				c.ready = true
			case relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY:
				c.notReady = true
			default:
				c.unknown = true
			}
		}
	}
	var best *candidate
	for holderID, c := range candidates {
		if !c.ready && !(c.unknown && !c.notReady) {
			continue
		}
		if best == nil || best.ballot.less(c.ballot) || (best.ballot == c.ballot && holderID < view.HolderID) {
			best, view.HolderID, view.Ready = c, holderID, c.ready
		}
	}
	return view
}
