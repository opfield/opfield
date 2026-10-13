package docker

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"sync"
)

// linkListenerBootSkipped reports the missing boot step once per process.
var linkListenerBootSkipped sync.Once

// nonRootCapability tells Opfield that this docker-daemon runs as a non-root
// user, so the features that need root are shown as unavailable with that
// reason instead of being offered and failing: disk-image volumes, moving
// volume data between nodes, installing Secure Runtime from Opfield, and the
// boot step that opens database link listeners before Docker.
const nonRootCapability = "docker_daemon_non_root_v1"

// daemonEUID and daemonEGID are the ids the non-root checks use.
var (
	daemonEUID = os.Geteuid
	daemonEGID = os.Getegid
)

func runsWithoutRoot() bool { return daemonEUID() != 0 }

// runUserName names the daemon's user for messages.
func runUserName() string {
	uid := daemonEUID()
	if account, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		return account.Username
	}
	return "uid " + strconv.Itoa(uid)
}

// requireVolumeDataAccess refuses an operation that reads or writes a Docker
// volume's directory under the Docker data root, which only root can open.
func requireVolumeDataAccess(operation string) error {
	if !runsWithoutRoot() {
		return nil
	}
	return fmt.Errorf("%s needs docker-daemon to run as root: it reads volume data under the Docker data root, and this node runs docker-daemon as %s", operation, runUserName())
}

// connectorGroupAdd is the supplementary group of the Secure Link and storage
// connector containers (uid 65532). A root daemon hands them their socket
// directories by ownership; a daemon without root cannot chown, so it shares
// those directories and sockets through its own group instead, which only its
// user and these containers hold.
func connectorGroupAdd() []string {
	if !runsWithoutRoot() {
		return nil
	}
	return []string{strconv.Itoa(daemonEGID())}
}

// sameConnectorGroups reports whether a connector container has exactly the
// groups this daemon gives connectors, so one created by a daemon running as
// another user is replaced.
func sameConnectorGroups(groups []string) bool {
	want := connectorGroupAdd()
	if len(groups) != len(want) {
		return false
	}
	for index := range groups {
		if groups[index] != want[index] {
			return false
		}
	}
	return true
}

// allowedConnectorGroups accepts a managed connector without extra groups or
// with only the group of a daemon running as this process's user.
func allowedConnectorGroups(groups []string) bool {
	return len(groups) == 0 || (len(groups) == 1 && groups[0] == strconv.Itoa(daemonEGID()))
}
