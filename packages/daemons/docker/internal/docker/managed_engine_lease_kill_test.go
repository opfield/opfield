package docker

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/events"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// rc.3 F-A2: a SIGKILL of the lease watchdog (the container's deadline record
// had passed) is Opfield's own fencing of an availability member: the log names
// the watchdog and the lease deadline instead of "another process".
func TestEngineKilledByTheLeaseWatchdogIsNamed(t *testing.T) {
	dir := leasefence.Dir{Root: t.TempDir()}
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	previous := engineLeaseRecords
	engineLeaseRecords = dir
	t.Cleanup(func() { engineLeaseRecords = previous })
	id := strings.Repeat("ab", 32)
	p := &DockerPlugin{}
	died := events.Message{Actor: events.Actor{ID: id, Attributes: map[string]string{"exitCode": "137"}}}

	if got := p.unrequestedStopCause(context.Background(), died, false); got != engineStopKilled {
		t.Fatalf("a SIGKILL of a container without a deadline record = %q, want %q", got, engineStopKilled)
	}
	if err := dir.WriteRecord(leasefence.Record{ContainerID: id, PolicyID: "policy", DeadlineNs: int64(leasefence.Now() + time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if got := p.unrequestedStopCause(context.Background(), died, false); got != engineStopKilled {
		t.Fatalf("a SIGKILL of a container whose lease deadline is ahead = %q, want %q", got, engineStopKilled)
	}
	if err := dir.WriteRecord(leasefence.Record{ContainerID: id, PolicyID: "policy", DeadlineNs: 1}); err != nil {
		t.Fatal(err)
	}
	cause := p.unrequestedStopCause(context.Background(), died, false)
	if cause != engineStopLeaseDeadline {
		t.Fatalf("a SIGKILL past the container's lease deadline = %q, want %q", cause, engineStopLeaseDeadline)
	}
	if line := engineStopLog("database", cause); !strings.Contains(line, "lease watchdog") || strings.Contains(line, "another process") {
		t.Fatalf("the log line must name the lease watchdog: %s", line)
	}
}

// rc.3 O-A6: the pg_basebackup helper that seeds a new copy carries the
// database's label and exits 0 when the seed is done: that is no engine stop
// (no "stopped on its own" line, no incident).
func TestEngineHelperExitIsNoEngineStop(t *testing.T) {
	stops := newEngineStops()
	for _, labels := range []map[string]string{
		helperContainerLabels(helperKindPostgres, map[string]string{managedDatabaseLabel: "db-1", pgHelperLabel: "1"}),
		{managedDatabaseLabel: "db-1", pgHelperLabel: "1"},
	} {
		attributes := map[string]string{"exitCode": "0"}
		for key, value := range labels {
			attributes[key] = value
		}
		if _, _, died := stops.observe(events.Message{Action: events.ActionDie, Actor: events.Actor{ID: "helper", Attributes: attributes}}); died {
			t.Fatalf("a helper container's exit must not count as an engine stop: %v", attributes)
		}
	}
	engine := map[string]string{managedDatabaseLabel: "db-1", "exitCode": "0"}
	if _, _, died := stops.observe(events.Message{Action: events.ActionDie, Actor: events.Actor{ID: "engine", Attributes: engine}}); !died {
		t.Fatal("the engine container's exit is an engine stop")
	}
}
