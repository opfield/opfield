package availabilitylease

import (
	"bytes"
	"errors"
	"time"
)

// IdentityKeyOverlap bounds how long a node keeps dual-signing with its
// previous identity key after a rotation (certificate renewal).
const IdentityKeyOverlap = 24 * time.Hour

// RotateIdentityKey switches this node to a renewed identity key. Frames and
// accept statements are signed with next and, during the overlap, also with
// the previous key, so peers whose manifests still list the previous key keep
// accepting them. The previous key is retired once every adopted manifest
// that names this node lists nextPublicKey (PKIX DER), or after
// IdentityKeyOverlap. A rotation during an overlap drops the oldest key.
func (n *Node) RotateIdentityKey(next Signer, nextPublicKey []byte) error {
	if next == nil || len(nextPublicKey) == 0 {
		return errors.New("renewed identity key and its public key are required")
	}
	n.run(func(now time.Duration) {
		n.previousSigner, n.signer = n.signer, next
		n.currentKey = append([]byte(nil), nextPublicKey...)
		n.overlapSince = now
		n.retireIdentityOverlap(now)
	})
	return nil
}

// IdentityOverlap reports whether the node still signs with its previous key.
func (n *Node) IdentityOverlap() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.previousSigner != nil
}

func (n *Node) retireIdentityOverlap(now time.Duration) {
	if n.previousSigner == nil {
		return
	}
	if now >= n.overlapSince+IdentityKeyOverlap || n.manifestsListCurrentKey() {
		n.previousSigner = nil
	}
}

// manifestsListCurrentKey reports whether every adopted manifest that names
// this node lists its current key.
func (n *Node) manifestsListCurrentKey() bool {
	for _, manifest := range n.manifests {
		if key, ok := manifest.keys[n.id]; ok && !bytes.Equal(key, n.currentKey) {
			return false
		}
		if key, ok := manifest.Voters.publicKey(n.id); ok && !bytes.Equal(key, n.currentKey) {
			return false
		}
	}
	return true
}

// signers returns the current signer and, during an overlap, the previous.
func (n *Node) signers() []Signer {
	if n.previousSigner != nil {
		return []Signer{n.signer, n.previousSigner}
	}
	return []Signer{n.signer}
}

// signAll signs message with every active identity key.
func signAll(signers []Signer, message []byte) ([]byte, [][]byte, error) {
	primary, err := signers[0].Sign(message)
	if err != nil {
		return nil, nil, err
	}
	var extra [][]byte
	for _, signer := range signers[1:] {
		if signature, err := signer.Sign(message); err == nil {
			extra = append(extra, signature)
		}
	}
	return primary, extra, nil
}

// identityKeys returns every key listed for id in any adopted manifest or
// remembered voter config. Each was signed by Opfield for that identity,
// so any of them authenticates it; which policies id votes in is decided
// separately, per policy (A18).
func (n *Node) identityKeys(id string) [][]byte {
	if keys, ok := n.keyCache[id]; ok {
		return keys
	}
	if n.keyCache == nil {
		n.keyCache = map[string][][]byte{}
	}
	var keys [][]byte
	add := func(key []byte, ok bool) {
		if !ok {
			return
		}
		for _, known := range keys {
			if bytes.Equal(known, key) {
				return
			}
		}
		keys = append(keys, key)
	}
	for _, policyID := range sortedKeys(n.manifests) {
		manifest := n.manifests[policyID]
		key, ok := manifest.keys[id]
		add(key, ok)
		add(manifest.Voters.publicKey(id))
	}
	for _, policyID := range sortedKeys(n.history) {
		for _, config := range n.history[policyID] {
			add(config.publicKey(id))
		}
	}
	n.keyCache[id] = keys
	return keys
}

// verifyAny reports whether any signature verifies under any key.
func (n *Node) verifyAny(keys [][]byte, message, primary []byte, extra [][]byte) bool {
	signatures := append([][]byte{primary}, extra...)
	for _, key := range keys {
		for _, signature := range signatures {
			if len(signature) > 0 && n.verifier.Verify(key, message, signature) {
				return true
			}
		}
	}
	return false
}
