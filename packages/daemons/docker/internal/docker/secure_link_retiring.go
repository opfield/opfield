package docker

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/statecompat"
)

// secureLinkRetiringFile records the connectors being retired: told to drain, they finish their sessions and accept
// nothing new. A daemon that starts while one drains (a restart, a switch of its user) must never take it for the
// serving connector: it refuses every binding and every new connection, and the connector that serves would be
// removed as a leftover.
const secureLinkRetiringFile = "secure-link-connector-retiring.json"

// secureLinkReplacedFile records the replaced connector that keeps accepting until every egress listens on its
// successor (pendingRetire) with the end of its retirement, the retire limit from its replacement. A daemon that starts
// meanwhile finds it next to the serving connector and retires it by that deadline, not by the limit from its start.
const secureLinkReplacedFile = "secure-link-connector-replaced.json"

// retiringConnectors are the connectors being retired (container id to the time it is removed at the latest),
// recorded in file when it is set. Guarded by its own lock: retirements end outside the manager's.
type retiringConnectors struct {
	mu     sync.Mutex
	file   string
	loaded bool
	until  map[string]time.Time
	// running are the retirements this process carries out.
	running map[string]*retirement
}

// retirement is one connector's retirement in this process. A connector removed before its retirement ended (its
// slot taken for a replacement, a teardown) is stopped first: the slot's control socket then belongs to another
// connector, which a later drain request on that path would stop.
type retirement struct {
	socketPath string
	mu         sync.Mutex
	stopped    bool
}

// drain sends fn (a drain request) unless the retirement was stopped; stop waits for one in flight.
func (r *retirement) drain(fn func() (int, error)) (active int, sent bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return 0, false, nil
	}
	active, err = fn()
	return active, true, err
}

func (r *retiringConnectors) loadLocked() {
	if r.loaded {
		return
	}
	r.loaded = true
	if r.until == nil {
		r.until = map[string]time.Time{}
	}
	if r.file == "" {
		return
	}
	data, err := os.ReadFile(r.file)
	if err != nil {
		return
	}
	var recorded map[string]time.Time
	if json.Unmarshal(data, &recorded) != nil {
		return
	}
	for id, until := range recorded {
		if id != "" {
			r.until[id] = until
		}
	}
}

func (r *retiringConnectors) saveLocked() error {
	if r.file == "" {
		return nil
	}
	if len(r.until) == 0 {
		if err := os.Remove(r.file); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	data, err := json.Marshal(r.until)
	if err != nil {
		return err
	}
	return statecompat.WriteAtomic(r.file, data)
}

// start records a retirement (an earlier deadline wins) and returns it with its deadline, or nil when this process
// already carries it out.
func (r *retiringConnectors) start(id, socketPath string, until time.Time) (*retirement, time.Time, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	if current, ok := r.until[id]; !ok || until.Before(current) {
		r.until[id] = until
	}
	if r.running == nil {
		r.running = map[string]*retirement{}
	}
	if r.running[id] != nil {
		return nil, r.until[id], nil
	}
	handle := &retirement{socketPath: socketPath}
	r.running[id] = handle
	return handle, r.until[id], r.saveLocked()
}

// record keeps the deadline of a connector without retiring it (the replaced connector that still accepts).
func (r *retiringConnectors) record(id string, until time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	r.until[id] = until
	return r.saveLocked()
}

// stop ends the drain requests of a connector's retirement before the connector is removed.
func (r *retiringConnectors) stop(id string) {
	r.mu.Lock()
	handle := r.running[id]
	r.mu.Unlock()
	if handle != nil {
		handle.stop()
	}
}

// stopSocket ends the drain requests of every retirement on a control socket before another connector takes it.
func (r *retiringConnectors) stopSocket(path string) {
	r.mu.Lock()
	var handles []*retirement
	for _, handle := range r.running {
		if handle.socketPath == path {
			handles = append(handles, handle)
		}
	}
	r.mu.Unlock()
	for _, handle := range handles {
		handle.stop()
	}
}

func (r *retirement) stop() {
	r.mu.Lock()
	r.stopped = true
	r.mu.Unlock()
}

// deadline returns when a connector being retired is removed at the latest.
func (r *retiringConnectors) deadline(id string) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	until, ok := r.until[id]
	return until, ok
}

