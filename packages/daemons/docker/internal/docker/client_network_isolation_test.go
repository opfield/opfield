package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/client"
)

const isolationContainerID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// fakeIsolationEngine is a Docker Engine API holding one container, "app", and the networks it can join.
type fakeIsolationEngine struct {
	t           *testing.T
	mu          sync.Mutex
	networkMode string
	// networks maps a network name to its ID.
	networks map[string]string
	// attached maps a network name to the endpoint settings the container holds there, as inspect reports them.
	attached map[string]map[string]any
	// disconnectFails makes a disconnect from this network fail.
	disconnectFails string
	connects        []fakeConnect
	disconnects     []string
}

type fakeConnect struct {
	network  string
	endpoint map[string]any
}

func newFakeIsolationEngine(t *testing.T) *fakeIsolationEngine {
	return &fakeIsolationEngine{
		t:           t,
		networkMode: "app-net",
		networks: map[string]string{
			"app-net":                     "id-app",
			"bridge":                      "id-bridge",
			"gateway-db-0123456789abcdef": "id-db",
			"zeta-net":                    "id-zeta",
		},
		attached: map[string]map[string]any{
			"app-net": {
				"NetworkID": "id-app", "EndpointID": "ep-1", "IPAddress": "172.20.0.5", "Gateway": "172.20.0.1",
				"MacAddress": "02:42:ac:14:00:05", "Aliases": []string{"api", "0123456789ab"},
				"DNSNames":   []string{"app", "api", "0123456789ab"},
				"IPAMConfig": map[string]any{"IPv4Address": "172.20.0.5", "LinkLocalIPs": []string{"169.254.1.5"}},
				"DriverOpts": map[string]string{"com.example.opt": "1"}, "Links": []string{"db:database"}, "GwPriority": 10,
			},
			"gateway-db-0123456789abcdef": {"NetworkID": "id-db", "EndpointID": "ep-2", "IPAddress": "172.21.0.3"},
			"bridge":                      {"NetworkID": "id-bridge", "EndpointID": "ep-3", "IPAddress": "172.17.0.4"},
		},
	}
}

func (e *fakeIsolationEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *fakeIsolationEngine) networkName(ref string) string {
	for name, id := range e.networks {
		if name == ref || id == ref {
			return name
		}
	}
	return ""
}

func (e *fakeIsolationEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	parts := strings.Split(strings.Trim(path, "/"), "/")
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && len(parts) == 3 && parts[0] == "containers" && parts[2] == "json":
		if parts[1] != "app" && parts[1] != isolationContainerID {
			return respond(http.StatusNotFound, `{"message":"No such container: `+parts[1]+`"}`)
		}
		body, _ := json.Marshal(map[string]any{
			"Id": isolationContainerID, "Name": "/app",
			"Config":          map[string]any{"Image": "app:1"},
			"HostConfig":      map[string]any{"NetworkMode": e.networkMode},
			"State":           map[string]any{"Running": true, "Status": "running"},
			"NetworkSettings": map[string]any{"Networks": e.attached},
		})
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodGet && len(parts) == 2 && parts[0] == "networks":
		name := e.networkName(parts[1])
		if name == "" {
			return respond(http.StatusNotFound, `{"message":"network `+parts[1]+` not found"}`)
		}
		body, _ := json.Marshal(map[string]any{"Name": name, "Id": e.networks[name]})
		return respond(http.StatusOK, string(body))
	case request.Method == http.MethodPost && len(parts) == 3 && parts[0] == "networks":
		var payload struct {
			Container      string
			Force          bool
			EndpointConfig map[string]any
		}
		raw, _ := io.ReadAll(request.Body)
		if err := json.Unmarshal(raw, &payload); err != nil {
			e.t.Errorf("decode %s body: %v", path, err)
		}
		if payload.Container != isolationContainerID {
			e.t.Errorf("%s for container %q, want the container ID", path, payload.Container)
		}
		name := e.networkName(parts[1])
		if name == "" {
			return respond(http.StatusNotFound, `{"message":"network `+parts[1]+` not found"}`)
		}
		switch parts[2] {
		case "disconnect":
			if !payload.Force {
				e.t.Errorf("disconnect from %s without force", name)
			}
			if name == e.disconnectFails {
				return respond(http.StatusInternalServerError, `{"message":"disconnect refused"}`)
			}
			delete(e.attached, name)
			e.disconnects = append(e.disconnects, name)
			return respond(http.StatusOK, "")
		case "connect":
			if _, exists := e.attached[name]; exists {
				return respond(http.StatusForbidden,
					`{"message":"endpoint with name app already exists in network `+name+`"}`)
			}
			endpoint := payload.EndpointConfig
			if endpoint == nil {
				endpoint = map[string]any{}
			}
			endpoint["NetworkID"] = e.networks[name]
			e.attached[name] = endpoint
			e.connects = append(e.connects, fakeConnect{network: name, endpoint: payload.EndpointConfig})
			return respond(http.StatusOK, "")
		}
	}
	e.t.Errorf("unexpected request %s %s", request.Method, path)
	return respond(http.StatusNotFound, `{"message":"unexpected"}`)
}

