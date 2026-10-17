package docker

import (
	"encoding/json"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

const (
	egressTestLinkID  = "6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
	egressTestNetwork = legacycompat.ContainerLinkNetworkPrefix + "6a1b2c3d4e5f4a6b"
	egressTestDBNet   = legacycompat.DatabaseLinkNetworkPrefix + "0123456789abcdef"
	// egressTestStorageNet is a storage link network created before the pool: Docker's subnet, no reserved address.
	egressTestStorageNet = legacycompat.StorageLinkNetworkPrefix + "0011223344556677"
)

// egressFakeEngine adds the link networks of create_link_network to the connector engine: network inspects, and
// connects that record the connector's address and aliases there.
type egressFakeEngine struct {
	*fakeConnectorEngine
	removedNetworks []string
	// gateways are database link networks created before (no reserved address), by name, with their gateway.
	gateways map[string]string
	// sidecars hold addresses on the storage network (container id to IPv4), like a storage link's sidecar.
	sidecars map[string]string
	// storageUserSubnet gives the storage network its own IPAM configuration (else one of Docker's default pools);
	// failAddressedConnect makes every connect at a chosen address fail.
	storageUserSubnet    bool
	failAddressedConnect bool
}

func (e *egressFakeEngine) serveNetwork(name, gateway string) {
	if e.gateways == nil {
		e.gateways = map[string]string{}
	}
	e.gateways[name] = gateway
}

func (e *egressFakeEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serveLinks)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (e *egressFakeEngine) serveLinks(request *http.Request) (*http.Response, error) {
	respond := func(code int, body any) (*http.Response, error) {
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(string(encoded))), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if parts[0] != "networks" || len(parts) < 2 {
		return e.serve(request)
	}
	name := parts[1]
	switch {
	case request.Method == http.MethodDelete && len(parts) == 2:
		e.mu.Lock()
		e.removedNetworks = append(e.removedNetworks, name)
		e.mu.Unlock()
		return respond(http.StatusNoContent, map[string]any{})
	case name == egressTestNetwork && request.Method == http.MethodGet:
		e.mu.Lock()
		defer e.mu.Unlock()
		containers := map[string]any{}
		for _, current := range e.containers {
			if endpoint := current.networks[egressTestNetwork]; endpoint != nil {
				containers[current.id] = map[string]any{"Name": current.name, "IPv4Address": endpoint["IPAddress"].(string) + "/26"}
			}
		}
		return respond(http.StatusOK, map[string]any{
			"Name": egressTestNetwork, "Id": "link-net-id", "Driver": "bridge", "Internal": true,
			"Labels":     map[string]string{"net.opfield.managed": linkNetworkLabel},
			"IPAM":       map[string]any{"Config": []map[string]string{{"Subnet": "10.213.0.0/26", "Gateway": "10.213.0.1", "IPRange": "10.213.0.32/27"}}},
			"Containers": containers,
		})
	case name == egressTestStorageNet && request.Method == http.MethodGet:
		e.mu.Lock()
		defer e.mu.Unlock()
		containers := map[string]any{}
		for _, current := range e.containers {
			if endpoint := current.networks[egressTestStorageNet]; endpoint != nil {
				containers[current.id] = map[string]any{"Name": current.name, "IPv4Address": endpoint["IPAddress"].(string) + "/24"}
			}
		}
		for id, address := range e.sidecars {
			containers[id] = map[string]any{"Name": legacycompat.StorageConnectorPrefix + id, "IPv4Address": address + "/24"}
		}
		ipam := map[string]string{"Subnet": "172.31.0.0/24", "Gateway": "172.31.0.1"}
		if e.storageUserSubnet {
			ipam["IPRange"] = "172.31.0.0/24"
		}
		return respond(http.StatusOK, map[string]any{
			"Name": egressTestStorageNet, "Id": egressTestStorageNet + "-id", "Driver": "bridge", "Internal": true,
			"IPAM":       map[string]any{"Config": []map[string]string{ipam}},
			"Containers": containers,
		})
	case e.gateways[name] != "" && request.Method == http.MethodGet:
		return respond(http.StatusOK, map[string]any{
			"Name": name, "Id": name + "-id", "Driver": "bridge",
			"IPAM": map[string]any{"Config": []map[string]string{{"Subnet": strings.TrimSuffix(e.gateways[name], ".1") + ".0/24", "Gateway": e.gateways[name]}}},
		})
	case len(parts) == 3 && parts[2] == "connect":
		var body struct {
			Container      string
			EndpointConfig struct {
				Aliases    []string
				IPAMConfig *struct{ IPv4Address string }
			}
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.mu.Lock()
		defer e.mu.Unlock()
		current := e.byIDOrName(body.Container)
		if current == nil {
			return respond(http.StatusNotFound, map[string]string{"message": "no such container"})
		}
		addressed := body.EndpointConfig.IPAMConfig != nil && body.EndpointConfig.IPAMConfig.IPv4Address != ""
		if addressed && name == egressTestStorageNet && !e.storageUserSubnet {
			return respond(http.StatusBadRequest, map[string]string{
				"message": "user specified IP address is supported only when connecting to networks with user configured subnets"})
		}
		if addressed && e.failAddressedConnect {
			return respond(http.StatusInternalServerError, map[string]string{"message": "connect failed"})
		}
		address := "10.213.0.33"
		if name == egressTestStorageNet {
			address = "172.31.0.5"
		}
		if body.EndpointConfig.IPAMConfig != nil && body.EndpointConfig.IPAMConfig.IPv4Address != "" {
			address = body.EndpointConfig.IPAMConfig.IPv4Address
		}
		if current.networks == nil {
			current.networks = map[string]map[string]any{}
		}
		networkID := "link-net-id"
		if name != egressTestNetwork {
			networkID = name + "-id"
		}
		current.networks[name] = map[string]any{"IPAddress": address, "Aliases": body.EndpointConfig.Aliases, "NetworkID": networkID}
		return respond(http.StatusOK, map[string]any{})
	case len(parts) == 3 && parts[2] == "disconnect":
		var body struct{ Container string }
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.mu.Lock()
		defer e.mu.Unlock()
		if current := e.byIDOrName(body.Container); current != nil {
			delete(current.networks, name)
		}
		return respond(http.StatusOK, map[string]any{})
	}
	return e.serve(request)
}

func egressTestBundle(egress ...*pb.RelayGrantAssignment) *pb.SyncRelayGrantsCommand {
	return &pb.SyncRelayGrantsCommand{PolicyRevision: 1, Grants: egress}
}

func egressTestAssignment(id, networkName string) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: containerLinkOwnerKind, OwnerId: id, Grant: &pb.RelaySignedGrant{KeyId: "k"},
		SecureLinkEgress: &pb.SecureLinkEgress{NetworkName: networkName, Alias: "app", ListenPort: 8080, RouteGeneration: 3,
			ConnectorImage: replaceTestNewImage},
	}
}

