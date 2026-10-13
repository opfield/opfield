package policy

import (
	"crypto/ed25519"
	"sort"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
)

// bucketAvailabilityLease holds the availability lease acceptor state of this
// relay: promised ballots, incarnation, adopted blocks and key chain (A3).
var bucketAvailabilityLease = []byte("availability-lease-v1")

// TrustedPolicyKey is a policy signing key the relay currently trusts.
type TrustedPolicyKey struct {
	KeyID     string
	PublicKey ed25519.PublicKey
	ValidFrom time.Time
}

// TrustedPolicyKeys lists the pinned policy signing keys, oldest first, so a
// key chain built from them orders later keys after earlier ones.
func (s *Store) TrustedPolicyKeys() []TrustedPolicyKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]TrustedPolicyKey, 0, len(s.policyTrust))
	for id, key := range s.policyTrust {
		keys = append(keys, TrustedPolicyKey{KeyID: id, PublicKey: append(ed25519.PublicKey(nil), key.PublicKey...), ValidFrom: key.ValidFrom})
	}
	sort.Slice(keys, func(i, j int) bool {
		if !keys[i].ValidFrom.Equal(keys[j].ValidFrom) {
			return keys[i].ValidFrom.Before(keys[j].ValidFrom)
		}
		return keys[i].KeyID < keys[j].KeyID
	})
	return keys
}

// leaseFields copies the availability lease blocks of a signed payload into
// the snapshot. They are authenticated by the envelope signature and again by
// their own policy-key signatures when the lease node adopts them.
func leaseFields(next *Snapshot, payload *relayv1.PolicyEnvelopePayload) {
	for _, block := range payload.LeaseBlocks {
		next.LeaseBlocks = append(next.LeaseBlocks, proto.Clone(block).(*relayv1.LeaseSignedBlock))
	}
	for _, link := range payload.LeaseKeyRotations {
		next.LeaseKeyRotations = append(next.LeaseKeyRotations, proto.Clone(link).(*relayv1.LeasePolicyKeyRotation))
	}
}

// LeaseState is the availability lease Store backed by a relay.db bucket.
// Every Apply is one bbolt transaction, fsynced before it returns.
type LeaseState struct {
	db *bolt.DB
}

// LeaseState opens the lease bucket. fresh reports that the bucket did not
// exist, for example after relay.db was renamed; the lease node abstains
// after every start anyway (A3).
func (s *Store) LeaseState() (*LeaseState, bool, error) {
	fresh := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketAvailabilityLease) != nil {
			return nil
		}
		fresh = true
		_, err := tx.CreateBucket(bucketAvailabilityLease)
		return err
	})
	if err != nil {
		return nil, false, err
	}
	return &LeaseState{db: s.db}, fresh, nil
}

func (l *LeaseState) Load() (map[string][]byte, error) {
	records := map[string][]byte{}
	err := l.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketAvailabilityLease).ForEach(func(key, value []byte) error {
			records[string(key)] = append([]byte(nil), value...)
			return nil
		})
	})
	return records, err
}

func (l *LeaseState) Apply(puts map[string][]byte, deletes []string) error {
	return l.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketAvailabilityLease)
		for _, key := range deletes {
			if err := bucket.Delete([]byte(key)); err != nil {
				return err
			}
		}
		for key, value := range puts {
			if err := bucket.Put([]byte(key), value); err != nil {
				return err
			}
		}
		return nil
	})
}
