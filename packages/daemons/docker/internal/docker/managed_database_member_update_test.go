package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// The member update rule (P3-T07) against a fake Docker Engine API: a copy's
// container is recreated under the member runtime's hold, the primary is
// refused with AVAILABILITY_SWITCHOVER_REQUIRED, a Postgres major change is
// refused with POSTGRES_MAJOR_CHANGE.

const (
	muSet    = "11111111-1111-4111-8111-111111111111"
	muMember = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	muPeer   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	muPolicy = "22222222-2222-4222-8222-222222222222"
	muDB     = "33333333-3333-4333-8333-333333333333"
)

// muDocker answers the container and image calls of a member update.
type muDocker struct {
	t       *testing.T
	mu      sync.Mutex
	calls   []string
	images  map[string]string // container -> image
	running map[string]bool
	majors  map[string]string // image digest -> PG_MAJOR
	created []muCreated
	// onCreate runs inside the create call (the hold is checked there).
	onCreate func()
}

type muCreated struct {
	Image      string
	Labels     map[string]string
	ExtraHosts []string
	Networks   []string
}

var muPath = regexp.MustCompile(`^/v[0-9.]+/(containers|images)/(.+?)(/json|/start|/stop|/rename|/update)?$`)

func (d *muDocker) client() *Client {
	d.t.Helper()
	server := httptest.NewServer(http.HandlerFunc(d.serve))
	d.t.Cleanup(server.Close)
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://"+strings.TrimPrefix(server.URL, "http://")), client.WithAPIVersion("1.47"))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (d *muDocker) serve(w http.ResponseWriter, r *http.Request) {
	reply := func(code int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	match := muPath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	kind, id, action := match[1], match[2], match[3]
	if kind == "containers" && id == "create" {
		var body struct {
			Image            string
			Labels           map[string]string
			HostConfig       struct{ ExtraHosts []string }
			NetworkingConfig struct{ EndpointsConfig map[string]any }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			d.t.Errorf("decode container create: %v", err)
		}
		if d.onCreate != nil {
			d.onCreate()
		}
		d.mu.Lock()
		created := fmt.Sprintf("new%d", len(d.created))
		networks := make([]string, 0, len(body.NetworkingConfig.EndpointsConfig))
		for name := range body.NetworkingConfig.EndpointsConfig {
			networks = append(networks, name)
		}
		sort.Strings(networks)
		d.created = append(d.created, muCreated{Image: body.Image, Labels: body.Labels, ExtraHosts: body.HostConfig.ExtraHosts, Networks: networks})
		d.images[created] = body.Image
		d.calls = append(d.calls, "create "+created)
		d.mu.Unlock()
		reply(http.StatusCreated, map[string]any{"Id": created, "Warnings": []string{}})
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case kind == "images":
		digest := managedDatabaseImageDigest(id)
		major, ok := d.majors[digest]
		if !ok {
			reply(http.StatusNotFound, map[string]string{"message": "no such image"})
			return
		}
		reply(http.StatusOK, map[string]any{"Id": "sha256:" + strings.Repeat("e", 64), "Config": map[string]any{"Env": []string{"PG_MAJOR=" + major}}})
	case action == "/json":
		image, ok := d.images[id]
		if !ok {
			reply(http.StatusNotFound, map[string]string{"message": "no such container"})
			return
		}
		reply(http.StatusOK, map[string]any{"Id": id, "Config": map[string]any{"Image": image}, "State": map[string]any{"Running": d.running[id]}})
	case action == "/stop":
		d.calls = append(d.calls, "stop "+id)
		d.running[id] = false
		reply(http.StatusNoContent, nil)
	case action == "/start":
		d.calls = append(d.calls, "start "+id)
		d.running[id] = true
		reply(http.StatusNoContent, nil)
	case action == "/rename":
		d.calls = append(d.calls, "rename "+id)
		reply(http.StatusNoContent, nil)
	case action == "/update":
		d.calls = append(d.calls, "live_update "+id)
		reply(http.StatusOK, map[string]any{"Warnings": []string{}})
	case action == "" && r.Method == http.MethodDelete:
		d.calls = append(d.calls, "remove "+id)
		delete(d.images, id)
		reply(http.StatusNoContent, nil)
	default:
		d.t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
		reply(http.StatusNotFound, map[string]string{"message": "not found"})
	}
}

func (d *muDocker) log() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.calls...)
}

// muLease is the lease node as a member update sees it: one role, and the
// state handler the member registered (its eligibility).
type muLease struct {
	pgNoLease
	mu      sync.Mutex
	role    memberha.Role
	handler *memberha.StateHandler
}