func (e *egressFakeEngine) requestCount(name string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if current := e.containers[name]; current != nil {
		return len(current.requests)
	}
	return 0
}

func (e *egressFakeEngine) lastRequest(name string) securelink.SyncRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	current := e.containers[name]
	if current == nil || len(current.requests) == 0 {
		e.t.Fatalf("connector %s received no sync", name)
	}
	return current.requests[len(current.requests)-1]
}

// The connector's egress side: a node with only egress gets a connector with the egress image, joined to the link
// network at its reserved address with the link's alias. Ingress syncs keep the egress listeners, failClosed drops
// ingress only, the connector stays without ingress while egress remains, and goes with the last egress.
func TestEgressFollowsTheGrantBundle(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: engine.controlDir + "/" + secureLinkConnectorSlots[0].socket,
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	connector := secureLinkConnectorSlots[0].name
	previousWait := egressSuccessorTo
	egressSuccessorTo = 100 * time.Millisecond
	t.Cleanup(func() { egressSuccessorTo = previousWait })

	invalidID := "7b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"
	statuses := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork),
		egressTestAssignment(invalidID, "user-network")))
	ready := statuses[egressTestLinkID]
	if ready.State != egressStateReady || ready.Address != "10.213.0.2" || ready.Port != 8080 || ready.RouteGeneration != 3 {
		t.Fatalf("egress status %+v", ready)
	}
	if statuses[invalidID].State != egressStateError {
		t.Fatalf("an egress on a user network was not refused: %+v", statuses[invalidID])
	}
	endpoint := engine.container(secureLinkAnchorName).networks[egressTestNetwork]
	if endpoint["IPAddress"] != "10.213.0.2" || len(endpoint["Aliases"].([]string)) != 1 || endpoint["Aliases"].([]string)[0] != "app" {
		t.Fatalf("connector endpoint on the link network %+v", endpoint)
	}
	request := engine.lastRequest(connector)
	if len(request.Egress) != 1 || request.Egress[0].ListenHost != "10.213.0.2" || request.Egress[0].AllowedPrefix != "10.213.0.0/26" ||
		request.Egress[0].OwnerKind != containerLinkOwnerKind || request.Egress[0].ListenPort != 8080 {
		t.Fatalf("egress sent to the connector %+v", request.Egress)
	}
	if !manager.egress.listeningOn(egressTestNetwork) {
		t.Fatal("the link network is not reported as served by the connector")
	}
	// Opfield polls by sending the same bundle again: answered from the published state, without a connector sync.
	syncs := engine.requestCount(connector)
	if again := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork),
		egressTestAssignment(invalidID, "user-network"))); again[egressTestLinkID].State != egressStateReady || engine.requestCount(connector) != syncs {
		t.Fatalf("a repeated bundle synced the connector again (%d syncs, status %+v)", engine.requestCount(connector)-syncs, again[egressTestLinkID])
	}

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("ingress apply: %v", err)
	}
	if request := engine.lastRequest(connector); len(request.Bindings) != 1 || len(request.Egress) != 1 {
		t.Fatalf("an ingress sync did not keep the egress listener: %+v", request)
	}
	// The daemon dials from the management network's gateway: the ingress listeners take no other peer.
	if peer := engine.lastRequest(connector).IngressPeer; peer != "10.99.0.1" {
		t.Fatalf("ingress peer %q, want the management network gateway", peer)
	}
	manager.mu.Lock()
	manager.failClosed(t.Context())
	manager.mu.Unlock()
	if request := engine.lastRequest(connector); len(request.Bindings) != 0 || len(request.Egress) != 1 {
		t.Fatalf("failClosed did not keep the egress listener: %+v", request)
	}

	if _, err := manager.apply(&pb.SyncProxySecureLinksCommand{}, nil, nil, false); err != nil {
		t.Fatalf("apply without ingress: %v", err)
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("the connector serving egress was removed with its last ingress binding: %v", removed)
	}
	if request := engine.lastRequest(connector); len(request.Bindings) != 0 || len(request.Egress) != 1 {
		t.Fatalf("connector state without ingress %+v", request)
	}

	// An Availability re-key split over two bundles: the listener of the binding that left stays until the binding
	// that takes its socket over arrives, and both are in one connector sync then, which moves the listener.
	successorID := "8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
	if statuses := manager.syncEgress(egressTestBundle()); len(statuses) != 0 {
		t.Fatalf("statuses of an empty bundle %+v", statuses)
	}
	if request := engine.lastRequest(connector); len(request.Egress) != 1 || request.Egress[0].ID != egressTestLinkID || len(engine.removedIDs()) != 0 {
		t.Fatalf("the listener of a binding that left was not kept for its successor: %+v", request.Egress)
	}
	if statuses := manager.syncEgress(egressTestBundle(egressTestAssignment(successorID, egressTestNetwork))); statuses[successorID].State != egressStateReady {
		t.Fatalf("successor status %+v", statuses[successorID])
	}
	if request := engine.lastRequest(connector); len(request.Egress) != 1 || request.Egress[0].ID != successorID {
		t.Fatalf("the successor did not take the socket over in one sync: %+v", request.Egress)
	}

	manager.syncEgress(egressTestBundle())
	deadline := time.Now().Add(3 * time.Second)
	for len(engine.removedIDs()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if removed := engine.removedIDs(); len(removed) != 2 {
		t.Fatalf("the connector and its anchor were not removed without links: %v", removed)
	}
	if manager.egress.listeningOn(egressTestNetwork) {
		t.Fatal("the link network is still reported as served")
	}
}

