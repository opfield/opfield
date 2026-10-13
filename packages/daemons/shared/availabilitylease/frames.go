package availabilitylease

import (
	"errors"
	"fmt"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// ReceiveFrame verifies and processes one frame addressed to this node.
func (n *Node) ReceiveFrame(frame *pb.CoordinationFrame) error {
	batch := &pb.LeaseBatch{}
	if err := proto.Unmarshal(frame.GetPayload(), batch); err != nil {
		return fmt.Errorf("decode lease batch: %w", err)
	}
	if batch.GetSenderId() == "" || batch.GetSenderId() != frame.GetSenderId() || batch.GetDestinationId() != n.id {
		return errors.New("lease frame routing does not match its payload")
	}
	var verr error
	n.run(func(now time.Duration) {
		// Blocks are signed by the policy key, so adopting them before the
		// frame signature check is safe and lets a new candidate's first
		// frame verify against the manifest it carries.
		n.adoptForwarded(batch, now)
		// Any signature under any key listed for the sender in any adopted
		// manifest authenticates it, so an identity-key rotation never drops
		// frames while manifests catch up (the sender dual-signs). Replay
		// binding (A9) is unchanged: it works on the authenticated batch.
		keys := n.identityKeys(batch.GetSenderId())
		if len(keys) == 0 || !n.sharesPolicy(batch.GetSenderId()) {
			n.reportUnknownSender(batch)
			verr = ErrUnknownSender
			return
		}
		if !n.verifyAny(keys, frameMessage(frame.GetPayload()), frame.GetSignature(), frame.GetAdditionalSignatures()) {
			verr = fmt.Errorf("lease frame from %q has an invalid signature", batch.GetSenderId())
			return
		}
		n.receiveLocked(batch, now)
	})
	return verr
}

// ErrUnknownSender means no manifest this node holds names the frame's sender
// together with this node; the frame is dropped and the sender is told this
// node lags.
var ErrUnknownSender = errors.New("lease frame from an unknown sender")

// sharesPolicy reports whether an adopted manifest names both id and this
// node. Only such peers coordinate with it (D3, A18). Identity keys come from
// every adopted manifest, so a node or relay of an unrelated policy
// authenticates; its items and its clock (D4) must still never reach this
// node's leases.
func (n *Node) sharesPolicy(id string) bool {
	for _, manifest := range n.manifests {
		if manifest.names(id) && manifest.names(n.id) {
			return true
		}
	}
	return false
}

// receive processes a batch without signature checks (simulator path). It
// still drops frames from unknown senders like ReceiveFrame.
func (n *Node) receive(batch *pb.LeaseBatch) error {
	var err error
	n.run(func(now time.Duration) {
		n.adoptForwarded(batch, now)
		if len(n.identityKeys(batch.GetSenderId())) == 0 || !n.sharesPolicy(batch.GetSenderId()) {
			n.reportUnknownSender(batch)
			err = ErrUnknownSender
			return
		}
		n.receiveLocked(batch, now)
	})
	return err
}

// reportUnknownSender answers the claimed sender with bare statuses for the
// keys it mentioned, so a genuine peer forwards its blocks (A4). Statuses
// carry nothing beyond this node's epoch and manifest versions.
func (n *Node) reportUnknownSender(batch *pb.LeaseBatch) {
	from := batch.GetSenderId()
	if from == "" || from == n.id {
		return
	}
	reported := map[Key]bool{}
	for _, item := range batch.GetItems() {
		key, ok := keyFromProto(itemKey(item))
		if !ok || reported[key] {
			continue
		}
		reported[key] = true
		status := &pb.LeaseStatus{Key: key.proto()}
		if config := n.policyConfig(key.PolicyID); config != nil {
			status.Epoch = config.Epoch
		}
		if manifest := n.manifests[key.PolicyID]; manifest != nil {
			status.ManifestVersion = manifest.Version
		}
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
	}
}

func itemKey(item *pb.LeaseItem) *pb.LeaseKey {
	switch body := item.GetBody().(type) {
	case *pb.LeaseItem_Prepare:
		return body.Prepare.GetKey()
	case *pb.LeaseItem_Propose:
		return body.Propose.GetKey()
	case *pb.LeaseItem_Commit:
		return body.Commit.GetKey()
	case *pb.LeaseItem_Release:
		return body.Release.GetKey()
	case *pb.LeaseItem_Query:
		if keys := body.Query.GetKeys(); len(keys) > 0 {
			return keys[0]
		}
	}
	return nil
}

// attachBlocks forwards the config, the policy manifest and the key chain
// with the next batch to dest.
func (n *Node) attachBlocks(dest, policyID string) {
	if dest == n.id {
		return
	}
	set := n.attach[dest]
	if set == nil {
		set = map[string]bool{}
		n.attach[dest] = set
	}
	set[policyID] = true
}

type forwardMark struct{ epoch, version uint64 }

// reportLag answers a commit for a manifest or epoch this node does not have
// with a bare status, so the sender forwards its blocks (A4).
func (n *Node) reportLag(from string, commit *pb.LeaseCommit) {
	key, ok := keyFromProto(commit.GetKey())
	if !ok || from == n.id {
		return
	}
	manifest, config := n.manifests[key.PolicyID], n.policyConfig(key.PolicyID)
	if manifest != nil && manifest.Version >= commit.GetManifestVersion() && config != nil && config.Epoch >= commit.GetEpoch() {
		return
	}
	status := &pb.LeaseStatus{Key: key.proto()}
	if config != nil {
		status.Epoch = config.Epoch
	}
	if manifest != nil {
		status.ManifestVersion = manifest.Version
	}
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
}

// forwardOnce attaches the policy manifest (with its voters) and the key chain the
// first time we address dest after adopting a newer version, so lagging
// peers adopt it from the frame instead of NACKing (A4, A14).
func (n *Node) forwardOnce(dest, policyID string) {
	manifest := n.manifests[policyID]
	if manifest == nil || dest == n.id {
		return
	}
	mark := forwardMark{epoch: manifest.Epoch, version: manifest.Version}
	name := dest + "\x00" + policyID
	if n.forwarded[name] == mark {
		return
	}
	n.forwarded[name] = mark
	n.attachBlocks(dest, policyID)
}
