package runtime

import (
	"os"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// F-R1: the daemon reports the local Secure Runtime command without its version, whatever that is, so older Gateways
// recognise it too; the Gateway adds the node's daemon version when it shows it.
func TestLocalInstallCommandNamesNoVersion(t *testing.T) {
	previous := lifecycle.Version
	t.Cleanup(func() { lifecycle.Version = previous })
	lifecycle.Version = "v2.11.1-rc.24"

	command := localInstallCommand()
	if os.Geteuid() == 0 {
		if command != "sudo docker-daemon runtime install runsc" {
			t.Fatalf("root command = %q", command)
		}
		return
	}
	if !strings.HasPrefix(command, "sudo bash setup-docker-node.sh --user ") || !strings.HasSuffix(command, " --secure-runtime") {
		t.Fatalf("command = %q", command)
	}
}
