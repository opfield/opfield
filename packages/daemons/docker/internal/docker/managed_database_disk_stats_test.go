package docker

import (
	"errors"
	"testing"

	"golang.org/x/sys/unix"
)

func TestManagedDatabaseDiskUsage(t *testing.T) {
	original := managedDatabaseDiskStatfs
	t.Cleanup(func() { managedDatabaseDiskStatfs = original })

	managedDatabaseDiskStatfs = func(path string, stat *unix.Statfs_t) error {
		if path != "/var/lib/docker-daemon/databases/db-1" {
			t.Fatalf("statfs of %q", path)
		}
		stat.Bsize = 4096
		stat.Blocks = 1000
		stat.Bfree = 300
		stat.Bavail = 250
		return nil
	}
	used, total, ok := managedDatabaseDiskUsage("/var/lib/docker-daemon/databases/db-1")
	if !ok || used != 700*4096 || total != 950*4096 {
		t.Fatalf("got used=%d total=%d ok=%v", used, total, ok)
	}

	if _, _, ok := managedDatabaseDiskUsage(""); ok {
		t.Fatal("an empty mount path has no usage")
	}
	managedDatabaseDiskStatfs = func(string, *unix.Statfs_t) error { return errors.New("not mounted") }
	if _, _, ok := managedDatabaseDiskUsage("/missing"); ok {
		t.Fatal("an unreadable mount has no usage")
	}
}
