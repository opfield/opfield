package availabilitylease

import (
	"encoding/json"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// markStore writes the store-created marker on the first start of a v3 node
// (M1). A fresh store, a renamed relay.db or a store of an older release has
// no KNOWN stateful memory: every stateful key reports UNKNOWN until it
// accepts again (AS1).
func (n *Node) markStore(records map[string][]byte, puts map[string][]byte) {
	var info storeInfo
	if data, ok := records[recordStoreInfo]; ok && json.Unmarshal(data, &info) == nil && info.CreatedIncarnation > 0 {
		n.storeCreated = info.CreatedIncarnation
		return
	}
	info = storeInfo{CreatedIncarnation: n.incarnation, Schema: 3, Fresh: len(records) == 0}
	n.storeCreated = info.CreatedIncarnation
	data, _ := json.Marshal(info)
	puts[recordStoreInfo] = data
}

// StoreCreatedIncarnation is the incarnation that created this node's lease
// store (or first ran v3 on it). A value equal to Incarnation means the
// store was created by this start, for example after relay.db was renamed.
func (n *Node) StoreCreatedIncarnation() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.storeCreated
}

// stateful reports whether key's policy carries holder state.
func (n *Node) stateful(policyID string) bool {
	manifest := n.manifests[policyID]
	return manifest != nil && manifest.Stateful
}

// acceptedState is this acceptor's memory of a stateful key for promises and
// statuses (Paxos phase 1b). Only a voter's persisted, KNOWN record is ever
// reported as KNOWN (AS1).
func (n *Node) acceptedState(ak *acceptorKey, key Key) *pb.LeaseAcceptedState {
	report := &pb.LeaseAcceptedState{}
	if ak == nil || !ak.rec.Known || ak.rec.Accepted == nil || len(ak.rec.Accepted.State) == 0 {
		return report
	}
	config := n.policyConfig(key.PolicyID)
	if config == nil || !config.isVoter(n.id) {
		return report
	}
	accepted := ak.rec.Accepted
	report.Known, report.Ballot, report.State, report.Epoch = true, accepted.Ballot.proto(), accepted.State, accepted.Epoch
	if released, ok := ak.rec.Released[accepted.Ballot.Proposer]; ok && !released.Less(accepted.Ballot) {
		report.Released = true
		if ak.release.active {
			report.ReleasedSuccessorId = ak.release.successor
		}
	}
	return report
}

// checkStatefulPropose validates a stateful propose before it is accepted:
// the state must decode and name the ballot's proposer (NACK STATE_INVALID),
// and the propose must echo a promise this acceptor issued for the ballot in
// its current incarnation (NACK NO_PROMISE). Only such an accept leaves
// UNKNOWN, so every accept in a stateful QC comes from a KNOWN acceptor.
func (n *Node) checkStatefulPropose(ak *acceptorKey, ballot Ballot, msg *pb.LeasePropose) ([32]byte, pb.LeaseNackReason) {
	state, err := decodeHolderState(msg.GetState())
	if err != nil || state.Holder != ballot.Proposer {
		return [32]byte{}, pb.LeaseNackReason_LEASE_NACK_REASON_STATE_INVALID
	}
	// Echo records live in memory only, so a match proves the promise was
	// issued by this incarnation after any loss of state.
	echo := msg.GetEcho()
	if echo == 0 {
		return [32]byte{}, pb.LeaseNackReason_LEASE_NACK_REASON_NO_PROMISE
	}
	for _, promise := range ak.echoes {
		if promise.echo == echo && promise.ballot == ballot {
			return stateHash(msg.GetState()), 0
		}
	}
	return [32]byte{}, pb.LeaseNackReason_LEASE_NACK_REASON_NO_PROMISE
}

// recordStatefulAccept stores a voter's accept of a stateful key with its
// state, in the transaction that precedes the accepted reply (M1), and makes
// the key KNOWN.
func (n *Node) recordStatefulAccept(ak *acceptorKey, key Key, ballot Ballot, epoch uint64, data []byte, hash [32]byte, at int64) {
	ak.rec.Accepted = &acceptedRecord{
		Ballot: ballot, AtNs: at, StateHash: append([]byte(nil), hash[:]...), State: append([]byte(nil), data...), Epoch: epoch,
	}
	ak.rec.Known = true
	n.markDirty(key)
}

// forgetOnJoin makes every stateful key of a policy UNKNOWN when this node
// becomes one of its voters anew: it was not a voter under the previously
// adopted manifest, or voter epochs were skipped, so its record may predate
// quorums it never saw (AS1). It learns the state again from the next round
// that reaches a quorum.
func (n *Node) forgetOnJoin(previous, manifest *Manifest) {
	if !manifest.Stateful || manifest.Voters == nil || !manifest.Voters.isVoter(n.id) {
		return
	}
	continuous := previous != nil && previous.Voters != nil && previous.Voters.isVoter(n.id) &&
		manifest.Epoch <= previous.Epoch+1
	if continuous {
		return
	}
	for key, ak := range n.acceptors {
		if key.PolicyID == manifest.PolicyID && ak.rec.Known {
			ak.rec.Known = false
			n.markDirty(key)
		}
	}
}

// statefulView fills the v3 fields of an acceptor view.
func (n *Node) statefulView(view *KeyView, ak *acceptorKey) {
	if !n.stateful(view.Key.PolicyID) {
		return
	}
	view.Stateful = true
	if report := n.acceptedState(ak, view.Key); report.GetKnown() {
		view.StateKnown = true
		view.AcceptedBallot = ballotFromProto(report.GetBallot())
		view.StateHash, _ = hashFromBytes(ak.rec.Accepted.StateHash)
	}
	if ak.commit != nil && len(ak.commit.GetState()) > 0 {
		view.CommitStateHash = stateHash(ak.commit.GetState())
	}
}
