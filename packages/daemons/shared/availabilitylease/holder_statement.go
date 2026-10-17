package availabilitylease

import (
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"strings"
)

// Holder statements: a stateful key's holder signs an application request
// with its identity key (for example the activation of a standby ClickHouse
// Keeper witness while Opfield is down, decision 8 of the availability plan),
// and any voter or shadow acceptor of the policy checks that the signer is the
// holder its latest verified commit names. The domain must start with
// HolderStatementDomainPrefix, so a statement can never be replayed as a lease
// frame or accept.
const HolderStatementDomainPrefix = legacycompat.AvailabilityHolderDomain + "/"

// HolderStatementMessage is the signed byte string of a holder statement.
func HolderStatementMessage(domain string, payload []byte) []byte {
	return newStatement(domain).bytes(payload).buf
}

// SignHolderStatement signs payload under domain with this node's identity.
func SignHolderStatement(signer Signer, domain string, payload []byte) ([]byte, error) {
	if !strings.HasPrefix(domain, HolderStatementDomainPrefix) || len(domain) == len(HolderStatementDomainPrefix) {
		return nil, errors.New("holder statement domain is invalid")
	}
	if signer == nil {
		return nil, errors.New("identity signer is required")
	}
	return signer.Sign(HolderStatementMessage(domain, payload))
}

// VerifyHolderStatement checks that signature over (domain, payload) was made
// by the holder the latest verified commit of the stateful key names, with
// that holder's identity key in the adopted manifest. It returns the holder.
// Like ObservedCommit it is informational for the lease itself: no lease
// safety decision rests on it.
func (n *Node) VerifyHolderStatement(key Key, domain string, payload, signature []byte) (string, error) {
	if !strings.HasPrefix(domain, HolderStatementDomainPrefix) || len(domain) == len(HolderStatementDomainPrefix) {
		return "", errors.New("holder statement domain is invalid")
	}
	commit, ok := n.ObservedCommit(key)
	if !ok || commit.State.Holder == "" {
		return "", errors.New("this node knows no committed holder of the key")
	}
	holder := commit.State.Holder
	n.mu.Lock()
	manifest := n.manifests[key.PolicyID]
	var publicKey []byte
	if manifest != nil {
		publicKey = append([]byte(nil), manifest.keys[holder]...)
	}
	verifier := n.verifier
	n.mu.Unlock()
	if manifest == nil || manifest.Closed {
		return "", errors.New("the policy has no open manifest on this node")
	}
	if len(publicKey) == 0 {
		return "", errors.New("the committed holder has no identity key in the manifest")
	}
	if verifier == nil || !verifier.Verify(publicKey, HolderStatementMessage(domain, payload), signature) {
		return "", errors.New("the statement is not signed by the committed holder")
	}
	return holder, nil
}
