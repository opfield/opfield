package docker

import (
	"bytes"
	"crypto"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/docker-daemon/internal/lease"
)

// identityKeys is the node's mTLS identity for the lease (ECDSA P-256, D3)
// and the source of its renewals (H3). A certificate renewal replaces the key
// file; the runtime then calls Node.RotateIdentityKey, and the node signs
// every frame and accept with both keys until every adopted manifest naming
// it lists the new key, or availabilitylease.IdentityKeyOverlap passed. The
// replaced key is persisted so a daemon restart inside the overlap starts
// with it and rotates again, as T1 requires (the overlap is in memory).
type identityKeys struct {
	certPath, keyPath, previousPath string
	now                             func() time.Time

	mu      sync.Mutex
	modTime time.Time
	current crypto.Signer // newest key on disk
	signing crypto.Signer // key the node signs with as its current key
	// previous is the key replaced by the last handed rotation, kept for the
	// overlap; rotatedAt is when that rotation first happened.
	previous  crypto.Signer
	rotatedAt time.Time
}

var _ lease.IdentityRotation = (*identityKeys)(nil)

type previousIdentity struct {
	RotatedAtUnixMs int64  `json:"rotatedAtUnixMs"`
	KeyPEM          []byte `json:"keyPem"`
}

func newIdentityKeys(certPath, keyPath, previousPath string) (*identityKeys, error) {
	keys := &identityKeys{certPath: certPath, keyPath: keyPath, previousPath: previousPath, now: time.Now}
	current, err := keys.reload()
	if err != nil {
		return nil, err
	}
	keys.signing = current
	if previous, rotatedAt, ok := keys.loadPrevious(); ok && !bytes.Equal(publicDER(previous), publicDER(current)) {
		// Restart inside an overlap: start with the previous key; the first
		// step rotates to the current one again.
		keys.signing, keys.rotatedAt = previous, rotatedAt
	}
	return keys, nil
}

// InitialSigner is the key the node is created with.
func (k *identityKeys) InitialSigner() availabilitylease.Signer {
	k.mu.Lock()
	defer k.mu.Unlock()
	return availabilitylease.ECDSASigner{Key: k.signing}
}

// SigningSigner is the key the node signs lease frames with now (holder
// statements use it, so relays verify them against the manifest's key).
func (k *identityKeys) SigningSigner() availabilitylease.Signer {
	k.mu.Lock()
	defer k.mu.Unlock()
	return availabilitylease.ECDSASigner{Key: k.signing}
}

// reload reads the key file when it changed.
func (k *identityKeys) reload() (crypto.Signer, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	info, err := os.Stat(k.keyPath)
	if err != nil {
		if k.current != nil {
			return k.current, nil
		}
		return nil, err
	}
	if k.current != nil && info.ModTime().Equal(k.modTime) {
		return k.current, nil
	}
	pair, err := tls.LoadX509KeyPair(k.certPath, k.keyPath)
	if err != nil {
		if k.current != nil {
			return k.current, nil
		}
		return nil, err
	}
	key, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("node identity key cannot sign")
	}
	k.current, k.modTime = key, info.ModTime()
	return key, nil
}

// PendingRotation implements lease.IdentityRotation.
func (k *identityKeys) PendingRotation() (availabilitylease.Signer, []byte, bool) {
	current, err := k.reload()
	if err != nil {
		return nil, nil, false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	der := publicDER(current)
	if bytes.Equal(der, publicDER(k.signing)) {
		return nil, nil, false
	}
	return availabilitylease.ECDSASigner{Key: current}, der, true
}

// RotationApplied implements lease.IdentityRotation.
func (k *identityKeys) RotationApplied(publicKeyDER []byte) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.current == nil || !bytes.Equal(publicDER(k.current), publicKeyDER) {
		return
	}
	if k.rotatedAt.IsZero() || k.previous != nil {
		// A fresh rotation (not the replay after a restart) starts its own
		// overlap clock.
		k.rotatedAt = k.now()
	}
	k.previous, k.signing = k.signing, k.current
	k.savePreviousLocked()
}

// OverlapEnded implements lease.IdentityRotation.
func (k *identityKeys) OverlapEnded() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.previous == nil && k.rotatedAt.IsZero() {
		return
	}
	k.previous, k.rotatedAt = nil, time.Time{}
	_ = os.Remove(k.previousPath)
}

// publicKeyDER is the newest key, reported so the Gateway republishes the
// manifests naming this node with it.
func (k *identityKeys) publicKeyDER() []byte {
	current, err := k.reload()
	if err != nil {
		return nil
	}
	return publicDER(current)
}

func publicDER(key crypto.Signer) []byte {
	if key == nil {
		return nil
	}
	der, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil
	}
	return der
}

func (k *identityKeys) savePreviousLocked() {
	if k.previousPath == "" || k.previous == nil {
		return
	}
	der, err := x509.MarshalPKCS8PrivateKey(k.previous)
	if err != nil {
		return
	}
	data, _ := json.Marshal(previousIdentity{
		RotatedAtUnixMs: k.rotatedAt.UnixMilli(),
		KeyPEM:          pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}),
	})
	if err := os.MkdirAll(filepath.Dir(k.previousPath), 0o700); err == nil {
		_ = writeDurableFile(k.previousPath, data)
	}
}

// loadPrevious returns the persisted previous key while its overlap is open.
func (k *identityKeys) loadPrevious() (crypto.Signer, time.Time, bool) {
	data, err := os.ReadFile(k.previousPath)
	if err != nil {
		return nil, time.Time{}, false
	}
	var stored previousIdentity
	if json.Unmarshal(data, &stored) != nil {
		return nil, time.Time{}, false
	}
	rotatedAt := time.UnixMilli(stored.RotatedAtUnixMs)
	block, _ := pem.Decode(stored.KeyPEM)
	if block == nil || k.now().Sub(rotatedAt) >= availabilitylease.IdentityKeyOverlap {
		_ = os.Remove(k.previousPath)
		return nil, time.Time{}, false
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, time.Time{}, false
	}
	key, ok := parsed.(crypto.Signer)
	return key, rotatedAt, ok
}

func writeDurableFile(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".identity-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
