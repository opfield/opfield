package lifecycle

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func TestEnsureHostIdentityAnswersFromConfiguredPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "host-identity")
	const identity = "0f8fad5b-d9cb-469f-a165-70867728950e"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(identity+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := &pb.OpfieldCommand{
		CommandId: "ensure-1",
		Payload:   &pb.OpfieldCommand_NodeFile{NodeFile: &pb.NodeFileCommand{Action: "ensure-host-identity"}},
	}

	result := handleNodeFile(context.Background(), cmd, path)
	if !result.Success {
		t.Fatalf("ensure-host-identity failed: %s", result.Error)
	}
	if got := strings.TrimSpace(string(result.Data)); got != identity {
		t.Fatalf("identity = %q, want the configured copy %q", got, identity)
	}
}
