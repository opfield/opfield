package availabilitylease

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// simStateModel is the application of stateful policies in the simulator: a
// database whose certified value carries a lineage id and a sync set. It
// checks, after every event:
//
//	I5: a candidate never acquires unless the application found it eligible
//	    under exactly the adopted state it proposes (drawn from a KNOWN
//	    majority), and that state is not stale (I6).
//	I6: every state a holder treated as committed (CommittedState) descends
//	    from every state certified at a lower ballot, unless an explicit
//	    forced acquisition in between replaced it.
type simStateModel struct {
	w *simWorld
	// parent is the lineage of application values; forced marks values a
	// forced acquisition introduced (roots of an explicit data loss).
	parent map[uint64]uint64
	forced map[uint64]bool
	nextID uint64
	// certs holds every distinct certified state (key, id, generation) with
	// the lowest ballot that certified it.
	certs []simCert
	// seen is the last certified ballot observed per node and key.
	seen map[string]Ballot
	// approvals is the last promise-phase approval per node and key.
	approvals map[string]EligibilityInput
	// app state per node and key.
	nextChange map[string]time.Duration
	seq        uint64
	// syncAll: holders keep every other candidate in the sync set (quiet
	// phase), so a successor is eligible.
	syncAll bool
	// manual: scripted scenarios drive sync-set changes themselves (setSync);
	// the model only confirms promotions.
	manual bool
	// transitions counts certified application transitions, forces counts
	// forced acquisitions, for coverage.
	transitions, forces, ineligible int
}

type simCert struct {
	key    Key
	id     uint64
	gen    uint64
	ballot Ballot
	forced bool
	node   string
}

type simValue struct {
	id   uint64
	sync []string
}

func encodeSimValue(v simValue) []byte {
	data := binary.BigEndian.AppendUint64(nil, v.id)
	return append(data, strings.Join(v.sync, ",")...)
}

func decodeSimValue(data []byte) simValue {
	if len(data) < 8 {
		return simValue{}
	}
	v := simValue{id: binary.BigEndian.Uint64(data)}
	if rest := string(data[8:]); rest != "" {
		v.sync = strings.Split(rest, ",")
	}
	return v
}

// describeAccepted formats a stateful memory report for traces.
func describeAccepted(value *pb.LeaseAcceptedState) string {
	if value == nil {
		return ""
	}
	if !value.GetKnown() {
		return " UNKNOWN"
	}
	state, _ := decodeHolderState(value.GetState())
	return fmt.Sprintf(" known=%s gen=%d value=%d released=%v", ballotFromProto(value.GetBallot()), state.Generation,
		decodeSimValue(state.Value).id, value.GetReleased())
}

func newSimStateModel(w *simWorld) *simStateModel {
	return &simStateModel{
		w: w, parent: map[uint64]uint64{}, forced: map[uint64]bool{}, seen: map[string]Ballot{},
		approvals: map[string]EligibilityInput{}, nextChange: map[string]time.Duration{},
	}
}

func (m *simStateModel) newValue(parent uint64, sync []string, forced bool) []byte {
	m.nextID++
	m.parent[m.nextID] = parent
	if forced {
		m.forced[m.nextID] = true
	}
	sorted := append([]string(nil), sync...)
	sort.Strings(sorted)
	return encodeSimValue(simValue{id: m.nextID, sync: sorted})
}

func (m *simStateModel) statefulKeys() []Key {
	var keys []Key
	for _, key := range m.w.keys {
		if p := m.w.gw.policies[key.PolicyID]; p != nil && p.stateful {
			keys = append(keys, key)
		}
	}
	return keys
}

// simEligible is the database rule of the model: a sync member, the previous
// holder unless it released (AS6), or the promoted holder of an acquisition
// that never confirmed its promotion.
func simEligible(id string, in EligibilityInput) (bool, string) {
	value := decodeSimValue(in.Adopted.Value)
	for _, member := range value.sync {
		if member == id {
			return true, ""
		}
	}
	if in.PreviousHolder == id && !in.PreviousReleased {
		return true, ""
	}
	if in.Adopted.PendingPromotion && in.Adopted.PromotedHolder == id && !in.PreviousReleased {
		return true, ""
	}
	return false, fmt.Sprintf("%s not in sync set %v of %s", id, value.sync, in.AdoptedBallot)
}

