package sysmetrics

import (
	"errors"
	"math"
	"testing"
	"time"
)

// Two /proc/stat samples recorded 10 s apart on an idle 6-core LXC (CT 1138).
// Field 9 (guest) is the hypervisor's VMs and is already part of user.
const (
	procStatT0 = "cpu  458860097 4112859 107614625 1411674781 28437653 0 15836790 0 346235680 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n"
	procStatT1 = "cpu  458861672 4112859 107614896 1411678523 28437850 0 15836862 0 346237084 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n"
)

func procStatReader(contents *string) func(string) ([]byte, error) {
	return func(path string) ([]byte, error) {
		if path != "/proc/stat" {
			return nil, errors.New("unexpected path " + path)
		}
		return []byte(*contents), nil
	}
}

func TestParseProcStatCPUExcludesGuestTime(t *testing.T) {
	idle, total, ok := parseProcStatCPU([]byte(procStatT0))
	if !ok {
		t.Fatal("parse failed")
	}
	if idle != 1411674781 {
		t.Fatalf("idle = %d", idle)
	}
	want := uint64(458860097 + 4112859 + 107614625 + 1411674781 + 28437653 + 0 + 15836790 + 0)
	if total != want {
		t.Fatalf("total = %d, want %d (guest and guest_nice must not be added)", total, want)
	}
	if _, _, ok := parseProcStatCPU([]byte("intr 1 2 3\n")); ok {
		t.Fatal("non-cpu first line must not parse")
	}
}

func TestCPUPercentFromRecordedSamples(t *testing.T) {
	contents := procStatT0
	state := &CPUState{}
	start := time.Unix(1_800_000_000, 0)
	state.sample(start, procStatReader(&contents))

	contents = procStatT1
	got := state.sample(start.Add(10*time.Second), procStatReader(&contents))
	// Δ without guest: user 1575 + system 271 + idle 3742 + iowait 197 + softirq 72 = 5857,
	// busy 2115 → 36.11 %. Counting guest twice would give 48.46 %.
	if math.Abs(got-36.11) > 0.01 {
		t.Fatalf("cpu = %.2f, want 36.11", got)
	}
}

func TestCPUPercentKeepsBaselineInsideMinimumWindow(t *testing.T) {
	contents := procStatT0
	state := &CPUState{}
	start := time.Unix(1_800_000_000, 0)
	state.sample(start, procStatReader(&contents))
	contents = procStatT1
	first := state.sample(start.Add(10*time.Second), procStatReader(&contents))

	// Opfield's health request lands a few ms after the ticker. The counters moved
	// by a handful of busy ticks only, which used to read as 100 %.
	contents = "cpu  458861675 4112859 107614896 1411678523 28437850 0 15836862 0 346237084 0\n"
	got := state.sample(start.Add(10*time.Second+3*time.Millisecond), procStatReader(&contents))
	if got != first {
		t.Fatalf("inside the window got %.2f, want the last value %.2f", got, first)
	}
	if state.PrevTotal != 458861672+4112859+107614896+1411678523+28437850+15836862 {
		t.Fatal("baseline moved inside the minimum window")
	}

	// Once the window has passed, the delta runs from the kept baseline.
	contents = "cpu  458861972 4112859 107614896 1411679223 28437850 0 15836862 0 346237084 0\n"
	got = state.sample(start.Add(16*time.Second), procStatReader(&contents))
	if math.Abs(got-30) > 0.01 { // busy 300 of 1000 ticks
		t.Fatalf("after the window got %.2f, want 30", got)
	}
}

func TestCPUPercentCounterResetReadsZero(t *testing.T) {
	contents := procStatT1
	state := &CPUState{}
	start := time.Unix(1_800_000_000, 0)
	state.sample(start, procStatReader(&contents))
	contents = "cpu  10 0 10 100 0 0 0 0 0 0\n"
	if got := state.sample(start.Add(30*time.Second), procStatReader(&contents)); got != 0 {
		t.Fatalf("after a counter reset got %.2f, want 0", got)
	}
}
