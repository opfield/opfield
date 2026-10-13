package policy

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
)

const (
	// MaxPolicyLease is the longest lease this relay build accepts between a
	// policy envelope's issuedAt and expiresAt. Gateway normally issues shorter
	// leases (see the relayPolicyLeaseHours setting); this is only the cap a
	// relay enforces so a compromised or misconfigured signer cannot mint one
	// that outlives it by an unbounded amount.
	MaxPolicyLease    = 7 * 24 * time.Hour
	IssuedAtClockSkew = 5 * time.Minute
	// LeaseExpiryClockSkew lets a relay whose clock runs ahead of Gateway keep a
	// lease Gateway still considers current. It only delays how long a relay
	// keeps admitting after Gateway stopped refreshing its policy; what the
	// policy admits is unchanged, and revocations arrive as new snapshots.
	LeaseExpiryClockSkew = 2 * time.Minute
	PoolCapability       = "relay_pool_v1"
	// TrustResetCapability tells Gateway that this local relay implements
	// ResetLocalPolicyTrust, so a trust lockout can be repaired without an operator.
	TrustResetCapability = "policy_trust_reset_v1"
	// LongLeaseCapability tells Gateway that this relay build accepts a policy
	// lease up to MaxPolicyLease and a grant up to grant.MaxTTL, instead of the
	// legacy 15-minute lease / 48-hour grant caps. Gateway must not issue the
	// longer lease or grant to a relay that does not advertise it, or an older
	// relay instance rejects the envelope outright.
	LongLeaseCapability = "policy_long_lease_v1"
)

var (
	bucketState = []byte("relay-state-v1")
	// keySnapshot is the snapshot relays before policy_long_lease_v1 load at
	// start; they refuse to start on one whose lease is longer than
	// legacyPolicyLease ("validate persisted snapshot: policy envelope lease
	// is invalid"). It only ever holds a snapshot they accept; keySnapshotFull
	// holds every snapshot (B-10: a relay rolled back to its previous binary
	// must start).
	keySnapshot     = []byte("snapshot")
	keyDigest       = []byte("digest")
	keySnapshotFull = []byte("snapshot-full")
	keyPolicyTrust  = []byte("policy-trust")
)

// legacyPolicyLease is the longest policy lease relays without
// policy_long_lease_v1 accept.
const legacyPolicyLease = 15 * time.Minute

type Options struct {
	Mode       relayv1.RelayMode
	PoolID     string
	InstanceID string
	Now        func() time.Time
}

type Snapshot struct {
	SchemaVersion       uint32
	Mode                relayv1.RelayMode
	Revision            uint64
	GatewayInstanceID   string
	PoolID              string
	RelayInstanceID     string
	IssuedAt            time.Time
	ExpiresAt           time.Time
	Capabilities        []string
	PublicKeys          map[string]ed25519.PublicKey
	Endpoints           map[string]*relayv1.EndpointPolicy
	Routes              map[string]*relayv1.RoutePolicy
	EndpointAssignments map[string]*relayv1.EndpointPolicy
	RouteAssignments    map[string]*relayv1.RoutePolicy
	Admission           *relayv1.AdmissionPolicy
	LeaseBlocks         []*relayv1.LeaseSignedBlock
	LeaseKeyRotations   []*relayv1.LeasePolicyKeyRotation
	Digest              [sha256.Size]byte
	// LeaseBound reports an endpoint or route bound to an availability lease
	// gate: without one the broker skips lease gate enforcement.
	LeaseBound bool
}

type trustedPolicyKey struct {
	PublicKey   ed25519.PublicKey
	Fingerprint string
	ValidFrom   time.Time
	VerifyUntil time.Time
}

type persistedTrust struct {
	Keys []persistedTrustKey `json:"keys"`
}

