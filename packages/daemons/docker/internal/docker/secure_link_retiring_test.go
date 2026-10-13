package docker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// connectorRequests returns the control requests a connector received.
func connectorRequests(engine *fakeConnectorEngine, connector *fakeConnectorContainer) []securelink.SyncRequest {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return append([]securelink.SyncRequest(nil), connector.requests...)
}

func onlyDrains(requests []securelink.SyncRequest) bool {
	for _, request := range requests {
		if !request.Drain {
			return false
		}
	}
	return true
}

// A switch of the daemon's user back to the user of an earlier run (gwdock → root on the stand): the daemon of the
// other user replaced the earlier user's connector and was still retiring it, by the drain signal because its control
// socket was out of that daemon's reach, when the switch came. That connector fits the new daemon again (its image,
// its groups) and used to be taken for the serving one: the connector that served was removed with every session, and
// every sync and connection went to one that drains ("secure-link connector is shutting down") until the next
// restart. The new daemon never syncs or dials through a draining connector: the serving one is replaced next to
// itself and drains, and the links bind on a new connector.
func TestRunUserSwitchNeverServesThroughADrainingConnector(t *testing.T) {
	limit := secureLinkConnectorRetireLimit
	secureLinkConnectorRetireLimit = time.Minute
	t.Cleanup(func() { secureLinkConnectorRetireLimit = limit })
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	earlier := &fakeConnectorContainer{id: "earlier-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, drainFails: true}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestOldImage,
		groups: []string{"4242"}, ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	engine.containers[earlier.name], engine.containers[serving.name], engine.containers[anchor.name] = earlier, serving, anchor
	engine.serveControl(earlier)
	engine.serveControl(serving)
	retiringFile := filepath.Join(t.TempDir(), secureLinkRetiringFile)

	// The other user's daemon retires the earlier connector; a held session keeps it.
	other := &dockerSecureLinkManager{plugin: &DockerPlugin{client: engine.client()}, controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[1].socket)}
	other.retiring.file = retiringFile
	session := newDrainConn(&connectorConn{Conn: nopConn{}, connectorID: earlier.id})
	release := other.plugin.proxyTunnels.addHeld(session, func() {})
	other.retireConnector(connectorRuntime{id: earlier.id, slot: 0, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket)})
	deadline := time.Now().Add(3 * time.Second)
	for {
		engine.mu.Lock()
		signalled := slices.Contains(earlier.signals, secureLinkDrainSignal)
		engine.mu.Unlock()
		if signalled {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the connector out of reach was not signalled to drain")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The daemon starts as the earlier user.
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: engine.client()}, controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.retiring.file = retiringFile
	manager.publishViewLocked()
	if _, err := manager.restore(replaceTestCommand(replaceTestOldImage)); err != nil {
		t.Fatalf("restore after the switch: %v", err)
	}
	view := manager.currentView()
	if view.connectorID == earlier.id || view.connectorID == serving.id || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("links served by %+v, want a new connector", view)
	}
	if requests := connectorRequests(engine, earlier); !onlyDrains(requests) {
		t.Fatalf("the draining connector was synced: %+v", requests)
	}
	// The connector that served was not cut: it drains next to its replacement and goes.
	waitRemoved(t, engine, serving.id)
	if !receivedDrain(engine, serving) {
		t.Fatal("the connector that served was removed without draining")
	}
	engine.mu.Lock()
	current := engine.byIDOrName(view.connectorID)
	engine.mu.Unlock()
	if current == nil || receivedDrain(engine, current) {
		t.Fatalf("the serving connector %s was told to drain", view.connectorID)
	}
	// Syncs go on to the new connector.
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil || manager.currentView().connectorID != view.connectorID {
		t.Fatalf("sync after the switch: %v (connector %s)", err, manager.currentView().connectorID)
	}

	release()
	deadline = time.Now().Add(3 * time.Second)
	for {
		other.retiring.mu.Lock()
		running := len(other.retiring.running)
		other.retiring.mu.Unlock()
		if running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the other daemon's retirement did not end")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A daemon restart while a replaced connector drains: the connector running the image serves, and the draining one
// is neither used nor cut. It finishes its sessions and goes when they ended.
func TestDaemonStartResumesARetirement(t *testing.T) {
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	draining := &fakeConnectorContainer{id: "draining-id", name: secureLinkConnectorSlots[0].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, draining: true}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	engine.containers[draining.name], engine.containers[serving.name], engine.containers[anchor.name] = draining, serving, anchor
	engine.serveControl(draining)
	engine.serveControl(serving)
	retiringFile := filepath.Join(t.TempDir(), secureLinkRetiringFile)
	// Recorded by the process that began the retirement.
	recorded := retiringConnectors{file: retiringFile}
	if _, _, err := recorded.start(draining.id, "", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: engine.client()}, controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.retiring.file = retiringFile
	manager.publishViewLocked()
	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != serving.id || manager.slot != 1 {
		t.Fatalf("restored view %+v slot %d, want the serving connector", view, manager.slot)
	}
	if requests := connectorRequests(engine, draining); !onlyDrains(requests) {
		t.Fatalf("the draining connector was synced: %+v", requests)
	}
	// It reports no session left: its retirement ends.
	waitRemoved(t, engine, draining.id)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, ok := manager.retiring.deadline(draining.id); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a removed connector is still recorded as retiring")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The deadline of a retirement survives a daemon restart: the retirement the next process resumes ends at the
// recorded deadline (an hour from the replacement), not an hour from the restart. The sessions still open then are
// cut, and the log says how many.
func TestDaemonStartKeepsTheRetirementDeadline(t *testing.T) {
	poll := secureLinkConnectorDrainPoll
	secureLinkConnectorDrainPoll = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkConnectorDrainPoll = poll })
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	draining := &fakeConnectorContainer{id: "draining-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, draining: true, active: 2}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	engine.containers[draining.name], engine.containers[serving.name], engine.containers[anchor.name] = draining, serving, anchor
	engine.serveControl(draining)
	engine.serveControl(serving)
	retiringFile := filepath.Join(t.TempDir(), secureLinkRetiringFile)
	// The node's last update, whose report the cut joins (stand rc.7 O-15).
	stateDir := t.TempDir()
	if err := handover.WritePending(stateDir, handover.Report{FromVersion: "v1", StartedAt: time.Now(), Handover: true}); err != nil {
		t.Fatal(err)
	}
	tracker := handover.NewTracker(stateDir, "v2")
	tracker.Settle()
	// Recorded by the process that replaced it almost an hour before the restart.
	until := time.Now().Add(time.Second)
	recorded := retiringConnectors{file: retiringFile}
	if _, _, err := recorded.start(draining.id, "", until); err != nil {
		t.Fatal(err)
	}

	logs := &lockedBuffer{}
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewTextHandler(logs, nil)),
			handoverTracker: tracker},
		controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.retiring.file = retiringFile
	manager.publishViewLocked()
	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if resumed, ok := manager.retiring.deadline(draining.id); !ok || !resumed.Equal(until) {
		t.Fatalf("resumed retirement until %v (recorded %v), want the recorded %v", resumed, ok, until)
	}
	waitRemoved(t, engine, draining.id)
	if logs.count("reached its retirement limit") != 1 || logs.count("connector="+draining.id+" sessions_cut=2") != 1 {
		t.Fatalf("the cut at the recorded deadline was not logged with its sessions: %s", logs.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for tracker.Last().Cut[cutConnectorRetired] != 2 {
		if time.Now().After(deadline) {
			t.Fatalf("the update report does not count the cut sessions: %+v", tracker.Last())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A daemon start drops the records of connectors that no longer exist (stand rc.5, O-6: app-node-1 kept records of
// connectors removed days before), and keeps the one of a connector still retiring in its slot.
func TestDaemonStartDropsRecordsOfConnectorsThatAreGone(t *testing.T) {
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	draining := &fakeConnectorContainer{id: "draining-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, draining: true, active: 2}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	engine.containers[draining.name], engine.containers[serving.name], engine.containers[anchor.name] = draining, serving, anchor
	engine.serveControl(draining)
	engine.serveControl(serving)
	retiringFile := filepath.Join(t.TempDir(), secureLinkRetiringFile)
	recorded := retiringConnectors{file: retiringFile}
	if _, _, err := recorded.start(draining.id, "", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"6bfa59b3-gone", "3828dfd8-gone"} {
		if err := recorded.record(gone, time.Date(2026, 10, 4, 23, 53, 7, 0, time.UTC)); err != nil {
			t.Fatal(err)
		}
	}

	manager := &dockerSecureLinkManager{
		plugin:     &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.retiring.file = retiringFile
	manager.publishViewLocked()
	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	for _, gone := range []string{"6bfa59b3-gone", "3828dfd8-gone"} {
		if _, ok := manager.retiring.deadline(gone); ok {
			t.Fatalf("the record of %s, gone, was kept", gone)
		}
	}
	if _, ok := manager.retiring.deadline(draining.id); !ok {
		t.Fatal("the record of the connector still retiring in its slot was dropped")
	}
	reread := retiringConnectors{file: retiringFile}
	if ids := reread.snapshot(); ids["6bfa59b3-gone"] || ids["3828dfd8-gone"] || !ids[draining.id] {
		t.Fatalf("recorded on disk: %v", ids)
	}
}

// A connector that refuses a sync because it drains (told to by a retirement nobody recorded) is never used again:
// the links and the egress go to a new connector at once.
func TestDrainingConnectorIsReplacedAtOnce(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	previous.draining = true
	engine.mu.Unlock()
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply on a draining connector: %v", err)
	}
	view := manager.currentView()
	if view.connectorID == previous.id || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("links served by %+v, want a new connector", view)
	}
	if _, ok := manager.retiring.deadline(previous.id); !ok && !slices.Contains(engine.removedIDs(), previous.id) {
		t.Fatal("the draining connector was not retired")
	}
}

// The same in an egress sync: its listeners move to a new connector instead of waiting on the draining one.
func TestEgressLeavesADrainingConnector(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress status %+v", status)
	}
	previous := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	previous.draining = true
	engine.mu.Unlock()
	assignment := egressTestAssignment(egressTestLinkID, egressTestNetwork)
	assignment.SecureLinkEgress.RouteGeneration = 4
	status := manager.syncEgress(egressTestBundle(assignment))[egressTestLinkID]
	if status.State != egressStateReady || manager.currentView().connectorID == previous.id {
		t.Fatalf("egress status %+v on connector %s, want ready on a new connector", status, manager.currentView().connectorID)
	}
	engine.mu.Lock()
	next := engine.byIDOrName(manager.currentView().connectorID)
	engine.mu.Unlock()
	if next == nil {
		t.Fatal("no connector started instead of the draining one")
	}
	if request := engine.lastRequest(next.name); len(request.Egress) != 1 || request.Egress[0].Generation != 4 {
		t.Fatalf("egress sent to the new connector %+v", request.Egress)
	}
}

// The rc.3 stand (O-e): docker kill -s USR1 to the serving connector of a node whose workloads use it only for egress
// closed its listeners, and the daemon replaced it only at its next sync, 27 s later; the workloads' connections were
// refused meanwhile. The drain signal is followed now: the connector is replaced at once, without a sync from Opfield.
func TestDrainSignalReplacesTheServingConnectorAtOnce(t *testing.T) {
	withRetireLimit(t, time.Minute)
	events, stream := io.Pipe()
	t.Cleanup(func() { _ = stream.Close() })
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.events = events
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress status %+v", status)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go manager.watchConnectorStarts(ctx)
	kill := func(id, name, signal string) {
		t.Helper()
		event := fmt.Sprintf(`{"Type":"container","Action":"kill","Actor":{"ID":%q,"Attributes":{"name":%q,"signal":%q}},"time":1700000000}`,
			id, name, signal)
		if _, err := stream.Write([]byte(event + "\n")); err != nil {
			t.Fatal(err)
		}
	}
	servingID := func() string {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return manager.connectorID
	}

	// A stop's SIGTERM is not a drain.
	previous := engine.container(secureLinkConnectorSlots[0].name)
	kill(previous.id, previous.name, strconv.Itoa(int(syscall.SIGTERM)))
	time.Sleep(3 * connectorDrainSettle)
	if servingID() != previous.id {
		t.Fatal("a connector was replaced for a signal other than the drain signal")
	}

	engine.mu.Lock()
	previous.draining, previous.active = true, 4 // it stops accepting at the signal; its sessions go on
	engine.mu.Unlock()
	kill(previous.id, previous.name, strconv.Itoa(int(syscall.SIGUSR1)))
	deadline := time.Now().Add(5 * time.Second)
	for servingID() == previous.id && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	next := servingID()
	if next == "" || next == previous.id {
		t.Fatalf("the drained connector still serves (%q)", next)
	}
	if status := manager.egress.currentStatuses()[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress status %+v after the replacement", status)
	}
	if _, retiring := manager.retiring.deadline(previous.id); !retiring {
		t.Fatal("the drained connector does not finish its sessions")
	}

	// The daemon's own drain signal to the connector it retires replaces nothing more.
	kill(previous.id, previous.name, strconv.Itoa(int(syscall.SIGUSR1)))
	time.Sleep(3 * connectorDrainSettle)
	if servingID() != next {
		t.Fatal("the drain signal of a retiring connector replaced the serving one")
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}

func (b *lockedBuffer) count(text string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.Count(b.String(), text)
}

// A connector that keeps refusing its ingress bindings is logged once, not on every egress sync (89 lines in six
// seconds on the stand).
func TestIngressRefusalDuringEgressSyncsIsLoggedOnce(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	logs := &lockedBuffer{}
	plugin := &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewTextHandler(logs, nil))}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress status %+v", status)
	}
	connector := engine.container(secureLinkConnectorSlots[0].name)
	engine.mu.Lock()
	connector.syncFails = true
	engine.mu.Unlock()
	for range 5 {
		manager.resyncEgress()
	}
	if logged := logs.count("refused its ingress bindings during an egress sync"); logged != 1 {
		t.Fatalf("the refusal was logged %d times, want once", logged)
	}
}

// A replacement whose slot is still being removed by a retirement waits for that removal instead of failing (the links'
// restore was deferred at a switch of the daemon's user).
func TestReplacementWaitsForARemovalInProgress(t *testing.T) {
	manager, engine := replaceTestManager(t)
	engine.mu.Lock()
	anchor := engine.containers[secureLinkAnchorName]
	leftover := &fakeConnectorContainer{id: "leftover-id", name: secureLinkConnectorSlots[1].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id, removing: true}
	engine.containers[leftover.name] = leftover
	engine.mu.Unlock()
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image while the slot was being removed: %v", err)
	}
	if view := manager.currentView(); view.connectorID == leftover.id || manager.slot != 1 {
		t.Fatalf("view %+v slot %d, want a new connector in the freed slot", view, manager.slot)
	}
}
