package lifecycle

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func touchAt(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestSweepUpdateLeftoversRemovesOnlyOldTemporaryBinaries(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	old := now.Add(-2 * time.Hour)
	touchAt(t, filepath.Join(dir, ".daemon-update-123"), old)
	touchAt(t, filepath.Join(dir, ".launcher-copy-456"), old)
	touchAt(t, filepath.Join(dir, ".daemon-update-789"), now)
	touchAt(t, filepath.Join(dir, "nginx-daemon"), old)
	touchAt(t, filepath.Join(dir, "nginx-daemon.previous"), old)
	if removed := sweepUpdateLeftovers(dir, now); removed != 2 {
		t.Fatalf("removed %d, want 2", removed)
	}
	for _, name := range []string{".daemon-update-789", "nginx-daemon", "nginx-daemon.previous"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s removed: %v", name, err)
		}
	}
}

func TestNodeUploadLeftoversAreSweptInRememberedDirectories(t *testing.T) {
	stateDir := t.TempDir()
	previous := nodeUploads.stateFile
	t.Cleanup(func() {
		nodeUploads.mu.Lock()
		nodeUploads.stateFile, nodeUploads.loaded, nodeUploads.dirs, nodeUploads.lastSweep = previous, false, nil, time.Time{}
		nodeUploads.mu.Unlock()
	})
	nodeUploads.mu.Lock()
	nodeUploads.stateFile, nodeUploads.loaded, nodeUploads.dirs, nodeUploads.lastSweep = filepath.Join(stateDir, nodeUploadDirsFile), false, nil, time.Time{}
	nodeUploads.mu.Unlock()

	target := t.TempDir()
	if err := initNodeFileUpload("live", filepath.Join(target, "file.bin"), 10); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	abandoned := filepath.Join(target, ".opfield-upload-gone.tmp")
	touchAt(t, abandoned, now.Add(-2*time.Hour))
	userFile := filepath.Join(target, "notes.tmp")
	touchAt(t, userFile, now.Add(-48*time.Hour))

	// A daemon restart forgets the in-memory set; the remembered directories come back from the state file.
	nodeUploads.mu.Lock()
	nodeUploads.loaded, nodeUploads.dirs, nodeUploads.lastSweep = false, nil, time.Time{}
	nodeUploads.mu.Unlock()
	sweepRememberedNodeUploadDirs(now)

	if _, err := os.Lstat(abandoned); !os.IsNotExist(err) {
		t.Fatal("abandoned upload kept")
	}
	for _, path := range []string{filepath.Join(target, ".opfield-upload-live.tmp"), userFile} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s removed: %v", path, err)
		}
	}
	if err := writeNodeFileUploadChunk("live", filepath.Join(target, "file.bin"), 0, []byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if err := completeNodeFileUpload("live", filepath.Join(target, "file.bin"), 10); err != nil {
		t.Fatal(err)
	}
}
