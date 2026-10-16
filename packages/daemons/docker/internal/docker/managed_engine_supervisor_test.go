package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// fakeEngineDocker is a Docker Engine API with engine containers that are
// running or stopped and have a restart policy. Starts and updates are
// written to the shared call log.
type fakeEngineDocker struct {
	t       *testing.T
	calls   *[]string
	running map[string]bool
	policy  map[string]string
	// users are the containers a container list returns.
	users []string
	// finishedAt is when a stopped container last exited, if set.
	finishedAt map[string]time.Time
	// oomKilled is Docker's State.OOMKilled of a container.
	oomKilled map[string]bool
}

func (d *fakeEngineDocker) client() *Client {
	d.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(d.serve)}))
	if err != nil {
		d.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (d *fakeEngineDocker) finished(id string) string {
	if at, ok := d.finishedAt[id]; ok {
		return at.Format(time.RFC3339Nano)
	}
	return "0001-01-01T00:00:00Z"
}

func (d *fakeEngineDocker) serve(request *http.Request) (*http.Response, error) {
	reply := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	match := fakeEngineContainerPath.FindStringSubmatch(request.URL.Path)
	if match == nil {
		d.t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
		return reply(http.StatusNotFound, `{"message":"not found"}`)
	}
	id, action := match[1], match[2]
	if id == "json" && request.Method == http.MethodGet {
		items := []map[string]string{}
		for _, user := range d.users {
			items = append(items, map[string]string{"Id": user})
		}
		raw, _ := json.Marshal(items)
		return reply(http.StatusOK, string(raw))
	}
	running, exists := d.running[id]
	if !exists {
		return reply(http.StatusNotFound, `{"message":"No such container: `+id+`"}`)
	}
	switch {
	case request.Method == http.MethodGet && action == "/json":
		raw, _ := json.Marshal(map[string]any{
			"Id":         id,
			"State":      map[string]any{"Running": running, "FinishedAt": d.finished(id), "OOMKilled": d.oomKilled[id]},
			"HostConfig": map[string]any{"RestartPolicy": map[string]any{"Name": d.policy[id]}},
		})
		return reply(http.StatusOK, string(raw))
	case request.Method == http.MethodPost && action == "/stop":
		*d.calls = append(*d.calls, "stop "+id)
		d.running[id] = false
		if d.finishedAt != nil {
			d.finishedAt[id] = time.Now()
		}
		return reply(http.StatusNoContent, "")
	case request.Method == http.MethodPost && action == "/start":
		*d.calls = append(*d.calls, "start "+id)
		d.running[id] = true
		return reply(http.StatusNoContent, "")
	case request.Method == http.MethodPost && action == "/update":
		var update container.UpdateConfig
		if err := json.NewDecoder(request.Body).Decode(&update); err != nil {
			d.t.Fatal(err)
		}
		*d.calls = append(*d.calls, "update "+id+" "+string(update.RestartPolicy.Name))
		d.policy[id] = string(update.RestartPolicy.Name)
		return reply(http.StatusOK, `{"Warnings":null}`)
	}
	d.t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
	return reply(http.StatusNotFound, `{"message":"not found"}`)
}

func TestStoppedEngineStartsOnlyAfterItsImageIsMounted(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{}, policy: map[string]string{}}
	m.client = docker.client()
	database := func(id, containerID string, desired bool) managedDatabaseRecord {
		record := saveTestDatabase(t, m, id)
		record.ContainerID, record.DesiredRunning = containerID, desired
		if err := m.saveRecord(record); err != nil {
			t.Fatal(err)
		}
		docker.running[containerID] = false
		return record
	}
	ctx := context.Background()

	record := database("db1", "c1", true)
	if err := m.startStoppedEngine(ctx, "db1", "c1"); err != nil {
		t.Fatal(err)
	}
	want := []string{"attach " + record.ImagePath, "mount /dev/loop100 " + record.MountPath, "start c1"}
	if !slices.Equal(loops.calls, want) {
		t.Fatalf("calls = %v, want the image mounted before the engine starts: %v", loops.calls, want)
	}

	// A running engine, a replaced container and a stopped database: nothing.
	loops.calls = nil
	database("db2", "c2", false)
	for _, event := range [][2]string{{"db1", "c1"}, {"db1", "c0"}, {"db2", "c2"}} {
		if err := m.startStoppedEngine(ctx, event[0], event[1]); err != nil {
			t.Fatal(err)
		}
	}
	if len(loops.calls) != 0 {
		t.Fatalf("calls = %v, want none", loops.calls)
	}

	// Without its image the engine is not started.
	database("db3", "c3", true)
	loops.attachErr = errNoFreeLoopDevice
	if err := m.startStoppedEngine(ctx, "db3", "c3"); err == nil || !strings.Contains(err.Error(), "no free loop device") {
		t.Fatalf("error = %v, want the mount failure", err)
	}
	if slices.Contains(loops.calls, "start c3") || docker.running["c3"] {
		t.Fatal("engine started without its image")
	}
}

