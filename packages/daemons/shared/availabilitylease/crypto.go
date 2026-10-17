package availabilitylease

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"sync"
)

// Signature domains. Every signed byte string starts with its domain and a
// zero byte so a signature can never be replayed as another message type.
const (
	domainFrame       = legacycompat.AvailabilityLeaseDomain + "/frame/v1"
	domainAccept      = legacycompat.AvailabilityLeaseDomain + "/accept/v1"
	domainAcceptV2    = legacycompat.AvailabilityLeaseDomain + "/accept/v2"
	domainManifest    = legacycompat.AvailabilityLeaseDomain + "/manifest/v1"
	domainKeyRotation = legacycompat.AvailabilityLeaseDomain + "/key-rotation/v1"
)

// Signer signs with this node's identity key (ECDSA P-256, the TLS identity).
type Signer interface {
	Sign(message []byte) ([]byte, error)
}

// Verifier checks identity signatures. publicKey is PKIX DER.
type Verifier interface {
	Verify(publicKey, message, signature []byte) bool
}

// ECDSASigner signs SHA-256(message) with an ECDSA P-256 crypto.Signer, for
// example the *ecdsa.PrivateKey of the node's TLS identity.
type ECDSASigner struct {
	Key crypto.Signer
}

func (s ECDSASigner) Sign(message []byte) ([]byte, error) {
	if s.Key == nil {
		return nil, errors.New("identity key is required")
	}
	digest := sha256.Sum256(message)
	return s.Key.Sign(rand.Reader, digest[:], crypto.SHA256)
}

// ECDSAVerifier verifies ASN.1 ECDSA P-256 signatures over SHA-256(message).
type ECDSAVerifier struct {
	cache sync.Map // string(publicKey) -> *ecdsa.PublicKey
}

func (v *ECDSAVerifier) Verify(publicKey, message, signature []byte) bool {
	key, ok := v.parse(publicKey)
	if !ok {
		return false
	}
	digest := sha256.Sum256(message)
	return ecdsa.VerifyASN1(key, digest[:], signature)
}

func (v *ECDSAVerifier) parse(publicKey []byte) (*ecdsa.PublicKey, bool) {
	if cached, ok := v.cache.Load(string(publicKey)); ok {
		return cached.(*ecdsa.PublicKey), true
	}
	parsed, err := x509.ParsePKIXPublicKey(publicKey)
	if err != nil {
		return nil, false
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key.Curve.Params().Name != "P-256" {
		return nil, false
	}
	v.cache.Store(string(publicKey), key)
	return key, true
}

// statement builds domain || 0x00 || fields, with strings and byte slices
// length-prefixed (4-byte big endian) and integers as 8-byte big endian.
type statement struct{ buf []byte }

func newStatement(domain string) *statement {
	s := &statement{buf: make([]byte, 0, 160)}
	s.buf = append(s.buf, domain...)
	s.buf = append(s.buf, 0)
	return s
}

func (s *statement) str(value string) *statement { return s.bytes([]byte(value)) }

func (s *statement) bytes(value []byte) *statement {
	s.buf = binary.BigEndian.AppendUint32(s.buf, uint32(len(value)))
	s.buf = append(s.buf, value...)
	return s
}

func (s *statement) u64(value uint64) *statement {
	s.buf = binary.BigEndian.AppendUint64(s.buf, value)
	return s
}

// acceptStatement is the canonical byte string an acceptor signs for an
// accept; documented in doc.go so other implementations can verify QCs.
func acceptStatement(key Key, ballot Ballot, epoch, manifestVersion uint64, acceptorID string, acceptorIncarnation uint64) []byte {
	return newStatement(domainAccept).
		str(key.PolicyID).u64(uint64(key.Slot)).
		u64(ballot.Round).u64(ballot.Incarnation).str(ballot.Proposer).
		u64(epoch).u64(manifestVersion).
		str(acceptorID).u64(acceptorIncarnation).buf
}

func frameMessage(payload []byte) []byte {
	return append(newStatement(domainFrame).buf, payload...)
}

func blockMessage(domain string, payload []byte) []byte {
	return append(newStatement(domain).buf, payload...)
}

func rotationMessage(keyID string, publicKey []byte) []byte {
	return append(newStatement(domainKeyRotation).str(keyID).buf, publicKey...)
}
