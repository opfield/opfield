package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/pgha"
)

func TestPGMemberAutoConfRunsAsACopyOfTheMeshPrimary(t *testing.T) {
	config := pgha.StandbyConfig{MemberID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ReplicationRole: "gw_repl_a", SlotName: "gw_ha_a",
		Parameters: pgha.Parameters{MaxConnections: 200}}
	values := pgMemberAutoConf(config, 8<<30, -1)
	conninfo := values["primary_conninfo"]
	// The member authenticates to the primary with its leaf as the client
	// certificate (Opfield issues set member leaves for server and client use)
	// and verifies the primary's against the database CA.
	for _, want := range []string{"host=primary-pg-repl", "port=5432", "user=gw_repl_a", "application_name=" + config.MemberID, "sslmode=verify-ca", "passfile=",
		"sslrootcert=" + pgContainerTLSDir + "/ca.pem", "sslcert=" + pgContainerTLSDir + "/cert.pem", "sslkey=" + pgContainerTLSDir + "/key.pem"} {
		if !strings.Contains(conninfo, want) {
			t.Fatalf("conninfo %q lacks %q", conninfo, want)
		}
	}
	if values["synchronous_standby_names"] != "" || values["restart_after_crash"] != "off" || values["max_connections"] != "200" {
		t.Fatalf("auto conf = %v", values)
	}
	if values["max_slot_wal_keep_size"] != "2048MB" {
		t.Fatalf("slot keep = %s, want a quarter of the volume", values["max_slot_wal_keep_size"])
	}
	dir := t.TempDir()
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = os.Chown })
	if err := os.WriteFile(filepath.Join(dir, "postgresql.auto.conf"), []byte("# x\nwork_mem = '64MB'\nprimary_conninfo = 'old'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "PG_VERSION"), []byte("18\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writePGStandbyAtRest(dir, 8<<30, config); err != nil {
		t.Fatal(err)
	}
	written, err := pgReadAutoConf(filepath.Join(dir, "postgresql.auto.conf"))
	if err != nil || written["work_mem"] != "64MB" || written["primary_conninfo"] != conninfo {
		t.Fatalf("auto conf after standby at rest = %v %v", written, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "standby.signal")); err != nil {
		t.Fatal("standby at rest must write standby.signal")
	}
	if err := pgUpdateAutoConf(dir, pgMemberOnlyAutoConfKeys, nil); err != nil {
		t.Fatal(err)
	}
	lifted, _ := pgReadAutoConf(filepath.Join(dir, "postgresql.auto.conf"))
	if _, ok := lifted["primary_conninfo"]; ok || lifted["max_connections"] != "200" {
		t.Fatalf("a lifted member keeps its sizing and drops its replication settings: %v", lifted)
	}
}

func TestPGMemberHBAKeepsSetRolesOnTLSWithACertificate(t *testing.T) {
	hba := pgMemberHBA([]string{"gw_repl_b", "gw_repl_a"}, "gw_rewind_x")
	for _, want := range []string{
		`hostssl replication "gw_repl_a","gw_repl_b" all scram-sha-256 clientcert=verify-ca`,
		`hostssl postgres "gw_rewind_x" all scram-sha-256 clientcert=verify-ca`,
		`host all "gw_repl_a","gw_repl_b","gw_rewind_x","gw_ha_local" all reject`,
		"host replication all all reject",
	} {
		if !strings.Contains(hba, want) {
			t.Fatalf("pg_hba lacks %q:\n%s", want, hba)
		}
	}
	// Every line that admits a set role requires its client certificate.
	for _, line := range strings.Split(hba, "\n") {
		if (strings.Contains(line, "gw_repl_") || strings.Contains(line, "gw_rewind_")) && !strings.HasSuffix(line, "reject") &&
			!strings.HasSuffix(line, "clientcert=verify-ca") {
			t.Fatalf("pg_hba admits a set role without its certificate: %q", line)
		}
	}
	passfile := pgMemberPassfile("gw_repl_a", `p:a\ss`, "gw_rewind_x", "r")
	if passfile != "*:*:*:gw_repl_a:p\\:a\\\\ss\n*:*:*:gw_rewind_x:r\n" {
		t.Fatalf("passfile = %q", passfile)
	}
}

// H1 (with P3-T07): an update a member never takes is refused; a moved
// published port is the member proxy's, so it is no reason to refuse (or
// recreate) at all.
func TestPGMemberUpdateRefusesWhatNoMemberTakes(t *testing.T) {
	record := managedDatabaseRecord{Type: "postgres", PublishedPort: 15432, StorageSize: 1 << 30,
		AvailabilitySetID: "s", AvailabilityMemberID: "m", TLSEnabled: true}
	input := managedDatabaseCommand{Type: "postgres", Image: pgCuratedTestImage(), StorageSizeBytes: 2 << 30, MemoryBytes: 1 << 30,
		PublishTCP: true, PublishedPort: 15432, OperationID: "op", OwnerUsername: "owner", OwnerPassword: "secret-password-0123456789", DatabaseName: "app"}
	plain := input
	if err := pgMemberUpdateAllowed(record, plain); err == nil {
		t.Fatal("a member keeps TLS")
	}
	ca, cert, key := muTLS(t)
	input.TLSEnabled, input.TLSCACertificatePEM, input.TLSCertificatePEM, input.TLSPrivateKeyPEM, input.TLSCertificateID = true, ca, cert, key, "leaf"
	if err := pgMemberUpdateAllowed(record, input); err != nil {
		t.Fatalf("a live update must be allowed: %v", err)
	}
	moved := input
	moved.PublishedPort = 15433
	if err := pgMemberUpdateAllowed(record, moved); err != nil {
		t.Fatalf("moving the published port is the member proxy's: %v", err)
	}
	if managedDatabaseRequiresRecreate(record, withRecordPublication(record, moved)) {
		t.Fatal("a member's publication never needs a recreate")
	}
	smaller := input
	smaller.StorageSizeBytes = 1 << 20
	if err := pgMemberUpdateAllowed(record, smaller); err == nil {
		t.Fatal("shrinking storage must be refused")
	}
}

// The gate: no lifecycle action starts, restarts or recreates a member
// outside the member runtime; principal SQL runs only on the serving primary.
func TestPGSetGateRefusesLifecycleActionsOfAMember(t *testing.T) {
	m := newTestDatabaseManager(t, nil)
	record := saveTestDatabase(t, m, "db-member")
	record.Type, record.AvailabilitySetID, record.AvailabilityMemberID = "postgres", "set-1", "member-1"
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"create", "start", "stop", "restart", "pause", "unpause", "remove"} {
		if _, err := m.handle(context.Background(), action, "db-member", "{}"); err == nil || !strings.Contains(err.Error(), "availability set") {
			t.Fatalf("%s on a member must be refused, got %v", action, err)
		}
	}
	if _, err := m.handle(context.Background(), "binding_principal_apply_v2", "db-member", "{}"); err == nil || !strings.Contains(err.Error(), "runtime") {
		t.Fatalf("principal SQL without the member runtime must be refused: %v", err)
	}
	if _, err := m.handle(context.Background(), "availability_member_lift", "db-member", "{}"); err == nil {
		t.Fatal("availability actions without the member runtime must be refused")
	}
}

