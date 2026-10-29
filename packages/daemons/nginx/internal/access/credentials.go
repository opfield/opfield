package access

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"runtime"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Service token headers (Cloudflare Access style).
const (
	ServiceTokenIDHeader     = "Opfield-Access-Client-Id"
	ServiceTokenSecretHeader = "Opfield-Access-Client-Secret"
)

// serviceTokenIdentity is the identity of a known, unexpired service token the request presents (nil: none).
func (p *Policy) serviceTokenIdentity(r *http.Request, now time.Time) *Identity {
	clientID, secret := r.Header.Get(ServiceTokenIDHeader), r.Header.Get(ServiceTokenSecretHeader)
	if clientID == "" || secret == "" {
		return nil
	}
	token, ok := p.serviceTokens[clientID]
	if !ok || (token.expiresAt != 0 && now.Unix() >= token.expiresAt) {
		return nil
	}
	digest := sha256.Sum256([]byte(secret))
	if subtle.ConstantTimeCompare(digest[:], token.secretSHA256) != 1 {
		return nil
	}
	return &Identity{Method: MethodServiceToken, Sub: token.id}
}

// Verified basic credentials are remembered for a while, so bcrypt runs once per credentials and not per request.
const (
	basicCacheTTL     = 5 * time.Minute
	basicCacheEntries = 4096
)

// basicVerifier checks basic authentication credentials against a list's bcrypt hashes.
type basicVerifier struct {
	mu       sync.Mutex
	verified map[[32]byte]time.Time
	// slots bounds the bcrypt comparisons running at once: wrong passwords are not cached.
	slots chan struct{}
}

func newBasicVerifier() *basicVerifier {
	return &basicVerifier{verified: make(map[[32]byte]time.Time), slots: make(chan struct{}, max(runtime.NumCPU(), 2))}
}

// identity is the list user whose credentials the request's Authorization header carries (nil: none or wrong).
func (b *basicVerifier) identity(list *List, r *http.Request, now time.Time) *Identity {
	header := r.Header.Get("Authorization")
	username, password, ok := r.BasicAuth()
	if !ok || username == "" {
		return nil
	}
	var hash string
	found := false
	for name, candidate := range list.users {
		if subtle.ConstantTimeCompare([]byte(name), []byte(username)) == 1 {
			hash, found = candidate, true
		}
	}
	if !found {
		return nil
	}
	key := sha256.Sum256([]byte(list.ID + "\x00" + header + "\x00" + hash))
	if b.cached(key, now) {
		return &Identity{Method: MethodBasic, Sub: username, List: list.ID}
	}
	b.slots <- struct{}{}
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	<-b.slots
	if err != nil {
		return nil
	}
	b.remember(key, now)
	return &Identity{Method: MethodBasic, Sub: username, List: list.ID}
}

func (b *basicVerifier) cached(key [32]byte, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	expires, ok := b.verified[key]
	if ok && now.After(expires) {
		delete(b.verified, key)
		return false
	}
	return ok
}

func (b *basicVerifier) remember(key [32]byte, now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.verified) >= basicCacheEntries {
		for entry, expires := range b.verified {
			if now.After(expires) {
				delete(b.verified, entry)
			}
		}
		// Still full: start over rather than grow.
		if len(b.verified) >= basicCacheEntries {
			clear(b.verified)
		}
	}
	b.verified[key] = now.Add(basicCacheTTL)
}
