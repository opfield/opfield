// Package leasefence is the on-disk contract between the docker daemon and
// the independent lease watchdog (A2.2, A12). It is versioned and must stay
// backward compatible: the watchdog is installed and updated independently of
// the daemon, so any daemon version may meet any watchdog version.
//
// Layout under Dir.Root (tmpfs, default /run/opfield-lease-watchdog; see
// RootPair for the pre-Opfield name):
//
//	heartbeat           written by the watchdog every HeartbeatInterval
//	daemon-heartbeat    written by the lease-aware docker daemon every
//	                    second (since availability_lease_v2)
//	records/<id>.json   one deadline record per lease-mode container,
//	                    written by the daemon
//
// A record names a container, its cgroup and a CLOCK_BOOTTIME deadline in
// nanoseconds. Whenever now >= deadline the watchdog kills every process in
// the container's cgroup without going through dockerd, and keeps doing so
// on every pass, so a start that completes late dies too. A deadline of 0 is
// always stale: a standby that was created but never held cannot run.
package leasefence

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

const (
	// DefaultRoot is on tmpfs so records vanish on reboot, when lease-mode
	// containers (RestartPolicy no) cannot be running either.
	DefaultRoot = "/run/opfield-lease-watchdog"
	// LegacyRoot is the pre-Opfield name of DefaultRoot. A watchdog or daemon
	// of an older release uses it; the watchdog moves it to DefaultRoot and
	// leaves a link (EnsureDefaultRoot), so both meet in one directory.
	// legacy-name: legacycompat.RunDirPrefixlease-watchdog of pre-Opfield watchdogs and docker daemons — remove once every node reports none
	LegacyRoot = legacycompat.RunDirPrefix + "lease-watchdog"
	// FormatVersion is the record and heartbeat schema version.
	FormatVersion = 1
	// HeartbeatInterval is how often the watchdog proves its kill loop runs.
	HeartbeatInterval = time.Second
	// HeartbeatMaxAge is how old a heartbeat may be for the daemon to acquire
	// a lease, start a container or open the backend gate.
	HeartbeatMaxAge = 3 * time.Second
	// HeartbeatLostAge is how old a heartbeat must be before the daemon
	// treats the watchdog as gone: a holder then stops renewing and kills its
	// containers, and the node reports no watchdog. A watchdog that is only
	// slow (CPU-starved) stays below it; the lease timing bound is in the
	// docker daemon's lease runtime.
	HeartbeatLostAge = 10 * time.Second
	// DaemonGoneAfter is how long the watchdog keeps enforcing records
	// without any sign of a lease-aware docker daemon: neither its
	// daemon-heartbeat nor a record written since. After that the records
	// are orphans (the node was rolled back to a daemon without the
	// availability lease, which never renews or removes them) and the
	// watchdog removes them, or it would kill those containers on every
	// start until the host reboots. Every deadline is long past by then.
	DaemonGoneAfter = 10 * time.Minute

	recordsDirName      = "records"
	heartbeatName       = "heartbeat"
	daemonHeartbeatName = "daemon-heartbeat"
)

var containerIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidContainerID reports whether id is a full Docker container id.
func ValidContainerID(id string) bool { return containerIDPattern.MatchString(id) }

// Record is one deadline record (A12.1).
type Record struct {
	Version     int    `json:"v"`
	ContainerID string `json:"containerId"`
	// CgroupPath is the container's cgroup directory when known; the watchdog
	// also probes the standard Docker cgroup locations.
	CgroupPath string `json:"cgroupPath,omitempty"`
	PolicyID   string `json:"policyId"`
	Slot       uint32 `json:"slot"`
	// DeadlineNs is a CLOCK_BOOTTIME value; 0 is always stale.
	DeadlineNs int64 `json:"deadlineNs"`
	// WrittenNs is the CLOCK_BOOTTIME time of the write, for diagnostics.
	WrittenNs int64 `json:"writtenNs"`
}

