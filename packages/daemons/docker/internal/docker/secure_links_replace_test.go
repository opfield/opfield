package docker

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

const (
	replaceTestOldImage = "ghcr.io/the-square-labs/gateway/secure-link-connector@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	replaceTestNewImage = "ghcr.io/the-square-labs/gateway/secure-link-connector@sha256:2222222222222222222222222222222222222222222222222222222222222222"
	replaceTestLinkID   = "0f6c8d3e-5b1a-4c2d-9e8f-7a6b5c4d3e2f"
)

// fakeConnectorEngine is a Docker Engine API with a running connector and a
// link target "app". A started connector container serves its control socket
// like the real connector.
type fakeConnectorEngine struct {
	t          *testing.T
	controlDir string
	mu         sync.Mutex
	// containers maps a container name to its state.
	containers map[string]*fakeConnectorContainer
	created    int
	pulled     []string
	removed    []string
	// syncFails makes the control socket of a connector created from now on refuse syncs.
	syncFails bool
	// egressFails makes a connector created from now on fail its egress listeners.
	egressFails bool
	// legacyImages are connector images of an earlier release: no anchor label.
	legacyImages map[string]bool
	// events is the event stream the engine serves (nil: none).
	events io.Reader
	// handover makes connectors created from now on answer handover requests like a connector of this release.
	handover bool
	// onSync, when set, applies a connector's sync before the connector answers it (a connector that serves its
	// egress listeners, live_handover_egress_test.go).
	onSync func(current *fakeConnectorContainer, request securelink.SyncRequest)
}

type fakeConnectorContainer struct {
	id, name, image, ip string
	groups              []string
	slot                int
	running             bool
	syncFails           bool
	egressFails         bool
	listener            net.Listener
	// requests are the control requests the connector received; networks are the link networks it was attached to.
	requests []securelink.SyncRequest
	networks map[string]map[string]any
	// networkMode is a connector's "container:<anchor id>"; anchor marks the anchor container.
	networkMode string
	anchor      bool
	// pidsLimit overrides a connector's pids limit (a shape that drifted).
	pidsLimit int64
	// drainFails makes the connector's drain request fail, as when its control socket is out of the daemon's reach.
	drainFails bool
	// signals are the signals the connector received.
	signals []string
	// draining: told to drain (a drain request or the drain signal), the connector refuses every sync.
	draining bool
	// active is the sessions the connector answers a drain request with.
	active int
	// removing: another removal of the container runs; a remove request is refused with "already in progress" and
	// the container goes shortly after.
	removing bool
	// handover answers handover requests like a connector of this release (else like one of an earlier release:
	// unsupported); handovers are the requests it received, and handoverResult what it answers (it then carries
	// active sessions).
	handover       bool
	handovers      []securelink.SyncRequest
	handoverResult securelink.HandoverResult
}

// fakeAnchor is a running anchor, as a daemon finds it after its restart.
func fakeAnchor(image, ip string) *fakeConnectorContainer {
	return &fakeConnectorContainer{id: "anchor-id", name: secureLinkAnchorName, image: image, ip: ip, running: true, anchor: true}
}

func newFakeConnectorEngine(t *testing.T) *fakeConnectorEngine {
	engine := &fakeConnectorEngine{t: t, controlDir: sockettest.Dir(t), containers: map[string]*fakeConnectorContainer{}}
	t.Cleanup(func() {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		for _, current := range engine.containers {
			if current.listener != nil {
				current.listener.Close()
			}
		}
	})
	return engine
}

