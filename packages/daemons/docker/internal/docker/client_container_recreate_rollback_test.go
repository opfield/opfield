package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/client"
)

// fakeRecreateEngine is a Docker Engine API holding one container, "app", in a restart loop on two networks. Docker
// keeps an endpoint of the removed container in "bind-net" (as it does for a container removed while it restarted).
type fakeRecreateEngine struct {
	t  *testing.T
	mu sync.Mutex
	// containers maps a container name to its ID.
	containers map[string]string
	// endpoints maps a network to its endpoints (key to endpoint name), as network inspect lists them.
	endpoints map[string]map[string]string
	// startFails makes every start fail with this message.
	startFails string
	// networkMode and attached override the inspected network mode and networks (app-net, and bind-net beside it).
	networkMode string
	attached    map[string]any
	// createdModes lists the network mode of every container created.
	createdModes []string
	// missingMode holds the containers created on no network whose network mode names a missing network: Docker
	// refuses to start them.
	missingMode map[string]string
	created     int
	removed     []string
	deleted     []string
	calls       []string
}

func newFakeRecreateEngine(t *testing.T) *fakeRecreateEngine {
	return &fakeRecreateEngine{
		t:          t,
		containers: map[string]string{"app": "orig"},
		endpoints: map[string]map[string]string{
			"app-net":  {"orig": "app"},
			"bind-net": {"ep-stale": "app"},
			// A link network the container left while it restarted still holds an endpoint of its name.
			"gateway-db-0123456789abcdef": {"ep-left": "app"},
		},
	}
}

func (e *fakeRecreateEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeRecreateEngine) nameOf(idOrName string) string {
	for name, id := range e.containers {
		if name == idOrName || id == idOrName {
			return name
		}
	}
	return ""
}