func TestIsolateContainerNetworksCollectsSettingsAndDisconnectsAll(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	result, err := engine.client().IsolateContainerNetworks(context.Background(), "app")
	if err != nil {
		t.Fatalf("isolate: %v", err)
	}
	if result.NetworkMode != "app-net" {
		t.Fatalf("network mode = %q", result.NetworkMode)
	}
	names := []string{}
	for _, endpoint := range result.Endpoints {
		names = append(names, endpoint.NetworkName)
	}
	if want := []string{"app-net", "bridge", "gateway-db-0123456789abcdef"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("endpoints = %v, want %v", names, want)
	}
	app := result.Endpoints[0]
	want := IsolatedEndpoint{
		NetworkID: "id-app", NetworkName: "app-net", Aliases: []string{"api"}, IPv4Address: "172.20.0.5",
		LinkLocalIPs: []string{"169.254.1.5"}, Links: []string{"db:database"},
		DriverOpts: map[string]string{"com.example.opt": "1"}, GwPriority: 10,
	}
	if !reflect.DeepEqual(app, want) {
		t.Fatalf("app-net endpoint = %+v, want %+v", app, want)
	}
	if db := result.Endpoints[2]; db.IPv4Address != "" || len(db.Aliases) != 0 || db.NetworkID != "id-db" {
		t.Fatalf("dynamic endpoint carried operational data: %+v", db)
	}
	if len(engine.attached) != 0 {
		t.Fatalf("container still attached to %v", engine.attached)
	}
	detail, _ := json.Marshal(result)
	for _, key := range []string{`"networkMode":"app-net"`, `"networkId":"id-app"`, `"aliases":["api"]`, `"ipv6Address":""`,
		`"linkLocalIps":["169.254.1.5"]`, `"macAddress":""`, `"gwPriority":10`, `"driverOpts":{}`} {
		if !strings.Contains(string(detail), key) {
			t.Fatalf("detail %s lacks %s", detail, key)
		}
	}
}

func TestIsolateContainerNetworksRefusesSharedNetworkStacks(t *testing.T) {
	for _, mode := range []string{"host", "container:other"} {
		engine := newFakeIsolationEngine(t)
		engine.networkMode = mode
		if mode == "host" {
			engine.attached = map[string]map[string]any{"host": {"NetworkID": "id-host"}}
		} else {
			engine.attached = map[string]map[string]any{}
		}
		_, err := engine.client().IsolateContainerNetworks(context.Background(), "app")
		if err == nil || !strings.HasPrefix(err.Error(), hostNetworkIsolationPrefix) {
			t.Fatalf("mode %s: err = %v, want %s prefix", mode, err, hostNetworkIsolationPrefix)
		}
		if len(engine.disconnects) != 0 {
			t.Fatalf("mode %s disconnected %v", mode, engine.disconnects)
		}
	}
}

func TestIsolateContainerNetworksAlreadyIsolatedIsEmpty(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	engine.attached = map[string]map[string]any{}
	result, err := engine.client().IsolateContainerNetworks(context.Background(), "app")
	if err != nil {
		t.Fatalf("isolate: %v", err)
	}
	if result.Endpoints == nil || len(result.Endpoints) != 0 {
		t.Fatalf("endpoints = %#v, want empty", result.Endpoints)
	}
	detail, _ := json.Marshal(result)
	if !strings.Contains(string(detail), `"endpoints":[]`) {
		t.Fatalf("detail = %s", detail)
	}
}

