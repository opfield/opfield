package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// A docker-daemon running without root cannot delete the socket directory a
// root daemon left to uid 65532 when the node switched modes. It runs this
// image once as uid 65532 with that directory mounted at cleanDirectoryMount
// and OPFIELD_CONNECTOR_CLEAN_DIR set; the connector empties the directory and
// exits.
const (
	cleanDirectoryMount = "/run/opfield-clean"
	// legacy-name: /run/gateway-clean mount — remove once every node reports none.
	// docker-daemon 2.12.0 mounts the directory there.
	legacyCleanDirectoryMount = "/run/gateway-clean"
)

// emptyCleanDirectory removes every entry of the mounted directory. Any other
// path is refused, so the mode cannot be pointed at the connector's own files.
func emptyCleanDirectory(directory string) error {
	mount := filepath.Clean(directory)
	if mount != cleanDirectoryMount && mount != legacyCleanDirectoryMount {
		return fmt.Errorf("%s must be %s", envPrefix+connectorCleanDirEnv, cleanDirectoryMount)
	}
	entries, err := os.ReadDir(mount)
	if err != nil {
		return fmt.Errorf("read %s: %w", mount, err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(mount, entry.Name())); err != nil {
			return fmt.Errorf("remove %s: %w", entry.Name(), err)
		}
	}
	return nil
}