func (e *fakeRecreateEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, request.Method+" "+path)
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case request.Method == http.MethodPost && path == "/containers/create":
		name := request.URL.Query().Get("name")
		if _, exists := e.containers[name]; exists {
			return respond(http.StatusConflict, `{"message":"Conflict. The container name \"/`+name+`\" is already in use"}`)
		}
		var body struct {
			HostConfig struct {
				NetworkMode string
			}
			NetworkingConfig struct {
				EndpointsConfig map[string]any
			}
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.created++
		id := "created-" + string(rune('0'+e.created))
		e.containers[name] = id
		mode := body.HostConfig.NetworkMode
		e.createdModes = append(e.createdModes, mode)
		if _, exists := e.endpoints[mode]; !exists && len(body.NetworkingConfig.EndpointsConfig) == 0 &&
			mode != "bridge" && mode != "default" && mode != "host" && mode != "none" {
			if e.missingMode == nil {
				e.missingMode = map[string]string{}
			}
			e.missingMode[id] = mode
		}
		return respond(http.StatusCreated, `{"Id":"`+id+`"}`)
	case parts[0] == "containers" && len(parts) >= 2:
		name := e.nameOf(parts[1])
		if name == "" {
			return respond(http.StatusNotFound, `{"message":"No such container: `+parts[1]+`"}`)
		}
		id := e.containers[name]
		switch {
		case request.Method == http.MethodGet && len(parts) == 3 && parts[2] == "json":
			networkMode := "app-net"
			if e.networkMode != "" {
				networkMode = e.networkMode
			}
			attached := map[string]any{"app-net": map[string]any{}, "bind-net": map[string]any{}}
			if e.attached != nil {
				attached = e.attached
			}
			inspect, _ := json.Marshal(map[string]any{
				"Id": id, "Name": "/" + name,
				"Config":          map[string]any{"Image": "app:1", "Env": []string{"MODE=production"}},
				"HostConfig":      map[string]any{"NetworkMode": networkMode, "RestartPolicy": map[string]any{"Name": "always"}},
				"State":           map[string]any{"Running": true, "Restarting": true, "Status": "restarting"},
				"NetworkSettings": map[string]any{"Networks": attached},
			})
			return respond(http.StatusOK, string(inspect))
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "stop":
			return respond(http.StatusNoContent, "")
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "start":
			for network, endpoints := range e.endpoints {
				for key, endpoint := range endpoints {
					if endpoint == name && key != id {
						return respond(http.StatusInternalServerError,
							`{"message":"endpoint with name `+name+` already exists in network `+network+`"}`)
					}
				}
			}
			if e.startFails != "" {
				return respond(http.StatusInternalServerError, `{"message":"`+e.startFails+`"}`)
			}
			if mode, missing := e.missingMode[id]; missing {
				return respond(http.StatusNotFound,
					`{"message":"could not find a network matching network mode `+mode+`: network `+mode+` not found"}`)
			}
			return respond(http.StatusNoContent, "")
		case request.Method == http.MethodDelete && len(parts) == 2:
			delete(e.containers, name)
			e.removed = append(e.removed, id)
			// Docker drops the endpoints the container's sandbox held, but not the stale one.
			for _, endpoints := range e.endpoints {
				delete(endpoints, id)
			}
			return respond(http.StatusNoContent, "")
		}
	case request.Method == http.MethodGet && path == "/networks":
		listed := []map[string]any{}
		for network := range e.endpoints {
			listed = append(listed, map[string]any{"Name": network, "Id": network})
		}
		body, _ := json.Marshal(listed)
		return respond(http.StatusOK, string(body))
	case parts[0] == "networks" && len(parts) >= 2:
		network := parts[1]
		endpoints, exists := e.endpoints[network]
		if !exists {
			return respond(http.StatusNotFound, `{"message":"network `+network+` not found"}`)
		}
		switch {
		case request.Method == http.MethodGet && len(parts) == 2:
			listed := map[string]any{}
			for key, name := range endpoints {
				listed[key] = map[string]any{"Name": name}
			}
			inspect, _ := json.Marshal(map[string]any{"Name": network, "Id": network, "Containers": listed})
			return respond(http.StatusOK, string(inspect))
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "connect":
			return respond(http.StatusOK, `{}`)
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "disconnect":
			var body struct {
				Container string
				Force     bool
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			if name := e.nameOf(body.Container); name != "" {
				if id := e.containers[name]; endpoints[id] == name {
					delete(endpoints, id)
					e.deleted = append(e.deleted, network+"/"+name)
					return respond(http.StatusOK, `{}`)
				}
				return respond(http.StatusForbidden, `{"message":"container `+body.Container+` is not connected to network `+network+`"}`)
			}
			if !body.Force {
				return respond(http.StatusNotFound, `{"message":"No such container: `+body.Container+`"}`)
			}
			for key, name := range endpoints {
				if name == body.Container {
					delete(endpoints, key)
					e.deleted = append(e.deleted, network+"/"+name)
				}
			}
			return respond(http.StatusOK, `{}`)
		case request.Method == http.MethodDelete && len(parts) == 2:
			if len(endpoints) > 0 {
				return respond(http.StatusForbidden, `{"message":"error while removing network: network `+network+` has active endpoints"}`)
			}
			delete(e.endpoints, network)
			return respond(http.StatusNoContent, "")
		}
	}
	e.t.Errorf("unexpected Docker API call %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

// A container removed while it restarted leaves its endpoint in the network; the replacement joins after the stale
// endpoint is deleted instead of failing (and losing the container with its rollback).
func TestRecreateDeletesTheStaleEndpointsOfTheRemovedContainer(t *testing.T) {
	engine := newFakeRecreateEngine(t)

	err := engine.client().UpdateContainer(context.Background(), "app", "", map[string]string{"DATABASE_URL": "postgres://db"}, nil, "", "running")
	if err != nil {
		t.Fatalf("recreate failed: %v", err)
	}
	if got := strings.Join(engine.deleted, ","); got != "bind-net/app,gateway-db-0123456789abcdef/app" {
		t.Fatalf("stale endpoints deleted = %q, want those in bind-net and the link network", got)
	}
	if engine.containers["app"] != "created-1" {
		t.Fatalf("app is %q, want the replacement", engine.containers["app"])
	}
}

// When neither the replacement nor the restored original can start (a host port still taken), the original
// configuration is kept as a created container rather than deleted along with the replacement.
func TestRecreateKeepsTheRestoredContainerWhenItCannotStart(t *testing.T) {
	engine := newFakeRecreateEngine(t)
	engine.startFails = "Bind for 0.0.0.0:18933 failed: port is already allocated"

	err := engine.client().UpdateContainer(context.Background(), "app", "", map[string]string{"DATABASE_URL": "postgres://db"}, nil, "", "running")
	if err == nil || !strings.Contains(err.Error(), "original container restored, not started") {
		t.Fatalf("recreate error = %v, want the original restored but not started", err)
	}
	if engine.containers["app"] != "created-2" {
		t.Fatalf("app is %q, want the restored original", engine.containers["app"])
	}
	if got := strings.Join(engine.removed, ","); got != "orig,created-1" {
		t.Fatalf("removed containers = %q, want only the original and the failed replacement", got)
	}
}

// A container on no network (the kill switch held it off its networks) whose network mode names a network removed
// meanwhile is recreated on the default bridge network: on its old network mode Docker would refuse to start it, and
// the restored original as well.
func TestRecreateOfAContainerWhoseNetworkModeIsGoneUsesTheBridge(t *testing.T) {
	engine := newFakeRecreateEngine(t)
	engine.networkMode = "gateway-db-fedcba9876543210"
	engine.attached = map[string]any{}
	engine.endpoints = map[string]map[string]string{"app-net": {}}

	err := engine.client().UpdateContainer(context.Background(), "app", "", nil, []string{"REDIS_URL"}, "", "running")
	if err != nil {
		t.Fatalf("recreate failed: %v", err)
	}
	if got := strings.Join(engine.createdModes, ","); got != "bridge" {
		t.Fatalf("created network modes = %q, want one container on the bridge network", got)
	}
	if engine.containers["app"] != "created-1" {
		t.Fatalf("app is %q, want the replacement", engine.containers["app"])
	}
}

// A container on no network keeps a network mode whose network still exists.
func TestRecreateKeepsAnExistingNetworkModeOnNoNetwork(t *testing.T) {
	engine := newFakeRecreateEngine(t)
	engine.networkMode = "app-net"
	engine.attached = map[string]any{}
	engine.endpoints = map[string]map[string]string{"app-net": {}}

	if err := engine.client().UpdateContainer(context.Background(), "app", "", nil, nil, "", "running"); err != nil {
		t.Fatalf("recreate failed: %v", err)
	}
	if got := strings.Join(engine.createdModes, ","); got != "app-net" {
		t.Fatalf("created network modes = %q, want app-net", got)
	}
}

// The network mode of a recreated container is a link network only when the container is on nothing else.
func TestPrioritizeNetworkNamesKeepsLinkNetworksSecondary(t *testing.T) {
	cases := []struct {
		names []string
		mode  string
		want  string
	}{
		{[]string{"bridge", "gateway-db-0123456789abcdef"}, "bridge", "bridge"},
		{[]string{"bridge", "gateway-db-0123456789abcdef"}, "gateway-db-0123456789abcdef", "bridge"},
		{[]string{"app-net", "gateway-db-0123456789abcdef"}, "gateway-db-0123456789abcdef", "app-net"},
		{[]string{"bridge", "gateway-link-0123456789abcdef", "zeta"}, "bridge", "zeta"},
		{[]string{"alpha", "beta"}, "beta", "beta"},
		{[]string{"bridge", "zeta"}, "bridge", "zeta"},
		{[]string{"gateway-db-0123456789abcdef", "gateway-link-0123456789abcdef"}, "gateway-link-0123456789abcdef", "gateway-link-0123456789abcdef"},
		{[]string{"gateway-db-0123456789abcdef"}, "bridge", "gateway-db-0123456789abcdef"},
	}
	for _, tc := range cases {
		got := prioritizeNetworkNames(append([]string(nil), tc.names...), tc.mode)
		if got[0] != tc.want || len(got) != len(tc.names) {
			t.Fatalf("prioritizeNetworkNames(%v, %q) = %v, want %s first", tc.names, tc.mode, got, tc.want)
		}
	}
}

// Removing a network deletes the endpoints of containers that no longer exist first; a live container's endpoint
// keeps the network.
func TestRemoveNetworkDeletesOrphanedEndpoints(t *testing.T) {
	engine := newFakeRecreateEngine(t)
	engine.containers = map[string]string{"live": "live-id"}
	engine.endpoints = map[string]map[string]string{
		"gateway-db-0123456789abcdef": {"ep-stale": "gone", "removed-id": "removed"},
		"in-use":                      {"live-id": "live", "ep-stale": "gone"},
	}
	cli := engine.client()

	if err := cli.RemoveNetwork(context.Background(), "gateway-db-0123456789abcdef"); err != nil {
		t.Fatalf("remove network with orphaned endpoints: %v", err)
	}
	if _, exists := engine.endpoints["gateway-db-0123456789abcdef"]; exists {
		t.Fatal("network with orphaned endpoints was not removed")
	}
	err := cli.RemoveNetwork(context.Background(), "in-use")
	if err == nil || !strings.Contains(err.Error(), "has active endpoints") {
		t.Fatalf("remove network in use = %v, want active endpoints", err)
	}
	if got := engine.endpoints["in-use"]; len(got) != 1 || got["live-id"] != "live" {
		t.Fatalf("in-use endpoints = %v, want only the live container", got)
	}
}

// The Secure Link connector joined a deployment network to reach its router: removing the deployment takes the
// connector off the network, which then goes (stand run x1: "network ... has active endpoints", so the replacement
// standby was never prepared). A network another container still uses keeps the connector.
func TestRemoveNetworkReleasesTheSecureLinkConnector(t *testing.T) {
	engine := newFakeRecreateEngine(t)
	engine.containers = map[string]string{secureLinkConnectorName: "connector-id", "live": "live-id"}
	engine.endpoints = map[string]map[string]string{
		"gwav-deployment-1-net": {"connector-id": secureLinkConnectorName},
		"in-use":                {"connector-id": secureLinkConnectorName, "live-id": "live"},
	}
	cli := engine.client()

	if err := cli.RemoveNetwork(context.Background(), "gwav-deployment-1-net"); err != nil {
		t.Fatalf("remove network the connector alone is on: %v", err)
	}
	if _, exists := engine.endpoints["gwav-deployment-1-net"]; exists {
		t.Fatal("network was not removed")
	}
	if err := cli.RemoveNetwork(context.Background(), "in-use"); err == nil {
		t.Fatal("network another container uses was removed")
	}
	if got := engine.endpoints["in-use"]; got["connector-id"] != secureLinkConnectorName {
		t.Fatalf("in-use endpoints = %v, want the connector kept next to the live container", got)
	}
}
