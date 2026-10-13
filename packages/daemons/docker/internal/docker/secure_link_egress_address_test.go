package docker

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const egressTestStorageID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

func egressTestStorage(aliasDisabled bool, address string) *pb.SyncRelayGrantsCommand {
	return egressTestBundle(&pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: storageBindingOwnerKind, OwnerId: egressTestStorageID, Grant: &pb.RelaySignedGrant{KeyId: "k"},
		SecureLinkEgress: &pb.SecureLinkEgress{NetworkName: egressTestStorageNet, Alias: "storage-0011223344556677", ListenPort: 9000,
			RouteGeneration: 4, ConnectorImage: replaceTestNewImage, AliasDisabled: aliasDisabled, ConnectorAddress: address},
	})
}

func (e *egressFakeEngine) anchorEndpoint(networkName string) (string, []string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	endpoint := e.containers[secureLinkAnchorName].networks[networkName]
	if endpoint == nil {
		return "", nil
	}
	aliases, _ := endpoint["Aliases"].([]string)
	return endpoint["IPAddress"].(string), aliases
}

// A storage link cutover keeps the address clients pinned (F6): the connector first listens on the link network
// without the alias, then takes the sidecar's exact address and the alias once the sidecar is gone; while the
// address is still in use the egress waits as pending and keeps what it has. An anchor that comes back on another
// address of a network created before the pool takes its recorded address again.
func TestEgressKeepsTheAddressClientsResolved(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t), storageUserSubnet: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	connector := secureLinkConnectorSlots[0].name
	previousRetry := egressAddressRetry
	egressAddressRetry = time.Hour
	t.Cleanup(func() { egressAddressRetry = previousRetry })

	status := manager.syncEgress(egressTestStorage(true, ""))[egressTestStorageID]
	if address, aliases := engine.anchorEndpoint(egressTestStorageNet); status.State != egressStateReady || address != "172.31.0.5" || len(aliases) != 0 {
		t.Fatalf("listening without the alias: status %+v, endpoint %s %v", status, address, aliases)
	}

	// The anchor restarted and Docker gave it another address on the network.
	engine.mu.Lock()
	engine.containers[secureLinkAnchorName].networks[egressTestStorageNet]["IPAddress"] = "172.31.0.20"
	engine.mu.Unlock()
	manager.resyncEgress()
	if address, _ := engine.anchorEndpoint(egressTestStorageNet); address != "172.31.0.5" || engine.lastRequest(connector).Egress[0].ListenHost != "172.31.0.5" {
		t.Fatalf("after an anchor restart the connector is on %s, want its recorded 172.31.0.5", address)
	}

	engine.mu.Lock()
	engine.sidecars = map[string]string{"sidecar-id": "172.31.0.9"}
	engine.mu.Unlock()
	status = manager.syncEgress(egressTestStorage(false, "172.31.0.9"))[egressTestStorageID]
	if address, aliases := engine.anchorEndpoint(egressTestStorageNet); status.State != egressStatePending ||
		!strings.Contains(status.Error, "still in use") || address != "172.31.0.5" || len(aliases) != 0 {
		t.Fatalf("while the sidecar holds the address: status %+v, endpoint %s %v", status, address, aliases)
	}

	engine.mu.Lock()
	engine.sidecars = nil
	engine.mu.Unlock()
	status = manager.syncEgress(egressTestStorage(false, "172.31.0.9"))[egressTestStorageID]
	address, aliases := engine.anchorEndpoint(egressTestStorageNet)
	if status.State != egressStateReady || status.Address != "172.31.0.9" || address != "172.31.0.9" ||
		len(aliases) != 1 || aliases[0] != "storage-0011223344556677" {
		t.Fatalf("after the sidecar went: status %+v, endpoint %s %v", status, address, aliases)
	}
	if request := engine.lastRequest(connector); len(request.Egress) != 1 || request.Egress[0].ListenHost != "172.31.0.9" {
		t.Fatalf("the listener did not move to the taken address: %+v", request.Egress)
	}
}

func egressAddressTestManager(t *testing.T, engine *egressFakeEngine) *dockerSecureLinkManager {
	t.Helper()
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	previousRetry := egressAddressRetry
	egressAddressRetry = time.Hour
	t.Cleanup(func() { egressAddressRetry = previousRetry })
	return manager
}

// On a network of Docker's default pools Docker attaches at no chosen address (R2): the connector refuses
// connector_address there, says so in the status, takes the alias at any address, and is never left off the network.
// A connector taken off a desired network is put back by the next reconcile.
func TestEgressOnADefaultPoolNetworkRefusesAnAddress(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	manager := egressAddressTestManager(t, engine)

	manager.syncEgress(egressTestStorage(true, ""))
	status := manager.syncEgress(egressTestStorage(false, "172.31.0.9"))[egressTestStorageID]
	address, aliases := engine.anchorEndpoint(egressTestStorageNet)
	if status.State != egressStateReady || !strings.Contains(status.Error, "refused") || address != "172.31.0.5" ||
		len(aliases) != 1 || aliases[0] != "storage-0011223344556677" {
		t.Fatalf("connector address on a default-pool network: status %+v, endpoint %q %v", status, address, aliases)
	}

	// No address of its own to take back there: after an anchor restart it keeps the new one.
	engine.mu.Lock()
	engine.containers[secureLinkAnchorName].networks[egressTestStorageNet]["IPAddress"] = "172.31.0.20"
	engine.mu.Unlock()
	manager.resyncEgress()
	if address, _ := engine.anchorEndpoint(egressTestStorageNet); address != "172.31.0.20" {
		t.Fatalf("the connector rejoined a default-pool network to pin %s", address)
	}

	// Taken off the network behind the daemon's back: the next reconcile puts it back.
	engine.mu.Lock()
	delete(engine.containers[secureLinkAnchorName].networks, egressTestStorageNet)
	engine.mu.Unlock()
	manager.resyncEgress()
	if address, aliases := engine.anchorEndpoint(egressTestStorageNet); address == "" || len(aliases) != 1 {
		t.Fatalf("the connector was not put back on its link network: %q %v", address, aliases)
	}
}

// A rejoin whose new endpoint Docker refuses puts the previous one back at once: the connector is never left off a
// desired network, the egress keeps listening and reports what failed; a later reconcile takes the address.
func TestRefusedRejoinKeepsTheConnectorOnTheNetwork(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	manager := egressAddressTestManager(t, engine)
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("first attach %+v", status)
	}

	engine.mu.Lock()
	engine.containers[secureLinkAnchorName].networks[egressTestNetwork]["IPAddress"] = "10.213.0.40"
	engine.failAddressedConnect = true
	engine.mu.Unlock()
	manager.resyncEgress()
	status := manager.egress.currentStatuses()[egressTestLinkID]
	if address, aliases := engine.anchorEndpoint(egressTestNetwork); address == "" || len(aliases) != 1 ||
		status.State != egressStateReady || !strings.Contains(status.Error, "previous endpoint") {
		t.Fatalf("after a refused rejoin: endpoint %q %v, status %+v", address, aliases, status)
	}

	engine.mu.Lock()
	engine.failAddressedConnect = false
	engine.mu.Unlock()
	manager.resyncEgress()
	if address, _ := engine.anchorEndpoint(egressTestNetwork); address != "10.213.0.2" {
		t.Fatalf("the connector did not take its address once Docker allowed it: %s", address)
	}
}
