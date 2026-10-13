package docker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/moby/moby/api/types/events"
)

func newTestStorageEngine(t *testing.T) (*managedStorageManager, *fakeEngineDocker, *fakeLoops, string) {
	t.Helper()
	loops := newFakeLoops(t)
	root := t.TempDir()
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"s1": false}, policy: map[string]string{},
		finishedAt: map[string]time.Time{}}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client(),
		chown: func(string, int, int) error { return nil }}
	if err := os.MkdirAll(filepath.Join(root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	const id = "11111111-1111-4111-8111-111111111111"
	record := managedStorageRecord{
		ID: id, ContainerID: "s1", DesiredRunning: true, OperationID: "22222222-2222-4222-8222-222222222222",
		ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
		MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
	}
	writeFile(t, record.ImagePath)
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return m, docker, loops, id
}

type inspectedStorage struct {
	Status       string `json:"status"`
	OperationID  string `json:"operationId"`
	EngineExited bool   `json:"engineExited"`
}

func inspectStorage(t *testing.T, m *managedStorageManager, id string) inspectedStorage {
	t.Helper()
	detail, err := m.handle(context.Background(), "inspect", id, "")
	if err != nil {
		t.Fatal(err)
	}
	var inspected inspectedStorage
	if err := json.Unmarshal([]byte(detail), &inspected); err != nil {
		t.Fatal(err)
	}
	return inspected
}

// An engine that keeps exiting runs most of the time (the supervisor starts it
// after every exit) without ever serving. It is reported stopped, not starting,
// until it serves or is started on purpose.
func TestStorageEngineThatKeepsExitingIsStopped(t *testing.T) {
	m, docker, _, id := newTestStorageEngine(t)
	ctx := context.Background()

	// Started when the daemon starts: it is starting.
	if err := m.startStoppedEngine(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.Status != "starting" || got.EngineExited {
		t.Fatalf("after a start: %+v, want starting", got)
	}

	// It exits on its own and the supervisor starts it again.
	docker.running["s1"] = false
	if err := m.startStoppedEngine(ctx, id, "s1"); err != nil {
		t.Fatal(err)
	}
	if !docker.running["s1"] {
		t.Fatal("supervisor did not start the engine")
	}
	if got := inspectStorage(t, m, id); got.Status != "stopped" || !got.EngineExited {
		t.Fatalf("after an exit: %+v, want stopped with engineExited", got)
	}

	// A restart starts it on purpose: starting again.
	if _, err := m.handle(ctx, "restart", id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.Status != "starting" || got.EngineExited {
		t.Fatalf("after a restart: %+v, want starting", got)
	}
}

// engineEvents drives the supervisor as Docker's event stream does: each event
// goes through engineStops, a die to handleEngineStop, and the restart it
// schedules runs when the test says so.
type engineEvents struct {
	t       *testing.T
	plugin  *DockerPlugin
	stops   *engineStops
	restart *engineRestarts
	queued  []func()
	id      string
	now     time.Time
}

func newEngineEvents(t *testing.T, m *managedStorageManager, id string) *engineEvents {
	e := &engineEvents{t: t, plugin: &DockerPlugin{storageManager: m, logger: m.logger}, stops: newEngineStops(),
		restart: newEngineRestarts(), id: id, now: time.Now()}
	e.restart.after = func(_ time.Duration, f func()) { e.queued = append(e.queued, f) }
	return e
}

func (e *engineEvents) send(action events.Action, attributes map[string]string) {
	e.now = e.now.Add(time.Second)
	labels := map[string]string{managedStorageLabel: e.id}
	maps.Copy(labels, attributes)
	message := events.Message{Type: events.ContainerEventType, Action: action, TimeNano: e.now.UnixNano(),
		Actor: events.Actor{ID: "s1", Attributes: labels}}
	if requested, oom, died := e.stops.observe(message); died {
		e.plugin.handleEngineStop(context.Background(), e.restart, message, requested, oom)
	}
}

// runRestart runs the restart the supervisor scheduled after a die.
func (e *engineEvents) runRestart() {
	e.t.Helper()
	if len(e.queued) == 0 {
		e.t.Fatal("the supervisor scheduled no restart")
	}
	run := e.queued[0]
	e.queued = e.queued[1:]
	run()
}

// An operator's docker stop of an engine (a stop signal, then its exit) is
// not a crash: while the supervisor brings it back the engine is starting,
// never stopped. An engine that dies without a stop signal, or OOM-killed,
// crashed: it is stopped at once and keeps stopping until it serves.
func TestStorageEngineStoppedByAnOperatorIsStartingAndACrashIsStopped(t *testing.T) {
	m, docker, _, id := newTestStorageEngine(t)
	serving := true
	m.probeReady = func(context.Context, managedStorageRecord) error {
		if serving {
			return nil
		}
		return errors.New("managed storage container health is starting")
	}
	e := newEngineEvents(t, m, id)
	die := func() {
		docker.running["s1"] = false
		docker.finishedAt["s1"] = time.Now()
		serving = false
		e.send(events.ActionDie, map[string]string{"exitCode": "0"})
	}
	restart := func() {
		t.Helper()
		e.runRestart()
		if !docker.running["s1"] {
			t.Fatal("supervisor did not start the engine")
		}
		e.send(events.ActionStart, nil)
	}
	expect := func(step, status string, exited bool) {
		t.Helper()
		if got := inspectStorage(t, m, id); got.Status != status || got.EngineExited != exited {
			t.Fatalf("%s: %+v, want %s (engineExited %v)", step, got, status, exited)
		}
	}

	docker.running["s1"] = true
	expect("serving", "ready", false)

	// docker stop: SIGTERM, SIGKILL after its timeout, exit.
	e.send(events.ActionKill, map[string]string{"signal": "15"})
	e.send(events.ActionKill, map[string]string{"signal": "9"})
	die()
	expect("stopped by an operator, before the supervisor starts it", "starting", false)
	restart()
	expect("started again after an operator's stop", "starting", false)
	serving = true
	expect("back", "ready", false)

	// A crash: no stop signal before the exit, only a certificate reload.
	e.send(events.ActionKill, map[string]string{"signal": "1"})
	die()
	expect("crashed, before the supervisor starts it", "stopped", false)
	restart()
	expect("crashed and started again", "stopped", true)

	// An operator's stop of an engine that keeps crashing does not hide it.
	e.send(events.ActionKill, map[string]string{"signal": "15"})
	die()
	expect("crash-looping engine stopped by an operator", "stopped", true)
	restart()
	expect("crash-looping engine started again", "stopped", true)
	serving = true
	expect("serves again", "ready", false)

	// An OOM kill is a crash, whatever signal came before it.
	e.send(events.ActionKill, map[string]string{"signal": "15"})
	e.send(events.ActionOOM, nil)
	die()
	restart()
	expect("OOM-killed", "stopped", true)
	serving = true
	expect("serves after the OOM kill", "ready", false)

	// A restart by this daemon (stop signal, exit, start) followed by a crash:
	// the restart's stop signal does not excuse the crash.
	e.send(events.ActionKill, map[string]string{"signal": "15"})
	docker.running["s1"] = false
	e.send(events.ActionDie, nil)
	if _, err := m.handle(context.Background(), "restart", id, ""); err != nil {
		t.Fatal(err)
	}
	e.send(events.ActionStart, nil)
	e.runRestart() // the engine runs: nothing to do
	die()
	restart()
	expect("crashed after this daemon restarted it", "stopped", true)
}

// The event stream tells a stop asked for through Docker's API from a crash.
func TestEngineStopsTellARequestedStopFromACrash(t *testing.T) {
	at := time.Unix(1_000_000, 0)
	event := func(action events.Action, offset time.Duration, attributes map[string]string) events.Message {
		labels := map[string]string{managedStorageLabel: "11111111-1111-4111-8111-111111111111"}
		maps.Copy(labels, attributes)
		return events.Message{Action: action, TimeNano: at.Add(offset).UnixNano(), Actor: events.Actor{ID: "c1", Attributes: labels}}
	}
	for _, tc := range []struct {
		name   string
		before []events.Message
		want   bool
	}{
		{"docker stop", []events.Message{event(events.ActionKill, -10*time.Second, map[string]string{"signal": "15"})}, true},
		{"docker kill", []events.Message{event(events.ActionKill, 0, map[string]string{"signal": "SIGKILL"})}, true},
		{"crash", nil, false},
		{"reload signal", []events.Message{event(events.ActionKill, -time.Second, map[string]string{"signal": "1"})}, false},
		{"OOM kill", []events.Message{event(events.ActionKill, -time.Second, map[string]string{"signal": "15"}), event(events.ActionOOM, 0, nil)}, false},
		{"stop then start", []events.Message{event(events.ActionKill, -20*time.Second, map[string]string{"signal": "15"}), event(events.ActionStart, -15*time.Second, nil)}, false},
		{"stale stop signal", []events.Message{event(events.ActionKill, -engineStopRequestWindow-time.Second, map[string]string{"signal": "15"})}, false},
	} {
		stops := newEngineStops()
		for _, message := range tc.before {
			if _, _, died := stops.observe(message); died {
				t.Fatalf("%s: %s is not a die", tc.name, message.Action)
			}
		}
		requested, _, died := stops.observe(event(events.ActionDie, 0, nil))
		if !died || requested != tc.want {
			t.Fatalf("%s: requested %v died %v, want requested %v", tc.name, requested, died, tc.want)
		}
	}
	other := events.Message{Action: events.ActionDie, Actor: events.Actor{ID: "x", Attributes: map[string]string{}}}
	if _, _, died := newEngineStops().observe(other); died {
		t.Fatal("a container that is no engine is not followed")
	}
}

// A stopped engine is starting only while the supervisor brings it back: one
// that stopped long ago is stopped, and so is one that should not run. One
// the supervisor started that does not serve within its readiness timeout is
// stopped too.
func TestStorageEngineStoppedForLongIsStopped(t *testing.T) {
	m, docker, _, id := newTestStorageEngine(t)
	serving := true
	m.probeReady = func(context.Context, managedStorageRecord) error {
		if serving {
			return nil
		}
		return errors.New("managed storage container health is starting")
	}
	docker.running["s1"] = true
	if got := inspectStorage(t, m, id); got.Status != "ready" {
		t.Fatalf("serving: %+v", got)
	}
	m.recordEngineStop("s1", true, false)
	docker.running["s1"] = false
	docker.finishedAt["s1"] = time.Now().Add(-engineRestartTimeout - time.Second)
	if got := inspectStorage(t, m, id); got.Status != "stopped" {
		t.Fatalf("stopped long ago: %+v, want stopped", got)
	}

	if err := m.startStoppedEngine(context.Background(), id, "s1"); err != nil {
		t.Fatal(err)
	}
	serving = false
	if got := inspectStorage(t, m, id); got.Status != "starting" {
		t.Fatalf("started again: %+v, want starting", got)
	}
	run := m.engineRun("s1")
	run.restartedAt = time.Now().Add(-managedStorageReadyTimeout(managedStorageRecord{}) - time.Second)
	m.setEngineRun("s1", run)
	if got := inspectStorage(t, m, id); got.Status != "stopped" || got.EngineExited {
		t.Fatalf("not serving after its readiness timeout: %+v, want stopped", got)
	}

	serving = true
	if got := inspectStorage(t, m, id); got.Status != "ready" {
		t.Fatalf("serving again: %+v", got)
	}
	m.recordEngineStop("s1", true, false)
	if _, err := m.handle(context.Background(), "stop", id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.Status != "stopped" {
		t.Fatalf("stopped on purpose: %+v, want stopped", got)
	}
}

// A restart is recorded with its operation, and the same restart sent again
// (its answer was lost) does not stop the engine a second time.
func TestStorageRestartIsAppliedOncePerOperation(t *testing.T) {
	m, docker, loops, id := newTestStorageEngine(t)
	ctx := context.Background()
	docker.running["s1"] = true
	const restartOperation = "33333333-3333-4333-8333-333333333333"
	payload, _ := json.Marshal(map[string]any{"version": 1, "engine": managedStorageEngineMinIO, "operationId": restartOperation})

	for range 2 {
		if _, err := m.handle(ctx, "restart", id, string(payload)); err != nil {
			t.Fatal(err)
		}
	}

	stops := 0
	for _, call := range loops.calls {
		if call == "stop s1" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("calls = %v, want the engine stopped once", loops.calls)
	}
	if got := inspectStorage(t, m, id); got.OperationID != restartOperation {
		t.Fatalf("operationId = %q, want the restart's %q", got.OperationID, restartOperation)
	}

	// A restart without an operation (an older Opfield) restarts as before.
	if _, err := m.handle(ctx, "restart", id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.OperationID != restartOperation {
		t.Fatalf("operationId = %q after a restart without one", got.OperationID)
	}
}
