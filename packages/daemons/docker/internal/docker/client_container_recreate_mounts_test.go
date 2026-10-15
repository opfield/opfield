package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"
)

const testAnonymousVolume = "2617777e419daa47c6b5499eb7a47a5ba83b9b1b9c63a5b2d51a6227e1a73980"

// fakeMountEngine is a Docker Engine API holding one container, "app" (ID "orig"), and the images it knows. Its create
// refuses two mounts at one path as Docker does: a bind next to a bind, or a HostConfig mount next to a bind.
type fakeMountEngine struct {
	t       *testing.T
	mu      sync.Mutex
	inspect map[string]any
	images  map[string]map[string]any
	created []fakeMountCreate
}

type fakeMountCreateConfig struct {
	Image        string
	Volumes      map[string]struct{}
	ExposedPorts map[string]struct{}
}

// fakeMountCreate is a create request body: the container config at the top level, beside HostConfig.
type fakeMountCreate struct {
	Config     fakeMountCreateConfig `json:"-"`
	HostConfig struct {
		Binds  []string
		Mounts []mount.Mount
	}
}

func (e *fakeMountEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeMountEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && (path == "/containers/app/json" || path == "/containers/orig/json"):
		body, _ := json.Marshal(e.inspect)
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodPost && path == "/containers/orig/stop":
		return respond(http.StatusNoContent, "")
	case request.Method == http.MethodDelete && path == "/containers/orig":
		return respond(http.StatusNoContent, "")
	case request.Method == http.MethodPost && path == "/containers/create":
		var body fakeMountCreate
		raw, _ := io.ReadAll(request.Body)
		if json.Unmarshal(raw, &body) != nil || json.Unmarshal(raw, &body.Config) != nil {
			return respond(http.StatusBadRequest, `{"message":"bad body"}`)
		}
		e.created = append(e.created, body)
		taken := map[string]bool{}
		for _, bind := range body.HostConfig.Binds {
			destination := bindDestination(bind)
			if taken[destination] {
				return respond(http.StatusBadRequest, `{"message":"Duplicate mount point: `+destination+`"}`)
			}
			taken[destination] = true
		}
		for _, configured := range body.HostConfig.Mounts {
			if taken[configured.Target] {
				return respond(http.StatusBadRequest, `{"message":"Duplicate mount point: `+configured.Target+`"}`)
			}
		}
		return respond(http.StatusCreated, `{"Id":"new"}`)
	case request.Method == http.MethodPost && path == "/containers/new/start":
		return respond(http.StatusNoContent, "")
	case request.Method == http.MethodGet && path == "/networks":
		return respond(http.StatusOK, `[]`)
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		ref := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
		if inspected, ok := e.images[ref]; ok {
			body, _ := json.Marshal(inspected)
			return respond(http.StatusOK, string(body))
		}
		return respond(http.StatusNotFound, `{"message":"No such image: `+ref+`"}`)
	}
	return respond(http.StatusNotFound, `{"message":"unexpected `+request.Method+` `+path+`"}`)
}

func (e *fakeMountEngine) lastCreate(t *testing.T) fakeMountCreate {
	t.Helper()
	if len(e.created) == 0 {
		t.Fatal("no container was created")
	}
	return e.created[len(e.created)-1]
}

func anonymousDataMount() map[string]any {
	return map[string]any{"Type": "volume", "Name": testAnonymousVolume, "Source": "/var/lib/docker/volumes/" +
		testAnonymousVolume + "/_data", "Destination": "/data", "RW": true, "Driver": "local"}
}

func volumeImage(id string, volumes ...string) map[string]any {
	declared := map[string]any{}
	for _, volume := range volumes {
		declared[volume] = map[string]any{}
	}
	return map[string]any{"Id": id, "Config": map[string]any{"Volumes": declared}}
}

// brokenContainerEngine is the container of the report: its image declares VOLUME /data, its first create gave it an
// anonymous volume there, and a recreate before the fix re-attached that volume through HostConfig.Mounts.
func brokenContainerEngine(t *testing.T, image map[string]any) *fakeMountEngine {
	return &fakeMountEngine{
		t: t,
		inspect: map[string]any{
			"Id": "orig", "Name": "/app", "Image": "sha256:old",
			"Config": map[string]any{"Image": "app:1", "Volumes": map[string]any{"/data": map[string]any{}}},
			"HostConfig": map[string]any{"NetworkMode": "bridge", "Mounts": []map[string]any{
				{"Type": "volume", "Source": testAnonymousVolume, "Target": "/data"},
			}},
			"State":  map[string]any{"Running": false, "Status": "exited"},
			"Mounts": []map[string]any{anonymousDataMount()},
		},
		images: map[string]map[string]any{"app:1": image, "sha256:old": image},
	}
}