// Deadline returns the record deadline as a clock value.
func (r Record) Deadline() time.Duration { return time.Duration(r.DeadlineNs) }

// Stale reports whether the record's container must be dead at now.
func (r Record) Stale(now time.Duration) bool { return int64(now) >= r.DeadlineNs }

// Heartbeat is the watchdog liveness proof (A12.4).
type Heartbeat struct {
	Version int    `json:"v"`
	NowNs   int64  `json:"nowNs"`
	PID     int    `json:"pid"`
	Build   string `json:"build,omitempty"`
}

// Age returns how long ago the heartbeat was written. A heartbeat written
// after the reader took now (the watchdog wrote between the reader's clock
// read and its file read) has age 0; one further ahead than HeartbeatMaxAge
// cannot come from this host's clock and is invalid.
func (h Heartbeat) Age(now time.Duration) (time.Duration, bool) {
	if h.NowNs <= 0 {
		return 0, false
	}
	age := now - time.Duration(h.NowNs)
	if age < 0 {
		if -age > HeartbeatMaxAge {
			return 0, false
		}
		age = 0
	}
	return age, true
}

// Fresh reports whether the heartbeat was written within HeartbeatMaxAge.
func (h Heartbeat) Fresh(now time.Duration) bool {
	age, ok := h.Age(now)
	return ok && age <= HeartbeatMaxAge
}

// Alive reports whether the heartbeat was written within HeartbeatLostAge.
func (h Heartbeat) Alive(now time.Duration) bool {
	age, ok := h.Age(now)
	return ok && age <= HeartbeatLostAge
}

// Dir addresses the shared tmpfs directory.
type Dir struct {
	Root string
}

// RootPair is the default directory under both its names.
var RootPair = hostrename.Pair{Old: LegacyRoot, New: DefaultRoot}

// root resolves the default directory on every use: an older watchdog may
// create it under the pre-Opfield name after a reboot, and a newer one moves it
// while the daemon runs.
func (d Dir) root() string {
	if d.Root == "" || d.Root == DefaultRoot || d.Root == LegacyRoot {
		return hostrename.Resolve(RootPair)
	}
	return d.Root
}

// EnsureDefaultRoot makes the default directory exist under its Opfield name
// with the pre-Opfield name linking to it (moving a directory an older
// component created). Only the watchdog, which runs as root, calls it.
func EnsureDefaultRoot() (string, error) {
	return hostrename.EnsureRunDir(RootPair, 0o755)
}

// ensureRoot creates the directory when it is missing. The default one is
// created under its Opfield name with the pre-Opfield name linking to it, so a
// watchdog of an older release that starts later uses the same directory
// instead of creating its own.
func (d Dir) ensureRoot() error {
	if info, err := os.Stat(d.root()); err == nil && info.IsDir() {
		return nil
	}
	if d.Root == "" || d.Root == DefaultRoot || d.Root == LegacyRoot {
		_, err := EnsureDefaultRoot()
		return err
	}
	return os.MkdirAll(d.root(), 0o755)
}

// Legacy reports whether the default directory is still under its pre-Opfield
// name.
func Legacy() bool { return hostrename.Legacy(RootPair) }

// RecordsDir is where deadline records live.
func (d Dir) RecordsDir() string { return filepath.Join(d.root(), recordsDirName) }

// HeartbeatPath is the watchdog heartbeat file.
func (d Dir) HeartbeatPath() string { return filepath.Join(d.root(), heartbeatName) }

func (d Dir) recordPath(containerID string) string {
	return filepath.Join(d.RecordsDir(), containerID+".json")
}

// WriteRecord atomically replaces the record of r.ContainerID.
func (d Dir) WriteRecord(r Record) error {
	if !ValidContainerID(r.ContainerID) {
		return fmt.Errorf("lease fence record needs a full container id, got %q", r.ContainerID)
	}
	if r.CgroupPath != "" && !filepath.IsAbs(r.CgroupPath) {
		return errors.New("lease fence record cgroup path must be absolute")
	}
	r.Version = FormatVersion
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	// Readable to the owner of the records directory (0700, the docker daemon's user), whoever wrote it: after a
	// switch of the daemon's user the new daemon reads the records the previous one wrote as soon as the directory
	// is its own, before the watchdog or the installer hands the files over.
	return writeAtomic(d.RecordsDir(), d.recordPath(r.ContainerID), data, 0o644)
}

