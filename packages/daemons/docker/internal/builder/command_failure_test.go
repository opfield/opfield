package builder

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const buildkitFailure = `#5 [2/3] RUN echo hello
#5 0.231 hello
#5 DONE 0.3s

#6 [3/3] RUN exit 7
#6 ERROR: process "/bin/sh -c exit 7" did not complete successfully: exit code: 7
------
 > [3/3] RUN exit 7:
------
Dockerfile:3
--------------------
   1 |     FROM busybox:1.36
   2 |     RUN echo hello
   3 | >>> RUN exit 7
   4 |
--------------------
error: failed to solve: process "/bin/sh -c exit 7" did not complete successfully: exit code: 7
`

// fakeExecutable writes a shell script standing in for a builder binary.
func fakeExecutable(t *testing.T, script string) func(string) (string, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	return func(string) (string, error) { return path, nil }
}

func TestFailedBuildNamesTheDockerfileStepAndExitCode(t *testing.T) {
	manager := NewManager(RuntimeConfig{}, t.TempDir(), "", nil)
	output := filepath.Join(t.TempDir(), "out.txt")
	if err := os.WriteFile(output, []byte(buildkitFailure), 0o600); err != nil {
		t.Fatal(err)
	}
	manager.executable = fakeExecutable(t, "cat "+output+" >&2\nexit 1\n")

	err := manager.runCommand(context.Background(), "", "", os.Environ(), "buildctl", "build")
	if err == nil {
		t.Fatal("expected the build to fail")
	}
	want := "Dockerfile:3 `RUN exit 7`: failed to solve: process \"/bin/sh -c exit 7\" did not complete successfully: exit code: 7"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}

func TestFailedCommandWithoutBuildKitOutputKeepsItsLastErrorLine(t *testing.T) {
	manager := NewManager(RuntimeConfig{}, t.TempDir(), "", nil)
	manager.executable = fakeExecutable(t, "echo 'fatal: couldn'\\''t find remote ref refs/heads/nope' >&2\nexit 128\n")

	err := manager.runCommand(context.Background(), "", "", os.Environ(), "git", "fetch")
	if err == nil || err.Error() != "couldn't find remote ref refs/heads/nope (git exit status 128)" {
		t.Fatalf("error = %v", err)
	}

	manager.executable = fakeExecutable(t, "exit 3\n")
	if err := manager.runCommand(context.Background(), "", "", os.Environ(), "git", "fetch"); err == nil || err.Error() != "exit status 3" {
		t.Fatalf("silent failure = %v", err)
	}
}

func TestBuilderCacheResetStaysOutOfTheBuildLog(t *testing.T) {
	var mu sync.Mutex
	var logged []string
	manager := NewManager(RuntimeConfig{}, t.TempDir(), "", func(event *pb.DockerBuildEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if event.GetStatus() == "log" {
			logged = append(logged, string(event.GetLogChunk()))
		}
		return nil
	})
	// ctr lists no stored images; buildctl prune prints its table of removed cache records.
	manager.executable = fakeExecutable(t, "if [ \"$1\" = \"--address\" ]; then exit 0; fi\necho 'ID RECLAIMABLE SIZE LAST ACCESSED'\necho 'abc123 true 10MB'\n")

	if err := manager.prune(context.Background()); err != nil {
		t.Fatalf("prune: %v", err)
	}
	manager.pruneAfterJob("11111111-1111-4111-8111-111111111111")

	mu.Lock()
	defer mu.Unlock()
	if joined := strings.Join(logged, ""); joined != "" {
		t.Fatalf("maintenance output reached the build log: %q", joined)
	}
}