func recreateWithMounts(t *testing.T, engine *fakeMountEngine, mounts string) error {
	t.Helper()
	return engine.client().RecreateWithConfig(context.Background(), "app", `{"mounts":`+mounts+`}`)
}

func TestRecreateMountListReplacesACarriedAnonymousVolume(t *testing.T) {
	for _, tc := range []struct {
		name    string
		image   map[string]any
		request string
		binds   []string
		want    []mount.Mount
	}{
		{
			name:    "a managed volume over the image VOLUME path",
			image:   volumeImage("sha256:old", "/data"),
			request: `[{"name":"rin-data","containerPath":"/data"}]`,
			binds:   []string{"rin-data:/data"},
		},
		{
			name:    "a managed volume on an image without the VOLUME",
			image:   volumeImage("sha256:old"),
			request: `[{"name":"rin-data","containerPath":"/data"}]`,
			binds:   []string{"rin-data:/data"},
		},
		{
			name:    "the adopted anonymous volume as a listed mount",
			image:   volumeImage("sha256:old", "/data"),
			request: `[{"name":"` + testAnonymousVolume + `","containerPath":"/data"}]`,
			binds:   []string{testAnonymousVolume + ":/data"},
		},
		{
			name:    "the anonymous volume moved to another path",
			image:   volumeImage("sha256:old", "/data"),
			request: `[{"name":"` + testAnonymousVolume + `","containerPath":"/old-data"},{"name":"rin-data","containerPath":"/data"}]`,
			binds:   []string{testAnonymousVolume + ":/old-data", "rin-data:/data"},
		},
		{
			name:    "an empty list keeps the volume at the path the image declares",
			image:   volumeImage("sha256:old", "/data"),
			request: `[]`,
			want:    []mount.Mount{{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/data"}},
		},
		{
			name:    "an empty list on an image without the VOLUME mounts nothing",
			image:   volumeImage("sha256:old"),
			request: `[]`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := brokenContainerEngine(t, tc.image)
			if err := recreateWithMounts(t, engine, tc.request); err != nil {
				t.Fatalf("recreate: %v", err)
			}
			created := engine.lastCreate(t)
			if !slices.Equal(created.HostConfig.Binds, tc.binds) {
				t.Fatalf("binds = %v, want %v", created.HostConfig.Binds, tc.binds)
			}
			if !slices.Equal(created.HostConfig.Mounts, tc.want) {
				t.Fatalf("mounts = %+v, want %+v", created.HostConfig.Mounts, tc.want)
			}
			if len(created.Config.Volumes) != 0 {
				t.Fatalf("the old container's VOLUME paths were carried: %v", created.Config.Volumes)
			}
		})
	}
}

func TestRecreateWithANewImageKeepsAnonymousDataAndDropsTheOldImageDeclarations(t *testing.T) {
	engine := &fakeMountEngine{
		t: t,
		inspect: map[string]any{
			"Id": "orig", "Name": "/app", "Image": "sha256:old",
			"Config": map[string]any{"Image": "app:1", "Volumes": map[string]any{"/data": map[string]any{}},
				"ExposedPorts": map[string]any{"8080/tcp": map[string]any{}, "9000/tcp": map[string]any{}}},
			"HostConfig": map[string]any{"NetworkMode": "bridge", "PortBindings": map[string]any{
				"9000/tcp": []map[string]any{{"HostIp": "0.0.0.0", "HostPort": "9000"}},
			}},
			"State":  map[string]any{"Running": false, "Status": "exited"},
			"Mounts": []map[string]any{anonymousDataMount()},
		},
		images: map[string]map[string]any{
			"sha256:old": {"Id": "sha256:old", "Config": map[string]any{
				"Volumes": map[string]any{"/data": map[string]any{}}, "ExposedPorts": map[string]any{"8080/tcp": map[string]any{}, "9000/tcp": map[string]any{}},
			}},
			"app:2": {"Id": "sha256:new", "Config": map[string]any{"ExposedPorts": map[string]any{"3000/tcp": map[string]any{}}}},
		},
	}
	if err := engine.client().RecreateWithConfig(context.Background(), "app", `{"image":"app:2"}`); err != nil {
		t.Fatalf("recreate: %v", err)
	}
	created := engine.lastCreate(t)
	if created.Config.Image != "app:2" || len(created.Config.Volumes) != 0 {
		t.Fatalf("config = %+v, want app:2 without the old VOLUME paths", created.Config)
	}
	// The data of the anonymous volume stays attached by name; Docker adds the new image's VOLUME paths itself.
	want := []mount.Mount{{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/data"}}
	if !slices.Equal(created.HostConfig.Mounts, want) {
		t.Fatalf("mounts = %+v, want %+v", created.HostConfig.Mounts, want)
	}
	if _, kept := created.Config.ExposedPorts["8080/tcp"]; kept {
		t.Fatalf("port only the old image exposed is still exposed: %v", created.Config.ExposedPorts)
	}
	if _, kept := created.Config.ExposedPorts["9000/tcp"]; !kept {
		t.Fatalf("published port lost its exposure: %v", created.Config.ExposedPorts)
	}
}

func TestRecreateDropsACarriedMountAtABindPath(t *testing.T) {
	hostConfig := &container.HostConfig{
		Binds: []string{"rin-data:/data"},
		Mounts: []mount.Mount{
			{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/data/"},
			{Type: mount.TypeTmpfs, Target: "/run"},
			{Type: mount.TypeVolume, Source: "other", Target: "/run"},
		},
	}
	kept, dropped := withoutDuplicateMountTargets(hostConfig)
	if len(kept) != 1 || kept[0].Target != "/run" || kept[0].Type != mount.TypeTmpfs || len(dropped) != 2 {
		t.Fatalf("kept %+v, dropped %+v", kept, dropped)
	}
}

func TestDuplicateMountErrorNamesTheMounts(t *testing.T) {
	err := describeDuplicateMountError(errors.New("Error response from daemon: Duplicate mount point: /data"), &container.HostConfig{
		Binds:  []string{"rin-data:/data"},
		Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/data"}},
	})
	message := err.Error()
	for _, part := range []string{`volume "rin-data" (mount list)`, "anonymous volume 2617777e419d (kept from the previous container)", "mount at /data"} {
		if !strings.Contains(message, part) {
			t.Fatalf("%q does not say %q", message, part)
		}
	}
	other := errors.New("no such image")
	if describeDuplicateMountError(other, &container.HostConfig{}) != other {
		t.Fatal("another error was changed")
	}
}

func TestDuplicateGetsItsOwnAnonymousVolumes(t *testing.T) {
	hostConfig := &container.HostConfig{
		Binds:  []string{"rin-data:/data", testAnonymousVolume + ":/cache:ro"},
		Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/state"}},
	}
	source := map[string]struct{}{"/image-volume": {}}
	volumes := duplicateVolumes(source, hostConfig)
	if !slices.Equal(hostConfig.Binds, []string{"rin-data:/data"}) || len(hostConfig.Mounts) != 0 {
		t.Fatalf("the copy still mounts the source's anonymous volumes: %+v", hostConfig)
	}
	for _, path := range []string{"/image-volume", "/cache", "/state"} {
		if _, ok := volumes[path]; !ok {
			t.Fatalf("volumes %v miss %s", volumes, path)
		}
	}
	if len(source) != 1 {
		t.Fatalf("the source's volumes were changed: %v", source)
	}
}

func TestMigrationManifestMountsAnAnonymousVolumeByName(t *testing.T) {
	engine := brokenContainerEngine(t, volumeImage("sha256:old", "/data"))
	engine.inspect["HostConfig"] = map[string]any{"NetworkMode": "bridge"}
	manifest, err := engine.client().CaptureMigrationManifest(context.Background(), "app")
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	want := []mount.Mount{{Type: mount.TypeVolume, Source: testAnonymousVolume, Target: "/data"}}
	if !slices.Equal(manifest.HostConfig.Mounts, want) {
		t.Fatalf("mounts = %+v, want %+v", manifest.HostConfig.Mounts, want)
	}
	if !slices.Equal(manifest.VolumeNames, []string{testAnonymousVolume}) {
		t.Fatalf("volume names = %v", manifest.VolumeNames)
	}
}
