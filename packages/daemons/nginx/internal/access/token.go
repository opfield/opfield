package access

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"time"
)

// Access tokens: v1.<payloadB64url>.<sigB64url>, an Ed25519 signature over "opfield-access-v1.<payloadB64url>".
const (
	tokenPrefix        = "v1."
	tokenSigningPrefix = "opfield-access-v1."
	// maxTokenLength bounds what is decoded; real tokens are well below 2 KiB.
	maxTokenLength = 8192
)

// Claims are the payload of an access token.
type Claims struct {
	KeyID     string   `json:"kid"`
	SessionID string   `json:"sid"`
	Audience  string   `json:"aud"`
	IssuedAt  int64    `json:"iat"`
	ExpiresAt int64    `json:"exp"`
	Identity  Identity `json:"idn"`
	Nonce     string   `json:"non,omitempty"`
}

var errInvalidToken = errors.New("invalid access token")

// VerifyToken checks a token for a request to host: signed by a synced key, for this host, not expired and of a
// session that was not revoked.
func (p *Policy) VerifyToken(token, host string, now time.Time) (*Claims, error) {
	if p == nil || len(token) > maxTokenLength {
		return nil, errInvalidToken
	}
	rest, ok := strings.CutPrefix(token, tokenPrefix)
	if !ok {
		return nil, errInvalidToken
	}
	payloadPart, signaturePart, ok := strings.Cut(rest, ".")
	if !ok || payloadPart == "" || strings.Contains(signaturePart, ".") {
		return nil, errInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		return nil, errInvalidToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, errInvalidToken
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, errInvalidToken
	}
	key, ok := p.keys[claims.KeyID]
	if !ok || !ed25519.Verify(key, []byte(tokenSigningPrefix+payloadPart), signature) {
		return nil, errInvalidToken
	}
	if claims.Audience == "" || claims.Audience != NormalizeHost(host) {
		return nil, errors.New("access token is for another host")
	}
	if now.Unix() >= claims.ExpiresAt {
		return nil, errors.New("access token expired")
	}
	if claims.SessionID == "" || claims.Identity.Method == "" {
		return nil, errInvalidToken
	}
	if _, revoked := p.revoked[claims.SessionID]; revoked {
		return nil, errors.New("access session was revoked")
	}
	return &claims, nil
}

// NormalizeHost is a request host as tokens name it: lowercase, without port.
func NormalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]"))
}
