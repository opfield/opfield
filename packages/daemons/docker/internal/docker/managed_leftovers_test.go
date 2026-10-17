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

// leftoverDocker is a Docker API with containers labelled as managed instances.
type leftoverDocker struct {
	t          *testing.T
	containers []map[string]any
	removed    []string
}

func (d *leftoverDocker) client() *Client {
	d.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			reply := func(code int, body string) (*http.Response, error) {
				return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			}
			path := request.URL.Path
			switch {
			case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/json"):
				filters := request.URL.Query().Get("filters")
				var items []map[string]any
				for _, item := range d.containers {
					labels := item["Labels"].(map[string]string)
					keep := true
					for key, value := range labels {
						if strings.Contains(filters, key+"=") && !strings.Contains(filters, key+"="+value) {
							keep = false
						}
					}
					if keep {
						items = append(items, item)
					}
				}
				raw, _ := json.Marshal(items)
				return reply(http.StatusOK, string(raw))
			case request.Method == http.MethodDelete && strings.Contains(path, "/containers/"):
				d.removed = append(d.removed, path[strings.LastIndex(path, "/")+1:])
				return reply(http.StatusNoContent, "")
			case request.Method == http.MethodDelete && strings.Contains(path, "/networks/"):
				return reply(http.StatusNotFound, `{"message":"network not found"}`)
			}
			d.t.Errorf("unexpected Docker request %s %s", request.Method, path)
			return reply(http.StatusNotFound, `{"message":"not found"}`)
		})}))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

const (
	zeroedStorageID = "05d710cc-c9a3-4ef4-9b19-bd50e881d0cf"
	deletedStorage  = "334c92c4-b058-4d74-94bb-40578d47404e"
	liveStorageID   = "a9704943-6982-4320-812f-ac0c6d86cffe"
)

// The stand after rc.8 (O-5): a record zeroed by a crash with its image and
// mount point, and an exited container of a storage whose delete an older
// daemon processed. Both are listed with what they hold; a live storage is not.
func TestStorageLeftoversAreListedAndRemovedOnlyWhenOpfieldConfirms(t *testing.T) {
	m, _, loops, _ := newTestStorageEngine(t)
	docker := &leftoverDocker{t: t, containers: []map[string]any{
		{"Id": "c-left", "Names": []string{"/" + legacycompat.StorageLinkNetworkPrefix + deletedStorage + "-0"},
			"Labels": map[string]string{managedStorageLabel: deletedStorage, managedStorageMemberLabel: "0"}},
		{"Id": "c-live", "Names": []string{"/" + legacycompat.StorageLinkNetworkPrefix + liveStorageID + "-0"},
			"Labels": map[string]string{managedStorageLabel: liveStorageID, managedStorageMemberLabel: "0"}},
	}}
	m.client = docker.client()
	_ = loops
	if err := m.saveRecord(managedStorageRecord{ID: liveStorageID, ContainerID: "c-live",
		ImagePath: filepath.Join(m.root, "storage", "images", liveStorageID+"-0.img"),
		MountPath: filepath.Join(m.root, "storage", "mounts", liveStorageID+"-0")}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.recordPath(zeroedStorageID), make([]byte, 932), 0o600); err != nil {
		t.Fatal(err)
	}
	zeroedImage := filepath.Join(m.root, "storage", "images", zeroedStorageID+"-0.img")
	sparseImage(t, zeroedImage, 2*testGiB)
	if err := os.MkdirAll(filepath.Join(m.root, "storage", "mounts", zeroedStorageID+"-0"), 0o700); err != nil {
		t.Fatal(err)
	}

	detail, err := m.handle(context.Background(), "leftovers", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Items []managedLeftover `json:"items"`
	}
	if err := json.Unmarshal([]byte(detail), &listed); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, item := range listed.Items {
		ids = append(ids, item.ID)
	}
	if !slices.Equal(ids, []string{zeroedStorageID, deletedStorage}) {
		t.Fatalf("leftovers %s", detail)
	}
	if zeroed := listed.Items[0]; zeroed.Record != "unreadable" || zeroed.ImageBytes != 2*testGiB || zeroed.AllocatedBytes != allocatedBytes(t, zeroedImage) {
		t.Fatalf("zeroed record leftover %+v", zeroed)
	}
	if deleted := listed.Items[1]; deleted.Record != "missing" || !slices.Equal(deleted.Containers, []string{legacycompat.StorageLinkNetworkPrefix + deletedStorage + "-0"}) {
		t.Fatalf("container leftover %+v", deleted)
	}

	// A plain remove of the zeroed record is refused as before; one Opfield marks as a leftover removes it.
	if _, err := m.handle(context.Background(), "remove", zeroedStorageID, ""); err == nil {
		t.Fatal("a remove without confirmation removed an unreadable record")
	}
	for _, id := range []string{zeroedStorageID, deletedStorage} {
		if _, err := m.handle(context.Background(), "remove", id, `{"leftover":true}`); err != nil {
			t.Fatalf("remove leftover %s: %v", id, err)
		}
	}
	for _, path := range []string{
		m.recordPath(zeroedStorageID),
		filepath.Join(m.root, "storage", "images", zeroedStorageID+"-0.img"),
		filepath.Join(m.root, "storage", "mounts", zeroedStorageID+"-0"),
	} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s is still there (%v)", path, err)
		}
	}
	if !slices.Contains(docker.removed, "c-left") || slices.Contains(docker.removed, "c-live") {
		t.Fatalf("removed containers %v", docker.removed)
	}
	// An instance with a readable record is never removed as a leftover.
	if _, err := m.handle(context.Background(), "remove", liveStorageID, `{"leftover":true}`); err == nil || !strings.Contains(err.Error(), "not a leftover") {
		t.Fatalf("leftover remove of a live storage: %v", err)
	}
	if _, err := m.loadRecord(liveStorageID); err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseLeftoversAreListedAndRemoved(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	const zeroed = "11111111-2222-4333-8444-555555555555"
	docker := &leftoverDocker{t: t}
	m.client = docker.client()
	m.logger = slog.New(slog.DiscardHandler)
	if err := os.WriteFile(m.recordPath(zeroed), make([]byte, 512), 0o600); err != nil {
		t.Fatal(err)
	}
	sparseImage(t, filepath.Join(m.root, "images", zeroed+".img"), testGiB)
	live := saveTestDatabase(t, m, "22222222-3333-4444-8555-666666666666")

	detail, err := m.handle(context.Background(), "leftovers", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, zeroed) || strings.Contains(detail, live.ID) || !strings.Contains(detail, `"record":"unreadable"`) {
		t.Fatalf("leftovers %s", detail)
	}
	if _, err := m.handle(context.Background(), "remove", zeroed, `{"leftover":true}`); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.recordPath(zeroed)); !os.IsNotExist(err) {
		t.Fatal("the zeroed record is still there")
	}
	if _, err := os.Stat(filepath.Join(m.root, "images", zeroed+".img")); !os.IsNotExist(err) {
		t.Fatal("the zeroed record's image is still there")
	}
	if _, err := m.handle(context.Background(), "remove", live.ID, `{"leftover":true}`); err == nil {
		t.Fatal("a database with a record was removed as a leftover")
	}
}
