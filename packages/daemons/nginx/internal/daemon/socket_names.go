package daemon

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// The socket directories nginx reaches the daemon through, under the names in effect (naming.Path). A process that
// moved the node to the Opfield names while it ran keeps the paths it started with: the old names link to the new
// ones (opfield_names.go).
func proxySecureLinkSocketDir() string    { return naming.Path(naming.SecureLinkSocketDir) }
func registrySecureLinkSocketDir() string { return naming.Path(naming.RegistrySocketDir) }

// keptNames are the listener keeper names a socket kept by the previous process may have: its name under the path
// it has now, and the same socket under its other directory name. A process that ran before the node moved to the
// Opfield names kept its sockets under the pre-Opfield directories, and the socket files moved with the directory.
// legacy-name: keeper names of sockets kept under the pre-Opfield directories — remove once every node reports none
func keptNames(name string) []string {
	names := []string{name}
	path, suffix := listenerkeep.NamePath(name), strings.TrimPrefix(name, listenerkeep.NamePath(name))
	if alias, ok := naming.AliasOf(path); ok {
		names = append(names, alias+suffix)
	}
	return names
}

// takeKept takes the listener the previous process kept under name or its alias, and returns the name it was kept
// under.
func takeKept(name string) (*os.File, string, bool) {
	for _, candidate := range keptNames(name) {
		if file, ok := listenerkeep.Take(candidate); ok {
			return file, candidate, true
		}
	}
	return nil, "", false
}

// dropStaleKept drops a copy systemd may still keep of a socket about to be replaced, under either name.
func dropStaleKept(name string) {
	for _, candidate := range keptNames(name) {
		_ = listenerkeep.DropStale(candidate)
	}
}

// releaseUnclaimedUnder closes the sockets the previous process kept in directory (under either of its names) that
// this process did not take over.
func releaseUnclaimedUnder(directory string) []string {
	released := listenerkeep.ReleaseUnclaimed(directory + "/")
	if alias, ok := naming.AliasOf(directory); ok {
		released = append(released, listenerkeep.ReleaseUnclaimed(alias+"/")...)
	}
	return released
}

// sameSocketPath reports whether two socket paths name the same socket, under either directory name.
func sameSocketPath(a, b string) bool {
	return a == b || (filepath.Base(a) == filepath.Base(b) && naming.SameDir(filepath.Dir(a), filepath.Dir(b)))
}