// A database consumer recreated after Opfield moved its link to the connector (the grant carries an egress and no
// host listener) gets no ExtraHosts entry for the link alias: it resolves the alias through Docker's DNS to the
// connector (C6, F4). A link still on, or moving off, the host listener keeps the entry.
func TestDatabaseExtraHostsLeaveOutLinksServedByTheConnector(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	cli := engine.client()
	other := legacycompat.DatabaseLinkNetworkPrefix + "fedcba9876543210"
	migrating := legacycompat.DatabaseLinkNetworkPrefix + "00112233445566ff"
	connect := func(id, networkName string, listener bool) *pb.RelayGrantAssignment {
		assignment := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: linkKindManagedDatabaseBinding, OwnerId: id,
			SecureLinkEgress: &pb.SecureLinkEgress{NetworkName: networkName, Alias: "db", ListenPort: 5432, RouteGeneration: 2}}
		if listener {
			assignment.ManagedDatabaseListener = &pb.ManagedDatabaseListener{NetworkName: networkName}
		}
		return assignment
	}
	bundle := egressTestBundle(connect(egressTestLinkID, egressTestDBNet, false), connect("9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a", migrating, true))
	cli.databaseLinkOnConnector = func(name string) bool { return databaseLinkOnConnectorIn(bundle, name) }
	engine.serveNetwork(other, "172.30.5.1")
	engine.serveNetwork(migrating, "172.30.6.1")

	entries, err := cli.managedDatabaseHostEntries(t.Context(), []string{egressTestDBNet, other, "app-net"})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0] != "db-fedcba9876543210:172.30.5.1" {
		t.Fatalf("ExtraHosts entries %v", entries)
	}
	merged := mergeManagedDatabaseExtraHosts([]string{"db-0123456789abcdef:172.30.4.1", "cache:10.0.0.3"}, entries)
	if strings.Join(merged, ",") != "cache:10.0.0.3,db-fedcba9876543210:172.30.5.1" {
		t.Fatalf("a recreate kept the host listener entry of a link the connector serves: %v", merged)
	}
	if entries, err := cli.managedDatabaseHostEntries(t.Context(), []string{migrating}); err != nil || len(entries) != 1 {
		t.Fatalf("a link whose grant still names the host listener lost its entry: %v %v", entries, err)
	}
	// Migrating: the host listener serves the consumers not moved yet, and the ones recreated now use the alias.
	bundle.Grants[1].SecureLinkEgress.ConsumersUseAlias = true
	if entries, err := cli.managedDatabaseHostEntries(t.Context(), []string{migrating}); err != nil || len(entries) != 0 {
		t.Fatalf("a consumer recreated during the migration kept the host listener entry: %v %v", entries, err)
	}
}