func TestIsolateContainerNetworksRollsBackPartialDisconnect(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	engine.disconnectFails = "gateway-db-0123456789abcdef"
	_, err := engine.client().IsolateContainerNetworks(context.Background(), "app")
	if err == nil || !strings.Contains(err.Error(), "disconnect refused") {
		t.Fatalf("err = %v, want the disconnect failure", err)
	}
	for _, name := range []string{"app-net", "bridge", "gateway-db-0123456789abcdef"} {
		if _, ok := engine.attached[name]; !ok {
			t.Fatalf("container not attached to %s after rollback: %v", name, engine.attached)
		}
	}
	if len(engine.connects) != 2 || engine.connects[0].network != "app-net" || engine.connects[1].network != "bridge" {
		t.Fatalf("rollback connects = %+v", engine.connects)
	}
	ipam, _ := engine.connects[0].endpoint["IPAMConfig"].(map[string]any)
	if ipam["IPv4Address"] != "172.20.0.5" {
		t.Fatalf("rollback lost the static address: %+v", engine.connects[0].endpoint)
	}
}

func TestRestoreContainerNetworksConnectsWithSameSettings(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	cli := engine.client()
	isolated, err := cli.IsolateContainerNetworks(context.Background(), "app")
	if err != nil {
		t.Fatalf("isolate: %v", err)
	}
	payload, _ := json.Marshal(map[string]any{"endpoints": isolated.Endpoints})
	endpoints, err := decodeNetworkRestoreEndpoints(string(payload))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	result, err := cli.RestoreContainerNetworks(context.Background(), isolationContainerID, endpoints)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if want := []string{"app-net", "bridge", "gateway-db-0123456789abcdef"}; !reflect.DeepEqual(result.Restored, want) {
		t.Fatalf("restored = %v, want %v", result.Restored, want)
	}
	if len(result.Failed) != 0 {
		t.Fatalf("failed = %+v", result.Failed)
	}
	if engine.connects[0].network != "app-net" {
		t.Fatalf("primary network connected as %s, want app-net first", engine.connects[0].network)
	}
	endpoint := engine.connects[0].endpoint
	ipam, _ := endpoint["IPAMConfig"].(map[string]any)
	if ipam["IPv4Address"] != "172.20.0.5" || !reflect.DeepEqual(ipam["LinkLocalIPs"], []any{"169.254.1.5"}) {
		t.Fatalf("IPAM config = %+v", ipam)
	}
	if !reflect.DeepEqual(endpoint["Aliases"], []any{"api"}) || !reflect.DeepEqual(endpoint["Links"], []any{"db:database"}) {
		t.Fatalf("aliases/links = %v / %v", endpoint["Aliases"], endpoint["Links"])
	}
	if opts, _ := endpoint["DriverOpts"].(map[string]any); opts["com.example.opt"] != "1" {
		t.Fatalf("driver opts = %v", endpoint["DriverOpts"])
	}
	if endpoint["GwPriority"] != float64(10) {
		t.Fatalf("gw priority = %v", endpoint["GwPriority"])
	}
	if mac, _ := endpoint["MacAddress"].(string); mac != "" {
		t.Fatalf("restore set the dynamic MAC address %q", mac)
	}
	if engine.connects[1].endpoint["IPAMConfig"] != nil {
		t.Fatalf("dynamic endpoint got an IPAM config: %+v", engine.connects[1].endpoint)
	}

	// A second restore finds every network attached and connects nothing.
	again, err := cli.RestoreContainerNetworks(context.Background(), "app", endpoints)
	if err != nil || len(again.Restored) != 3 || len(engine.connects) != 3 {
		t.Fatalf("second restore = %+v, %v; connects %d", again, err, len(engine.connects))
	}
}

// A network removed meanwhile (with its binding or link) is gone, not failed: retrying cannot bring it back.
func TestRestoreContainerNetworksCountsRemovedNetworksAsGone(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	engine.attached = map[string]map[string]any{}
	endpoints := []IsolatedEndpoint{
		{NetworkID: "id-gone", NetworkName: "gone-net"},
		{NetworkID: "id-zeta", NetworkName: "zeta-renamed"},
		{NetworkID: "id-app", NetworkName: "app-net", Aliases: []string{"api"}},
	}
	result, err := engine.client().RestoreContainerNetworks(context.Background(), "app", endpoints)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if want := []string{"app-net", "zeta-renamed"}; !reflect.DeepEqual(result.Restored, want) {
		t.Fatalf("restored = %v, want %v", result.Restored, want)
	}
	if want := []string{"gone-net"}; !reflect.DeepEqual(result.Gone, want) {
		t.Fatalf("gone = %v, want %v", result.Gone, want)
	}
	if len(result.Failed) != 0 || result.NetworkModeGone != "" || result.FallbackNetwork != "" {
		t.Fatalf("result = %+v", result)
	}
	if _, ok := engine.attached["zeta-net"]; !ok {
		t.Fatalf("renamed network not connected by id: %v", engine.attached)
	}
}

