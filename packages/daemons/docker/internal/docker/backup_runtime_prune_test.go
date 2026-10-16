package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupRunStatusesArePrunedAfterTheRetention(t *testing.T) {
	root := t.TempDir()
	runtime := &backupRuntime{plugin: &DockerPlugin{}, root: root, runs: map[string]*backupRunStatus{}, active: map[string]bool{}}
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	old := now.Add(-backupRunStatusRetained - time.Hour)
	recent := now.Add(-backupRunStatusRetained + time.Hour)
	write := func(status backupRunStatus) {
		t.Helper()
		data, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, status.RunID+".json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(backupRunStatus{RunID: "old-completed", Status: "completed", CompletedAt: &old})
	write(backupRunStatus{RunID: "old-failed", Status: "failed", CompletedAt: &old})
	write(backupRunStatus{RunID: "recent", Status: "completed", CompletedAt: &recent})
	write(backupRunStatus{RunID: "running", Status: "running"})
	write(backupRunStatus{RunID: "cleanup", Status: "failed", CompletedAt: &old, CleanupPending: true})
	write(backupRunStatus{RunID: "active", Status: "completed", CompletedAt: &old})
	write(backupRunStatus{RunID: "no-end", Status: "cancelled"})
	if err := os.Chtimes(filepath.Join(root, "no-end.json"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(root, "running.json"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	completed := backupRunStatus{RunID: "old-completed", Status: "completed", CompletedAt: &old}
	runtime.runs["old-completed"] = &completed
	runtime.active["active"] = true

	runtime.pruneTerminalRuns(now)

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, entry := range entries {
		left = append(left, entry.Name())
	}
	want := "active.json cleanup.json notes.txt recent.json running.json"
	if got := strings.Join(left, " "); got != want {
		t.Fatalf("left %q, want %q", got, want)
	}
	if _, ok := runtime.runs["old-completed"]; ok {
		t.Fatal("a pruned run leaves memory too")
	}
}
