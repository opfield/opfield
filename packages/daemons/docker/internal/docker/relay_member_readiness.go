package docker

import (
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

type memberReadinessEntry struct {
	ready       bool
	fingerprint string
	checkedAt   time.Time
	// fullAt is when the member was last probed in full (its port, not only its
	// containers); misses counts the failed full re-checks of a ready member
	// not confirmed yet.
	fullAt time.Time
	misses int
}

// memberReadiness tracks, per availability policy, whether this node's member
// workload is ready to take traffic.
type memberReadiness struct {
	mu      sync.Mutex
	entries map[string]memberReadinessEntry
	// states is the serving state each Secure Link target last registered
	// with (see memberEndpointState).
	states map[string]relayv1.EndpointServingState
	wake   chan struct{}
}

func newMemberReadiness() *memberReadiness {
	return &memberReadiness{
		entries: map[string]memberReadinessEntry{},
		states:  map[string]relayv1.EndpointServingState{},
		wake:    make(chan struct{}, 1),
	}
}

// recordState remembers the state a link registers with and returns it.
func (m *memberReadiness) recordState(linkID string, state relayv1.EndpointServingState) relayv1.EndpointServingState {
	if m == nil {
		return state
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.states == nil {
		m.states = map[string]relayv1.EndpointServingState{}
	}
	m.states[linkID] = state
	return state
}

// tookTraffic reports whether a link last registered as one that takes
// traffic: SERVING, or UNSPECIFIED (a plain link, which serves).
func (m *memberReadiness) tookTraffic(linkID string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[linkID]
	return ok && state != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

// keepLinks forgets the states of links this node no longer targets.
func (m *memberReadiness) keepLinks(linkIDs map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for linkID := range m.states {
		if !linkIDs[linkID] {
			delete(m.states, linkID)
		}
	}
}

func (m *memberReadiness) ready(policyID string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.entries[policyID].ready
}

func (m *memberReadiness) entry(policyID string) (memberReadinessEntry, bool) {
	if m == nil {
		return memberReadinessEntry{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[policyID]
	return entry, ok
}

// set records a probe result and reports whether readiness changed.
func (m *memberReadiness) set(policyID string, next memberReadinessEntry) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.entries[policyID]
	m.entries[policyID] = next
	return previous.ready != next.ready
}

// reset forgets a policy's readiness (it no longer serves here, or serves
// anew): the next serve is probed from scratch. Reports whether it was ready.
func (m *memberReadiness) reset(policyID string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, ok := m.entries[policyID]
	delete(m.entries, policyID)
	return ok && previous.ready
}

// keepOnly drops the policies that have no member link here any more.
func (m *memberReadiness) keepOnly(policies map[string][]string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	changed := false
	for policyID, entry := range m.entries {
		if _, ok := policies[policyID]; !ok {
			changed = changed || entry.ready
			delete(m.entries, policyID)
		}
	}
	return changed
}

func (m *memberReadiness) signal() {
	if m == nil {
		return
	}
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
