//go:build swhacontainer || kvhacontainer || pghacontainer

package docker

import (
	"os/exec"
	"strings"
	"testing"
)

func dockerCLI(args ...string) (string, error) {
	out, err := exec.Command("docker", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func mustDocker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := dockerCLI(args...)
	if err != nil {
		t.Fatalf("docker %v: %v\n%s", args, err, out)
	}
	return out
}
