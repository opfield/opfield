package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

// labelledDockerEngine is fakeDockerEngine behind the daemon's label transport,
// as the daemon's own Docker client is.
func labelledDockerEngine(t *testing.T, confirmed bool, serve func(request *http.Request, path string) (int, string)) *Client {
	t.Helper()
	base := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		path, _ := url.PathUnescape(request.URL.Path)
		code, body := serve(request, path)
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})
	transport := &labelTransport{base: base, confirmed: func() bool { return confirmed }}
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: transport}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

func migrationInspect(id, imageID string, labels map[string]string) string {
	data, _ := json.Marshal(map[string]any{
		"Id": id, "Name": "/app", "Image": imageID,
		"Config":          map[string]any{"Image": "registry.test/app:1", "Labels": labels},
		"HostConfig":      map[string]any{"NetworkMode": "bridge"},
		"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]any{}}},
	})
	return string(data)
}

// A container imported from an archive and migrated once under 2.12.0 carries
// pre-2.12.1 labels, among them the archive image reference and the
// old migration id. Its manifest names every label by its Opfield key, so the
// target, which is created with Opfield keys, captures the same manifest:
// before and after its start is confirmed.
func TestMigrationManifestOfPreOpfieldLabelsMatchesTheTarget(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	sourceLabels := map[string]string{
		"wiolett.gateway.archive.image.reference": "registry.test/app:1",
		"wiolett.gateway.migration.id":            "migration-under-2.12.0",
		"wiolett.gateway.managed":                 "true",
		"wiolett.gateway.availability.policy":     "p1",
		"com.wiolett.gateway.managed-volume":      "true",
		"org.example.team":                        "blue",
	}
	imageJSON := `{"Id":"` + imageID + `","Config":{"Env":[]}}`
	source := labelledDockerEngine(t, true, func(request *http.Request, path string) (int, string) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
			return http.StatusOK, migrationInspect(strings.Repeat("b", 64), imageID, sourceLabels)
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/images/"+imageID+"/json"):
			return http.StatusOK, imageJSON
		}
		t.Errorf("unexpected source request %s %s", request.Method, path)
		return http.StatusInternalServerError, `{"message":"unexpected"}`
	})
	captured, err := source.CaptureMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	wantLabels := map[string]string{
		"net.opfield.managed":             "true",
		"net.opfield.availability.policy": "p1",
		"net.opfield.managed-volume":      "true",
		"org.example.team":                "blue",
	}
	if !reflect.DeepEqual(captured.Config.Labels, wantLabels) {
		t.Fatalf("source manifest labels %v, want %v", captured.Config.Labels, wantLabels)
	}
	if captured.ImageReference != "registry.test/app:1" {
		t.Fatalf("image reference %q", captured.ImageReference)
	}
	sourceJSON, _ := json.Marshal(captured)

	for _, confirmed := range []bool{true, false} {
		var manifest dockerMigrationManifest
		_ = json.Unmarshal(sourceJSON, &manifest)
		var created map[string]string
		target := labelledDockerEngine(t, confirmed, func(request *http.Request, path string) (int, string) {
			switch {
			case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
				if created == nil {
					return http.StatusNotFound, `{"message":"No such container: app"}`
				}
				return http.StatusOK, migrationInspect(strings.Repeat("c", 64), imageID, created)
			case request.Method == http.MethodPost && strings.HasSuffix(path, "/containers/create"):
				var body struct{ Labels map[string]string }
				_ = json.NewDecoder(request.Body).Decode(&body)
				created = body.Labels
				return http.StatusCreated, `{"Id":"target","Warnings":[]}`
			case request.Method == http.MethodGet && strings.HasSuffix(path, "/images/"+imageID+"/json"):
				return http.StatusOK, imageJSON
			}
			t.Errorf("unexpected target request %s %s", request.Method, path)
			return http.StatusInternalServerError, `{"message":"unexpected"}`
		})
		if _, err := target.CreateContainerStopped(context.Background(), createStoppedContainerRequest{
			MigrationID: "migration-2", Manifest: manifest,
		}); err != nil {
			t.Fatal(err)
		}
		if created[migrationOwnershipLabel] != "migration-2" || created[archiveImageReferenceLabel] != "registry.test/app:1" {
			t.Fatalf("confirmed=%v created labels %v", confirmed, created)
		}
		if _, ok := created["wiolett.gateway.migration.id"]; ok && created["wiolett.gateway.migration.id"] != "migration-2" {
			t.Fatalf("confirmed=%v the old migration id key keeps the 2.12.0 migration: %v", confirmed, created)
		}
		// A retry of the same migration finds its own target.
		if id, err := target.CreateContainerStopped(context.Background(), createStoppedContainerRequest{
			MigrationID: "migration-2", Manifest: manifest,
		}); err != nil || id != strings.Repeat("c", 64) {
			t.Fatalf("confirmed=%v retry = %q, %v", confirmed, id, err)
		}
		targetManifest, err := target.CaptureMigrationManifest(context.Background(), "app")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(targetManifest.Config, captured.Config) || targetManifest.ImageReference != captured.ImageReference {
			t.Fatalf("confirmed=%v target manifest config %+v / %q, source %+v / %q", confirmed,
				targetManifest.Config.Labels, targetManifest.ImageReference, captured.Config.Labels, captured.ImageReference)
		}
	}
}

// A create before the start is confirmed writes the old keys for a daemon the
// launcher may roll back to; an old key gets the value of its Opfield key, the
// one the daemon changed.
func TestUnconfirmedCreateWritesTheCurrentValueUnderTheOldKey(t *testing.T) {
	labels := labelsForCreate(map[string]string{
		archiveImageReferenceLabel:                "registry.test/app:2",
		"wiolett.gateway.archive.image.reference": "registry.test/app:1",
	}, false)
	if labels["wiolett.gateway.archive.image.reference"] != "registry.test/app:2" || labels[archiveImageReferenceLabel] != "registry.test/app:2" {
		t.Fatalf("labels %v", labels)
	}
}
