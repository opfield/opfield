package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func hexVolume(char string) string { return strings.Repeat(char, 64) }

// fakeVolumeEngine is a Docker Engine API with containers (inspect and list) and volumes, recording what is removed.
type fakeVolumeEngine struct {
	t          *testing.T
	mu         sync.Mutex
	containers map[string]map[string]any
	volumes    map[string]map[string]any
	requests   []string
}

func (e *fakeVolumeEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeVolumeEngine) removed(kind string) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var names []string
	for _, request := range e.requests {
		if name, ok := strings.CutPrefix(request, "DELETE /"+kind+"/"); ok {
			names = append(names, name)
		}
	}
	return names
}

func (e *fakeVolumeEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	e.requests = append(e.requests, request.Method+" "+path)
	switch {
	case request.Method == http.MethodGet && path == "/containers/json":
		var items []map[string]any
		for id, inspect := range e.containers {
			items = append(items, map[string]any{"Id": id, "Names": []string{inspect["Name"].(string)}, "State": "exited",
				"Mounts": inspect["Mounts"]})
		}
		body, _ := json.Marshal(items)
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/containers/") && strings.HasSuffix(path, "/json"):
		ref := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
		for id, inspect := range e.containers {
			if id == ref || inspect["Name"] == "/"+ref {
				body, _ := json.Marshal(inspect)
				return respond(http.StatusOK, string(body))
			}
		}
		return respond(http.StatusNotFound, `{"message":"No such container: `+ref+`"}`)
	case request.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
		ref := strings.TrimPrefix(path, "/containers/")
		for id, inspect := range e.containers {
			if id == ref || inspect["Name"] == "/"+ref {
				delete(e.containers, id)
				return respond(http.StatusNoContent, "")
			}
		}
		return respond(http.StatusNotFound, `{"message":"No such container: `+ref+`"}`)
	case request.Method == http.MethodGet && strings.HasPrefix(path, "/volumes/"):
		name := strings.TrimPrefix(path, "/volumes/")
		if volume, ok := e.volumes[name]; ok {
			body, _ := json.Marshal(volume)
			return respond(http.StatusOK, string(body))
		}
		return respond(http.StatusNotFound, `{"message":"no such volume"}`)
	case request.Method == http.MethodDelete && strings.HasPrefix(path, "/volumes/"):
		name := strings.TrimPrefix(path, "/volumes/")
		delete(e.volumes, name)
		return respond(http.StatusNoContent, "")
	}
	e.t.Errorf("unexpected request %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

func volumeMount(name, destination string) map[string]any {
	return map[string]any{"Type": "volume", "Name": name, "Source": "/var/lib/docker/volumes/" + name + "/_data",
		"Destination": destination, "Driver": "local", "RW": true}
}

func dockerVolume(name string, labels map[string]string) map[string]any {
	return map[string]any{"Name": name, "Driver": "local", "Mountpoint": "/var/lib/docker/volumes/" + name + "/_data",
		"Labels": labels, "Scope": "local"}
}

// slotEngine holds a deployment slot mounting, at different paths: its own anonymous volume, a named volume, an
// anonymous volume another container also uses, one carrying the protection label (and the legacy one), one Opfield
// manages, and one its mount list names. Only its own unprotected anonymous volume may go with it.
func slotEngine(t *testing.T) *fakeVolumeEngine {
	own, shared, protected, legacyProtected, managed, listed := hexVolume("a"), hexVolume("b"), hexVolume("c"), hexVolume("d"), hexVolume("e"), hexVolume("f")
	return &fakeVolumeEngine{
		t: t,
		containers: map[string]map[string]any{
			"slot-id": {
				"Id": "slot-id", "Name": "/app-blue",
				"HostConfig": map[string]any{"Binds": []string{"data:/named", listed + ":/listed"}},
				"Mounts": []map[string]any{
					volumeMount(own, "/cache"), volumeMount("data", "/named"), volumeMount(shared, "/shared"),
					volumeMount(protected, "/protected"), volumeMount(legacyProtected, "/legacy"),
					volumeMount(managed, "/managed"), volumeMount(listed, "/listed"),
				},
			},
			"other-id": {
				"Id": "other-id", "Name": "/other",
				"Mounts": []map[string]any{volumeMount(shared, "/shared")},
			},
		},
		volumes: map[string]map[string]any{
			own:             dockerVolume(own, nil),
			"data":          dockerVolume("data", nil),
			shared:          dockerVolume(shared, nil),
			protected:       dockerVolume(protected, map[string]string{housekeepingProtectedLabel: "true"}),
			legacyProtected: dockerVolume(legacyProtected, map[string]string{legacyHousekeepingProtectedLabel: "true"}),
			managed:         dockerVolume(managed, map[string]string{managedVolumeLabel: "true"}),
			listed:          dockerVolume(listed, nil),
		},
	}
}

func TestContainerAnonymousVolumesAreOnlyTheContainersOwn(t *testing.T) {
	insp := &container.InspectResponse{
		HostConfig: &container.HostConfig{Binds: []string{hexVolume("f") + ":/listed:ro", "/srv:/srv"}},
		Mounts: []container.MountPoint{
			{Type: mount.TypeVolume, Name: hexVolume("a"), Destination: "/cache", Driver: "local"},
			{Type: mount.TypeVolume, Name: hexVolume("a"), Destination: "/cache2", Driver: "local"},
			{Type: mount.TypeVolume, Name: "data", Destination: "/named", Driver: "local"},
			{Type: mount.TypeVolume, Name: hexVolume("f"), Destination: "/listed", Driver: "local"},
			{Type: mount.TypeVolume, Name: hexVolume("9"), Destination: "/nfs", Driver: "nfs-plugin"},
			{Type: mount.TypeBind, Source: "/srv", Destination: "/srv"},
		},
	}
	if got := containerAnonymousVolumes(insp); !slices.Equal(got, []string{hexVolume("a")}) {
		t.Fatalf("anonymous volumes = %v, want only the container's own", got)
	}
}

func TestRemovedSlotTakesOnlyItsOwnUnprotectedAnonymousVolume(t *testing.T) {
	engine := slotEngine(t)
	if err := engine.client().removeContainerByName(context.Background(), "app-blue", true); err != nil {
		t.Fatal(err)
	}
	if got := engine.removed("containers"); !slices.Equal(got, []string{"app-blue"}) {
		t.Fatalf("removed containers = %v", got)
	}
	if got := engine.removed("volumes"); !slices.Equal(got, []string{hexVolume("a")}) {
		t.Fatalf("removed volumes = %v, want only the slot's own anonymous volume", got)
	}
	for _, kept := range []string{"data", hexVolume("b"), hexVolume("c"), hexVolume("d"), hexVolume("e"), hexVolume("f")} {
		if _, ok := engine.volumes[kept]; !ok {
			t.Errorf("volume %s was removed", kept[:min(len(kept), 12)])
		}
	}
	// The container went first: a volume is never removed from under a container that still exists.
	containerAt, volumeAt := slices.Index(engine.requests, "DELETE /containers/app-blue"), slices.Index(engine.requests, "DELETE /volumes/"+hexVolume("a"))
	if containerAt < 0 || volumeAt < containerAt {
		t.Fatalf("requests out of order: %v", engine.requests)
	}
}

func TestPluginRemoveTakesAnonymousVolumesOnlyWhenAsked(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config string
		want   []string
	}{
		{name: "Opfield's container removal keeps them (it removes them itself)", config: ""},
		{name: "an Availability placement removal takes them", config: `{"removeAnonymousVolumes":true}`, want: []string{hexVolume("a")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := slotEngine(t)
			envDir := t.TempDir()
			plugin := &DockerPlugin{client: engine.client(), envStore: NewEnvStore(envDir)}
			plugin.useLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err := os.WriteFile(filepath.Join(envDir, "app-blue.env"), []byte("SECRET=1\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			result := &pb.CommandResult{Success: true}
			plugin.handleContainerCommand(&pb.DockerContainerCommand{Action: "remove", ContainerId: "slot-id", Force: true, ConfigJson: tc.config}, result)
			if !result.Success {
				t.Fatal(result.Error)
			}
			if got := engine.removed("volumes"); !slices.Equal(got, tc.want) {
				t.Fatalf("removed volumes = %v, want %v", got, tc.want)
			}
			if _, err := os.Stat(filepath.Join(envDir, "app-blue.env")); !os.IsNotExist(err) {
				t.Fatalf("the removed container's env file stays: %v", err)
			}
		})
	}
}

// A recreate is no removal for good: the anonymous volume goes over to the new container and is never removed.
func TestRecreateKeepsTheAnonymousVolume(t *testing.T) {
	engine := brokenContainerEngine(t, volumeImage("sha256:old", "/data"))
	var mu sync.Mutex
	var volumeRequests []string
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if strings.Contains(request.URL.Path, "/volumes") {
				mu.Lock()
				volumeRequests = append(volumeRequests, request.Method+" "+request.URL.Path)
				mu.Unlock()
			}
			return engine.serve(request)
		})}))
	if err != nil {
		t.Fatal(err)
	}
	if err := (&Client{cli: cli}).RecreateWithConfig(context.Background(), "app", `{"mounts":[]}`); err != nil {
		t.Fatal(err)
	}
	if len(volumeRequests) != 0 {
		t.Fatalf("a recreate touched volumes: %v", volumeRequests)
	}
	created := engine.lastCreate(t)
	if !slices.ContainsFunc(created.HostConfig.Mounts, func(m mount.Mount) bool { return m.Source == testAnonymousVolume }) {
		t.Fatalf("the recreated container lost its anonymous volume: %+v", created.HostConfig.Mounts)
	}
}

func TestComposeDownKeepsVolumesTheComposeFileNames(t *testing.T) {
	names := []string{hexVolume("a"), hexVolume("b")}
	yaml := []byte("services:\n  app:\n    volumes:\n      - " + hexVolume("b") + ":/data\nvolumes:\n  " + hexVolume("b") + ":\n    external: true\n")
	if got := withoutNamedIn(names, yaml); !slices.Equal(got, []string{hexVolume("a")}) {
		t.Fatalf("kept for removal = %v", got)
	}
	if got := withoutNamedIn(names, nil); !slices.Equal(got, names) {
		t.Fatalf("without a compose file = %v", got)
	}
}
