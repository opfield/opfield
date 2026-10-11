package availabilitylease

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// maxEncodedState bounds an encoded LeaseHolderState on the wire: the
// application value plus the library's envelope (ids, ballots).
const maxEncodedState = 2 * MaxStateValueBytes

// encodeHolderState encodes a state once; the bytes are what every node
// hashes and stores, nobody re-encodes them.
func encodeHolderState(state HolderState) []byte {
	value := &pb.LeaseHolderState{
		Value: state.Value, HolderId: state.Holder, PendingPromotion: state.PendingPromotion,
		PromotedHolderId: state.PromotedHolder, Generation: state.Generation, TransitionId: state.TransitionID,
	}
	if marker := state.Forced; marker != nil {
		value.Forced = &pb.LeaseForcedMarker{
			OperationId: marker.OperationID, Over: marker.Over.proto(), HolderId: marker.Holder,
		}
		if !marker.Base.IsZero() {
			value.Forced.Base = marker.Base.proto()
		}
	}
	data, _ := proto.MarshalOptions{Deterministic: true}.Marshal(value)
	return data
}

func decodeHolderState(data []byte) (HolderState, error) {
	if len(data) == 0 {
		return HolderState{}, errors.New("holder state is empty")
	}
	if len(data) > maxEncodedState {
		return HolderState{}, fmt.Errorf("holder state has %d bytes, more than %d", len(data), maxEncodedState)
	}
	value := &pb.LeaseHolderState{}
	if err := proto.Unmarshal(data, value); err != nil {
		return HolderState{}, fmt.Errorf("decode holder state: %w", err)
	}
	if len(value.GetValue()) > MaxStateValueBytes {
		return HolderState{}, ErrStateTooLarge
	}
	if value.GetHolderId() == "" {
		return HolderState{}, errors.New("holder state names no holder")
	}
	state := HolderState{
		Value: value.GetValue(), Holder: value.GetHolderId(), PendingPromotion: value.GetPendingPromotion(),
		PromotedHolder: value.GetPromotedHolderId(), Generation: value.GetGeneration(), TransitionID: value.GetTransitionId(),
	}
	if marker := value.GetForced(); marker != nil {
		state.Forced = &ForcedMarker{
			OperationID: marker.GetOperationId(), Over: ballotFromProto(marker.GetOver()), Holder: marker.GetHolderId(),
			Base: ballotFromProto(marker.GetBase()),
		}
	}
	return state, nil
}

func stateHash(data []byte) [32]byte { return sha256.Sum256(data) }

// StateHashString formats a state hash for views and logs; the state itself
// is never logged.
func StateHashString(hash [32]byte) string { return "sha256:" + hex.EncodeToString(hash[:]) }

func hashFromBytes(data []byte) ([32]byte, bool) {
	var hash [32]byte
	if len(data) != len(hash) {
		return hash, false
	}
	copy(hash[:], data)
	return hash, true
}

// acceptStatementV2 is the accept statement of a stateful key: the v1 fields,
// the stateful flag and the sha256 of the accepted state (doc.go).
func acceptStatementV2(key Key, ballot Ballot, epoch, manifestVersion uint64, acceptorID string, acceptorIncarnation uint64, hash [32]byte) []byte {
	return newStatement(domainAcceptV2).
		str(key.PolicyID).u64(uint64(key.Slot)).
		u64(ballot.Round).u64(ballot.Incarnation).str(ballot.Proposer).
		u64(epoch).u64(manifestVersion).
		str(acceptorID).u64(acceptorIncarnation).
		u64(1).bytes(hash[:]).buf
}

// statementFor returns the statement an accept of key signs: v2 with the
// state hash for stateful policies, the unchanged v1 bytes otherwise.
func statementFor(stateful bool, key Key, ballot Ballot, epoch, manifestVersion uint64, acceptorID string, acceptorIncarnation uint64, hash [32]byte) []byte {
	if stateful {
		return acceptStatementV2(key, ballot, epoch, manifestVersion, acceptorID, acceptorIncarnation, hash)
	}
	return acceptStatement(key, ballot, epoch, manifestVersion, acceptorID, acceptorIncarnation)
}

// certified is a state with the ballot whose QC over every quorum set
// certified it.
type certified struct {
	ballot          Ballot
	epoch           uint64
	manifestVersion uint64
	data            []byte
	state           HolderState
	hash            [32]byte
	restored        bool
}

func (c *certified) public(key Key) CertifiedState {
	return CertifiedState{
		Key: key, Ballot: c.ballot, Epoch: c.epoch, ManifestVersion: c.manifestVersion, State: cloneHolderState(c.state),
		Hash: c.hash, Restored: c.restored,
	}
}

func cloneHolderState(state HolderState) HolderState {
	state.Value = append([]byte(nil), state.Value...)
	if state.Forced != nil {
		marker := *state.Forced
		state.Forced = &marker
	}
	return state
}

// knownAccepted is one KNOWN acceptor memory reported in a promise or status.
type knownAccepted struct {
	ballot            Ballot
	data              []byte
	state             HolderState
	released          bool
	releasedSuccessor string
}

// parseKnown decodes a KNOWN report; UNKNOWN, absent or undecodable reports
// return false and never count (AS1).
func parseKnown(value *pb.LeaseAcceptedState) (knownAccepted, bool) {
	if value == nil || !value.GetKnown() {
		return knownAccepted{}, false
	}
	ballot := ballotFromProto(value.GetBallot())
	state, err := decodeHolderState(value.GetState())
	if err != nil || ballot.IsZero() || state.Holder != ballot.Proposer {
		return knownAccepted{}, false
	}
	return knownAccepted{
		ballot: ballot, data: append([]byte(nil), value.GetState()...), state: state,
		released: value.GetReleased(), releasedSuccessor: value.GetReleasedSuccessorId(),
	}, true
}

// highestKnown returns the KNOWN memory with the highest ballot; released is
// true when any report of that ballot says its proposer released it.
func highestKnown(reports map[string]knownAccepted) (knownAccepted, bool) {
	var best knownAccepted
	found := false
	for _, id := range sortedKeys(reports) {
		report := reports[id]
		switch {
		case !found || best.ballot.Less(report.ballot):
			best, found = report, true
		case report.ballot == best.ballot:
			if report.released && !best.released {
				best.released, best.releasedSuccessor = true, report.releasedSuccessor
			}
		}
	}
	return best, found
}

func sameBytes(a, b []byte) bool { return bytes.Equal(a, b) }
