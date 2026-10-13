package docker

import (
	"maps"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
)

// A replacement that does not listen on every egress address yet leaves the previous connector accepting: it is told
// to drain as soon as a reconcile, which runs again shortly by itself, finds every egress listening on the replacement.
func TestReplacedConnectorDrainsOnlyOnceEgressListens(t *testing.T) {
	retry := egressAddressRetry
	egressAddressRetry = 100 * time.Millisecond
	t.Cleanup(func() { egressAddressRetry = retry })
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress on the first connector %+v", status)
	}
	previous := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	engine.egressFails = true
	engine.mu.Unlock()

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	replacement := engine.container(secureLinkConnectorSlots[1].name)
	time.Sleep(300 * time.Millisecond)
	if receivedDrain(engine.fakeConnectorEngine, previous) || slices.Contains(engine.removedIDs(), previous.id) {
		t.Fatal("the previous connector was drained before the egress listened on its replacement")
	}

	engine.mu.Lock()
	replacement.egressFails = false
	engine.mu.Unlock()
	waitRemoved(t, engine, previous.id)
	if !receivedDrain(engine.fakeConnectorEngine, previous) {
		t.Fatal("the previous connector was removed without draining")
	}
}

// A replacement whose egress does not listen leaves the previous connector serving that egress (availability first)
// and re-checks by itself; at the retire limit the previous one drains all the same.
func TestReplacedConnectorServesUntilTheRetireLimit(t *testing.T) {
	retry, limit := egressAddressRetry, secureLinkConnectorRetireLimit
	egressAddressRetry, secureLinkConnectorRetireLimit = 100*time.Millisecond, time.Second
	t.Cleanup(func() { egressAddressRetry, secureLinkConnectorRetireLimit = retry, limit })
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress on the first connector %+v", status)
	}
	previous := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	engine.egressFails = true
	engine.mu.Unlock()
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if receivedDrain(engine.fakeConnectorEngine, previous) {
		t.Fatal("the previous connector stopped accepting while an egress did not listen on its replacement")
	}
	waitRemoved(t, engine, previous.id)
	if !receivedDrain(engine.fakeConnectorEngine, previous) {
		t.Fatal("the previous connector was removed without draining")
	}
}

// The anchor sets tcp_migrate_req, so a draining listener hands its queued connections to the replacement, only on
// a kernel that has it (Docker refuses an unknown sysctl); each variant is current on its kernel.
func TestAnchorSysctlFollowsTheKernel(t *testing.T) {
	previous := hostSupportsTCPMigrateReq
	t.Cleanup(func() { hostSupportsTCPMigrateReq = previous })
	anchor := func(sysctls map[string]string) container.InspectResponse {
		pids := secureLinkAnchorPidsLimit
		return container.InspectResponse{
			Name: "/" + secureLinkAnchorName,
			Config: &container.Config{Image: replaceTestNewImage, User: "65532:65532", Cmd: secureLinkAnchorCommand,
				Labels: map[string]string{"net.opfield.managed": "secure-link-connector", secureLinkRoleLabel: secureLinkAnchorRole}},
			HostConfig: &container.HostConfig{ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"}, Sysctls: sysctls,
				Resources: container.Resources{Memory: secureLinkAnchorMemory, PidsLimit: &pids}},
		}
	}
	migrate := map[string]string{tcpMigrateReqSysctl: "1"}
	for _, test := range []struct {
		kernel  bool
		sysctls map[string]string
		valid   bool
	}{
		{kernel: true, sysctls: migrate, valid: true},
		{kernel: true, sysctls: nil, valid: false}, // replaced once after a kernel upgrade
		{kernel: false, sysctls: nil, valid: true},
		{kernel: false, sysctls: map[string]string{}, valid: true},
		{kernel: false, sysctls: migrate, valid: false},
	} {
		hostSupportsTCPMigrateReq = func() bool { return test.kernel }
		if got := validSecureLinkAnchor(anchor(test.sysctls)); got != test.valid {
			t.Errorf("kernel with tcp_migrate_req %v, sysctls %v: valid %v, want %v", test.kernel, test.sysctls, got, test.valid)
		}
		if got := secureLinkAnchorSysctls(); test.valid && !maps.Equal(got, test.sysctls) {
			t.Errorf("a new anchor on kernel %v gets %v, which the check then refuses", test.kernel, got)
		}
	}
}

func waitRemoved(t *testing.T, engine interface{ removedIDs() []string }, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !slices.Contains(engine.removedIDs(), id) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !slices.Contains(engine.removedIDs(), id) {
		t.Fatalf("%s was not removed: %v", id, engine.removedIDs())
	}
}

