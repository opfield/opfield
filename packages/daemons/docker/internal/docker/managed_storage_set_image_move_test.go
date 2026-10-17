package docker

import (
	"context"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/swha"
)

// SeaweedFS set members on a newly pinned image (P3-T07): imageMove is
// reported while a container runs another image; the imageMove update
// recreates a copy on the pinned image under the hold and refuses the primary.

const swStorage = "44444444-4444-4444-8444-444444444444"

type swMoveFixture struct {
	m       *managedStorageManager
	docker  *muDocker
	lease   *muLease
	members *memberha.Manager
	plugin  *DockerPlugin
	record  managedStorageRecord
}

func newSWMoveFixture(t *testing.T, running string, withMaster bool) *swMoveFixture {
	t.Helper()
	docker := &muDocker{t: t, images: map[string]string{}, running: map[string]bool{}, labels: map[string]map[string]string{},
		majors: map[string]string{managedDatabaseImageDigest(seaweedfsImage): "present"}}
	root := t.TempDir()
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: muPlainLoops(), client: docker.client()}
	record := managedStorageRecord{ID: swStorage, Image: running, ImagePath: filepath.Join(root, "images", swStorage+".img"),
		MountPath: filepath.Join(root, "mounts", swStorage), NetworkName: legacycompat.StorageLinkNetworkPrefix + swStorage, OperationID: "op-before",
		StorageBytes: 1 << 30, MemoryBytes: 512 << 20,
		Set: &managedStorageSetRecord{SetID: muSet, MemberID: muMember, MemberIndex: 0}}
	for _, dir := range []string{filepath.Dir(record.ImagePath), record.MountPath, m.seaweedfsStagingDir(record), m.seaweedfsSetDir(swStorage, 0)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(record.ImagePath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.seaweedfsSetDir(swStorage, 0), seaweedfsSetHostsFile), []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, role := range seaweedfsSetRoles {
		if role == swha.RoleMaster && !withMaster {
			continue
		}
		name := seaweedfsSetContainerName(legacyManagedStorageNamePrefix, swStorage, 0, role)
		docker.images[name] = running
		docker.labels[name] = map[string]string{managedStorageLabel: swStorage}
		docker.running[name] = role != swha.RoleMaster
	}
	lease := &muLease{}
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	members, err := memberha.NewManager(memberha.Deps{
		Lease: lease, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: bootWallClock{},
		Engine: func(memberha.Config) (memberha.Engine, error) { return muEngine{}, nil },
		Async:  func(func()) {},
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := members.Configure(memberha.Config{SetID: muSet, MemberID: muMember, NodeID: "node-a", Engine: managedStorageEngineSeaweedFS,
		OwnerKind: "managed_storage", OwnerID: swStorage, Mode: memberha.ModeAutomatic, LeasePolicyID: muPolicy, ConfigRevision: 1,
		Members: []memberha.Peer{{MemberID: muMember, NodeID: "node-a"}, {MemberID: muPeer, NodeID: "node-b", MemberIndex: 1}}}); err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{setMembers: members, storageManager: m}
	m.plugin = plugin
	return &swMoveFixture{m: m, docker: docker, lease: lease, members: members, plugin: plugin, record: record}
}

func (f *swMoveFixture) move(t *testing.T) (managedStorageRecord, error) {
	t.Helper()
	record := f.record
	input := managedStorageCommand{OperationID: "op-move", Set: &managedStorageSetCommand{SetID: muSet, MemberID: muMember, MemberIndex: 0,
		ImageMove: true, Members: []managedStorageSetMember{{MemberID: muMember}, {MemberID: muPeer, MemberIndex: 1}}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := f.m.updateSetMember(ctx, &record, input)
	return record, err
}

func TestASeaweedFSCopyMovesToThePinnedImageUnderTheHold(t *testing.T) {
	if seaweedfsImageCurrent(seaweedfsUpstreamImage, seaweedfsImage) {
		t.Skip("the upstream image is the pinned one")
	}
	f := newSWMoveFixture(t, seaweedfsUpstreamImage, true)
	held := ""
	f.docker.onCreate = func() { _, held = f.lease.eligibility() }
	record, err := f.move(t)
	if err != nil {
		t.Fatalf("a copy's image move: %v", err)
	}
	log := f.docker.log()
	for _, role := range seaweedfsSetRoles {
		name := seaweedfsSetContainerName(legacyManagedStorageNamePrefix, swStorage, 0, role)
		stop, rename, remove := indexOfCall(log, "stop "+name), indexOfCall(log, "rename "+name), indexOfCall(log, "remove "+name+"-rollback")
		if stop < 0 || rename < stop || remove < rename {
			t.Fatalf("%s is stopped, kept for a rollback and removed after the new one: %v", role, log)
		}
	}
	if len(f.docker.created) != 3 || indexOfCall(log, "start ") >= 0 {
		t.Fatalf("three containers are created and none started (the member runtime starts the copy): %v", log)
	}
	for _, created := range f.docker.created {
		if created.Image != seaweedfsImage {
			t.Fatalf("recreated on %s, want the pinned image", created.Image)
		}
	}
	if held != "held" {
		t.Fatalf("the member must be held while its containers are replaced, got %q", held)
	}
	if record.Image != seaweedfsImage || record.OperationID != "op-move" || record.ContainerID == "" {
		t.Fatalf("record after the move = %+v", record)
	}
}

func TestASeaweedFSMoveCreatesTheMasterOnlyWhereItExisted(t *testing.T) {
	if seaweedfsImageCurrent(seaweedfsUpstreamImage, seaweedfsImage) {
		t.Skip("the upstream image is the pinned one")
	}
	f := newSWMoveFixture(t, seaweedfsUpstreamImage, false)
	if _, err := f.move(t); err != nil {
		t.Fatal(err)
	}
	for _, created := range f.docker.created {
		if created.Labels[managedStorageRoleLabel] == string(swha.RoleMaster) {
			t.Fatal("no master is created where none existed")
		}
	}
	if len(f.docker.created) != 2 {
		t.Fatalf("created %d containers, want the volume server and the filer", len(f.docker.created))
	}
}

func TestTheSeaweedFSPrimaryRefusesTheImageMove(t *testing.T) {
	if seaweedfsImageCurrent(seaweedfsUpstreamImage, seaweedfsImage) {
		t.Skip("the upstream image is the pinned one")
	}
	f := newSWMoveFixture(t, seaweedfsUpstreamImage, true)
	f.lease.role = memberha.RoleHolding
	_, err := f.move(t)
	if err == nil || !strings.HasPrefix(err.Error(), memberha.SwitchoverRequiredCode) {
		t.Fatalf("the primary's image move = %v, want %s", err, memberha.SwitchoverRequiredCode)
	}
	if log := f.docker.log(); indexOfCall(log, "stop ") >= 0 || indexOfCall(log, "rename ") >= 0 || len(f.docker.created) > 0 {
		t.Fatalf("a refused move touches nothing: %v", log)
	}
}

func TestASeaweedFSMemberOnThePinnedImageAnswersReady(t *testing.T) {
	f := newSWMoveFixture(t, seaweedfsImage, true)
	f.lease.role = memberha.RoleHolding // even the primary: nothing to move
	record, err := f.move(t)
	if err != nil || record.OperationID != "op-move" {
		t.Fatalf("a member already on the pinned image = %+v %v", record, err)
	}
	if log := f.docker.log(); indexOfCall(log, "stop ") >= 0 || len(f.docker.created) > 0 {
		t.Fatalf("nothing is recreated: %v", log)
	}
}

func TestTheSeaweedFSMemberReportsAPendingImageMove(t *testing.T) {
	f := newSWMoveFixture(t, seaweedfsImage, true)
	report := func() *pb.AvailabilityMemberReport {
		reports := f.plugin.availabilityMemberReports()
		if len(reports) != 1 {
			t.Fatalf("reports = %v", reports)
		}
		return reports[0]
	}
	f.m.setImages.observe(muSet, swha.RoleVolume, seaweedfsImage, true)
	f.m.setImages.observe(muSet, swha.RoleMaster, seaweedfsImage, true)
	if _, ok := report().GetPosition()[setImageMovePosition]; ok {
		t.Fatal("no imageMove while every container runs the pinned image")
	}
	if seaweedfsImageCurrent(seaweedfsUpstreamImage, seaweedfsImage) {
		return
	}
	f.m.setImages.observe(muSet, swha.RoleFiler, seaweedfsUpstreamImage, true)
	if got := report().GetPosition()[setImageMovePosition]; got != "pending" {
		t.Fatalf("imageMove = %q, want pending", got)
	}
	f.m.setImages.observe(muSet, swha.RoleFiler, "", false)
	if _, ok := report().GetPosition()[setImageMovePosition]; ok {
		t.Fatal("a removed container no longer counts")
	}
}