func (l *muLease) HolderStatus(memberha.Key) memberha.HolderStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	return memberha.HolderStatus{Role: l.role}
}

func (l *muLease) SetStateHandler(_ string, handler *memberha.StateHandler) {
	l.mu.Lock()
	l.handler = handler
	l.mu.Unlock()
}

func (l *muLease) eligibility() (bool, string) {
	l.mu.Lock()
	handler := l.handler
	l.mu.Unlock()
	if handler == nil {
		return false, "no handler"
	}
	return handler.Eligible(memberha.EligibilityInput{})
}

// muEngine is an engine the test never steps.
type muEngine struct{}

func (muEngine) Container(context.Context) (memberha.ContainerState, error) {
	return memberha.ContainerState{}, nil
}
func (muEngine) Status(context.Context) (memberha.EngineStatus, error) {
	return memberha.EngineStatus{}, nil
}
func (muEngine) PrepareStandby(context.Context) error                 { return nil }
func (muEngine) Start(context.Context) error                          { return nil }
func (muEngine) StopClean(context.Context, time.Duration) error       { return nil }
func (muEngine) Kill(context.Context) error                           { return nil }
func (muEngine) CgroupEmpty(context.Context) (bool, error)            { return true, nil }
func (muEngine) Promote(context.Context, []byte) error                { return nil }
func (muEngine) Rejoin(context.Context) error                         { return nil }
func (muEngine) Switchover(context.Context, string) error             { return nil }
func (muEngine) BootstrapValue(memberha.EngineStatus) ([]byte, error) { return nil, nil }
func (muEngine) Eligible(memberha.EligibilityInput, memberha.EngineStatus) (bool, string) {
	return true, ""
}
func (muEngine) PromotedValue([]byte, memberha.EngineStatus) ([]byte, error) { return nil, nil }
func (muEngine) NextValue([]byte, memberha.EngineStatus, time.Duration) ([]byte, string, bool, error) {
	return nil, "", false, nil
}
func (muEngine) ReleaseTarget([]byte) (string, bool) { return "", false }
func (muEngine) DialPeer(context.Context, string) (net.Conn, error) {
	return nil, os.ErrInvalid
}

// muMesh is the set's member mesh as a recreate sees it.
type muMesh struct{}

func (muMesh) Ensure(context.Context, string) (string, error) { return "gateway-set-test", nil }
func (muMesh) Expose(string, string, uint16, string)          {}
func (muMesh) ExtraHosts(string) []string                     { return []string{"primary-pg-repl:10.1.2.1"} }
func (muMesh) Release(string)                                 {}

// muPlainLoops mounts an image as a plain directory.
func muPlainLoops() *loopHost {
	var mu sync.Mutex
	mounted := map[string]bool{}
	return &loopHost{
		loops: func() ([]loopDevice, error) { return nil, nil },
		mounts: func() ([]mountEntry, error) {
			mu.Lock()
			defer mu.Unlock()
			out := make([]mountEntry, 0, len(mounted))
			for path := range mounted {
				out = append(out, mountEntry{MountPoint: path})
			}
			return out, nil
		},
		identity:    func(string) (uint64, uint64, bool) { return 0, 0, false },
		unmount:     func(context.Context, string) error { return nil },
		detach:      func(context.Context, string) error { return nil },
		sleep:       func(context.Context, time.Duration) error { return nil },
		attach:      func(context.Context, string) (string, error) { return "/dev/mu-loop", nil },
		placeholder: func(context.Context, string) error { return nil },
		mount: func(_ context.Context, _, path, _ string) error {
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
			mu.Lock()
			mounted[canonicalLoopPath(path)] = true
			mu.Unlock()
			return nil
		},
	}
}

func muTLS(t *testing.T) (ca, cert, key string) {
	t.Helper()
	encode := func(kind string, der []byte) string {
		return string(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}))
	}
	caKey := mustECDSAKey(t)
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "mu ca"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafTemplate := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "mu"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"database"}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(leafKey)
	return encode("CERTIFICATE", caDER), encode("CERTIFICATE", leafDER), encode("EC PRIVATE KEY", keyDER)
}

// muImages are two curated postgres images (sorted).
func muImages(t *testing.T) (string, string) {
	t.Helper()
	var images []string
	for image := range curatedManagedDatabaseImages["postgres"] {
		images = append(images, image)
	}
	sort.Strings(images)
	if len(images) < 2 {
		t.Skip("two curated postgres images are needed")
	}
	return images[0], images[1]
}