// Lifting is idempotent through the record; a database that is no member is
// never removed or changed by an availability action (B2): its lift answers
// ready.
func TestPGLiftAndRemoveNeverTouchAPlainDatabase(t *testing.T) {
	m := newTestDatabaseManager(t, nil)
	record := saveTestDatabase(t, m, "db-plain")
	record.Type = "postgres"
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	manager := newPGTestMemberManager(t)
	ref := pgMemberRef{OperationID: "op", SetID: "11111111-1111-4111-8111-111111111111", MemberID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
	if _, err := m.pgRemove(context.Background(), manager, "db-plain", ref); err == nil {
		t.Fatal("a plain database must never be removed by a member removal")
	}
	// A plain database already runs as a single node: the lift answers ready
	// and leaves the record as it is (a set that never converted it).
	before, err := m.loadRecord("db-plain")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := m.pgLift(context.Background(), manager, "db-plain", ref, nil)
	if err != nil || !strings.Contains(plain, `"singleNode":true`) {
		t.Fatalf("a lift of a plain database answers ready untouched: %s %v", plain, err)
	}
	if _, err := m.pgLift(context.Background(), manager, "db-plain", ref, &memberha.DetachEvidence{NeverHeld: true}); err != nil {
		t.Fatalf("a detach of a plain database answers ready untouched: %v", err)
	}
	if after, err := m.loadRecord("db-plain"); err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("a plain database must stay untouched: %+v -> %+v (%v)", before, after, err)
	}
	record.AvailabilityLiftedFrom = ref.MemberID
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	detail, err := m.pgLift(context.Background(), manager, "db-plain", ref, nil)
	if err != nil || !strings.Contains(detail, `"ready"`) {
		t.Fatalf("a repeated lift answers ready: %s %v", detail, err)
	}
}

// A Valkey store that is no member already runs as a single node: its lift
// answers lifted and leaves it untouched (a set that never converted it).
func TestKVLiftOfAPlainStoreIsDone(t *testing.T) {
	m := newTestDatabaseManager(t, nil)
	record := saveTestDatabase(t, m, "kv-plain")
	record.Type = "redis"
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	before, err := m.loadRecord("kv-plain")
	if err != nil {
		t.Fatal(err)
	}
	command := kvLiftCommand{kvMemberRef: kvMemberRef{SetID: "11111111-1111-4111-8111-111111111111", MemberID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}
	detail, err := m.kvLift(context.Background(), newPGTestMemberManager(t), "kv-plain", command)
	if err != nil || !strings.Contains(detail, `"singleNode":true`) {
		t.Fatalf("a lift of a plain store answers lifted: %s %v", detail, err)
	}
	if after, err := m.loadRecord("kv-plain"); err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("a plain store must stay untouched: %+v -> %+v (%v)", before, after, err)
	}
}