// The daemon is updated before Opfield, which still sends the connector image of its release: an image without the
// anchor label runs the connector in its own namespace as before (proxy ingress works, egress waits as pending). The
// first image with the label moves the connector into a new anchor once, next to the serving one; an image without
// it again (an Opfield rollback) moves it out, and the anchor no connector runs in goes.
func TestConnectorAnchorFollowsTheImage(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.legacyImages = map[string]bool{replaceTestOldImage: true}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager

	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply with an image without the anchor: %v", err)
	}
	if engine.container(secureLinkAnchorName) != nil {
		t.Fatal("an anchor was created for an image without the pause subcommand")
	}
	view := manager.currentView()
	if view.connectorID != "created-1" || view.managementIP != "10.99.0.11" || view.bindings[replaceTestLinkID].port == 0 ||
		engine.container(secureLinkConnectorSlots[0].name).networkMode != "" {
		t.Fatalf("proxy ingress on a connector in its own namespace: %+v", view)
	}
	statuses := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))
	if status := statuses[egressTestLinkID]; status.State != egressStatePending || status.Error != connectorImageTooOld {
		t.Fatalf("egress with a connector image too old: %+v", status)
	}

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with an image with the anchor: %v", err)
	}
	anchor := engine.container(secureLinkAnchorName)
	view = manager.currentView()
	if anchor == nil || view.connectorID != "created-3" || view.managementIP != anchor.ip ||
		engine.container(secureLinkConnectorSlots[1].name).networkMode != "container:"+anchor.id {
		t.Fatalf("the connector did not move into the anchor: %+v (anchor %+v)", view, anchor)
	}
	if status := manager.egress.currentStatuses()[egressTestLinkID]; status.State != egressStateReady || status.Address != "10.213.0.2" {
		t.Fatalf("egress after the move into the anchor: %+v", status)
	}
	waitRemoved(t, engine, "created-1")

	// An Opfield rolled back to the earlier image sends no egress either.
	previousWait := egressSuccessorTo
	egressSuccessorTo = 50 * time.Millisecond
	t.Cleanup(func() { egressSuccessorTo = previousWait })
	manager.syncEgress(egressTestBundle())
	time.Sleep(300 * time.Millisecond)
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the earlier image again: %v", err)
	}
	if view = manager.currentView(); view.connectorID != "created-4" || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("proxy ingress after the move out of the anchor: %+v", view)
	}
	waitRemoved(t, engine, "created-3")
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply after the previous connector was retired: %v", err)
	}
	if !slices.Contains(engine.removedIDs(), anchor.id) {
		t.Fatalf("the anchor no connector runs in stayed: %v", engine.removedIDs())
	}
}

// A connector whose shape drifted (here its pids limit) may carry sessions: found running at a daemon start, it is
// taken as the serving connector, the new one starts next to it, and it drains before it goes (F-C9).
func TestDriftedConnectorIsReplacedSideBySide(t *testing.T) {
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestNewImage, "10.99.0.2")
	drifted := &fakeConnectorContainer{id: "drifted-id", name: secureLinkConnectorSlots[0].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, pidsLimit: 128}
	engine.containers[anchor.name], engine.containers[drifted.name] = anchor, drifted
	engine.serveControl(drifted)
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()

	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != "created-1" || manager.slot != 1 || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("view %+v slot %d, want the replacement next to the drifted connector", view, manager.slot)
	}
	waitRemoved(t, engine, drifted.id)
	if !receivedDrain(engine, drifted) {
		t.Fatal("the drifted connector was removed without draining")
	}
}

// A held container link session through the serving connector (same node: consumer, egress, local dial, ingress)
// survives a connector replacement (R3): idle or not, it is not cut as an idle request tunnel would be, and the
// previous connector stays until the session ends.
func TestHeldLinkSessionSurvivesReplacement(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView()
	limit := secureLinkConnectorRetireLimit
	secureLinkConnectorRetireLimit = 5 * time.Second
	t.Cleanup(func() { secureLinkConnectorRetireLimit = limit })
	// Idle for longer than any request tunnel may be: a database pool's connection between queries.
	session := newDrainConn(&connectorConn{Conn: nopConn{}, connectorID: previous.connectorID})
	session.lastRead.Store(time.Now().Add(-time.Minute).UnixNano())
	session.lastWrite.Store(time.Now().Add(-time.Minute).UnixNano())
	cut := make(chan struct{})
	release := manager.plugin.proxyTunnels.addHeld(session, func() { close(cut) })

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	select {
	case <-cut:
		t.Fatal("the held container link session was cut by the connector replacement")
	case <-time.After(500 * time.Millisecond):
	}
	if slices.Contains(engine.removedIDs(), previous.connectorID) {
		t.Fatal("the previous connector was removed while it carried the session")
	}
	// The session ends: the previous connector goes.
	release()
	waitRemoved(t, engine, previous.connectorID)
}

// A replaced connector keeps its sessions at most an hour from its replacement.
func TestReplacedConnectorKeepsItsSessionsAtMostAnHour(t *testing.T) {
	if secureLinkConnectorRetireLimit != time.Hour {
		t.Fatalf("retire limit %s, want 1h", secureLinkConnectorRetireLimit)
	}
}

// A replaced connector whose control socket is out of the daemon's reach (a switch of the daemon's user) is told to
// stop accepting by the drain signal instead, so new connections reach only its replacement (F3).
func TestUnreachableConnectorIsSignalledToDrain(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	previous.drainFails = true
	engine.mu.Unlock()
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	waitRemoved(t, engine, previous.id)
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if !slices.Contains(previous.signals, secureLinkDrainSignal) {
		t.Fatalf("signals %v, want the drain signal", previous.signals)
	}
}
