package main

import (
	"log/slog"
	"math"
	"os"
	"runtime/debug"

	"github.com/opfield/opfield/relay/internal/admission"
)

// configureMemoryLimit gives the Go runtime a soft memory limit of 90 % of the
// relay's cgroup limit, unless GOMEMLIMIT sets one: near it the collector
// works harder and returns memory to the system instead of letting the heap
// grow into the kernel's OOM kill, which would cut every tunnel (F11).
// Without a finite cgroup limit nothing changes.
func configureMemoryLimit() {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	limit := admission.CgroupMemoryLimit()
	if limit == 0 {
		return
	}
	soft := limit / 10 * 9
	if soft > math.MaxInt64 {
		return
	}
	debug.SetMemoryLimit(int64(soft))
	slog.Info("relay memory limit set from its cgroup", "cgroup_limit_bytes", limit, "soft_limit_bytes", soft)
}