func TestStoppedStorageEngineStartsOnlyAfterItsImageIsMounted(t *testing.T) {
	loops := newFakeLoops(t)
	root := t.TempDir()
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"s1": false, "s2": false}, policy: map[string]string{}}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client()}
	if err := os.MkdirAll(filepath.Join(root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	member := func(id, containerID string, removed bool) managedStorageRecord {
		record := managedStorageRecord{
			ID: id, ContainerID: containerID, DesiredRunning: true, Removed: removed,
			ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
			MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
		}
		writeFile(t, record.ImagePath)
		if err := m.saveRecord(record); err != nil {
			t.Fatal(err)
		}
		return record
	}
	running := member("11111111-1111-4111-8111-111111111111", "s1", false)
	member("22222222-2222-4222-8222-222222222222", "s2", true)

	for _, id := range []string{running.ID, "22222222-2222-4222-8222-222222222222"} {
		if err := m.startStoppedEngine(context.Background(), id, ""); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"attach " + running.ImagePath, "mount /dev/loop100 " + running.MountPath, "start s1"}
	if !slices.Equal(loops.calls, want) {
		t.Fatalf("calls = %v, want %v (and nothing for the removed member)", loops.calls, want)
	}
}

func TestEngineRestartPolicyIsTurnedOffForOlderContainers(t *testing.T) {
	var calls []string
	docker := &fakeEngineDocker{t: t, calls: &calls,
		running: map[string]bool{"old": true, "new": true},
		policy:  map[string]string{"old": "unless-stopped", "new": "no"}}
	cli := docker.client()
	for _, id := range []string{"old", "new", "gone"} {
		if err := ensureEngineRestartPolicy(context.Background(), cli, id); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(calls, []string{"update old no"}) {
		t.Fatalf("calls = %v, want only the older container switched to no", calls)
	}
	if engineRestartPolicy.Name != container.RestartPolicyDisabled {
		t.Fatalf("engine containers must not be started by Docker, policy %q", engineRestartPolicy.Name)
	}
}

func TestEngineRestartsBackOff(t *testing.T) {
	now := time.Unix(0, 0)
	var delays []time.Duration
	var queued []func()
	restarts := newEngineRestarts()
	restarts.now = func() time.Time { return now }
	restarts.after = func(d time.Duration, f func()) { delays = append(delays, d); queued = append(queued, f) }
	runs := 0
	stop := func() {
		restarts.schedule("database/db1", func() { runs++ })
		restarts.schedule("database/db1", func() { runs++ }) // one pending restart per engine
		queued[len(queued)-1]()
	}
	stop()
	stop()
	stop()
	now = now.Add(2 * engineRestartStableAfter) // ran long enough: start over
	stop()
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, time.Second}
	if !slices.Equal(delays, want) || runs != 4 {
		t.Fatalf("delays = %v, runs = %d; want %v and 4 runs", delays, runs, want)
	}
}

func TestVolumeFstabEntryMountsBeforeDockerAndReplacesOlderEntry(t *testing.T) {
	record := volumeImageRecord{Name: "data", ImagePath: "/var/lib/docker-daemon/volume-images/images/k.img", MountPath: "/var/lib/docker-daemon/volume-images/mounts/k"}
	other := volumeImageRecord{Name: "other", ImagePath: "/var/lib/docker-daemon/volume-images/images/o.img", MountPath: "/var/lib/docker-daemon/volume-images/mounts/o"}
	older := volumeImageFstabMarker(record) + "\n" + record.ImagePath + " " + record.MountPath + " ext4 loop,noatime,nodev,nosuid,nofail 0 0\n"
	fstab := "UUID=1 / ext4 defaults 0 1\n" + older + withFstabEntry("", other, false)

	updated := withFstabEntry(fstab, record, false)
	if strings.Count(updated, volumeImageFstabMarker(record)) != 1 || strings.Contains(updated, older) ||
		!strings.Contains(updated, "x-systemd.before=docker.service") || !strings.Contains(updated, withFstabEntry("", other, false)) {
		t.Fatalf("fstab after update:\n%s", updated)
	}
	if withFstabEntry(updated, record, false) != updated || withFstabEntry(updated, other, false) != updated {
		t.Fatal("a current entry must not be rewritten")
	}
	// A pre-Opfield entry stays until the start is confirmed, then turns into the current one.
	legacy := legacyVolumeImageFstabMarker(record) + "\n" + legacyVolumeImageFstabEntryLine(record) + "\n"
	legacyFstab := "UUID=1 / ext4 defaults 0 1\n" + legacy
	if withFstabEntry(legacyFstab, record, true) != legacyFstab {
		t.Fatal("a pre-Opfield entry was rewritten before the start was confirmed")
	}
	if converted := withFstabEntry(legacyFstab, record, false); strings.Contains(converted, "gateway-volume") ||
		strings.Count(converted, volumeImageFstabMarker(record)) != 1 || !strings.Contains(converted, "x-systemd.before="+volumeImageBootService+".service") {
		t.Fatalf("pre-Opfield entry after the confirmed start:\n%s", converted)
	}
	if removed := withoutFstabEntry(legacyFstab, record); strings.Contains(removed, record.ImagePath) {
		t.Fatalf("pre-Opfield entry not removed:\n%s", removed)
	}
	if removed := withoutFstabEntry(fstab, record); strings.Contains(removed, record.ImagePath) || !strings.Contains(removed, other.ImagePath) {
		t.Fatalf("fstab after removing the older entry:\n%s", removed)
	}
}