// register installs the handlers of every stateful policy on a started node.
func (m *simStateModel) register(n *simNode) {
	for _, key := range m.statefulKeys() {
		policyID := key.PolicyID
		n.node.SetStateHandler(policyID, &StateHandler{
			Eligible: func(in EligibilityInput) (bool, string) {
				ok, reason := simEligible(n.id, in)
				m.w.tracef("%s eligibility phase=%d adopted=%s value=%d: %v %s", n.id, in.Phase, in.AdoptedBallot, decodeSimValue(in.Adopted.Value).id, ok, reason)
				if in.Phase == EligibilityPromise && ok {
					m.approvals[n.id+"|"+in.Key.String()] = in
				}
				if !ok {
					m.ineligible++
				}
				return ok, reason
			},
			BootstrapValue: func(Key) ([]byte, error) { return m.newValue(0, nil, false), nil },
		})
	}
}

// observe runs after every event of a node: checks I5/I6 and plays the
// application (promotion confirmation and sync-set changes).
func (m *simStateModel) observe(n *simNode, events []Event) {
	for _, key := range m.statefulKeys() {
		committed, ok := n.node.CommittedState(key)
		name := n.id + "|" + key.String()
		if ok && !committed.Restored && m.seen[name] != committed.Ballot {
			m.seen[name] = committed.Ballot
			m.certified(n.id, key, committed)
		}
		for _, event := range events {
			if event.Kind == EventAcquired && event.Key == key && ok && event.Ballot == committed.Ballot {
				m.checkAcquisition(n.id, key, committed, event)
			}
		}
		if ok && !committed.Restored {
			m.play(n, key, committed)
		}
	}
}

func (m *simStateModel) certified(node string, key Key, committed CertifiedState) {
	value := decodeSimValue(committed.State.Value)
	forced := committed.State.Forced != nil && committed.State.TransitionID == committed.State.Forced.OperationID
	for _, prior := range m.certs {
		if prior.key != key || !prior.ballot.Less(committed.Ballot) {
			continue
		}
		if !m.descends(value.id, prior, committed.Ballot) {
			m.w.fail("I6 violated: %s certified %s (value %d gen %d) at %s, which lost value %d gen %d certified by %s at %s",
				node, key, value.id, committed.State.Generation, committed.Ballot, prior.id, prior.gen, prior.node, prior.ballot)
			return
		}
	}
	for i, prior := range m.certs {
		if prior.key == key && prior.id == value.id && prior.gen == committed.State.Generation {
			if committed.Ballot.Less(prior.ballot) {
				m.certs[i].ballot = committed.Ballot
			}
			return
		}
	}
	if committed.State.TransitionID != "" && !forced {
		m.transitions++
	}
	m.certs = append(m.certs, simCert{key: key, id: value.id, gen: committed.State.Generation, ballot: committed.Ballot, forced: forced, node: node})
}

// descends reports whether value id descends from prior (or equals it), or
// an explicit forced acquisition at a higher ballot than prior replaced it.
// A forced value not certified yet counts at the ballot being certified.
func (m *simStateModel) descends(id uint64, prior simCert, certifying Ballot) bool {
	for current := id; current != 0; current = m.parent[current] {
		if current == prior.id {
			return true
		}
		if m.forced[current] {
			at := certifying
			for _, cert := range m.certs {
				if cert.id == current && cert.ballot.Less(at) {
					at = cert.ballot
				}
			}
			return prior.ballot.Less(at)
		}
	}
	return false
}

