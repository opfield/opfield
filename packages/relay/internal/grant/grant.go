package grant

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/peer"
	"github.com/opfield/opfield/relay/internal/policy"
)

const (
	// Audience is the audience of a grant Opfield issues to relays.
	Audience = "opfield-relay"
	// legacy-name: legacycompat.GrantAudience grant audience — remove once every node reports none.
	// Opfield 2.12.0 issues it, and a newer Opfield keeps issuing it while a
	// relay of the pool does not advertise AudienceCapability.
	LegacyAudience = legacycompat.GrantAudience
	// AudienceCapability tells Opfield this relay accepts grants for Audience.
	AudienceCapability = "grant_audience_opfield_v1"
	// MaxTTL is the longest grant lifetime this relay build accepts. Opfield only
	// issues a grant this long to a relay instance that advertised
	// policy.LongLeaseCapability; otherwise it keeps issuing the legacy 48-hour
	// grants an older relay still enforces.
	MaxTTL    = 240 * time.Hour
	ClockSkew = 5 * time.Minute
)

type Claims struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Audience      string `json:"audience"`
	GrantID       string `json:"grantId"`
	legacycompat.InstanceClaim
	Kind                  string `json:"kind"`
	SubjectKind           string `json:"subjectKind"`
	SubjectID             string `json:"subjectId"`
	CertificateSHA256     string `json:"certificateSha256"`
	PoolID                string `json:"poolId,omitempty"`
	RelayInstanceID       string `json:"relayInstanceId,omitempty"`
	AssignmentGeneration  uint64 `json:"assignmentGeneration,omitempty"`
	EndpointID            string `json:"endpointId,omitempty"`
	EndpointGeneration    uint64 `json:"endpointGeneration,omitempty"`
	RouteID               string `json:"routeId,omitempty"`
	RouteGeneration       uint64 `json:"routeGeneration,omitempty"`
	IssuedAt              int64  `json:"issuedAt"`
	NotBefore             int64  `json:"notBefore"`
	ExpiresAt             int64  `json:"expiresAt"`
	MaxConcurrentSessions uint32 `json:"maxConcurrentSessions,omitempty"`
	MaxFrameBytes         uint32 `json:"maxFrameBytes,omitempty"`
}

var (
	// ErrUnknownKey marks a grant signed by a key this relay's policy does
	// not list yet: Opfield pushes a new grant key to the daemons and the
	// relays at the same time, and the daemon's grant may arrive first.
	ErrUnknownKey = errors.New("grant signing key is not in the relay policy yet")
	// ErrPolicyUnavailable marks a relay without a current policy (none yet,
	// or its lease expired while Opfield is away): a relay condition, not a
	// verdict about the grant.
	ErrPolicyUnavailable = errors.New("relay policy is unavailable")
)

type Verifier struct {
	Store *policy.Store
	Now   func() time.Time
}

func (v Verifier) Verify(envelope *relayv1.SignedGrant, wantKind string, identity peer.Identity) (Claims, error) {
	claims, err := v.VerifyEnvelope(envelope, wantKind, identity)
	if err != nil {
		return Claims{}, err
	}
	if err := ValidatePolicy(claims, wantKind, v.Store.Current()); err != nil {
		return Claims{}, err
	}
	return claims, nil
}

