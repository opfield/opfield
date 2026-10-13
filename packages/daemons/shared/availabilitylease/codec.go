package availabilitylease

import (
	"errors"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// SealFrame encodes and signs a batch with the first signer; further signers
// (the previous identity key during a rotation) add additional signatures.
// Relays route the frame by DestinationId; the recipient verifies it in
// ReceiveFrame.
func SealFrame(batch *pb.LeaseBatch, signers ...Signer) (*pb.CoordinationFrame, error) {
	if len(signers) == 0 || signers[0] == nil {
		return nil, errors.New("lease frame needs a signer")
	}
	if batch.GetSenderId() == "" || batch.GetDestinationId() == "" {
		return nil, errors.New("lease batch needs sender and destination")
	}
	payload, err := proto.Marshal(batch)
	if err != nil {
		return nil, err
	}
	signature, extra, err := signAll(signers, frameMessage(payload))
	if err != nil {
		return nil, err
	}
	return &pb.CoordinationFrame{
		DestinationId: batch.GetDestinationId(), SenderId: batch.GetSenderId(),
		Payload: payload, Signature: signature, AdditionalSignatures: extra,
	}, nil
}