func (e *fakeConnectorEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

// serveControl answers syncs like the connector: one port per binding.
func (e *fakeConnectorEngine) serveControl(current *fakeConnectorContainer) {
	path := filepath.Join(e.controlDir, secureLinkConnectorSlots[current.slot].socket)
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		e.t.Errorf("connector control socket: %v", err)
		return
	}
	current.listener = listener
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			var request securelink.SyncRequest
			if securelink.ReadJSON(connection, &request) == nil && request.Version == securelink.ProtocolVersionHandover {
				e.mu.Lock()
				current.handovers = append(current.handovers, request)
				response := securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: securelink.UnsupportedVersionError}
				if current.handover {
					current.draining = true
					result := current.handoverResult
					current.active = 0
					for _, n := range result.Left {
						current.active += n
					}
					response = securelink.SyncResponse{Version: securelink.ProtocolVersionHandover, Handover: &result, Active: current.active}
				}
				e.mu.Unlock()
				_ = securelink.WriteJSON(connection, response)
				connection.Close()
				continue
			} else if request.Version != 0 {
				e.mu.Lock()
				current.requests = append(current.requests, request)
				egressFails, drainFails, active := current.egressFails, current.drainFails, current.active
				if request.Drain && !drainFails {
					current.draining = true
				}
				draining := current.draining
				onSync := e.onSync
				e.mu.Unlock()
				if onSync != nil && !request.Drain && !draining {
					onSync(current, request)
				}
				if request.Drain {
					response := securelink.SyncResponse{Version: securelink.ProtocolVersion, Active: active}
					if drainFails {
						response.Error = "control socket out of reach"
					}
					_ = securelink.WriteJSON(connection, response)
					connection.Close()
					continue
				}
				if draining {
					_ = securelink.WriteJSON(connection, securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: securelink.ShuttingDownError})
					connection.Close()
					continue
				}
				response := securelink.SyncResponse{Version: securelink.ProtocolVersion}
				for _, egress := range request.Egress {
					status := securelink.EgressStatus{ID: egress.ID, Generation: egress.Generation, State: securelink.EgressListening}
					if egressFails {
						status.State, status.Error = securelink.EgressError, "address in use"
					}
					response.Egress = append(response.Egress, status)
				}
				if current.syncFails {
					response.Error = "bind failed"
				}
				for index, binding := range request.Bindings {
					if binding.ListenHost != current.ip {
						response.Error = "listen host " + binding.ListenHost + " is not this connector"
					}
					response.Bindings = append(response.Bindings, securelink.BindingStatus{
						ID: binding.ID, Generation: binding.Generation, Port: uint16(20000 + current.slot*100 + index),
					})
				}
				_ = securelink.WriteJSON(connection, response)
			}
			connection.Close()
		}
	}()
}

func (e *fakeConnectorEngine) byIDOrName(value string) *fakeConnectorContainer {
	for _, current := range e.containers {
		if current.id == value || current.name == value {
			return current
		}
	}
	return nil
}

// connectorNetworks are a connector's endpoints: none in the anchor's namespace, its own (the management network and
// what was attached) when its image has no anchor.
func (e *fakeConnectorEngine) connectorNetworks(current *fakeConnectorContainer) map[string]any {
	networks := map[string]any{}
	if strings.HasPrefix(current.networkMode, "container:") {
		return networks
	}
	networks[secureLinkManagementNetwork] = map[string]any{"IPAddress": current.ip, "NetworkID": "management"}
	for name, endpoint := range current.networks {
		networks[name] = endpoint
	}
	return networks
}

func (e *fakeConnectorEngine) connectorInspect(current *fakeConnectorContainer) map[string]any {
	if current.anchor {
		// The anchor holds the endpoints: the management network and what was attached.
		networks := map[string]any{secureLinkManagementNetwork: map[string]any{"IPAddress": current.ip, "NetworkID": "management"}}
		for name, endpoint := range current.networks {
			networks[name] = endpoint
		}
		return map[string]any{
			"Id": current.id, "Name": "/" + current.name,
			"Config": map[string]any{
				"Image": current.image, "User": "65532:65532", "Cmd": secureLinkAnchorCommand,
				"Labels": map[string]string{"net.opfield.managed": "secure-link-connector", secureLinkRoleLabel: secureLinkAnchorRole},
			},
			"HostConfig": map[string]any{
				"ReadonlyRootfs": true, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"},
				"RestartPolicy": map[string]any{"Name": "unless-stopped"}, "NetworkMode": secureLinkManagementNetwork,
				"Memory": secureLinkAnchorMemory, "PidsLimit": secureLinkAnchorPidsLimit, "Sysctls": secureLinkAnchorSysctls(),
			},
			"State":           map[string]any{"Running": current.running},
			"NetworkSettings": map[string]any{"Networks": networks},
		}
	}
	return map[string]any{
		"Id": current.id, "Name": "/" + current.name,
		"Config": map[string]any{
			"Image": current.image, "User": "65532:65532", "Env": secureLinkConnectorEnv(current.slot),
			"Labels": map[string]string{"net.opfield.managed": "secure-link-connector"},
		},
		"HostConfig": map[string]any{
			"Binds": []string{e.controlDir + ":" + secureLinkConnectorMount}, "ReadonlyRootfs": true, "CapDrop": []string{"ALL"},
			"SecurityOpt": []string{"no-new-privileges:true"}, "RestartPolicy": map[string]any{"Name": "unless-stopped"},
			"Memory": secureLinkConnectorMemory(), "NanoCpus": secureLinkConnectorNanoCPUs, "PidsLimit": connectorPids(current),
			"GroupAdd": current.groups, "NetworkMode": current.networkMode,
		},
		"State":           map[string]any{"Running": current.running},
		"NetworkSettings": map[string]any{"Networks": e.connectorNetworks(current)},
	}
}