// The signed assignment statement verifies with the lease node's keychain:
// the same bytes Opfield signs (golden vector shared with the backend test).
func TestPrimaryAssignmentSignatureVerifiesWithTheLeaseKeychain(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	private := ed25519.NewKeyFromSeed(seed)
	assignment := memberha.Assignment{PrimaryMemberID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Generation: 7, SigningKeyID: "k1"}
	setID := "11111111-1111-4111-8111-111111111111"
	message := append(append([]byte(memberha.AssignmentDomain), 0), memberha.AssignmentStatement(setID, assignment)...)
	assignment.Signature = ed25519.Sign(private, message)
	if got := pgHex(assignment.Signature); got != pgAssignmentGoldenSignature {
		t.Fatalf("golden signature changed: %s", got)
	}
	node, err := availabilitylease.NewNode(availabilitylease.Config{ID: "n", Clock: pgTestClock{}, Store: availabilitylease.NewMemoryStore(),
		Signer: availabilitylease.ECDSASigner{Key: mustECDSAKey(t)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.TrustPolicyKey("k1", private.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	verify := func(a memberha.Assignment) error {
		return node.VerifyOpfieldSigned(memberha.AssignmentDomain, a.SigningKeyID, memberha.AssignmentStatement(setID, a), a.Signature)
	}
	if err := verify(assignment); err != nil {
		t.Fatalf("Opfield's assignment must verify: %v", err)
	}
	forged := assignment
	forged.Generation = 8
	if err := verify(forged); err == nil {
		t.Fatal("a changed generation must not verify")
	}
}

// pgAssignmentGoldenSignature is Ed25519(seed 00..1f) over the assignment of
// set 1111..., primary bbbb..., generation 7; the backend's signer test
// checks the same bytes.
const pgAssignmentGoldenSignature = "b5b708bd779fc33895015482f024b107820229cafee289e481a4d705af1525c7ca478d337afd6b6dcbeabd18a9b520abf3309d27cc27dfa8b1bc063269210401"

func pgHex(data []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(data)*2)
	for _, b := range data {
		out = append(out, digits[b>>4], digits[b&15])
	}
	return string(out)
}

type pgTestClock struct{}

func (pgTestClock) Now() time.Duration { return time.Hour }

func newPGTestMemberManager(t *testing.T) *memberha.Manager {
	t.Helper()
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: pgNoLease{}, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: bootWallClock{},
		Engine: func(memberha.Config) (memberha.Engine, error) { return nil, os.ErrInvalid },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

var _ = json.Marshal

func mustECDSAKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

type pgNoLease struct{}

func (pgNoLease) HolderStatus(memberha.Key) memberha.HolderStatus { return memberha.HolderStatus{} }
func (pgNoLease) ManifestInfo(string) (memberha.ManifestInfo, bool) {
	return memberha.ManifestInfo{}, false
}
func (pgNoLease) BootstrapPending(memberha.Key) bool                        { return false }
func (pgNoLease) SetCandidateReady(string, bool)                            {}
func (pgNoLease) SetStateHandler(string, *memberha.StateHandler)            {}
func (pgNoLease) ProposeTransition(memberha.Key, memberha.Transition) error { return nil }
func (pgNoLease) TransitionStatus(memberha.Key, string) (memberha.TransitionOutcome, string) {
	return 0, ""
}
func (pgNoLease) CommittedState(memberha.Key) (memberha.CertifiedState, bool) {
	return memberha.CertifiedState{}, false
}
func (pgNoLease) ObservedCommit(memberha.Key) (memberha.CertifiedState, bool) {
	return memberha.CertifiedState{}, false
}
func (pgNoLease) Recover(memberha.Key, time.Duration) {}
func (pgNoLease) Release(memberha.Key, string) error  { return nil }
func (pgNoLease) FenceComplete(memberha.Key)          {}
func (pgNoLease) Abandon(memberha.Key)                {}

type pgNoWatchdog struct{}

func (pgNoWatchdog) HeartbeatAge(time.Duration) (time.Duration, bool) { return 0, false }
func (pgNoWatchdog) Records() (map[string]leasefence.Record, error)   { return nil, nil }
func (pgNoWatchdog) WriteRecord(leasefence.Record) error              { return nil }
func (pgNoWatchdog) DeleteRecord(string) error                        { return nil }

type pgNoEndpoints struct{}

func (pgNoEndpoints) SetServing(string, string, bool) {}

func pgCuratedTestImage() string {
	for image := range curatedManagedDatabaseImages["postgres"] {
		return image
	}
	return ""
}