// done forgets a connector whose retirement ended. kept: it could not be removed, and stays recorded for the next
// daemon start to remove.
func (r *retiringConnectors) done(id string, kept bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	delete(r.running, id)
	if kept {
		return nil
	}
	delete(r.until, id)
	return r.saveLocked()
}

// forget drops the records of connectors that are gone.
func (r *retiringConnectors) forget(ids ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	changed := false
	for _, id := range ids {
		if _, ok := r.until[id]; ok {
			delete(r.until, id)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return r.saveLocked()
}

// prune drops the records of connectors no slot holds any more (present names every connector found), except the
// retirements this process carries out. A record outliving its connector (removed by hand, or by a process that could
// not record it) was otherwise kept for good: only the removal of a connector a slot holds forgets it (stand rc.5, O-6).
func (r *retiringConnectors) prune(present map[string]bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	changed := false
	for id := range r.until {
		if !present[id] && r.running[id] == nil {
			delete(r.until, id)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return r.saveLocked()
}

// snapshot returns the connectors being retired. Taken before the slots are inspected, it names every retiring
// connector an inspect can still find: a retirement forgets its connector only after removing it, and one that ended
// in between would otherwise make the removed connector look like one to serve through.
func (r *retiringConnectors) snapshot() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	ids := make(map[string]bool, len(r.until))
	for id := range r.until {
		ids[id] = true
	}
	return ids
}

// resumeRetirementLocked goes on with the retirement of a connector found draining at a daemon start: it keeps
// finishing its sessions until its deadline and is removed then, as the process that began it would have done.
func (m *dockerSecureLinkManager) resumeRetirementLocked(inspect container.InspectResponse, slot int) {
	until, ok := m.retiring.deadline(inspect.ID)
	if !ok {
		return
	}
	runtime := connectorRuntime{id: inspect.ID, slot: slot}
	runtime.socketPath = m.adoptedControlSocket(m.slotSocketPath(slot))
	m.retireConnectorUntil(runtime, until)
}

// abandonDrainingConnectorLocked handles a sync the serving connector refused because it was told to drain (a
// retirement that began before this process, or one this process began on it): it never serves again. It is retired,
// dials stop using it, and the next sync starts a new connector next to it.
func (m *dockerSecureLinkManager) abandonDrainingConnectorLocked() {
	if m.connectorID == "" {
		return
	}
	if m.plugin != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("the secure-link connector is draining and is replaced by a new one", "connector", m.connectorID)
	}
	previous := connectorRuntime{id: m.connectorID, managementIP: m.managementIP, socketPath: m.socketPath, slot: m.slot, attached: m.attached}
	if m.pendingRetire != nil && m.pendingRetire.id == previous.id {
		m.clearPendingRetireLocked()
	}
	m.retireConnector(previous)
	m.connectorID = ""
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
}

// removeConnectorContainer force-removes a connector container. A removal already running (a retirement removing the
// same container while a replacement takes its slot) is waited for, as the slot is free only once the container is
// gone: failing on it deferred the links' restore at a switch of the daemon's user.
func (m *dockerSecureLinkManager) removeConnectorContainer(ctx context.Context, id string) error {
	_, err := m.plugin.client.cli.ContainerRemove(ctx, id, mobyclient.ContainerRemoveOptions{Force: true})
	if err == nil || isNotFoundErr(err) {
		return nil
	}
	if !strings.Contains(strings.ToLower(err.Error()), "already in progress") {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		if _, inspectErr := m.plugin.client.cli.ContainerInspect(waitCtx, id, mobyclient.ContainerInspectOptions{}); isNotFoundErr(inspectErr) {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return err
		case <-time.After(100 * time.Millisecond):
		}
	}
}