func (e *fakeConnectorEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body any) (*http.Response, error) {
		encoded, _ := json.Marshal(body)
		if text, ok := body.(string); ok {
			encoded = []byte(text)
		}
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(string(encoded))), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case path == "/events" && e.events != nil:
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(e.events), Request: request}, nil
	case strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		image := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
		e.pulled = append(e.pulled, image)
		labels := map[string]string{secureLinkAnchorImageLabel: secureLinkAnchorImageVersion}
		if e.legacyImages[image] {
			labels = nil
		}
		return respond(http.StatusOK, map[string]any{"Id": "sha256:image", "Config": map[string]any{"Labels": labels}})
	case request.Method == http.MethodGet && path == "/networks/"+secureLinkManagementNetwork:
		return respond(http.StatusOK, map[string]any{
			"Name": secureLinkManagementNetwork, "Id": "management", "Driver": "bridge", "Internal": true,
			"Labels": map[string]string{"net.opfield.managed": "secure-link"},
			"IPAM":   map[string]any{"Config": []map[string]string{{"Subnet": "10.99.0.0/24", "Gateway": "10.99.0.1"}}},
		})
	case parts[0] == "networks" && len(parts) == 3 && (parts[2] == "connect" || parts[2] == "disconnect"):
		return respond(http.StatusOK, map[string]any{})
	case request.Method == http.MethodPost && path == "/containers/create":
		name := request.URL.Query().Get("name")
		if e.containers[name] != nil {
			return respond(http.StatusConflict, `{"message":"name in use"}`)
		}
		var body struct {
			Image      string
			HostConfig struct {
				GroupAdd    []string
				NetworkMode string
			}
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.created++
		slot := 0
		for index, candidate := range secureLinkConnectorSlots {
			if name == candidate.name {
				slot = index
			}
		}
		created := &fakeConnectorContainer{
			id: fmt.Sprintf("created-%d", e.created), name: name, image: body.Image, groups: body.HostConfig.GroupAdd, slot: slot,
			ip: fmt.Sprintf("10.99.0.%d", 10+e.created), syncFails: e.syncFails, egressFails: e.egressFails, anchor: name == secureLinkAnchorName,
			networkMode: body.HostConfig.NetworkMode, handover: e.handover,
		}
		// A connector in the anchor's network namespace has the anchor's addresses.
		if anchor := e.byIDOrName(strings.TrimPrefix(body.HostConfig.NetworkMode, "container:")); anchor != nil {
			created.ip = anchor.ip
		}
		e.containers[name] = created
		return respond(http.StatusCreated, map[string]any{"Id": created.id})
	case parts[0] == "containers" && len(parts) >= 2:
		current := e.byIDOrName(parts[1])
		if current == nil {
			return respond(http.StatusNotFound, `{"message":"No such container: `+parts[1]+`"}`)
		}
		switch {
		case request.Method == http.MethodGet && len(parts) == 3 && parts[2] == "json":
			if current.name == "app" {
				return respond(http.StatusOK, map[string]any{
					"Id": current.id, "Name": "/app", "State": map[string]any{"Running": true},
					"HostConfig":      map[string]any{"NetworkMode": "app-net"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{"app-net": map[string]any{"IPAddress": current.ip}}},
				})
			}
			return respond(http.StatusOK, e.connectorInspect(current))
		case request.Method == http.MethodPost && len(parts) == 3 && (parts[2] == "start" || parts[2] == "restart"):
			current.running = true
			if !current.anchor {
				if current.listener != nil {
					current.listener.Close()
				}
				e.serveControl(current)
			}
			return respond(http.StatusNoContent, "")
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "kill":
			current.signals = append(current.signals, request.URL.Query().Get("signal"))
			if request.URL.Query().Get("signal") == secureLinkDrainSignal {
				current.draining = true
			}
			return respond(http.StatusNoContent, "")
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "update":
			return respond(http.StatusOK, map[string]any{})
		case request.Method == http.MethodDelete && len(parts) == 2 && current.removing:
			current.removing = false
			go func() {
				time.Sleep(50 * time.Millisecond)
				e.mu.Lock()
				defer e.mu.Unlock()
				if current.listener != nil {
					current.listener.Close()
				}
				delete(e.containers, current.name)
				e.removed = append(e.removed, current.id)
			}()
			return respond(http.StatusConflict, `{"message":"removal of container `+current.id+` is already in progress"}`)
		case request.Method == http.MethodDelete && len(parts) == 2:
			if current.listener != nil {
				current.listener.Close()
			}
			delete(e.containers, current.name)
			e.removed = append(e.removed, current.id)
			return respond(http.StatusNoContent, "")
		}
	}
	e.t.Errorf("unexpected Docker API call %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

// container is the named container, read under the engine's lock (a
// replaced connector's removal runs on its own goroutine).
func (e *fakeConnectorEngine) container(name string) *fakeConnectorContainer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.containers[name]
}

func (e *fakeConnectorEngine) removedIDs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.removed...)
}

