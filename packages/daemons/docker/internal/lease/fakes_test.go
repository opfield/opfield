package lease

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

var containerSeq int

// addContainer creates a lease-mode container on h (created, not started).
func (h *daemonHost) addContainer(policyID string, running bool) *Container {
	containerSeq++
	c := &Container{
		ID: fmt.Sprintf("%012x%052x", containerSeq, 0), Name: fmt.Sprintf("%s-%s", policyID, h.id), PolicyID: policyID,
		PlacementID: "placement-" + h.id, Labels: map[string]string{}, Running: running, RestartPolicy: "unless-stopped",
	}
	h.engine.containers[c.ID] = c
	return c
}

type fakeEngine struct {
	w          *world
	host       *daemonHost
	containers map[string]*Container
	hung       bool
	stopFails  bool
	listFails  bool
	// beforeStart runs before every start, as if Docker changed meanwhile.
	beforeStart func(id string)
}

var errHung = errors.New("dockerd does not answer")

func (e *fakeEngine) running() bool {
	for _, c := range e.containers {
		if c.Running {
			return true
		}
	}
	return false
}

func (e *fakeEngine) ListLeaseContainers(context.Context) ([]Container, error) {
	if e.hung || e.listFails {
		return nil, errHung
	}
	out := make([]Container, 0, len(e.containers))
	for _, c := range e.containers {
		copied := *c
		copied.Status = "exited"
		if c.Running {
			copied.Status = "running"
		}
		out = append(out, copied)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (e *fakeEngine) Inspect(_ context.Context, id string) (Container, bool, error) {
	c := e.containers[id]
	if c == nil {
		return Container{}, false, nil
	}
	return *c, true, nil
}

func (e *fakeEngine) Start(_ context.Context, id string) error {
	if e.hung {
		return errHung
	}
	if e.beforeStart != nil {
		e.beforeStart(id)
	}
	if e.containers[id] == nil {
		return fmt.Errorf("no such container: %s", id)
	}
	record, ok := e.host.fence.records[id]
	if !ok || record.Stale(e.w.hostNow(e.host)) {
		e.w.violations = append(e.w.violations, fmt.Sprintf("%s started %s without a live deadline record", e.host.id, shortID(id)))
	}
	e.containers[id].Running = true
	e.w.logf("%s docker start %s", e.host.id, shortID(id))
	return nil
}

func (e *fakeEngine) Stop(_ context.Context, id string, grace time.Duration) error {
	if e.hung || e.stopFails {
		return errHung
	}
	if c := e.containers[id]; c != nil && c.Running {
		c.Running = false
		e.w.logf("%s docker stop %s grace=%s", e.host.id, shortID(id), grace)
	}
	return nil
}

func (e *fakeEngine) Kill(_ context.Context, id string) error {
	if e.hung || e.stopFails {
		return errHung
	}
	if c := e.containers[id]; c != nil && c.Running {
		c.Running = false
		e.w.logf("%s docker kill %s", e.host.id, shortID(id))
	}
	return nil
}

func (e *fakeEngine) DisableRestart(_ context.Context, id string) error {
	e.containers[id].RestartPolicy = "no"
	return nil
}

func (e *fakeEngine) CgroupEmpty(_ context.Context, c Container) (bool, error) {
	current := e.containers[c.ID]
	empty := current == nil || !current.Running
	if empty {
		e.w.logf("%s cgroup empty %s", e.host.id, shortID(c.ID))
	}
	return empty, nil
}

type fakeFence struct {
	w       *world
	records map[string]leasefence.Record
	// heartbeat: the watchdog runs and keeps writing its heartbeat, lag
	// behind now (a slow watchdog). When it stops, the last heartbeat ages;
	// lastBeat 0 means there is no heartbeat file at all.
	heartbeat bool
	lag       time.Duration
	lastBeat  time.Duration
	// unreadable models records the daemon may not read (another user's, before the watchdog hands them over).
	unreadable bool
}

func (f *fakeFence) HeartbeatAge(now time.Duration) (time.Duration, bool) {
	if f.heartbeat {
		f.lastBeat = now - f.lag
	}
	if f.lastBeat == 0 {
		return 0, false
	}
	return max(now-f.lastBeat, 0), true
}

// removeWatchdog models a node without a watchdog: no heartbeat file.
func (f *fakeFence) removeWatchdog() { f.heartbeat, f.lastBeat = false, 0 }

func (f *fakeFence) Records() (map[string]leasefence.Record, error) {
	if f.unreadable {
		return nil, os.ErrPermission
	}
	out := make(map[string]leasefence.Record, len(f.records))
	for id, record := range f.records {
		out[id] = record
	}
	return out, nil
}

func (f *fakeFence) WriteRecord(record leasefence.Record) error {
	f.records[record.ContainerID] = record
	return nil
}

func (f *fakeFence) DeleteRecord(id string) error {
	delete(f.records, id)
	return nil
}

func (f *fakeFence) DaemonAlive(time.Duration) error { return nil }

type fakeEndpoints struct {
	w       *world
	host    string
	serving map[string]bool
	// stops counts SetServing(false) calls: each renews the members dormant
	// and cuts the policy's tunnels on this node.
	stops int
}

func (e *fakeEndpoints) SetServing(policyID string, serving bool) {
	if !serving {
		e.stops++
	}
	if e.serving[policyID] != serving {
		e.w.logf("%s endpoints serving=%v", e.host, serving)
	}
	e.serving[policyID] = serving
}

type fakePlacements struct {
	host string
	w    *world
}

func (p fakePlacements) Local(string) (Placement, bool) {
	return Placement{PlacementID: "placement-" + p.host, Generation: 7}, true
}

func (fakePlacements) ServeSet(_ string, containers []Container) []Container { return containers }

func (p fakePlacements) MarkServing(_ string, serving bool) {
	p.w.logf("%s placement serving=%v", p.host, serving)
}
