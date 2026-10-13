package policy

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
)

// keyPolicyRebind persists the rebind a local trust reset grants, so a relay
// restarted before Gateway's next snapshot still accepts it (F12).
var keyPolicyRebind = []byte("policy-trust-rebind")

// BootstrapPolicyTrust is deliberately not a general key-add operation. The
// first raw key and matching fingerprint arrive over the authenticated
// enrollment/control channel; subsequent keys require signed rotation.
func (s *Store) BootstrapPolicyTrust(keyID string, raw []byte, fingerprint string) (bool, error) {
	if keyID == "" || len(raw) != ed25519.PublicKeySize {
		return false, fmt.Errorf("policy signing key is invalid")
	}
	publicKey := append(ed25519.PublicKey(nil), raw...)
	if fingerprint == "" || PublicKeyFingerprint(publicKey) != fingerprint {
		return false, fmt.Errorf("policy signing key fingerprint does not match public key")
	}
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	if existing, ok := s.policyTrust[keyID]; ok {
		if existing.Fingerprint != fingerprint || !bytes.Equal(existing.PublicKey, publicKey) {
			return false, fmt.Errorf("policy signing key conflicts with pinned key")
		}
		return true, nil
	}
	if len(s.policyTrust) != 0 {
		return false, fmt.Errorf("new policy signing keys require signed rotation")
	}
	next := map[string]trustedPolicyKey{keyID: {PublicKey: publicKey, Fingerprint: fingerprint}}
	if err := s.db.Update(func(tx *bolt.Tx) error { return persistTrust(tx.Bucket(bucketState), next) }); err != nil {
		return false, err
	}
	s.mu.Lock()
	s.policyTrust = next
	s.mu.Unlock()
	return false, nil
}

// ResetLocalPolicyTrust replaces pinned policy trust with a single key. It exists
// for the local combined relay only, whose relay.db can be restored from a
// backup that predates every key Gateway can still sign with. The caller is the
// co-located Gateway app over its authenticated admin channel, the same channel
// that bootstraps trust in the first place. A remote relay learns keys only
// through signed rotation and never accepts this.
//
// A persisted signed snapshot is dropped unless the new key signed it, so a
// restart before Gateway's next snapshot starts empty instead of refusing to
// load. The in-memory snapshot keeps serving until that next snapshot arrives,
// and that snapshot may rebind the relay to Gateway's current instance and
// revision sequence; the rebind is persisted until then. Repeating the reset
// with the same key changes nothing else, so a retried call is safe.
func (s *Store) ResetLocalPolicyTrust(keyID string, raw []byte, fingerprint string) ([]string, error) {
	if s.mode != relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED {
		return nil, fmt.Errorf("policy trust reset is only available to the local relay")
	}
	if keyID == "" || len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("policy signing key is invalid")
	}
	publicKey := append(ed25519.PublicKey(nil), raw...)
	if fingerprint == "" || PublicKeyFingerprint(publicKey) != fingerprint {
		return nil, fmt.Errorf("policy signing key fingerprint does not match public key")
	}
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	replaced := make([]string, 0, len(s.policyTrust))
	for id := range s.policyTrust {
		if id != keyID {
			replaced = append(replaced, id)
		}
	}
	sort.Strings(replaced)
	if existing, ok := s.policyTrust[keyID]; ok && (existing.Fingerprint != fingerprint || !bytes.Equal(existing.PublicKey, publicKey)) {
		return nil, fmt.Errorf("policy signing key conflicts with pinned key")
	}
	next := map[string]trustedPolicyKey{keyID: {PublicKey: publicKey, Fingerprint: fingerprint}}
	if err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		for _, key := range [][]byte{keySnapshot, keySnapshotFull} {
			if signer, signed := persistedSnapshotSigner(bucket, key); signed && signer != keyID {
				if err := deleteSnapshot(bucket, key); err != nil {
					return err
				}
			}
		}
		if err := bucket.Put(keyPolicyRebind, []byte{1}); err != nil {
			return err
		}
		return persistTrust(bucket, next)
	}); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.policyTrust = next
	s.rebind = true
	s.mu.Unlock()
	return replaced, nil
}

func deleteSnapshot(bucket *bolt.Bucket, key []byte) error {
	if err := bucket.Delete(key); err != nil {
		return err
	}
	if bytes.Equal(key, keySnapshot) {
		return bucket.Delete(keyDigest)
	}
	return nil
}

func persistedSnapshotSigner(bucket *bolt.Bucket, key []byte) (string, bool) {
	value := bucket.Get(key)
	if len(value) == 0 {
		return "", false
	}
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(value, request); err != nil {
		return "", true
	}
	if request.SignedEnvelope == nil {
		return "", false
	}
	return request.SignedEnvelope.SigningKeyId, true
}

func (s *Store) loadTrust() error {
	return s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		// Only a local relay can have been reset; a remote one ignores a
		// stray flag (its trust changes only through signed rotation).
		s.rebind = len(bucket.Get(keyPolicyRebind)) > 0 && s.mode == relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED
		value := bucket.Get(keyPolicyTrust)
		if len(value) == 0 {
			return nil
		}
		var state persistedTrust
		if err := json.Unmarshal(value, &state); err != nil {
			return fmt.Errorf("decode policy trust: %w", err)
		}
		for _, record := range state.Keys {
			if record.KeyID == "" || len(record.PublicKey) != ed25519.PublicKeySize || PublicKeyFingerprint(record.PublicKey) != record.Fingerprint {
				return fmt.Errorf("persisted policy trust is invalid")
			}
			s.policyTrust[record.KeyID] = trustedPolicyKey{
				PublicKey: append(ed25519.PublicKey(nil), record.PublicKey...), Fingerprint: record.Fingerprint,
				ValidFrom: unixTime(record.ValidFrom), VerifyUntil: unixTime(record.VerifyUntil),
			}
		}
		return nil
	})
}

func persistTrust(bucket *bolt.Bucket, keys map[string]trustedPolicyKey) error {
	state := persistedTrust{Keys: make([]persistedTrustKey, 0, len(keys))}
	for keyID, key := range keys {
		state.Keys = append(state.Keys, persistedTrustKey{
			KeyID: keyID, PublicKey: key.PublicKey, Fingerprint: key.Fingerprint,
			ValidFrom: unixValue(key.ValidFrom), VerifyUntil: unixValue(key.VerifyUntil),
		})
	}
	sort.Slice(state.Keys, func(i, j int) bool { return state.Keys[i].KeyID < state.Keys[j].KeyID })
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return bucket.Put(keyPolicyTrust, encoded)
}

func (key trustedPolicyKey) validAt(at time.Time) bool {
	// Gateway stamps ValidFrom with its own clock when it promotes a key. Allow
	// the same skew as IssuedAt so a relay running slightly behind does not
	// refuse the first snapshots the new key signs.
	if !key.ValidFrom.IsZero() && at.Add(IssuedAtClockSkew).Before(key.ValidFrom) {
		return false
	}
	return key.VerifyUntil.IsZero() || at.Before(key.VerifyUntil)
}

func cloneTrust(source map[string]trustedPolicyKey) map[string]trustedPolicyKey {
	next := make(map[string]trustedPolicyKey, len(source))
	for id, key := range source {
		key.PublicKey = append(ed25519.PublicKey(nil), key.PublicKey...)
		next[id] = key
	}
	return next
}