type muFixture struct {
	m       *managedDatabaseManager
	docker  *muDocker
	lease   *muLease
	members *memberha.Manager
	input   managedDatabaseCommand
	oldImg  string
	newImg  string
}

// newMUFixture is a Postgres member (container "old" on oldImg, data of
// major dataMajor) with the update command for newImg.
func newMUFixture(t *testing.T, dataMajor, oldMajor, newMajor string) *muFixture {
	t.Helper()
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = os.Chown })
	oldImg, newImg := muImages(t)
	docker := &muDocker{t: t, images: map[string]string{"old": oldImg}, running: map[string]bool{"old": true},
		majors: map[string]string{managedDatabaseImageDigest(oldImg): oldMajor, managedDatabaseImageDigest(newImg): newMajor}}
	m := newTestDatabaseManager(t, nil)
	m.loops = muPlainLoops()
	m.client = docker.client()
	record := saveTestDatabase(t, m, muDB)
	record.Type, record.ContainerID, record.ContainerName, record.NetworkName = "postgres", "old", "gwdb-"+muDB, "gateway-set-test"
	record.AvailabilitySetID, record.AvailabilityMemberID = muSet, muMember
	record.StorageSize, record.TLSEnabled, record.TLSCertificateID, record.OperationID = 1<<30, true, "leaf-1", "op-before"
	if err := os.MkdirAll(filepath.Join(record.MountPath, pgdataDirName), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(record.MountPath, pgdataDirName, "PG_VERSION"), []byte(dataMajor+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	lease := &muLease{}
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	members, err := memberha.NewManager(memberha.Deps{
		Lease: lease, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: bootWallClock{},
		Engine: func(memberha.Config) (memberha.Engine, error) { return muEngine{}, nil },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := members.Configure(memberha.Config{SetID: muSet, MemberID: muMember, NodeID: "node-a", Engine: "postgres",
		OwnerKind: "managed_database", OwnerID: muDB, Mode: memberha.ModeAutomatic, LeasePolicyID: muPolicy, ConfigRevision: 1,
		Members: []memberha.Peer{{MemberID: muMember, NodeID: "node-a"}, {MemberID: muPeer, NodeID: "node-b", MemberIndex: 1}}}); err != nil {
		t.Fatal(err)
	}
	m.pgSets.members = func() *memberha.Manager { return members }
	m.pgSets.mesh = func() pgSetMesh { return muMesh{} }
	ca, cert, key := muTLS(t)
	input := managedDatabaseCommand{Type: "postgres", Image: newImg, StorageSizeBytes: 1 << 30, MemoryBytes: 512 << 20,
		OperationID: "op-update", OwnerUsername: "app_owner", OwnerPassword: "owner-password-0123456789", DatabaseName: "app",
		TLSEnabled: true, TLSCertificatePEM: cert, TLSPrivateKeyPEM: key, TLSCACertificatePEM: ca, TLSCertificateID: "leaf-1"}
	return &muFixture{m: m, docker: docker, lease: lease, members: members, input: input, oldImg: oldImg, newImg: newImg}
}

func (f *muFixture) update(t *testing.T, input managedDatabaseCommand) (string, error) {
	t.Helper()
	body, _ := json.Marshal(input)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return f.m.handle(ctx, "update", muDB, string(body))
}

func TestAMemberCopyIsRecreatedOnANewImageUnderTheHold(t *testing.T) {
	f := newMUFixture(t, "17", "17", "17")
	heldDuringCreate := ""
	f.docker.onCreate = func() { _, heldDuringCreate = f.lease.eligibility() }
	if _, err := f.update(t, f.input); err != nil {
		t.Fatalf("a copy's image update: %v", err)
	}
	log := f.docker.log()
	stop, rename, create, remove := indexOfCall(log, "stop old"), indexOfCall(log, "rename old"), indexOfCall(log, "create "), indexOfCall(log, "remove old")
	if stop < 0 || rename < stop || create < rename || remove < create {
		t.Fatalf("the copy's container is stopped, kept, recreated, then the old one removed: %v", log)
	}
	if indexOfCall(log, "start ") >= 0 {
		t.Fatalf("the member runtime starts the recreated copy, never the update: %v", log)
	}
	if heldDuringCreate != "held" {
		t.Fatalf("the member must be held (ineligible) while its container is replaced, got %q", heldDuringCreate)
	}
	created := f.docker.created[0]
	if managedDatabaseImageDigest(created.Image) != managedDatabaseImageDigest(f.newImg) {
		t.Fatalf("recreated on %s, want %s", created.Image, f.newImg)
	}
	if created.Labels[pgMemberLabel] != muMember || created.Labels["wiolett.gateway.availability.set"] != muSet {
		t.Fatalf("the recreated container keeps the member labels: %v", created.Labels)
	}
	if len(created.Networks) != 1 || created.Networks[0] != "gateway-set-test" || len(created.ExtraHosts) == 0 {
		t.Fatalf("the recreated container keeps the set network and mesh hosts: %+v", created)
	}
	record, err := f.m.loadRecord(muDB)
	if err != nil || record.ContainerID != "new0" || record.OperationID != "op-update" || record.AvailabilityMemberID != muMember {
		t.Fatalf("record after the recreate = %+v %v", record, err)
	}
	if ok, reason := f.lease.eligibility(); reason == "held" {
		t.Fatalf("the hold ends with the update (%v %s)", ok, reason)
	}
}

func TestTheMemberPrimaryRefusesARecreateButTakesLiveChanges(t *testing.T) {
	f := newMUFixture(t, "17", "17", "17")
	f.lease.role = memberha.RoleHolding
	_, err := f.update(t, f.input)
	if err == nil || !strings.Contains(err.Error(), memberha.SwitchoverRequiredCode) {
		t.Fatalf("the primary's image update must be refused with the switchover code, got %v", err)
	}
	if log := f.docker.log(); indexOfCall(log, "stop ") >= 0 || indexOfCall(log, "create ") >= 0 {
		t.Fatalf("a refused update touches nothing: %v", log)
	}
	// The same image with new limits applies live on the primary.
	live := f.input
	live.Image = f.oldImg
	live.MemoryBytes = 1 << 30
	if _, err := f.update(t, live); err != nil {
		t.Fatalf("a live change on the primary: %v", err)
	}
	if log := f.docker.log(); indexOfCall(log, "live_update old") < 0 || indexOfCall(log, "create ") >= 0 {
		t.Fatalf("limits apply live on the primary: %v", log)
	}
	// A moved published port is the member proxy's: live as well.
	moved := live
	moved.OperationID = "op-move"
	moved.PublishTCP, moved.PublishedPort = true, 25432
	if _, err := f.update(t, moved); err != nil {
		t.Fatalf("a publication change on the primary is live: %v", err)
	}
	if log := f.docker.log(); indexOfCall(log, "create ") >= 0 {
		t.Fatalf("publication never recreates a member: %v", log)
	}
}

func TestAPostgresMajorChangeIsRefused(t *testing.T) {
	f := newMUFixture(t, "16", "16", "17")
	_, err := f.update(t, f.input)
	if err == nil || !strings.Contains(err.Error(), postgresMajorChangeCode) {
		t.Fatalf("a major change of a member must be refused with %s, got %v", postgresMajorChangeCode, err)
	}
	if log := f.docker.log(); indexOfCall(log, "stop ") >= 0 || indexOfCall(log, "create ") >= 0 {
		t.Fatalf("a refused major change touches nothing: %v", log)
	}
	// A single-node database is refused the same way.
	record, _ := f.m.loadRecord(muDB)
	record.AvailabilitySetID, record.AvailabilityMemberID = "", ""
	if err := f.m.checkPostgresMajor(context.Background(), record, f.input); err == nil || !strings.Contains(err.Error(), postgresMajorChangeCode) {
		t.Fatalf("a single-node major change = %v", err)
	}
	if err := postgresMajorChange("17", "17"); err != nil {
		t.Fatal(err)
	}
	if err := postgresMajorChange("", "18"); err != nil {
		t.Fatal("a data directory not initialized yet has no major")
	}
}

func TestManagedDatabaseImageDigestComparesMirrorsAsTheSameImage(t *testing.T) {
	upstream, _ := muImages(t)
	mirror, ok := thirdPartyMirrorReference(upstream)
	if !ok {
		t.Skip("the curated image has no GHCR mirror")
	}
	if managedDatabaseImageDigest(upstream) != managedDatabaseImageDigest(mirror) {
		t.Fatal("a GHCR mirror of the same digest is the same image")
	}
	if managedDatabaseImageDigest(upstream) == managedDatabaseImageDigest("docker.io/library/postgres@sha256:"+strings.Repeat("b", 64)) {
		t.Fatal("another digest is another image")
	}
}

func indexOfCall(log []string, prefix string) int {
	for i, entry := range log {
		if strings.HasPrefix(entry, prefix) {
			return i
		}
	}
	return -1
}
