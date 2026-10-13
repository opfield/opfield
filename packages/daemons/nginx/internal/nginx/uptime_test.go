package nginx

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// P-5: in an LXC container /proc/uptime is the container's while a process's
// start is counted from the host's boot; the start time comes from btime.
func TestProcessStartTimeUsesTheBootTime(t *testing.T) {
	root := t.TempDir()
	saved := procRoot
	procRoot = root
	t.Cleanup(func() { procRoot = saved })
	// The host booted 30 days ago, the container (its /proc/uptime) 1 hour
	// ago, and nginx started 9 days after the host's boot.
	bootTime := time.Now().Add(-30 * 24 * time.Hour).Unix()
	write := func(name, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("uptime", "3600.00 3600.00\n")
	write("stat", "cpu  1 2 3 4\nintr 0\nbtime "+strconv.FormatInt(bootTime, 10)+"\nprocesses 9\n")
	startTicks := int64(9 * 24 * 3600 * 100)
	write("42/stat", "42 (nginx: master) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 "+strconv.FormatInt(startTicks, 10)+" 1 1 18446744073709551615\n")
	started, err := processStartTime(42)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Unix(bootTime, 0).Add(9 * 24 * time.Hour)
	if !started.Equal(want) {
		t.Fatalf("start %v, want %v", started, want)
	}
	if uptime := time.Since(started); uptime < 20*24*time.Hour || uptime > 22*24*time.Hour {
		t.Fatalf("uptime %v, want about 21 days", uptime)
	}
}
