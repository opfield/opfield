package docker

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/events"
)

// DB-O-6: a SIGKILL of the engine's process by another process (kill -9,
// exit code 137, no Docker stop and no out-of-memory kill) is logged and
// reported as a kill, not as out of memory; the kernel's out-of-memory kill
// (Docker's oom event, or its State.OOMKilled when the event was missed) is.
func TestEngineSIGKILLIsNotReportedAsOutOfMemory(t *testing.T) {
	m, docker, _, id := newTestStorageEngine(t)
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	e := newEngineEvents(t, m, id)
	e.plugin.client, e.plugin.logger = docker.client(), logger
	docker.oomKilled = map[string]bool{}
	var oomRun bool
	die := func(attributes map[string]string) string {
		t.Helper()
		logs.Reset()
		docker.running["s1"] = false
		docker.finishedAt["s1"] = time.Now()
		e.send(events.ActionDie, attributes)
		oomRun = m.engineRun("s1").oomKilled
		e.runRestart()
		e.send(events.ActionStart, nil)
		return logs.String()
	}
	incidents := func() map[string]any {
		t.Helper()
		return m.incidents.detail(id)
	}
	m.incidents = newEngineIncidents()

	// kill -9 of the engine's process.
	line := die(map[string]string{"exitCode": "137"})
	if !strings.Contains(line, "killed (SIGKILL) by another process, not out of memory") || !strings.Contains(line, `"outOfMemory":false`) {
		t.Fatalf("a SIGKILL from another process must be logged as a kill, not out of memory: %s", line)
	}
	if got := incidents(); got["oomKills"] != 0 || got["signalKills"] != 1 {
		t.Fatalf("incidents after a SIGKILL = %v, want 0 out-of-memory kills and 1 signal kill", got)
	}
	if oomRun {
		t.Fatal("a SIGKILL from another process is no out-of-memory kill of the run")
	}

	// The kernel's out-of-memory kill with its event.
	e.send(events.ActionOOM, nil)
	line = die(map[string]string{"exitCode": "137"})
	if !strings.Contains(line, "killed for memory (out of memory)") || !strings.Contains(line, `"outOfMemory":true`) || !oomRun {
		t.Fatalf("an out-of-memory kill must be logged and recorded as one: %s", line)
	}

	// The out-of-memory kill whose event the stream missed: Docker's state.
	docker.oomKilled["s1"] = true
	line = die(map[string]string{"exitCode": "137"})
	if !strings.Contains(line, `"outOfMemory":true`) {
		t.Fatalf("Docker's OOMKilled state must count as out of memory: %s", line)
	}
	if got := incidents(); got["oomKills"] != 2 || got["signalKills"] != 1 || got["restarts"] != 3 {
		t.Fatalf("incidents = %v, want 3 restarts, 2 out-of-memory kills, 1 signal kill", got)
	}

	// A plain crash is neither.
	docker.oomKilled["s1"] = false
	line = die(map[string]string{"exitCode": "1"})
	if !strings.Contains(line, "stopped on its own") || !strings.Contains(line, `"outOfMemory":false`) {
		t.Fatalf("a crash: %s", line)
	}
}