// checkAcquisition is I5: a non-forced acquisition proposes exactly the state
// its eligibility approval saw, with this node as pending holder; a
// bootstrap happens only while nothing was ever certified.
func (m *simStateModel) checkAcquisition(node string, key Key, committed CertifiedState, event Event) {
	state := committed.State
	switch {
	case event.Forced != "":
		m.forces++
		if state.Forced == nil || state.Forced.OperationID != event.Forced || !state.PendingPromotion {
			m.w.fail("forced acquisition by %s at %s lacks its marker: %+v", node, committed.Ballot, state)
		}
		return
	case isBootstrapState(state, node):
		for _, cert := range m.certs {
			if cert.key == key && cert.ballot.Less(committed.Ballot) && cert.gen > 1 {
				m.w.fail("I5 violated: %s bootstrapped %s at %s over certified gen %d at %s", node, key, committed.Ballot, cert.gen, cert.ballot)
			}
		}
		return
	case event.Recovered:
		return
	}
	approval, ok := m.approvals[node+"|"+key.String()]
	if !ok {
		m.w.fail("I5 violated: %s acquired %s at %s without an eligibility approval", node, key, committed.Ballot)
		return
	}
	if string(approval.Adopted.Value) != string(state.Value) || approval.Adopted.Generation+1 != state.Generation || !state.PendingPromotion || state.Holder != node {
		m.w.fail("I5 violated: %s acquired %s at %s with a state other than the approved adoption (%s)", node, key, committed.Ballot, approval.AdoptedBallot)
		return
	}
	if ok, reason := simEligible(node, approval); !ok {
		m.w.fail("I5 violated: %s acquired %s while ineligible: %s", node, key, reason)
	}
}

// play is the database: confirm a promotion, then change the sync set now
// and then (drop or add members), always computed from the certified value.
func (m *simStateModel) play(n *simNode, key Key, committed CertifiedState) {
	status := n.node.HolderStatus(key)
	if !status.Holding || committed.Ballot != status.Ballot {
		return
	}
	if _, pending := n.node.PendingState(key); pending {
		return
	}
	if c := n.containers[key]; c != nil && c.draining {
		// A release was decided under the current sync set (AS6): keep it.
		return
	}
	value := decodeSimValue(committed.State.Value)
	name := n.id + "|" + key.String()
	var next []string
	promoted := false
	switch {
	case committed.State.PendingPromotion && committed.State.Holder == n.id:
		// The new primary drops itself from the sync set it inherited.
		for _, id := range value.sync {
			if id != n.id {
				next = append(next, id)
			}
		}
		if m.syncAll {
			next = m.otherCandidates(key, n.id)
		}
		promoted = true
	case m.manual:
		return
	case m.syncAll:
		next = m.otherCandidates(key, n.id)
		if strings.Join(next, ",") == strings.Join(value.sync, ",") {
			return
		}
	case m.w.now >= m.nextChange[name]:
		m.nextChange[name] = m.w.now + m.w.randDuration(2*time.Second, 12*time.Second)
		for _, id := range m.otherCandidates(key, n.id) {
			if m.w.rng.Float64() < 0.6 {
				next = append(next, id)
			}
		}
	default:
		return
	}
	m.seq++
	transition := Transition{ID: fmt.Sprintf("%s-t%d", n.id, m.seq), Value: m.newValue(value.id, next, false), Promoted: promoted}
	if err := n.node.ProposeTransition(key, transition); err != nil && err != ErrTransitionPending && err != ErrNotHolding {
		m.w.fail("propose transition on %s: %v", n.id, err)
	}
}

func (m *simStateModel) otherCandidates(key Key, self string) []string {
	var out []string
	for _, id := range m.w.gw.policies[key.PolicyID].candidates {
		if id != self {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// syncSet returns the certified sync set of the current holder of key.
func (m *simStateModel) holderSync(key Key) (string, []string, bool) {
	holder := m.w.holder(key)
	if holder == "" {
		return "", nil, false
	}
	committed, ok := m.w.nodes[holder].node.CommittedState(key)
	if !ok {
		return holder, nil, false
	}
	return holder, decodeSimValue(committed.State.Value).sync, !committed.State.PendingPromotion
}

// force arms a forced acquisition on node over the latest commit it knows,
// like an operator (API) or the node-local CLI.
func (m *simStateModel) force(n *simNode, key Key, operation string) error {
	if !n.processUp() || n.node == nil {
		return ErrNoQuorum
	}
	var over Ballot
	if observed, ok := n.node.ObservedCommit(key); ok {
		over = observed.Ballot
	}
	// An override superseded by a newer accepted ballot is decided again,
	// over that ballot, like an operator reading ForceStatus.
	if status := n.node.ForceStatus(key); status.Outcome == ForceSuperseded && over.Less(status.Newer) {
		over = status.Newer
	}
	return n.node.ForceAcquire(key, ForceRequest{OperationID: operation, Over: over, Value: m.newValue(0, nil, true)})
}
