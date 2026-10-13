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

func fakeDockerEngine(t *testing.T, serve func(request *http.Request, path string) (int, string)) *Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			path, _ := url.PathUnescape(request.URL.Path)
			code, body := serve(request, path)
			return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
				Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
		})}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

// The manifest names the container's own environment: an image variable the
// container runs unchanged (PATH, PODINFO_PORT) is left to the image, which the
// target runs too; a variable the container overrides (LANG) and its own
// variables are named. Opfield supplies exactly those values, and the target
// is created with them alone, so Docker adds the image defaults again.
func TestMigrationManifestNamesOwnEnvironmentAndTargetAcceptsIt(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	source := fakeDockerEngine(t, func(request *http.Request, path string) (int, string) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
			inspect, _ := json.Marshal(map[string]any{
				"Id": strings.Repeat("b", 64), "Name": "/app", "Image": imageID,
				"Config": map[string]any{"Image": "podinfo:6", "Env": []string{
					"PATH=/usr/local/sbin:/usr/bin", "LANG=en_US.UTF-8", "PODINFO_PORT=9898", "PODINFO_UI_MESSAGE=hello",
				}},
				"HostConfig":      map[string]any{"NetworkMode": "bridge", "RestartPolicy": map[string]any{"Name": "unless-stopped"}},
				"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]any{}}},
			})
			return http.StatusOK, string(inspect)
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/images/"+imageID+"/json"):
			return http.StatusOK, `{"Id":"` + imageID + `","Config":{"Env":["PATH=/usr/local/sbin:/usr/bin","LANG=C.UTF-8","PODINFO_PORT=9898"]}}`
		}
		t.Errorf("unexpected source request %s %s", request.Method, path)
		return http.StatusInternalServerError, `{"message":"unexpected"}`
	})

	captured, err := source.CaptureMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatal(err)
	}
	if captured.SchemaVersion != 2 || len(captured.Blockers) > 0 || captured.Config.Env != nil {
		t.Fatalf("manifest schema %d, blockers %v, env %v", captured.SchemaVersion, captured.Blockers, captured.Config.Env)
	}
	if want := []string{"LANG", "PODINFO_UI_MESSAGE"}; !reflect.DeepEqual(captured.EnvKeys, want) {
		t.Fatalf("env keys %v, want %v", captured.EnvKeys, want)
	}
	// Opfield keeps the manifest and sends it back with the values.
	data, _ := json.Marshal(captured)
	var manifest dockerMigrationManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}

	var createdEnv []string
	creates := 0
	target := fakeDockerEngine(t, func(request *http.Request, path string) (int, string) {
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
			return http.StatusNotFound, `{"message":"No such container: app"}`
		case request.Method == http.MethodPost && strings.HasSuffix(path, "/containers/create"):
			creates++
			var body struct{ Env []string }
			_ = json.NewDecoder(request.Body).Decode(&body)
			createdEnv = body.Env
			return http.StatusCreated, `{"Id":"target","Warnings":[]}`
		}
		t.Errorf("unexpected target request %s %s", request.Method, path)
		return http.StatusInternalServerError, `{"message":"unexpected"}`
	})
	create := func(env ...string) (string, error) {
		return target.CreateContainerStopped(context.Background(), createStoppedContainerRequest{
			MigrationID: "migration-1", Manifest: manifest, Env: env,
		})
	}

	// The whole runtime environment, as an older Opfield sent it, names the keys the image supplies.
	if _, err := create("LANG=en_US.UTF-8", "PATH=/usr/local/sbin:/usr/bin", "PODINFO_PORT=9898", "PODINFO_UI_MESSAGE=hello"); err == nil ||
		err.Error() != "environment keys do not match manifest: unexpected PATH, PODINFO_PORT" {
		t.Fatalf("runtime environment error = %v", err)
	}
	if _, err := create("LANG=en_US.UTF-8"); err == nil ||
		err.Error() != "environment keys do not match manifest: missing PODINFO_UI_MESSAGE" {
		t.Fatalf("missing value error = %v", err)
	}
	if creates != 0 {
		t.Fatalf("a mismatched environment reached Docker %d times", creates)
	}

	id, err := create("LANG=en_US.UTF-8", "PODINFO_UI_MESSAGE=hello")
	if err != nil || id != "target" {
		t.Fatalf("create = %q, %v", id, err)
	}
	if want := []string{"LANG=en_US.UTF-8", "PODINFO_UI_MESSAGE=hello"}; !reflect.DeepEqual(createdEnv, want) {
		t.Fatalf("created env %v, want %v", createdEnv, want)
	}
}

// An environment the target cannot rebuild from the container's own variables
// and the image is a blocker, never a silently different target.
func TestMigrationOwnEnvKeysBlocksEnvironmentItCannotRebuild(t *testing.T) {
	for name, tc := range map[string]struct {
		container, image []string
		blocker          string
	}{
		"duplicate key":        {[]string{"A=1", "A=2"}, nil, `duplicate environment key "A"`},
		"image variable unset": {[]string{"A=1"}, []string{"PATH=/bin"}, `image environment variable "PATH" is unset in the container`},
		"entry without value":  {[]string{"A"}, nil, `environment variable "A" has no value`},
	} {
		t.Run(name, func(t *testing.T) {
			_, blockers := migrationOwnEnvKeys(tc.container, tc.image, nil)
			if !reflect.DeepEqual(blockers, []string{tc.blocker}) {
				t.Fatalf("blockers %v, want %q", blockers, tc.blocker)
			}
		})
	}
}
