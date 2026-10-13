package docker

import (
	"os"
	"path/filepath"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// legacyDatabaseTunnelDirectory held the socket of the per-binding database sidecars of earlier releases
// (tunnel.sock, open to every container). No Gateway creates those sidecars any more: database links are served by
// the host listeners and the shared connector.
const legacyDatabaseTunnelDirectory = "database-tunnel"

// removeLegacyDatabaseTunnelSocket removes that socket, and the copy a previous daemon process handed to the listener
// keeper. A daemon rolled back to an earlier release creates it again.
func removeLegacyDatabaseTunnelSocket(stateDir string) {
	directory := filepath.Join(stateDir, legacyDatabaseTunnelDirectory)
	listenerkeep.ReleaseUnclaimed(directory + string(os.PathSeparator))
	path := filepath.Join(directory, "tunnel.sock")
	if name, err := listenerkeep.Name(path); err == nil {
		_ = listenerkeep.DropStale(name)
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
		_ = os.Remove(path)
	}
	// Only an empty directory goes.
	_ = os.Remove(directory)
}