// The network mode names the removed binding's network and nothing else was left: the container joins the default
// bridge network, so Docker can start it.
func TestRestoreContainerNetworksPutsAContainerWhoseNetworkModeIsGoneOnTheBridge(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	engine.networkMode = "gateway-db-fedcba9876543210"
	engine.attached = map[string]map[string]any{}
	endpoints := []IsolatedEndpoint{{NetworkID: "id-removed", NetworkName: "gateway-db-fedcba9876543210"}}
	result, err := engine.client().RestoreContainerNetworks(context.Background(), "app", endpoints)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if want := []string{"gateway-db-fedcba9876543210"}; !reflect.DeepEqual(result.Gone, want) {
		t.Fatalf("gone = %v, want %v", result.Gone, want)
	}
	if len(result.Failed) != 0 || len(result.Restored) != 0 {
		t.Fatalf("result = %+v", result)
	}
	if result.NetworkModeGone != "gateway-db-fedcba9876543210" || result.FallbackNetwork != "bridge" {
		t.Fatalf("network mode gone = %q, fallback = %q", result.NetworkModeGone, result.FallbackNetwork)
	}
	if _, ok := engine.attached["bridge"]; !ok {
		t.Fatalf("container not on the bridge network: %v", engine.attached)
	}
	detail, _ := json.Marshal(result)
	for _, key := range []string{`"gone":["gateway-db-fedcba9876543210"]`, `"networkModeGone":"gateway-db-fedcba9876543210"`,
		`"fallbackNetwork":"bridge"`} {
		if !strings.Contains(string(detail), key) {
			t.Fatalf("detail %s lacks %s", detail, key)
		}
	}
}

// With another network restored, a gone network mode is reported and the container stays on what it had: Docker
// starts a container that is on a network without looking up its network mode.
func TestRestoreContainerNetworksKeepsRestoredNetworksWhenTheNetworkModeIsGone(t *testing.T) {
	engine := newFakeIsolationEngine(t)
	engine.networkMode = "gateway-db-fedcba9876543210"
	engine.attached = map[string]map[string]any{}
	endpoints := []IsolatedEndpoint{
		{NetworkID: "id-removed", NetworkName: "gateway-db-fedcba9876543210"},
		{NetworkID: "id-app", NetworkName: "app-net"},
	}
	result, err := engine.client().RestoreContainerNetworks(context.Background(), "app", endpoints)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if !reflect.DeepEqual(result.Restored, []string{"app-net"}) ||
		!reflect.DeepEqual(result.Gone, []string{"gateway-db-fedcba9876543210"}) || len(result.Failed) != 0 {
		t.Fatalf("result = %+v", result)
	}
	if result.NetworkModeGone != "gateway-db-fedcba9876543210" || result.FallbackNetwork != "" {
		t.Fatalf("network mode gone = %q, fallback = %q", result.NetworkModeGone, result.FallbackNetwork)
	}
	if _, ok := engine.attached["bridge"]; ok {
		t.Fatalf("container joined the bridge network although it has app-net: %v", engine.attached)
	}
}

func TestDecodeNetworkRestoreEndpointsRejectsBadPayloads(t *testing.T) {
	for _, payload := range []string{"", "{", `{}`, `{"endpoints":[{}]}`, `{"endpoints":[{"networkName":"a","ipv4Address":"x"}]}`} {
		if _, err := decodeNetworkRestoreEndpoints(payload); err == nil {
			t.Fatalf("payload %q accepted", payload)
		}
	}
	endpoints, err := decodeNetworkRestoreEndpoints(`{"endpoints":[]}`)
	if err != nil || len(endpoints) != 0 {
		t.Fatalf("empty endpoints = %v, %v", endpoints, err)
	}
}