// replaceTestManager serves the link through a connector running the old
// image, as after an earlier Relay update.
func replaceTestManager(t *testing.T) (*dockerSecureLinkManager, *fakeConnectorEngine) {
	t.Helper()
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	return manager, engine
}

func replaceTestCommand(image string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: replaceTestLinkID, Role: "target", Generation: 1, TargetContainer: "app", TargetNetwork: "app-net",
		TargetPort: 8080, ConnectorImage: image,
	}}}
}

// The connector image a Relay update promoted used to replace the connector in place on every Docker node, and every
// Secure Link route failed for seconds until the new one was pulled, started and bound. The new connector
// now starts next to the serving one; dials switch once it is bound, and the previous one goes when its tunnels
// are idle.
func TestNewConnectorImageReplacesTheConnectorWithoutAGap(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView()
	previousContainer := engine.container(secureLinkConnectorSlots[0].name)
	if previous.connectorID != "created-2" || previous.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("serving view = %+v", previous)
	}
	// A request in flight through the serving connector when the update arrives.
	busyTunnel := newDrainConn(&connectorConn{Conn: nopConn{}, connectorID: previous.connectorID})
	busyTunnel.lastWrite.Store(time.Now().UnixNano())
	cancelled := make(chan struct{})
	release := manager.plugin.proxyTunnels.add(busyTunnel, func() { close(cancelled) })
	defer release()
	limit := secureLinkConnectorRetireLimit
	secureLinkConnectorRetireLimit = 5 * time.Second
	defer func() { secureLinkConnectorRetireLimit = limit }()

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}

	current := manager.currentView()
	if current.connectorID != "created-3" || current.managementIP != previous.managementIP || manager.anchorID != "created-1" {
		t.Fatalf("dials use %+v (anchor %s), want the new connector on the same addresses", current, manager.anchorID)
	}
	if port := current.bindings[replaceTestLinkID].port; port != 20100 {
		t.Fatalf("link bound on port %d, want the new connector's port", port)
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("connectors removed before their tunnels finished: %v", removed)
	}
	// The answer went out: the tunnel is idle between requests and closes, then the previous connector goes.
	busyTunnel.lastRead.Store(time.Now().UnixNano())
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("the idle tunnel through the replaced connector was not closed")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(engine.removedIDs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "created-2" || !receivedDrain(engine, previousContainer) {
		t.Fatalf("removed %v, want only the replaced connector, after it was told to drain", removed)
	}

	// The next image change takes the first slot again.
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply back to the first image: %v", err)
	}
	if view := manager.currentView(); view.connectorID != "created-4" || manager.slot != 0 {
		t.Fatalf("second replacement view %+v slot %d", view, manager.slot)
	}
}

// A replacement that cannot bind its links leaves the serving connector as it was.
func TestFailedConnectorReplacementKeepsTheServingConnector(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView()
	engine.mu.Lock()
	engine.syncFails = true
	engine.mu.Unlock()

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err == nil {
		t.Fatal("apply succeeded although the new connector refused its links")
	}

	current := manager.currentView()
	if current.connectorID != previous.connectorID || current.bindings[replaceTestLinkID] != previous.bindings[replaceTestLinkID] {
		t.Fatalf("view after the failed replacement = %+v, want %+v", current, previous)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "created-3" {
		t.Fatalf("removed %v, want only the failed replacement", removed)
	}
}

// After a daemon restart the connector already running the committed image is kept and a leftover of an
// interrupted replacement is removed.
func TestDaemonStartKeepsTheConnectorRunningTheImage(t *testing.T) {
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	// Both were created by this daemon before its restart, so they carry the groups it gives connectors, and run in
	// the anchor's network namespace.
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	old := &fakeConnectorContainer{id: "old-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage, groups: connectorGroupAdd(),
		ip: anchor.ip, running: true, networkMode: "container:" + anchor.id}
	current := &fakeConnectorContainer{id: "next-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage, groups: connectorGroupAdd(),
		ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	engine.containers[old.name], engine.containers[current.name], engine.containers[anchor.name] = old, current, anchor
	engine.serveControl(old)
	engine.serveControl(current)
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()

	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != "next-id" || manager.slot != 1 {
		t.Fatalf("restored view %+v slot %d, want the connector running the image", view, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "old-id" {
		t.Fatalf("removed %v, want the leftover connector", removed)
	}
}

func connectorPids(current *fakeConnectorContainer) int64 {
	if current.pidsLimit != 0 {
		return current.pidsLimit
	}
	return secureLinkConnectorPidsLimit
}

// receivedDrain reports a connector told to stop accepting (its replacement took its addresses over).
func receivedDrain(engine *fakeConnectorEngine, connector *fakeConnectorContainer) bool {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, request := range connector.requests {
		if request.Drain {
			return true
		}
	}
	return false
}

type nopConn struct{ net.Conn }

func (nopConn) Close() error { return nil }
