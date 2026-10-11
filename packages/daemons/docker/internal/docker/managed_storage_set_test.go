package docker

import (
	"strconv"
	"strings"
	"testing"
)

// The SeaweedFS master runs as the runtime user: its scratch tmpfs must be
// that user's (a root-owned 0700 tmpfs made the master exit at once with
// "permission denied"), private (0700, never world-writable).
func TestSeaweedFSMasterTmpfsBelongsToTheRuntimeUser(t *testing.T) {
	options := seaweedfsSetMasterTmpfs()[seaweedfsSetMasterDataDir]
	for _, want := range []string{"mode=0700", "uid=" + strconv.Itoa(seaweedfsRuntimeUID), "gid=" + strconv.Itoa(seaweedfsRuntimeGID), "noexec"} {
		if !strings.Contains(options, want) {
			t.Fatalf("master tmpfs options %q lack %q", options, want)
		}
	}
	if strings.Contains(options, "1777") {
		t.Fatalf("the master tmpfs must not be world-writable: %q", options)
	}
}