// DeleteRecord removes a record; a missing record is not an error.
func (d Dir) DeleteRecord(containerID string) error {
	if !ValidContainerID(containerID) {
		return fmt.Errorf("invalid container id %q", containerID)
	}
	if err := os.Remove(d.recordPath(containerID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ReadRecords returns every well-formed record, sorted by container id, and
// the names of malformed files, which never hide valid records. err is set
// only when the directory itself cannot be read.
func (d Dir) ReadRecords() (records []Record, problems []string, err error) {
	return d.readRecords(false)
}

// ReadableRecords is ReadRecords for the docker daemon: a record it is not
// allowed to read (written by the daemon of another user before a switch of
// its user, until the watchdog hands it over) is an error like an unreadable
// directory, never a missing record. A malformed record is still ignored.
func (d Dir) ReadableRecords() ([]Record, error) {
	records, _, err := d.readRecords(true)
	return records, err
}

func (d Dir) readRecords(strict bool) (records []Record, problems []string, err error) {
	entries, err := os.ReadDir(d.RecordsDir())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		data, readErr := os.ReadFile(filepath.Join(d.RecordsDir(), name))
		if readErr != nil {
			if strict && errors.Is(readErr, os.ErrPermission) {
				return nil, nil, readErr
			}
			problems = append(problems, fmt.Sprintf("%s: %v", name, readErr))
			continue
		}
		var record Record
		if jsonErr := json.Unmarshal(data, &record); jsonErr != nil || record.ContainerID != id || !ValidContainerID(id) {
			problems = append(problems, fmt.Sprintf("%s: malformed record", name))
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ContainerID < records[j].ContainerID })
	return records, problems, nil
}

// WriteHeartbeat atomically replaces the heartbeat.
func (d Dir) WriteHeartbeat(h Heartbeat) error {
	h.Version = FormatVersion
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	return writeAtomic(d.root(), d.HeartbeatPath(), data, 0o644)
}

// DaemonHeartbeatPath is the lease-aware docker daemon's liveness file.
func (d Dir) DaemonHeartbeatPath() string { return filepath.Join(d.root(), daemonHeartbeatName) }

// WriteDaemonHeartbeat atomically replaces the docker daemon's heartbeat.
func (d Dir) WriteDaemonHeartbeat(h Heartbeat) error {
	h.Version = FormatVersion
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if err := d.ensureRoot(); err != nil {
		return err
	}
	return writeAtomic(d.root(), d.DaemonHeartbeatPath(), data, 0o644)
}

// ReadDaemonHeartbeat returns the docker daemon's last heartbeat; a missing
// file (no lease-aware daemon since boot) is an error.
func (d Dir) ReadDaemonHeartbeat() (Heartbeat, error) {
	data, err := os.ReadFile(d.DaemonHeartbeatPath())
	if err != nil {
		return Heartbeat{}, err
	}
	var heartbeat Heartbeat
	if err := json.Unmarshal(data, &heartbeat); err != nil {
		return Heartbeat{}, fmt.Errorf("decode docker daemon heartbeat: %w", err)
	}
	return heartbeat, nil
}

// ReadHeartbeat returns the last heartbeat; a missing file is an error.
func (d Dir) ReadHeartbeat() (Heartbeat, error) {
	data, err := os.ReadFile(d.HeartbeatPath())
	if err != nil {
		return Heartbeat{}, err
	}
	var heartbeat Heartbeat
	if err := json.Unmarshal(data, &heartbeat); err != nil {
		return Heartbeat{}, fmt.Errorf("decode lease watchdog heartbeat: %w", err)
	}
	return heartbeat, nil
}

func writeAtomic(dir, path string, data []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
