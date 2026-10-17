package docker

import (
	"context"
	"encoding/json"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

// fakeLabelledDocker is a Docker Engine API with labelled containers: it
// lists them by label filter, inspects, stops and removes them, removes
// networks, and writes stops and removals to the shared call log.
type fakeLabelledDocker struct {
	t          *testing.T
	calls      *[]string
	containers []fakeLabelledContainer
}

type fakeLabelledContainer struct {
	id, name string
	labels   map[string]string
	running  bool
}

func (d *fakeLabelledDocker) client() *Client {
	d.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(d.serve)}))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (d *fakeLabelledDocker) serve(request *http.Request) (*http.Response, error) {
	reply := func(code int, body any) (*http.Response, error) {
		raw, _ := json.Marshal(body)
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	}
	if network, ok := strings.CutPrefix(request.URL.Path, "/v1.47/networks/"); ok && request.Method == http.MethodDelete {
		*d.calls = append(*d.calls, "remove network "+network)
		return reply(http.StatusNoContent, nil)
	}
	match := fakeEngineContainerPath.FindStringSubmatch(request.URL.Path)
	if match == nil {
		d.t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
		return reply(http.StatusNotFound, map[string]string{"message": "not found"})
	}
	if match[1] == "json" && request.Method == http.MethodGet {
		var filters map[string]map[string]bool
		if raw := request.URL.Query().Get("filters"); raw != "" {
			if err := json.Unmarshal([]byte(raw), &filters); err != nil {
				d.t.Fatal(err)
			}
		}
		items := []map[string]any{}
		for _, candidate := range d.containers {
			if candidate.matches(filters["label"]) {
				items = append(items, map[string]any{"Id": candidate.id, "Names": []string{"/" + candidate.name}, "Labels": candidate.labels})
			}
		}
		return reply(http.StatusOK, items)
	}
	index := slices.IndexFunc(d.containers, func(candidate fakeLabelledContainer) bool { return candidate.id == match[1] })
	if index < 0 {
		return reply(http.StatusNotFound, map[string]string{"message": "No such container: " + match[1]})
	}
	target := &d.containers[index]
	switch {
	case request.Method == http.MethodGet && match[2] == "/json":
		return reply(http.StatusOK, map[string]any{"Id": target.id, "Name": "/" + target.name, "State": map[string]any{"Running": target.running}, "Config": map[string]any{"Labels": target.labels}})
	case request.Method == http.MethodPost && match[2] == "/stop":
		*d.calls = append(*d.calls, "stop "+target.id)
		target.running = false
		return reply(http.StatusNoContent, nil)
	case request.Method == http.MethodDelete && match[2] == "":
		*d.calls = append(*d.calls, "remove "+target.id)
		d.containers = slices.Delete(d.containers, index, index+1)
		return reply(http.StatusNoContent, nil)
	}
	d.t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
	return reply(http.StatusNotFound, map[string]string{"message": "not found"})
}

func (c fakeLabelledContainer) matches(labels map[string]bool) bool {
	for filter := range labels {
		key, value, withValue := strings.Cut(filter, "=")
		actual, ok := c.labels[key]
		if !ok || (withValue && actual != value) {
			return false
		}
	}
	return true
}

func inspectMissing(t *testing.T, handle func(context.Context, string, string, string) (string, error), id string) map[string]any {
	t.Helper()
	detail, err := handle(context.Background(), "inspect", id, "")
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(detail), &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed
}

