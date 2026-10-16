package sysmetrics

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// machineIDPaths are where the host keeps its machine id: systemd's, then
// D-Bus's (hosts without systemd, such as Alpine with OpenRC).
var machineIDPaths = []string{"/etc/machine-id", "/var/lib/dbus/machine-id"}

var machineIDCache struct {
	sync.Mutex
	id string
}

// hostMachineID is the host's machine id, or "" when it has none. Every
// daemon on one host (also one run as another user: the file is world
// readable) reads the same id. A found id is kept for the life of the
// process.
func hostMachineID() string {
	machineIDCache.Lock()
	defer machineIDCache.Unlock()
	if machineIDCache.id != "" {
		return machineIDCache.id
	}
	machineIDCache.id = readMachineID(machineIDPaths)
	return machineIDCache.id
}

func readMachineID(paths []string) string {
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	return ""
}

// DiskID names the filesystem behind a mount, the same for every daemon on
// one host that sees it: several nodes enrolled on one machine report the
// same disk, and Opfield raises one disk alert for it. It hashes the host's
// machine id, the filesystem id (statfs f_fsid) and the device of the mount
// point (st_dev), so two filesystems that share an fsid on one host still
// differ. The machine id itself is not revealed. Empty without a machine id.
func DiskID(machineID string, fsid unix.Fsid, dev uint64) string {
	if machineID == "" {
		return ""
	}
	sum := sha256.Sum256(fmt.Appendf(nil, "opfield-disk-id/v1\x00%s\x00%08x:%08x\x00%d",
		machineID, uint32(fsid.Val[0]), uint32(fsid.Val[1]), dev))
	return hex.EncodeToString(sum[:16])
}
