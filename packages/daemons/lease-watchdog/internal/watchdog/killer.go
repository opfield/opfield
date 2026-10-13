package watchdog

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// CgroupKiller kills a cgroup directly through cgroupfs, never through
// dockerd, so a hung dockerd cannot keep a fenced container alive (A2.2).
type CgroupKiller struct {
	// Signal delivers SIGKILL to one pid; injectable for tests.
	Signal func(pid int) error
}

func (k CgroupKiller) Kill(path string) (int, error) {
	pids, err := leasefence.CgroupProcs(path)
	if err != nil {
		return 0, err
	}
	if len(pids) == 0 {
		return 0, nil
	}
	// A frozen cgroup (docker pause, v1 freezer) would hold SIGKILL pending;
	// thaw it first. Both writes are best effort: absent files are normal.
	writeIfExists(filepath.Join(path, "cgroup.freeze"), "0")
	writeIfExists(filepath.Join(path, "freezer.state"), "THAWED")
	// cgroup v2 (Linux 5.14+) kills the whole subtree atomically, including
	// processes forked during the kill.
	writeIfExists(filepath.Join(path, "cgroup.kill"), "1")
	signal := k.Signal
	if signal == nil {
		signal = func(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
	}
	var firstErr error
	for _, pid := range pids {
		if killErr := signal(pid); killErr != nil && !errors.Is(killErr, syscall.ESRCH) && firstErr == nil {
			firstErr = killErr
		}
	}
	return len(pids), firstErr
}

func writeIfExists(path, value string) {
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return
	}
	_, _ = file.WriteString(value)
	_ = file.Close()
}
