package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

type fakeHelper struct {
	labels   map[string]string
	status   string
	created  time.Time
	finished time.Time
}

// fakeHelperEngine answers container list (applying the label filter as Docker does), inspect and remove.
type fakeHelperEngine struct {
	t          *testing.T
	mu         sync.Mutex
	containers map[string]fakeHelper
	removed    []string
}

func (e *fakeHelperEngine) client() *Client {
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func labelFilterMatches(labels map[string]string, filter string) bool {
	key, value, hasValue := strings.Cut(filter, "=")
	actual, ok := labels[key]
	return ok && (!hasValue || actual == value)
}

func (e *fakeHelperEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && path == "/containers/json":
		var filters map[string]map[string]bool
		if raw := request.URL.Query().Get("filters"); raw != "" {
			if err := json.Unmarshal([]byte(raw), &filters); err != nil {
				e.t.Fatalf("filters %q: %v", raw, err)
			}
		}
		if len(filters["label"]) == 0 {
			e.t.Errorf("helper containers listed without a label filter")
		}
		var items []map[string]any
		for id, helper := range e.containers {
			matches := true
			for filter := range filters["label"] {
				matches = matches && labelFilterMatches(helper.labels, filter)
			}
			if matches {
				items = append(items, map[string]any{"Id": id, "Names": []string{"/" + id}, "Labels": helper.labels, "State": helper.status})
			}
		}
		body, _ := json.Marshal(items)
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
		helper, ok := e.containers[id]
		if !ok {
			return respond(http.StatusNotFound, `{"message":"No such container"}`)
		}
		finished := "0001-01-01T00:00:00Z"
		if !helper.finished.IsZero() {
			finished = helper.finished.Format(time.RFC3339Nano)
		}
		body, _ := json.Marshal(map[string]any{"Id": id, "Name": "/" + id, "Created": helper.created.Format(time.RFC3339Nano),
			"State":  map[string]any{"Status": helper.status, "FinishedAt": finished},
			"Config": map[string]any{"Labels": helper.labels}})
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
		id := strings.TrimPrefix(path, "/containers/")
		if request.URL.Query().Get("v") != "1" {
			e.t.Errorf("helper %s removed without its anonymous volumes", id)
		}
		delete(e.containers, id)
		e.removed = append(e.removed, id)
		return respond(http.StatusNoContent, "")
	}
	e.t.Errorf("unexpected request %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

func TestLeftoverHelperContainersAreRemovedOnlyWhenStale(t *testing.T) {
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	helper := map[string]string{helperContainerLabel: helperKindVolume}
	engine := &fakeHelperEngine{t: t, containers: map[string]fakeHelper{
		"exited-long-ago":     {labels: helper, status: "exited", created: now.Add(-2 * time.Hour), finished: now.Add(-20 * time.Minute)},
		"exited-just-now":     {labels: helper, status: "exited", created: now.Add(-3 * time.Hour), finished: now.Add(-2 * time.Minute)},
		"running":             {labels: helper, status: "running", created: now.Add(-5 * time.Hour)},
		"created-long-ago":    {labels: helper, status: "created", created: now.Add(-2 * time.Hour)},
		"created-just-now":    {labels: helper, status: "created", created: now.Add(-10 * time.Minute)},
		"old-compose-sidecar": {labels: map[string]string{"net.opfield.compose.sidecar": "true"}, status: "exited", created: now.Add(-time.Hour), finished: now.Add(-time.Hour)},
		"old-pg-helper":       {labels: map[string]string{pgHelperLabel: "1"}, status: "dead", created: now.Add(-time.Hour), finished: now.Add(-time.Hour)},
		"user-workload":       {labels: map[string]string{"app": "web"}, status: "exited", created: now.Add(-48 * time.Hour), finished: now.Add(-24 * time.Hour)},
		"user-labelled-other": {labels: map[string]string{"net.opfield.managed": "backup-runner"}, status: "exited", created: now.Add(-48 * time.Hour), finished: now.Add(-24 * time.Hour)},
	}}
	removed, err := engine.client().removeStaleHelperContainers(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	want := []string{"created-long-ago", "exited-long-ago", "old-compose-sidecar", "old-pg-helper"}
	if !slices.Equal(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, kept := range []string{"exited-just-now", "running", "created-just-now", "user-workload", "user-labelled-other"} {
		if _, ok := engine.containers[kept]; !ok {
			t.Errorf("%s was removed", kept)
		}
	}
}

func TestHelperLabelsKeepTheirOwnMarkers(t *testing.T) {
	labels := helperContainerLabels(helperKindPostgres, map[string]string{pgHelperLabel: "1"})
	if labels[helperContainerLabel] != helperKindPostgres || labels[pgHelperLabel] != "1" {
		t.Fatalf("labels = %v", labels)
	}
}

func writeAged(t *testing.T, path string, age time.Duration, now time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, now.Add(-age), now.Add(-age)); err != nil {
		t.Fatal(err)
	}
}

func TestEnvFilesOfRemovedContainersGoAndOthersStay(t *testing.T) {
	now := time.Now()
	dir := t.TempDir()
	store := NewEnvStore(dir)
	for name, age := range map[string]time.Duration{
		"stopped.env":         48 * time.Hour, // its container exists (stopped)
		"stopped.applied.env": 48 * time.Hour,
		"gone.env":            48 * time.Hour,
		"gone.applied.env":    48 * time.Hour,
		"gone-recently.env":   time.Hour,
		".gone.env.tmp-123":   48 * time.Hour, // an atomic-write temp: the temp sweep's
		"notes.txt":           48 * time.Hour,
	} {
		writeAged(t, filepath.Join(dir, name), age, now)
	}
	removed, err := store.RemoveOrphans(map[string]bool{"stopped": true}, envFileOrphanMinAge, now)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	if want := []string{"gone.applied.env", "gone.env"}; !slices.Equal(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, kept := range []string{"stopped.env", "stopped.applied.env", "gone-recently.env", ".gone.env.tmp-123", "notes.txt"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Errorf("%s: %v", kept, err)
		}
	}

	if err := store.Remove("stopped"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"stopped.env", "stopped.applied.env"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s stays after its container was removed", name)
		}
	}
	if err := store.Remove("../escape"); err != nil {
		t.Fatal(err)
	}
}

func TestStaleTempFilesAreSweptAtStart(t *testing.T) {
	now := time.Now()
	stateDir, tempDir := t.TempDir(), t.TempDir()
	removable := []string{
		filepath.Join(stateDir, ".state.json.tmp-123456"),
		filepath.Join(stateDir, "databases", "records", ".db1.json.tmp-42"),
		filepath.Join(stateDir, "availability.json.pending-4711"),
	}
	kept := []string{
		filepath.Join(stateDir, ".fresh.json.tmp-1"), // a write in progress
		filepath.Join(stateDir, "state.json"),
		filepath.Join(stateDir, "migrations", "m1", "image.tmp"),
		filepath.Join(stateDir, "notes.pending-x"),
	}
	for _, path := range removable {
		writeAged(t, path, 2*time.Hour, now)
	}
	for _, path := range kept {
		age := 2 * time.Hour
		if strings.Contains(path, "fresh") {
			age = time.Minute
		}
		writeAged(t, path, age, now)
	}
	for _, name := range []string{"opfield-compose-123", "opfield-runsc-install-456", "opfield-compose-789", "other-123"} {
		dir := filepath.Join(tempDir, name)
		writeAged(t, filepath.Join(dir, "compose.yaml"), 2*time.Hour, now)
		age := 2 * time.Hour
		if name == "opfield-compose-789" {
			age = time.Minute
		}
		if err := os.Chtimes(dir, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}

	removed := sweepStaleTempFiles(stateDir, tempDir, now)
	want := append(slices.Clone(removable), filepath.Join(tempDir, "opfield-compose-123"), filepath.Join(tempDir, "opfield-runsc-install-456"))
	slices.Sort(removed)
	slices.Sort(want)
	if !slices.Equal(removed, want) {
		t.Fatalf("removed %v, want %v", removed, want)
	}
	for _, path := range append(kept, filepath.Join(tempDir, "opfield-compose-789"), filepath.Join(tempDir, "other-123")) {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
}
