package lease

import (
	"os"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// DirFence is the production Fence: the watchdog's tmpfs directory.
type DirFence struct {
	Dir leasefence.Dir
}

var _ Fence = DirFence{}

func (f DirFence) HeartbeatAge(now time.Duration) (time.Duration, bool) {
	heartbeat, err := f.Dir.ReadHeartbeat()
	if err != nil {
		return 0, false
	}
	return heartbeat.Age(now)
}

func (f DirFence) Records() (map[string]leasefence.Record, error) {
	records, err := f.Dir.ReadableRecords()
	if err != nil {
		return nil, err
	}
	out := make(map[string]leasefence.Record, len(records))
	for _, record := range records {
		out[record.ContainerID] = record
	}
	return out, nil
}

func (f DirFence) WriteRecord(record leasefence.Record) error { return f.Dir.WriteRecord(record) }

func (f DirFence) DeleteRecord(containerID string) error { return f.Dir.DeleteRecord(containerID) }

func (f DirFence) DaemonAlive(now time.Duration) error {
	return f.Dir.WriteDaemonHeartbeat(leasefence.Heartbeat{NowNs: int64(now), PID: os.Getpid()})
}

// HeartbeatFresh reports a heartbeat within leasefence.HeartbeatMaxAge: the
// watchdog runs promptly enough to acquire, start or open the backend gate.
func HeartbeatFresh(f Fence, now time.Duration) bool {
	age, ok := f.HeartbeatAge(now)
	return ok && age <= leasefence.HeartbeatMaxAge
}

// HeartbeatAlive reports a heartbeat within leasefence.HeartbeatLostAge: the
// watchdog may be slow but is not gone. Capability and lease reports use it,
// so a CPU-starved watchdog does not move policies out of lease mode.
func HeartbeatAlive(f Fence, now time.Duration) bool {
	age, ok := f.HeartbeatAge(now)
	return ok && age <= leasefence.HeartbeatLostAge
}