type persistedTrustKey struct {
	KeyID       string `json:"keyId"`
	PublicKey   []byte `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
	ValidFrom   int64  `json:"validFrom,omitempty"`
	VerifyUntil int64  `json:"verifyUntil,omitempty"`
}

type Store struct {
	db *bolt.DB
	// applyMu serializes every change of current, policyTrust and rebind and
	// the writes that persist them; it is held across the fsync. mu guards
	// those fields for readers and is held only to swap them, so readers
	// never wait for the disk (F4). Holders of applyMu read them without mu.
	applyMu     sync.Mutex
	mu          sync.RWMutex
	current     *Snapshot
	mode        relayv1.RelayMode
	poolID      string
	instanceID  string
	now         func() time.Time
	policyTrust map[string]trustedPolicyKey
	// rebind is set by a local trust reset. The next accepted snapshot may then
	// replace the serving one even if it names another Gateway instance or an
	// older revision: both are what a Gateway restored from backup, or one that
	// was reinstalled over an existing relay volume, sends after re-pinning.
	// It is persisted until that snapshot applies (keyPolicyRebind).
	rebind bool
}

func Open(dir string) (*Store, error) {
	return OpenWithOptions(dir, Options{Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED})
}

func OpenWithOptions(dir string, options Options) (*Store, error) {
	if options.Mode == relayv1.RelayMode_RELAY_MODE_UNSPECIFIED {
		options.Mode = relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED
	}
	if options.Mode == relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY && (options.PoolID == "" || options.InstanceID == "") {
		return nil, fmt.Errorf("remote relay pool and instance identity are required")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "relay.db"), 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	store := &Store{
		db: db, mode: options.Mode, poolID: options.PoolID, instanceID: options.InstanceID,
		now: options.Now, policyTrust: map[string]trustedPolicyKey{},
	}
	store.current = emptySnapshot(store.mode, store.poolID, store.instanceID)
	if err := db.Update(func(tx *bolt.Tx) error { _, err := tx.CreateBucketIfNotExists(bucketState); return err }); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.loadTrust(); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.load(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func emptySnapshot(mode relayv1.RelayMode, poolID, instanceID string) *Snapshot {
	return &Snapshot{
		Mode: mode, PoolID: poolID, RelayInstanceID: instanceID,
		PublicKeys: map[string]ed25519.PublicKey{}, Endpoints: map[string]*relayv1.EndpointPolicy{},
		Routes: map[string]*relayv1.RoutePolicy{}, EndpointAssignments: map[string]*relayv1.EndpointPolicy{},
		RouteAssignments: map[string]*relayv1.RoutePolicy{}, Admission: defaultAdmissionPolicy(),
	}
}

func assignmentKey(id string, generation uint64) string {
	return fmt.Sprintf("%s:%d", id, generation)
}

func (s *Snapshot) Endpoint(id string, assignmentGeneration uint64) *relayv1.EndpointPolicy {
	if assignmentGeneration > 0 {
		if endpoint := s.EndpointAssignments[assignmentKey(id, assignmentGeneration)]; endpoint != nil {
			return endpoint
		}
	}
	return s.Endpoints[id]
}

func (s *Snapshot) Route(id string, assignmentGeneration uint64) *relayv1.RoutePolicy {
	if assignmentGeneration > 0 {
		if route := s.RouteAssignments[assignmentKey(id, assignmentGeneration)]; route != nil {
			return route
		}
	}
	return s.Routes[id]
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Current() *Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

func (s *Store) KeyIDs() []string {
	current := s.Current()
	ids := make([]string, 0, len(current.PublicKeys))
	for id := range current.PublicKeys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (s *Store) PolicyKeyIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.policyTrust))
	for id := range s.policyTrust {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func PublicKeyFingerprint(publicKey ed25519.PublicKey) string {
	digest := sha256.Sum256(publicKey)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func (s *Store) Apply(request *relayv1.ApplySnapshotRequest) (*Snapshot, bool, error) {
	return s.ApplyStaged(request, nil)
}

// ApplyStaged validates and persists a snapshot without blocking readers:
// Current, the grant verifier and health keep reading the serving snapshot
// during the fsync (F4). The pinned trust follows the snapshot before publish
// runs. publish, when set, must call makeCurrent exactly once; it lets the
// caller hold its own lock across the swap alone (the broker swaps under its
// admission lock). Without publish the snapshot becomes current at once.
func (s *Store) ApplyStaged(request *relayv1.ApplySnapshotRequest, publish func(next *Snapshot, makeCurrent func())) (*Snapshot, bool, error) {
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	encoded, digest, next, nextTrust, err := s.normalizeLocked(request, false)
	if err != nil {
		return nil, false, err
	}
	current := s.Current()
	if next.Revision == current.Revision && bytes.Equal(next.Digest[:], current.Digest[:]) {
		return current, true, nil
	}
	// After a local trust reset the first snapshot from the re-pinned key is
	// authoritative; see ResetLocalPolicyTrust.
	if !s.rebind {
		if current.GatewayInstanceID != "" && next.GatewayInstanceID != current.GatewayInstanceID {
			return nil, false, fmt.Errorf("snapshot Opfield instance changed")
		}
		if next.Revision < current.Revision {
			return nil, false, fmt.Errorf("snapshot revision %d is older than applied revision %d", next.Revision, current.Revision)
		}
		if next.Revision == current.Revision {
			return nil, false, fmt.Errorf("snapshot revision %d conflicts with applied content", next.Revision)
		}
	}
	if err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		if err := bucket.Put(keySnapshotFull, encoded); err != nil {
			return err
		}
		if legacySnapshotCompatible(request) {
			if err := bucket.Put(keySnapshot, encoded); err != nil {
				return err
			}
			if err := bucket.Put(keyDigest, digest[:]); err != nil {
				return err
			}
		} else if err := deleteSnapshot(bucket, keySnapshot); err != nil {
			return err
		}
		if err := bucket.Delete(keyPolicyRebind); err != nil {
			return err
		}
		return persistTrust(bucket, nextTrust)
	}); err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	s.policyTrust = nextTrust
	s.rebind = false
	s.mu.Unlock()
	makeCurrent := func() {
		s.mu.Lock()
		s.current = next
		s.mu.Unlock()
	}
	if publish == nil {
		makeCurrent()
	} else {
		publish(next, makeCurrent)
	}
	return next, false, nil
}

func (s *Store) AdmissionError(at time.Time) error {
	current := s.Current()
	if current.Revision == 0 {
		return fmt.Errorf("policy snapshot is required")
	}
	if !current.ExpiresAt.IsZero() && !at.Before(current.ExpiresAt.Add(LeaseExpiryClockSkew)) {
		return fmt.Errorf("policy snapshot expired")
	}
	return nil
}

func (s *Store) Ready(at time.Time) bool { return s.AdmissionError(at) == nil }

// legacySnapshotCompatible reports whether relays before policy_long_lease_v1
// start on this snapshot: an unsigned local snapshot, or a signed one whose
// lease is at most legacyPolicyLease.
func legacySnapshotCompatible(request *relayv1.ApplySnapshotRequest) bool {
	envelope := request.GetSignedEnvelope()
	if envelope == nil {
		return true
	}
	payload := &relayv1.PolicyEnvelopePayload{}
	if proto.Unmarshal(envelope.GetPayload(), payload) != nil {
		return false
	}
	lease := time.Unix(payload.GetExpiresAtUnix(), 0).Sub(time.Unix(payload.GetIssuedAtUnix(), 0))
	return lease > 0 && lease <= legacyPolicyLease
}

// load restores the newest persisted snapshot. The full copy is the one this
// build writes; the legacy copy is newer when an older relay build ran on this
// relay.db after it (a rollback) and applied a later revision.
func (s *Store) load() error {
	var full, legacy []byte
	if err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		full = append([]byte(nil), bucket.Get(keySnapshotFull)...)
		legacy = append([]byte(nil), bucket.Get(keySnapshot)...)
		return nil
	}); err != nil {
		return err
	}
	var chosen *Snapshot
	var chosenTrust map[string]trustedPolicyKey
	for _, encoded := range [][]byte{full, legacy} {
		if len(encoded) == 0 {
			continue
		}
		request := &relayv1.ApplySnapshotRequest{}
		if err := proto.Unmarshal(encoded, request); err != nil {
			slog.Warn("ignoring persisted relay policy snapshot that does not decode", "error", err)
			continue
		}
		_, _, snapshot, nextTrust, err := s.normalizeLocked(request, true)
		if err != nil {
			// A persisted snapshot that no longer validates must not keep the
			// relay from starting, or it restarts forever: for example one
			// written for another relay instance before a re-enrollment. The
			// relay starts without a policy, admits nothing and keeps its
			// pinned trust until Gateway sends a new snapshot.
			slog.Warn("ignoring persisted relay policy snapshot that no longer validates", "error", err)
			continue
		}
		if chosen == nil || snapshot.Revision > chosen.Revision {
			chosen, chosenTrust = snapshot, nextTrust
		}
	}
	if chosen != nil {
		s.current = chosen
		s.policyTrust = chosenTrust
	}
	return nil
}

// normalizeLocked reads the pinned trust: called with applyMu held, or while
// the store is opened.
func (s *Store) normalizeLocked(request *relayv1.ApplySnapshotRequest, allowExpired bool) ([]byte, [sha256.Size]byte, *Snapshot, map[string]trustedPolicyKey, error) {
	if request == nil {
		return nil, [sha256.Size]byte{}, nil, nil, fmt.Errorf("snapshot is required")
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(request)
	if err != nil {
		return nil, [sha256.Size]byte{}, nil, nil, err
	}
	digest := sha256.Sum256(encoded)
	if request.SignedEnvelope == nil {
		if s.mode != relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED {
			return nil, digest, nil, nil, fmt.Errorf("remote relay requires signed policy envelope")
		}
		next, err := s.normalizeLegacy(request, digest)
		return encoded, digest, next, cloneTrust(s.policyTrust), err
	}
	if len(s.policyTrust) == 0 {
		return nil, digest, nil, nil, fmt.Errorf("policy signing trust is not bootstrapped")
	}
	envelope := request.SignedEnvelope
	trusted, ok := s.policyTrust[envelope.SigningKeyId]
	// A persisted snapshot was verified when it was applied, and its trust was
	// written in the same transaction. Reloading it checks the signature again
	// but not the signer's validity window: a key that has since aged out, or a
	// clock that moved, must not stop the relay from starting.
	if !ok || (!allowExpired && !trusted.validAt(s.now())) || len(envelope.Signature) != ed25519.SignatureSize || !ed25519.Verify(trusted.PublicKey, envelope.Payload, envelope.Signature) {
		return nil, digest, nil, nil, fmt.Errorf("policy envelope signature is invalid")
	}
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(envelope.Payload, payload); err != nil {
		return nil, digest, nil, nil, fmt.Errorf("decode policy envelope: %w", err)
	}
	next, nextTrust, err := s.normalizeSignedPayload(payload, digest, envelope.SigningKeyId, allowExpired)
	if err != nil {
		return nil, digest, nil, nil, err
	}
	return encoded, digest, next, nextTrust, nil
}

func (s *Store) normalizeLegacy(request *relayv1.ApplySnapshotRequest, digest [sha256.Size]byte) (*Snapshot, error) {
	if request.Revision == 0 || request.GatewayInstanceId == "" {
		return nil, fmt.Errorf("snapshot revision and Opfield instance id are required")
	}
	return buildSnapshot(&relayv1.PolicyEnvelopePayload{
		SchemaVersion: 1, GatewayInstanceId: request.GatewayInstanceId, Revision: request.Revision,
		PoolId: s.poolID, RelayInstanceId: s.instanceID,
		GrantPublicKeys: request.PublicKeys, Endpoints: request.Endpoints, Routes: request.Routes,
		AdmissionPolicy: request.AdmissionPolicy,
	}, s.mode, digest)
}

func (s *Store) normalizeSignedPayload(payload *relayv1.PolicyEnvelopePayload, digest [sha256.Size]byte, signer string, allowExpired bool) (*Snapshot, map[string]trustedPolicyKey, error) {
	if payload.SchemaVersion != 2 || payload.GatewayInstanceId == "" || payload.PoolId == "" || payload.RelayInstanceId == "" || payload.Revision == 0 {
		return nil, nil, fmt.Errorf("policy envelope scope is invalid")
	}
	if payload.PoolId != s.poolID || payload.RelayInstanceId != s.instanceID {
		return nil, nil, fmt.Errorf("policy envelope targets another relay instance")
	}
	issuedAt, expiresAt := time.Unix(payload.IssuedAtUnix, 0), time.Unix(payload.ExpiresAtUnix, 0)
	now := s.now()
	if expiresAt.Sub(issuedAt) <= 0 || expiresAt.Sub(issuedAt) > MaxPolicyLease {
		return nil, nil, fmt.Errorf("policy envelope lease is invalid")
	}
	// A reload checks neither end of the lease: a relay whose clock starts
	// behind the snapshot it persisted must still start.
	if !allowExpired && issuedAt.After(now.Add(IssuedAtClockSkew)) {
		return nil, nil, fmt.Errorf("policy envelope was issued in the future")
	}
	if !allowExpired && !now.Before(expiresAt.Add(LeaseExpiryClockSkew)) {
		return nil, nil, fmt.Errorf("policy envelope is expired")
	}
	if !contains(payload.Capabilities, PoolCapability) {
		return nil, nil, fmt.Errorf("policy envelope lacks relay pool capability")
	}
	nextTrust := make(map[string]trustedPolicyKey, len(payload.PolicySigningKeys))
	for _, key := range payload.PolicySigningKeys {
		if key.KeyId == "" || len(key.PublicKey) != ed25519.PublicKeySize || (key.Status != "active" && key.Status != "verification_only") {
			return nil, nil, fmt.Errorf("policy envelope contains invalid signing key")
		}
		publicKey := append(ed25519.PublicKey(nil), key.PublicKey...)
		if PublicKeyFingerprint(publicKey) != key.PublicKeyFingerprint {
			return nil, nil, fmt.Errorf("policy signing key fingerprint mismatch")
		}
		if _, exists := nextTrust[key.KeyId]; exists {
			return nil, nil, fmt.Errorf("duplicate policy signing key %q", key.KeyId)
		}
		nextTrust[key.KeyId] = trustedPolicyKey{
			PublicKey: publicKey, Fingerprint: key.PublicKeyFingerprint,
			ValidFrom: unixTime(key.ValidFromUnix), VerifyUntil: unixTime(key.VerifyUntilUnix),
		}
	}
	currentSigner, exists := nextTrust[signer]
	if !exists {
		return nil, nil, fmt.Errorf("policy envelope removes its signing key")
	}
	previousSigner := s.policyTrust[signer]
	if previousSigner.Fingerprint != currentSigner.Fingerprint || !bytes.Equal(previousSigner.PublicKey, currentSigner.PublicKey) {
		return nil, nil, fmt.Errorf("policy envelope changes its signing key material")
	}
	next, err := buildSnapshot(payload, s.mode, digest)
	if err != nil {
		return nil, nil, err
	}
	next.IssuedAt, next.ExpiresAt = issuedAt, expiresAt
	return next, nextTrust, nil
}

func buildSnapshot(payload *relayv1.PolicyEnvelopePayload, mode relayv1.RelayMode, digest [sha256.Size]byte) (*Snapshot, error) {
	next := &Snapshot{
		SchemaVersion: payload.SchemaVersion, Mode: mode, Revision: payload.Revision,
		GatewayInstanceID: payload.GatewayInstanceId, PoolID: payload.PoolId, RelayInstanceID: payload.RelayInstanceId,
		Capabilities: append([]string(nil), payload.Capabilities...), PublicKeys: map[string]ed25519.PublicKey{},
		Endpoints: map[string]*relayv1.EndpointPolicy{}, Routes: map[string]*relayv1.RoutePolicy{},
		EndpointAssignments: map[string]*relayv1.EndpointPolicy{}, RouteAssignments: map[string]*relayv1.RoutePolicy{},
		Admission: defaultAdmissionPolicy(), Digest: digest,
	}
	if payload.AdmissionPolicy != nil {
		next.Admission = proto.Clone(payload.AdmissionPolicy).(*relayv1.AdmissionPolicy)
	}
	if err := validateAdmissionPolicy(next.Admission); err != nil {
		return nil, err
	}
	leaseFields(next, payload)
	for _, key := range payload.GrantPublicKeys {
		if key.KeyId == "" || len(key.PublicKey) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid public key")
		}
		if _, exists := next.PublicKeys[key.KeyId]; exists {
			return nil, fmt.Errorf("duplicate public key %q", key.KeyId)
		}
		next.PublicKeys[key.KeyId] = append(ed25519.PublicKey(nil), key.PublicKey...)
	}
	for _, endpoint := range payload.Endpoints {
		if endpoint.EndpointId == "" || endpoint.Generation == 0 || endpoint.SubjectKind == "" || endpoint.SubjectId == "" || endpoint.CertificateSha256 == "" {
			return nil, fmt.Errorf("invalid endpoint policy")
		}
		if payload.SchemaVersion == 2 && (endpoint.PoolId != payload.PoolId || endpoint.RelayInstanceId != payload.RelayInstanceId || endpoint.AssignmentGeneration == 0) {
			return nil, fmt.Errorf("endpoint policy relay assignment scope is invalid")
		}
		next.LeaseBound = next.LeaseBound || endpoint.LeasePolicyId != ""
		clone := proto.Clone(endpoint).(*relayv1.EndpointPolicy)
		if payload.SchemaVersion == 2 {
			key := assignmentKey(endpoint.EndpointId, endpoint.AssignmentGeneration)
			if _, exists := next.EndpointAssignments[key]; exists {
				return nil, fmt.Errorf("duplicate endpoint assignment %q", key)
			}
			next.EndpointAssignments[key] = clone
		} else if _, exists := next.Endpoints[endpoint.EndpointId]; exists {
			return nil, fmt.Errorf("duplicate endpoint %q", endpoint.EndpointId)
		}
		if current := next.Endpoints[endpoint.EndpointId]; current == nil || endpoint.AssignmentGeneration > current.AssignmentGeneration {
			next.Endpoints[endpoint.EndpointId] = clone
		}
	}
	for _, route := range payload.Routes {
		if route.RouteId == "" || route.Generation == 0 || route.SourceKind == "" || route.SourceId == "" || route.SourceCertificateSha256 == "" {
			return nil, fmt.Errorf("invalid route policy")
		}
		if payload.SchemaVersion == 2 && route.AssignmentGeneration == 0 {
			return nil, fmt.Errorf("route policy assignment generation is required")
		}
		if endpoint := next.Endpoint(route.TargetEndpointId, route.AssignmentGeneration); endpoint == nil {
			return nil, fmt.Errorf("route %q targets unknown endpoint", route.RouteId)
		} else if payload.SchemaVersion == 2 && route.AssignmentGeneration != endpoint.AssignmentGeneration {
			return nil, fmt.Errorf("route %q assignment generation does not match endpoint", route.RouteId)
		}
		next.LeaseBound = next.LeaseBound || route.LeasePolicyId != ""
		clone := proto.Clone(route).(*relayv1.RoutePolicy)
		if payload.SchemaVersion == 2 {
			key := assignmentKey(route.RouteId, route.AssignmentGeneration)
			if _, exists := next.RouteAssignments[key]; exists {
				return nil, fmt.Errorf("duplicate route assignment %q", key)
			}
			next.RouteAssignments[key] = clone
		} else if _, exists := next.Routes[route.RouteId]; exists {
			return nil, fmt.Errorf("duplicate route %q", route.RouteId)
		}
		if current := next.Routes[route.RouteId]; current == nil || route.AssignmentGeneration > current.AssignmentGeneration {
			next.Routes[route.RouteId] = clone
		}
	}
	return next, nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func unixTime(value int64) time.Time {
	if value == 0 {
		return time.Time{}
	}
	return time.Unix(value, 0)
}

func unixValue(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.Unix()
}

func defaultAdmissionPolicy() *relayv1.AdmissionPolicy {
	return &relayv1.AdmissionPolicy{Enabled: true, ProxyTargetPressurePercent: 70, DatabaseReservePercent: 20, HardPressurePercent: 95}
}

func validateAdmissionPolicy(value *relayv1.AdmissionPolicy) error {
	if value == nil || !value.Enabled {
		return nil
	}
	if value.ProxyTargetPressurePercent < 50 || value.ProxyTargetPressurePercent > 85 {
		return fmt.Errorf("proxy target pressure must be between 50 and 85 percent")
	}
	if value.DatabaseReservePercent < 5 || value.DatabaseReservePercent > 35 {
		return fmt.Errorf("database reserve must be between 5 and 35 percent")
	}
	if value.HardPressurePercent < 90 || value.HardPressurePercent > 99 {
		return fmt.Errorf("hard pressure cutoff must be between 90 and 99 percent")
	}
	if value.ProxyTargetPressurePercent+value.DatabaseReservePercent >= value.HardPressurePercent {
		return fmt.Errorf("proxy target pressure plus database reserve must remain below the hard cutoff")
	}
	return nil
}

func RevisionBytes(revision uint64) []byte {
	value := make([]byte, 8)
	binary.BigEndian.PutUint64(value, revision)
	return value
}
