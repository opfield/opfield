//go:build enginecontainer

package docker

// Container test of an engine that dies while it starts (a Valkey on a CPU
// without the instructions its modules need): the readiness wait ends at once
// with the exit and the crash line instead of the timeout, and the log of the
// failed start outlives the container. Run on a host with a Docker engine:
//
//	go test -tags enginecontainer -run TestCrashingEngine -v ./internal/docker/

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

func TestCrashingEngineFailsFastWithItsCause(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := NewClient("unix:///var/run/docker.sock", t.TempDir(), logger)
	if err != nil {
		t.Fatal(err)
	}
	m := &managedDatabaseManager{root: t.TempDir(), client: client, logger: logger, incidents: newEngineIncidents()}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	image, err := client.EnsureThirdPartyImage(ctx, volumeHelperImage)
	if err != nil {
		t.Fatal(err)
	}
	// The GHCR mirror first, Docker Hub when the mirror does not have it yet.
	t.Logf("helper image pulled as %s", image)
	// The first lines of a Valkey crash report, then a segmentation fault (in
	// a child: PID 1 ignores a signal it sends itself, a real fault kills it).
	script := `echo "1:M * Module 'json' loaded from /usr/lib/valkey/libjson.so"; echo '=== VALKEY BUG REPORT START: Cut & paste starting from here ==='; echo '1:M # valkey 9.1.2 crashed by signal: 4, si_code: 2'; echo 'RAX:0000'; sleep 1; sh -c 'kill -SEGV $$'; exit $?`
	created, err := client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{Image: image, Cmd: []string{"sh", "-c", script}},
		Name:   "fv-crashing-engine",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.RemoveContainer(context.Background(), created.ID, true) }()
	if _, err := client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = m.waitForDatabaseReady(ctx, created.ID, managedDatabaseCommand{Type: "redis", OwnerPassword: "x"})
	if !errors.Is(err, errEngineExited) {
		t.Fatalf("readiness ended with %v", err)
	}
	if waited := time.Since(started); waited > 20*time.Second {
		t.Errorf("waited %s for an engine that died", waited)
	}
	for _, want := range []string{"exit code 139 (SIGSEGV", "crashed by signal: 4"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%q lacks %q", err.Error(), want)
		}
	}
	t.Logf("error: %v", err)

	id := "fv-crashing-engine-db"
	m.keepFailedStartLog(ctx, id, created.ID, err)
	_ = client.RemoveContainer(ctx, created.ID, true)
	lines, ok := m.failedStartLog(id, 0, false)
	if !ok || len(lines) < 3 || !strings.Contains(strings.Join(lines, "\n"), "crashed by signal: 4") {
		t.Fatalf("kept log %v, %v", lines, ok)
	}
}
