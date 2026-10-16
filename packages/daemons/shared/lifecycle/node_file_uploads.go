package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// A node file-manager upload writes .opfield-upload-<id>.tmp next to its target; a browser closed mid-upload, an
// Opfield restart or a daemon crash leaves it behind. The daemon remembers the directories it wrote such files to
// (nodeUploadDirsFile in its state directory) and removes the ones nobody wrote to for nodeUploadLeftoverAge: in the
// target directory when a new upload starts there, and in every remembered directory on the first file-manager
// command after a start and every hour after it.
const (
	nodeUploadTempPrefix  = ".opfield-upload-"
	nodeUploadTempSuffix  = ".tmp"
	nodeUploadLeftoverAge = time.Hour
	nodeUploadSweepEvery  = time.Hour
	nodeUploadDirsFile    = "node-file-upload-dirs.json"
	maxNodeUploadDirs     = 256
)

var nodeUploads = struct {
	mu        sync.Mutex
	loaded    bool
	dirs      map[string]time.Time
	lastSweep time.Time
	// stateFile is a variable for tests; "" resolves it from the launcher state directory.
	stateFile string
}{}

func nodeUploadStateFile() string {
	if nodeUploads.stateFile != "" {
		return nodeUploads.stateFile
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	stateDir := launcherStateDirFromEnvironment(executable)
	if stateDir == "" {
		return ""
	}
	return filepath.Join(stateDir, nodeUploadDirsFile)
}

func loadNodeUploadDirsLocked() {
	if nodeUploads.loaded {
		return
	}
	nodeUploads.loaded = true
	nodeUploads.dirs = map[string]time.Time{}
	path := nodeUploadStateFile()
	if path == "" {
		return
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var dirs map[string]time.Time
	if json.Unmarshal(content, &dirs) == nil {
		for dir, at := range dirs {
			if filepath.IsAbs(dir) {
				nodeUploads.dirs[dir] = at
			}
		}
	}
}

func saveNodeUploadDirsLocked() {
	path := nodeUploadStateFile()
	if path == "" {
		return
	}
	if len(nodeUploads.dirs) > maxNodeUploadDirs {
		// The least recently used directories are forgotten first.
		dirs := make([]string, 0, len(nodeUploads.dirs))
		for dir := range nodeUploads.dirs {
			dirs = append(dirs, dir)
		}
		sort.Slice(dirs, func(i, j int) bool { return nodeUploads.dirs[dirs[i]].Before(nodeUploads.dirs[dirs[j]]) })
		for _, dir := range dirs[:len(dirs)-maxNodeUploadDirs] {
			delete(nodeUploads.dirs, dir)
		}
	}
	content, err := json.Marshal(nodeUploads.dirs)
	if err != nil {
		return
	}
	_ = atomicfile.WriteFile(path, content, 0o600)
}

// rememberNodeUploadDir records dir as holding an upload in progress and sweeps its stale uploads.
func rememberNodeUploadDir(dir string, now time.Time) {
	nodeUploads.mu.Lock()
	defer nodeUploads.mu.Unlock()
	loadNodeUploadDirsLocked()
	sweepNodeUploadDir(dir, now)
	nodeUploads.dirs[dir] = now
	saveNodeUploadDirsLocked()
}

// sweepRememberedNodeUploadDirs sweeps every remembered directory at most once per nodeUploadSweepEvery and forgets
// directories that no longer hold an upload.
func sweepRememberedNodeUploadDirs(now time.Time) {
	nodeUploads.mu.Lock()
	defer nodeUploads.mu.Unlock()
	if !nodeUploads.lastSweep.IsZero() && now.Sub(nodeUploads.lastSweep) < nodeUploadSweepEvery {
		return
	}
	nodeUploads.lastSweep = now
	loadNodeUploadDirsLocked()
	changed := false
	for dir := range nodeUploads.dirs {
		if remaining := sweepNodeUploadDir(dir, now); remaining == 0 {
			delete(nodeUploads.dirs, dir)
			changed = true
		}
	}
	if changed {
		saveNodeUploadDirsLocked()
	}
}

// sweepNodeUploadDir removes upload temp files in dir untouched for nodeUploadLeftoverAge and returns how many
// remain.
func sweepNodeUploadDir(dir string, now time.Time) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	remaining := 0
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasPrefix(name, nodeUploadTempPrefix) || !strings.HasSuffix(name, nodeUploadTempSuffix) {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err == nil && info.Mode().IsRegular() && info.ModTime().Before(now.Add(-nodeUploadLeftoverAge)) {
			if os.Remove(path) == nil {
				continue
			}
		}
		remaining++
	}
	return remaining
}
