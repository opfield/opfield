package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/client"
)

// fakeMoveDocker is a Docker Engine API with storage containers (by id, each
// with its image and name), the images the node has or can pull, and the
// storage network. Container changes are written to calls.
type fakeMoveDocker struct {
	t          *testing.T
	mu         sync.Mutex
	storageID  string
	containers map[string]*fakeMoveContainer
	images     *fakeImageStore
	created    int
	calls      []string
	// createTimesOut: a create makes the container but answers an error
	// (the command's context ran out while Docker created it).
	createTimesOut bool
}

type fakeMoveContainer struct {
	name, image string
	running     bool
	// owner overrides the storage label (another storage's container).
	owner string
}

func (d *fakeMoveDocker) client() *Client {
	d.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			path := strings.TrimPrefix(r.URL.Path, "/v1.47")
			if strings.HasPrefix(path, "/images/") {
				return d.images.serve(r)
			}
			return d.serve(r, path)
		})}))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (d *fakeMoveDocker) serve(r *http.Request, path string) (*http.Response, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	reply := func(status int, body any) (*http.Response, error) {
		raw, _ := json.Marshal(body)
		if status == http.StatusNoContent {
			raw = nil
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	}
	notFound := func() (*http.Response, error) {
		return reply(http.StatusNotFound, map[string]string{"message": "No such object"})
	}
	if strings.HasPrefix(path, "/networks/") && strings.HasSuffix(path, "/connect") && r.Method == http.MethodPost {
		return reply(http.StatusOK, nil)
	}
	if strings.HasPrefix(path, "/networks/") && r.Method == http.MethodGet {
		return reply(http.StatusOK, map[string]any{"Name": strings.TrimPrefix(path, "/networks/"), "Internal": true, "Labels": map[string]string{managedStorageLabel: d.storageID}})
	}
	if path == "/containers/create" && r.Method == http.MethodPost {
		var body struct {
			Image string `json:"Image"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			d.t.Error(err)
		}
		d.created++
		id := "new" + string(rune('0'+d.created))
		name := r.URL.Query().Get("name")
		for _, c := range d.containers {
			if c.name == name {
				return reply(http.StatusConflict, map[string]string{"message": "Conflict. The container name \"/" + name + "\" is already in use"})
			}
		}
		d.containers[id] = &fakeMoveContainer{name: name, image: body.Image}
		d.calls = append(d.calls, "create "+id+" "+body.Image)
		if d.createTimesOut {
			return reply(http.StatusInternalServerError, map[string]string{"message": "context deadline exceeded"})
		}
		return reply(http.StatusCreated, map[string]any{"Id": id, "Warnings": []string{}})
	}
	rest, ok := strings.CutPrefix(path, "/containers/")
	if !ok {
		d.t.Errorf("unexpected Docker request %s %s", r.Method, path)
		return notFound()
	}
	id, action, _ := strings.Cut(rest, "/")
	c := d.containers[id]
	if c == nil {
		// Docker finds a container by its name too.
		for other, candidate := range d.containers {
			if candidate.name == id {
				id, c = other, candidate
			}
		}
	}
	if c == nil {
		return notFound()
	}
	owner := d.storageID
	if c.owner != "" {
		owner = c.owner
	}
	switch {
	case r.Method == http.MethodGet && action == "json":
		return reply(http.StatusOK, map[string]any{
			"Id":         id,
			"Name":       "/" + c.name,
			"State":      map[string]any{"Running": c.running},
			"Config":     map[string]any{"Image": c.image, "Labels": map[string]string{managedStorageLabel: owner, managedStorageMemberLabel: "0"}},
			"HostConfig": map[string]any{},
			"NetworkSettings": map[string]any{"Networks": map[string]any{
				"gateway-storage-" + d.storageID: map[string]any{"IPAddress": "172.30.0.2"},
			}},
		})
	case r.Method == http.MethodPost && action == "stop":
		c.running = false
		d.calls = append(d.calls, "stop "+id)
		return reply(http.StatusNoContent, nil)
	case r.Method == http.MethodPost && action == "start":
		c.running = true
		d.calls = append(d.calls, "start "+id)
		return reply(http.StatusNoContent, nil)
	case r.Method == http.MethodPost && action == "rename":
		for other, candidate := range d.containers {
			if other != id && candidate.name == r.URL.Query().Get("name") {
				return reply(http.StatusConflict, map[string]string{"message": "name in use"})
			}
		}
		c.name = r.URL.Query().Get("name")
		d.calls = append(d.calls, "rename "+id+" "+c.name)
		return reply(http.StatusNoContent, nil)
	case r.Method == http.MethodDelete && action == "":
		delete(d.containers, id)
		d.calls = append(d.calls, "remove "+id)
		return reply(http.StatusNoContent, nil)
	}
	d.t.Errorf("unexpected Docker request %s %s", r.Method, path)
	return notFound()
}

func newMoveTest(t *testing.T, running string, local, pullable map[string]bool) (*managedStorageManager, *fakeMoveDocker, managedStorageRecord) {
	t.Helper()
	const id = "33333333-3333-4333-8333-333333333333"
	root := t.TempDir()
	store := &fakeImageStore{local: local, pullable: pullable}
	docker := &fakeMoveDocker{t: t, storageID: id, images: store, containers: map[string]*fakeMoveContainer{
		"old1": {name: "gateway-storage-" + id, image: running, running: true},
	}}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), client: docker.client(),
		chown:      func(string, int, int) error { return nil },
		probeReady: func(context.Context, managedStorageRecord) error { return nil },
	}
	if err := os.MkdirAll(filepath.Join(root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	record := managedStorageRecord{
		ID: id, Engine: managedStorageEngineSeaweedFS, ContainerID: "old1", ContainerName: "gateway-storage-" + id,
		NetworkName: "gateway-storage-" + id, Image: running, DesiredRunning: true, MemberCount: 1,
		MemoryBytes: 768 * mebibyte, StorageBytes: 4 * gibibyte,
		ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
		MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
	}
	if _, err := m.stageSeaweedFS(record, managedStorageCommand{RootCredentials: managedStorageRootCreds{AccessKey: "gateway-root", SecretKey: "secret-key-1"}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = removeStagingTree(m.seaweedfsStagingDir(record)) })
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return m, docker, record
}

// After a daemon update that pins another SeaweedFS image, the new process
// moves a running storage to it once (data kept) and the record, and so the
// detail Opfield reads, names the pinned image. A node that cannot pull the
// pinned image, and a storage already on it, are left alone.
func TestStorageMovesToThePinnedImageAtStart(t *testing.T) {
	ctx := context.Background()
	mirror, _ := thirdPartyMirrorReference(seaweedfsUpstreamImage)

	t.Run("outdated", func(t *testing.T) {
		m, docker, record := newMoveTest(t, mirror, map[string]bool{mirror: true}, map[string]bool{seaweedfsImage: true})
		m.moveStoragesToPinnedImage(ctx, []string{record.ID})
		saved, err := m.loadRecord(record.ID)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Image != seaweedfsImage || saved.ContainerID != "new1" {
			t.Fatalf("record after the move: image %s, container %s (calls %v)", saved.Image, saved.ContainerID, docker.calls)
		}
		if docker.containers["old1"] != nil || docker.containers["new1"].image != seaweedfsImage || docker.containers["new1"].name != record.ContainerName {
			t.Fatalf("containers after the move: %v (calls %v)", docker.containers, docker.calls)
		}
		detail, err := m.marshalManagedStorageDetail(ctx, saved, "ready")
		if err != nil || !strings.Contains(detail, `"image":"`+seaweedfsImage+`"`) {
			t.Fatalf("detail %s, %v", detail, err)
		}
		// Once: a second pass finds the storage current.
		calls := len(docker.calls)
		m.moveStoragesToPinnedImage(ctx, []string{record.ID})
		if docker.created != 1 || len(docker.calls) != calls {
			t.Fatalf("the storage was recreated again: %v", docker.calls)
		}
	})

	t.Run("pinned image not pullable", func(t *testing.T) {
		m, docker, record := newMoveTest(t, mirror, map[string]bool{mirror: true}, map[string]bool{})
		m.moveStoragesToPinnedImage(ctx, []string{record.ID})
		saved, _ := m.loadRecord(record.ID)
		if docker.created != 0 || len(docker.calls) != 0 || saved.Image != mirror || saved.ContainerID != "old1" {
			t.Fatalf("storage touched without the pinned image: %v, record %+v", docker.calls, saved)
		}
	})

	t.Run("current", func(t *testing.T) {
		m, docker, record := newMoveTest(t, seaweedfsImage, map[string]bool{seaweedfsImage: true}, map[string]bool{})
		m.moveStoragesToPinnedImage(ctx, []string{record.ID})
		if docker.created != 0 || len(docker.calls) != 0 || len(docker.images.pulls) != 0 {
			t.Fatalf("current storage touched: %v, pulls %v", docker.calls, docker.images.pulls)
		}
	})

	t.Run("stopped", func(t *testing.T) {
		m, docker, record := newMoveTest(t, mirror, map[string]bool{mirror: true, seaweedfsImage: true}, map[string]bool{})
		record.DesiredRunning = false
		if err := m.saveRecord(record); err != nil {
			t.Fatal(err)
		}
		m.moveStoragesToPinnedImage(ctx, []string{record.ID})
		if docker.created != 0 || len(docker.calls) != 0 {
			t.Fatalf("stopped storage recreated: %v", docker.calls)
		}
	})
}
