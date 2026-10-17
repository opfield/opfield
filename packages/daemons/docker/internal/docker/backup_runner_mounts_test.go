package docker

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"testing"
)

// N-2: a backup or storage-copy runner finds its configuration at the Opfield
// path and at the path a pinned pre-2.12.1 runner image reads only.
func TestBackupRunnerConfigIsMountedAtBothPaths(t *testing.T) {
	mounts := backupRunnerConfigMounts("/var/lib/docker-daemon/backup-runs/r1/config")
	targets := map[string]bool{}
	for _, m := range mounts {
		if m.Source != "/var/lib/docker-daemon/backup-runs/r1/config" || !m.ReadOnly {
			t.Fatalf("config mount %+v", m)
		}
		targets[m.Target] = true
	}
	// legacy-name: the path a pre-2.12.1 runner image reads
	if len(mounts) != 2 || !targets["/run/opfield-backup"] || !targets[legacycompat.RunDirPrefix+"backup"] {
		t.Fatalf("config mounts %+v", mounts)
	}
}
