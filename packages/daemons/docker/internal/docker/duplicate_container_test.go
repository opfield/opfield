package docker

import (
	"context"
	"encoding/json"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// A duplicate is not linked: it leaves out the variables the backend names (the source's link credentials), the
// source's database and storage link networks and their host aliases, and keeps everything else.
func TestDuplicateContainerLeavesOutLinkVariablesAndNetworks(t *testing.T) {
	const (
		databaseNetwork = legacycompat.DatabaseLinkNetworkPrefix + "0123456789abcdef"
		storageNetwork  = legacycompat.StorageLinkNetworkPrefix + "fedcba9876543210"
	)
	var mu sync.Mutex
	var created struct {
		Env        []string
		HostConfig struct {
			NetworkMode string
			ExtraHosts  []string
		}
		NetworkingConfig struct {
			EndpointsConfig map[string]json.RawMessage
		}
	}
	var connected []string
	respond := func(request *http.Request, code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	serve := func(request *http.Request) (*http.Response, error) {
		path, _ := url.PathUnescape(request.URL.Path)
		mu.Lock()
		defer mu.Unlock()
		switch {
		case request.Method == http.MethodGet && strings.HasSuffix(path, "/containers/app/json"):
			inspect, _ := json.Marshal(map[string]any{
				"Id": "source", "Name": "/app",
				"Config": map[string]any{"Image": "app:1", "Env": []string{
					"MODE=production", "DATABASE_URL=postgres://binding:secret@db-0123456789abcdef:5432/app", "AWS_SECRET_ACCESS_KEY=secret",
				}},
				"HostConfig": map[string]any{"NetworkMode": "app-net", "ExtraHosts": []string{"db-0123456789abcdef:172.30.5.1", "api.internal:10.0.0.5"}},
				"NetworkSettings": map[string]any{"Networks": map[string]any{
					"app-net": map[string]any{}, "backend-net": map[string]any{}, databaseNetwork: map[string]any{}, storageNetwork: map[string]any{},
				}},
			})
			return respond(request, http.StatusOK, string(inspect))
		case request.Method == http.MethodPost && strings.HasSuffix(path, "/containers/create"):
			if request.URL.Query().Get("name") != "app-copy" {
				t.Errorf("duplicate created as %q", request.URL.Query().Get("name"))
			}
			if err := json.NewDecoder(request.Body).Decode(&created); err != nil {
				t.Errorf("decode create request: %v", err)
			}
			return respond(request, http.StatusCreated, `{"Id":"copy"}`)
		case request.Method == http.MethodPost && strings.HasSuffix(path, "/connect"):
			parts := strings.Split(path, "/")
			connected = append(connected, parts[len(parts)-2])
			return respond(request, http.StatusOK, `{}`)
		}
		t.Errorf("unexpected Docker API call %s %s", request.Method, path)
		return respond(request, http.StatusInternalServerError, `{"message":"unexpected"}`)
	}
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(serve)}))
	if err != nil {
		t.Fatal(err)
	}

	id, err := (&Client{cli: cli}).DuplicateContainer(context.Background(), "app", "app-copy", []string{"DATABASE_URL", "AWS_SECRET_ACCESS_KEY"})
	if err != nil || id != "copy" {
		t.Fatalf("duplicate returned %q, %v", id, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(created.Env, []string{"MODE=production"}) {
		t.Fatalf("duplicate env %v", created.Env)
	}
	if !slices.Equal(created.HostConfig.ExtraHosts, []string{"api.internal:10.0.0.5"}) {
		t.Fatalf("duplicate extra hosts %v", created.HostConfig.ExtraHosts)
	}
	if created.HostConfig.NetworkMode != "app-net" || len(created.NetworkingConfig.EndpointsConfig) != 1 || created.NetworkingConfig.EndpointsConfig["app-net"] == nil {
		t.Fatalf("duplicate network mode %q, endpoints %v", created.HostConfig.NetworkMode, created.NetworkingConfig.EndpointsConfig)
	}
	if !slices.Equal(connected, []string{"backend-net"}) {
		t.Fatalf("duplicate connected to %v", connected)
	}
}

// A source whose own network is a link network gets its next network as the copy's, or none.
func TestDuplicateHostConfigLeavesALinkNetworkMode(t *testing.T) {
	linked := &container.HostConfig{NetworkMode: legacycompat.DatabaseLinkNetworkPrefix + "0123456789abcdef"}
	if got := duplicateHostConfig(linked, []string{"backend-net"}).NetworkMode; got != "backend-net" {
		t.Fatalf("network mode %q, want backend-net", got)
	}
	if got := duplicateHostConfig(linked, nil).NetworkMode; got != "none" {
		t.Fatalf("network mode %q, want none", got)
	}
	if got := duplicateHostConfig(&container.HostConfig{NetworkMode: "bridge"}, nil).NetworkMode; got != "bridge" {
		t.Fatalf("network mode %q, want bridge", got)
	}
}