// VerifyEnvelope authenticates a grant (signature, scope, subject, lifetime)
// without binding it to the policy: the caller validates it against the
// policy snapshot it admits under (ValidatePolicy), and may wait for a policy
// the grant is ahead of.
func (v Verifier) VerifyEnvelope(envelope *relayv1.SignedGrant, wantKind string, identity peer.Identity) (Claims, error) {
	if envelope == nil || envelope.KeyId == "" || len(envelope.Payload) == 0 || len(envelope.Signature) != ed25519.SignatureSize {
		return Claims{}, fmt.Errorf("signed grant is incomplete")
	}
	snapshot := v.Store.Current()
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	if err := v.Store.AdmissionError(now); err != nil {
		return Claims{}, fmt.Errorf("%w: %w", ErrPolicyUnavailable, err)
	}
	key, ok := snapshot.PublicKeys[envelope.KeyId]
	if !ok {
		return Claims{}, fmt.Errorf("grant signature is invalid: %w", ErrUnknownKey)
	}
	if !ed25519.Verify(key, envelope.Payload, envelope.Signature) {
		return Claims{}, fmt.Errorf("grant signature is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	var claims Claims
	if err := decoder.Decode(&claims); err != nil {
		return Claims{}, fmt.Errorf("grant payload is invalid: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Claims{}, fmt.Errorf("grant payload contains trailing data")
	}
	if (claims.SchemaVersion != 1 && claims.SchemaVersion != 2) || !acceptedAudience(claims.Audience) || claims.GrantID == "" || claims.OpfieldInstanceID != snapshot.OpfieldInstanceID {
		return Claims{}, fmt.Errorf("grant scope is invalid")
	}
	if claims.SchemaVersion == 1 && snapshot.Mode == relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY {
		return Claims{}, fmt.Errorf("remote relay rejects legacy grants")
	}
	if claims.SchemaVersion == 2 && (claims.PoolID != snapshot.PoolID || claims.RelayInstanceID != snapshot.RelayInstanceID || claims.AssignmentGeneration == 0) {
		return Claims{}, fmt.Errorf("grant relay assignment scope is invalid")
	}
	if claims.Kind != wantKind || claims.SubjectKind == "" || claims.CertificateSHA256 != identity.CertificateFingerprint {
		return Claims{}, fmt.Errorf("grant subject is invalid")
	}
	// Daemon certificates use their node ID as CN. Opfield service certificates
	// deliberately use a stable service CN, so their instance ID is bound by the
	// signed claims, policy snapshot and pinned certificate fingerprint instead.
	if claims.SubjectKind != legacycompat.GrantSubjectKind && claims.SubjectID != identity.SubjectID {
		return Claims{}, fmt.Errorf("grant subject is invalid")
	}
	issuedAt, notBefore, expiresAt := time.Unix(claims.IssuedAt, 0), time.Unix(claims.NotBefore, 0), time.Unix(claims.ExpiresAt, 0)
	if notBefore.Before(issuedAt) || !expiresAt.After(notBefore) || expiresAt.Sub(issuedAt) > MaxTTL {
		return Claims{}, fmt.Errorf("grant lifetime is invalid")
	}
	if now.Add(ClockSkew).Before(issuedAt) || now.Add(ClockSkew).Before(notBefore) || now.Add(-ClockSkew).After(expiresAt) {
		return Claims{}, fmt.Errorf("grant is not currently valid")
	}
	return claims, nil
}

// ValidatePolicy binds already authenticated claims to one immutable policy
// snapshot. Broker admission calls it again while holding its own lock so a
// concurrent snapshot swap cannot retarget or resurrect a stale grant.
func ValidatePolicy(claims Claims, wantKind string, snapshot *policy.Snapshot) error {
	switch wantKind {
	case "endpoint":
		endpoint := snapshot.Endpoint(claims.EndpointID, claims.AssignmentGeneration)
		if endpoint == nil || endpoint.Generation != claims.EndpointGeneration || endpoint.SubjectKind != claims.SubjectKind || endpoint.SubjectId != claims.SubjectID || endpoint.CertificateSha256 != claims.CertificateSHA256 {
			return fmt.Errorf("endpoint grant does not match policy")
		}
		if claims.SchemaVersion == 2 && (endpoint.PoolId != claims.PoolID || endpoint.RelayInstanceId != claims.RelayInstanceID || endpoint.AssignmentGeneration != claims.AssignmentGeneration) {
			return fmt.Errorf("endpoint grant assignment does not match policy")
		}
	case "connect":
		route := snapshot.Route(claims.RouteID, claims.AssignmentGeneration)
		if route == nil || route.Generation != claims.RouteGeneration || route.SourceKind != claims.SubjectKind || route.SourceId != claims.SubjectID || route.SourceCertificateSha256 != claims.CertificateSHA256 {
			return fmt.Errorf("connect grant does not match policy")
		}
		if claims.SchemaVersion == 2 && route.AssignmentGeneration != claims.AssignmentGeneration {
			return fmt.Errorf("connect grant assignment does not match policy")
		}
	default:
		return fmt.Errorf("unsupported grant kind")
	}
	return nil
}

// acceptedAudience reports a grant audience this relay accepts.
func acceptedAudience(audience string) bool {
	return audience == Audience || audience == LegacyAudience
}
