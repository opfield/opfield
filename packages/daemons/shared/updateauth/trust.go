package updateauth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// Update signing trust. A signed manifest verifies when a trusted key that is not revoked signed it. The keys sit in
// slots: primary is the release signing key (config/update-trust/update-signing-public-key.pem, embedded); secondary
// is the owner's standby key, kept offline and empty until it is added here, so that a lost or leaked primary can be
// retired by a release signed with the standby key, without reinstalling a node. Release signing is unchanged: the
// envelope's keyId names the update trust, not one key of it.
//
// The same slots and revocation list are in the backend (packages/backend/src/lib/update-artifact-trust.ts) and in
// the node installers (scripts/setup-*.sh, UPDATE_TRUST_* lines); docs/security.md describes a rotation.

// secondaryPublicKey is the standby key: the base64 body of its PEM PUBLIC KEY block (one line, e.g.
// `openssl pkey -pubin -in standby.pem -outform DER | base64 -w0`). Empty: no standby key yet.
const secondaryPublicKey = ""

// revokedKeyIDs are keys that no longer verify anything, by key id (PublicKeyID): the SHA-256 of the key's
// SubjectPublicKeyInfo DER in hex (`openssl pkey -pubin -in key.pem -outform DER | sha256sum`).
var revokedKeyIDs = []string{}

// PublicKeyID is the id a revocation names a key by: the SHA-256 of its SubjectPublicKeyInfo DER, in hex. The
// envelope's keyId is not used for it: whoever holds a key writes any keyId into what it signs.
func PublicKeyID(key ed25519.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:]), nil
}

// trustedKeys returns the keys a manifest may be signed by; tests of this package substitute test keys.
var trustedKeys = func() ([]ed25519.PublicKey, error) {
	return trustedKeySet([]string{publicKeyPEM, secondaryPublicKey}, revokedKeyIDs)
}

// trustedKeySet parses the key slots (a PEM block or its base64 body; empty: an unused slot) and leaves out the
// revoked keys. A slot that does not parse fails the whole set: a broken trust anchor must not go unnoticed.
func trustedKeySet(slots []string, revoked []string) ([]ed25519.PublicKey, error) {
	revokedSet := make(map[string]bool, len(revoked))
	for _, id := range revoked {
		revokedSet[strings.ToLower(strings.TrimSpace(id))] = true
	}
	keys := make([]ed25519.PublicKey, 0, len(slots))
	for index, slot := range slots {
		if strings.TrimSpace(slot) == "" {
			continue
		}
		key, err := parseTrustedKey(slot)
		if err != nil {
			return nil, fmt.Errorf("trusted update public key %d: %w", index+1, err)
		}
		id, err := PublicKeyID(key)
		if err != nil {
			return nil, err
		}
		if !revokedSet[id] {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("no trusted update public key is left")
	}
	return keys, nil
}

func parseTrustedKey(slot string) (ed25519.PublicKey, error) {
	var der []byte
	if block, _ := pem.Decode([]byte(slot)); block != nil {
		der = block.Bytes
	} else {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(slot))
		if err != nil {
			return nil, errors.New("not a PEM public key or its base64 body")
		}
		der = decoded
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	return key, nil
}