// A database whose record the node lost reports what is left of it, and a
// retried create takes its storage image over as it is: it is never
// formatted, and without the image the create is refused.
func TestDatabaseCreateTakesOverStorageLeftWithoutItsRecord(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeLabelledDocker{t: t, calls: &loops.calls}
	m.client = docker.client()
	ctx := context.Background()

	if facts := inspectMissing(t, m.handle, "db1"); facts["status"] != "missing" || facts["container"] != false || facts["storageImage"] != false {
		t.Fatalf("inspect = %v, want nothing of the database left", facts)
	}

	image := filepath.Join(m.root, "images", "db1.img")
	if err := os.WriteFile(image, []byte("rows"), 0o600); err != nil {
		t.Fatal(err)
	}
	docker.containers = append(docker.containers,
		fakeLabelledContainer{id: "c1", name: "gwdb-db1", labels: map[string]string{managedDatabaseLabel: "db1"}, running: true},
		fakeLabelledContainer{id: "c9", name: "gwdb-other", labels: map[string]string{managedDatabaseLabel: "other"}, running: true})
	if facts := inspectMissing(t, m.handle, "db1"); facts["container"] != true || facts["storageImage"] != true {
		t.Fatalf("inspect = %v, want the container and the image reported", facts)
	}

	input := managedDatabaseCommand{
		Type: "postgres", OperationID: "op-retry",
		Image:            "docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a",
		StorageSizeBytes: minimumDatabaseBytes, OwnerUsername: "app_owner", DatabaseName: "app", OwnerPassword: strings.Repeat("p", 24),
	}
	loops.attachErr = errNoFreeLoopDevice
	if _, err := m.create(ctx, "db1", input); err == nil || !strings.Contains(err.Error(), "no free loop device") {
		t.Fatalf("create error = %v, want the mount of the existing image to fail", err)
	}
	if raw, _ := os.ReadFile(image); string(raw) != "rows" {
		t.Fatalf("image = %q, want it kept as it was", raw)
	}
	want := []string{"stop c1", "attach " + image}
	if !slices.Equal(loops.calls, want) {
		t.Fatalf("calls = %v, want the engine stopped, then its own image mounted: %v", loops.calls, want)
	}
	if exists(m.recordPath("db1")) {
		t.Fatal("record written for a take-over that failed")
	}

	if err := os.Remove(image); err != nil {
		t.Fatal(err)
	}
	loops.calls = nil
	if _, err := m.create(ctx, "db1", input); err == nil || !strings.Contains(err.Error(), "cannot be recovered") {
		t.Fatalf("create error = %v, want the lost data named", err)
	}
	if exists(image) || len(loops.calls) != 0 {
		t.Fatalf("create without the image allocated storage: calls %v", loops.calls)
	}
}

