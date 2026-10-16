package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// maxDaemonArtifactBytes bounds one downloaded daemon binary: a download past it is cut off instead of filling the
// disk before the checksum could reject it (a variable for tests).
var maxDaemonArtifactBytes int64 = 512 << 20

// updateLeftoverAge: a temporary binary of an update or launcher copy lives only while one operation runs.
const updateLeftoverAge = time.Hour

// updateLeftoverPrefixes are the temporary files selfupdate.go and launcher_state.go create next to the binaries;
// a crash, an OOM kill or a power loss in the middle leaves them behind.
var updateLeftoverPrefixes = []string{".daemon-update-", ".launcher-copy-"}

// sweepUpdateLeftovers removes temporary update files in dir older than updateLeftoverAge and returns how many.
func sweepUpdateLeftovers(dir string, now time.Time) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !hasUpdateLeftoverPrefix(entry.Name()) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.ModTime().After(now.Add(-updateLeftoverAge)) {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
	return removed
}

func hasUpdateLeftoverPrefix(name string) bool {
	for _, prefix := range updateLeftoverPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
