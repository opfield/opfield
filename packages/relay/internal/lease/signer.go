package lease

import (
	"bytes"
	"crypto"
	"crypto/x509"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/relay/internal/identity"
)

// IdentityKeys yields the relay's lease identity keys: the current external
// server certificate key (ECDSA P-256, the identity daemons verify the relay
// by) and, after a renewal replaced it, the previous one with the time the
// current certificate became valid.
type IdentityKeys interface {
	Keys() (current, previous crypto.Signer, renewedAt time.Time)
}

// StoreKeys reads the keys from the relay identity store. The previous key is
// the retained external-server.previous.* pair, so it survives restarts.
type StoreKeys struct {
	Identity *identity.Store
}

func (k StoreKeys) Keys() (crypto.Signer, crypto.Signer, time.Time) {
	snapshot := k.Identity.Current()
	if snapshot == nil {
		return nil, nil, time.Time{}
	}
	current, _ := snapshot.External.PrivateKey.(crypto.Signer)
	var renewedAt time.Time
	if snapshot.External.Leaf != nil {
		renewedAt = snapshot.External.Leaf.NotBefore
	}
	var previous crypto.Signer
	if snapshot.PreviousExternal != nil {
		previous, _ = snapshot.PreviousExternal.PrivateKey.(crypto.Signer)
	}
	return current, previous, renewedAt
}

// initialSigner picks the key the lease node starts with. Within
// IdentityKeyOverlap of a renewal that changed the key, it is the previous
// key, and the caller rotates to the current one so the node dual-signs until
// every manifest naming the relay lists the new key (H3). The node keeps the
// overlap in memory only, so this restores it after a restart.
func initialSigner(keys IdentityKeys, now time.Time) (start crypto.Signer, rotateTo crypto.Signer) {
	current, previous, renewedAt := keys.Keys()
	if current == nil || previous == nil {
		return current, nil
	}
	if bytes.Equal(publicKeyDER(previous), publicKeyDER(current)) ||
		(!renewedAt.IsZero() && !now.Before(renewedAt.Add(availabilitylease.IdentityKeyOverlap))) {
		return current, nil
	}
	return previous, current
}

// checkIdentityKey rotates the node to a renewed identity key as soon as the
// relay serves it; the node then dual-signs frames and accepts with the
// previous key until every adopted manifest naming the relay lists the new
// key, or for IdentityKeyOverlap (H3).
func (c *Coordinator) checkIdentityKey() {
	current, _, _ := c.keys.Keys()
	encoded := publicKeyDER(current)
	c.mu.Lock()
	changed := encoded != nil && !bytes.Equal(encoded, c.identityKey)
	if changed {
		c.identityKey = encoded
	}
	c.mu.Unlock()
	if !changed {
		return
	}
	if err := c.node.RotateIdentityKey(availabilitylease.ECDSASigner{Key: current}, encoded); err != nil {
		c.logger.Error("availability lease identity key rotation failed", "error", err)
		return
	}
	c.logger.Info("availability lease identity key renewed; signing with the previous key too until manifests list the new one")
}

func publicKeyDER(key crypto.Signer) []byte {
	if key == nil {
		return nil
	}
	encoded, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil
	}
	return encoded
}