// A daemon start (an update's next process) restores the connector's ingress bindings before it syncs the egress. The
// connector keeps the egress listeners the previous process gave it, and with them the workloads' link connections
// that process handed over: every sync of the new process names them, or the connector closes the listeners with
// every connection they carry (stand rc.7 F-1: each source-side link connection of the updated node was cut).
func TestDaemonStartKeepsTheConnectorsEgressListeners(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	newManager := func() *dockerSecureLinkManager {
		plugin := &DockerPlugin{client: engine.client()}
		manager := &dockerSecureLinkManager{plugin: plugin, socketPath: engine.controlDir + "/" + secureLinkConnectorSlots[0].socket,
			bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
		manager.publishViewLocked()
		plugin.secureLinks = manager
		return manager
	}
	bundle := egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork))
	connector := secureLinkConnectorSlots[0].name

	// The previous process: the egress listens, the ingress binding is bound.
	previous := newManager()
	if statuses := previous.syncEgress(bundle); statuses[egressTestLinkID].State != egressStateReady {
		t.Fatalf("egress status %+v", statuses[egressTestLinkID])
	}
	if _, err := previous.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("ingress apply: %v", err)
	}
	held := engine.lastRequest(connector).Egress
	if len(held) != 1 {
		t.Fatalf("egress held by the connector %+v", held)
	}
	syncs := engine.requestCount(connector)

	// The next process, as Init runs it: the egress of the persisted bundle, then the restore of the committed
	// ingress bindings.
	next := newManager()
	next.setDesiredEgress(bundle)
	if _, err := next.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	engine.mu.Lock()
	requests := append([]securelink.SyncRequest(nil), engine.containers[connector].requests[syncs:]...)
	engine.mu.Unlock()
	if len(requests) == 0 {
		t.Fatal("the restore sent the connector nothing")
	}
	for index, request := range requests {
		if len(request.Egress) != 1 || request.Egress[0] != held[0] {
			t.Fatalf("sync %d of the next process names egress %+v, want the listener the connector holds %+v: the connector "+
				"would close it with the connections it carries", index, request.Egress, held[0])
		}
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("the restore removed %v", removed)
	}
}