// A storage member whose container outlived its record keeps its image
// through the repair pass, reports it, and a retried create takes it over
// instead of formatting it.
func TestStorageMemberLeftWithoutItsRecordKeepsItsImage(t *testing.T) {
	loops := newFakeLoops(t)
	root := t.TempDir()
	for _, dir := range []string{"storage/images", "storage/mounts", "storage/records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	docker := &fakeLabelledDocker{t: t, calls: &loops.calls}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client()}
	const kept, orphan = "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"
	keptImage := filepath.Join(root, "storage", "images", kept+"-0.img")
	keptMount := filepath.Join(root, "storage", "mounts", kept+"-0")
	if err := os.MkdirAll(filepath.Dir(keptImage), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keptImage, []byte("objects"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(keptMount, 0o700); err != nil {
		t.Fatal(err)
	}
	loops.attach("/dev/loop1", "7:1", keptImage)
	loops.mount("7:1", keptMount)
	orphanImage := filepath.Join(root, "storage", "images", orphan+"-0.img")
	writeFile(t, orphanImage)
	docker.containers = append(docker.containers, fakeLabelledContainer{
		id: "s1", name: legacycompat.StorageLinkNetworkPrefix + kept + "-0", running: true,
		labels: map[string]string{managedStorageLabel: kept, managedStorageMemberLabel: "0"},
	})

	m.repairLoopImages(context.Background())

	if !exists(keptImage) || !loops.bound("/dev/loop1") {
		t.Fatal("repair released the storage of a member whose container is still on the node")
	}
	if exists(orphanImage) {
		t.Fatal("repair kept an image no member owns")
	}
	if facts := inspectMissing(t, m.handle, kept); facts["status"] != "missing" || facts["container"] != true || facts["storageImage"] != true {
		t.Fatalf("inspect = %v, want the container and the image reported", facts)
	}
	if facts := inspectMissing(t, m.handle, orphan); facts["container"] != false || facts["storageImage"] != false {
		t.Fatalf("inspect = %v, want nothing of the cluster left", facts)
	}

	input := managedStorageCommand{
		Engine: managedStorageEngineSeaweedFS, OperationID: "op-retry", MemberIndex: 0,
		Resources: managedStorageResources{StorageBytes: minimumStorageBytes},
	}
	// The node restarted since: nothing is mounted.
	loops.mounts, loops.loops, loops.calls = nil, nil, nil
	loops.attachErr = errNoFreeLoopDevice
	if _, err := m.create(context.Background(), kept, input); err == nil || !strings.Contains(err.Error(), "no free loop device") {
		t.Fatalf("create error = %v, want the mount of the existing image to fail", err)
	}
	if raw, _ := os.ReadFile(keptImage); string(raw) != "objects" {
		t.Fatalf("image = %q, want it kept as it was", raw)
	}
	want := []string{"stop s1", "attach " + keptImage}
	if !slices.Equal(loops.calls, want) || exists(m.recordPath(kept)) {
		t.Fatalf("calls = %v, want the engine stopped, then its own image mounted (%v), and no record", loops.calls, want)
	}
}

// Deleting a database whose record the node lost removes what is left of it:
// its containers (the instance's and one a replacement left), its network,
// mount, loop device and image. Another database's container stays, and a
// repeated delete finds nothing left.
func TestDatabaseDeleteRemovesWhatIsLeftWithoutItsRecord(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeLabelledDocker{t: t, calls: &loops.calls}
	m.client = docker.client()
	image := filepath.Join(m.root, "images", "db1.img")
	mount := filepath.Join(m.root, "mounts", "db1")
	writeFile(t, image)
	if err := os.MkdirAll(mount, 0o700); err != nil {
		t.Fatal(err)
	}
	loops.attach("/dev/loop5", "7:5", image)
	loops.mount("7:5", mount)
	docker.containers = append(docker.containers,
		fakeLabelledContainer{id: "c1", name: "gwdb-db1", labels: map[string]string{managedDatabaseLabel: "db1"}},
		fakeLabelledContainer{id: "c2", name: "gwdb-db1-rollback", labels: map[string]string{managedDatabaseLabel: "db1"}},
		fakeLabelledContainer{id: "c9", name: "gwdb-other", labels: map[string]string{managedDatabaseLabel: "other"}, running: true})

	for attempt := range 2 {
		detail, err := m.handle(context.Background(), "remove", "db1", `{"operationId":"op-delete"}`)
		if err != nil || detail != `{"status":"deleted"}` {
			t.Fatalf("remove %d = %q, %v; want deleted", attempt, detail, err)
		}
	}
	for _, want := range []string{"remove c1", "remove c2", "remove network gwdb-db1-net", "detach /dev/loop5"} {
		if !slices.Contains(loops.calls, want) {
			t.Fatalf("calls = %v, want %q", loops.calls, want)
		}
	}
	if len(docker.containers) != 1 || docker.containers[0].id != "c9" {
		t.Fatalf("containers left = %v, want only the other database's", docker.containers)
	}
	if exists(image) || exists(mount) || loops.bound("/dev/loop5") {
		t.Fatal("the image, mount point or loop device of the deleted database is left")
	}
}

// Removing a storage member whose record the node lost removes its container
// and network and releases its loop device; with deleteData its image goes
// too, without it the image stays under a removed record that the repair
// pass keeps.
func TestStorageRemovalRemovesWhatIsLeftWithoutItsRecord(t *testing.T) {
	const id = "44444444-4444-4444-8444-444444444444"
	for _, tc := range []struct {
		action    string
		imageKept bool
	}{{action: "delete_data"}, {action: "remove", imageKept: true}} {
		t.Run(tc.action, func(t *testing.T) {
			loops := newFakeLoops(t)
			root := t.TempDir()
			for _, dir := range []string{"storage/images", "storage/mounts", "storage/records"} {
				if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			docker := &fakeLabelledDocker{t: t, calls: &loops.calls}
			m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client()}
			image := filepath.Join(root, "storage", "images", id+"-0.img")
			mount := filepath.Join(root, "storage", "mounts", id+"-0")
			writeFile(t, image)
			if err := os.MkdirAll(mount, 0o700); err != nil {
				t.Fatal(err)
			}
			loops.attach("/dev/loop4", "7:4", image)
			loops.mount("7:4", mount)
			docker.containers = append(docker.containers, fakeLabelledContainer{
				id: "s1", name: legacycompat.StorageLinkNetworkPrefix + id + "-0",
				labels: map[string]string{managedStorageLabel: id, managedStorageMemberLabel: "0"},
			})

			if _, err := m.handle(context.Background(), tc.action, id, ""); err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"remove s1", "remove network " + legacycompat.StorageLinkNetworkPrefix + id, "detach /dev/loop4"} {
				if !slices.Contains(loops.calls, want) {
					t.Fatalf("calls = %v, want %q", loops.calls, want)
				}
			}
			if len(docker.containers) != 0 || exists(mount) || loops.bound("/dev/loop4") {
				t.Fatal("the container, mount point or loop device of the removed member is left")
			}
			if exists(image) != tc.imageKept {
				t.Fatalf("image kept = %v, want %v", exists(image), tc.imageKept)
			}
			m.repairLoopImages(context.Background())
			if exists(image) != tc.imageKept {
				t.Fatalf("image kept after repair = %v, want %v", exists(image), tc.imageKept)
			}
		})
	}
}
