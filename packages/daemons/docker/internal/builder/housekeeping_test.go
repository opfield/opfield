package builder

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestIdleHousekeepingRemovesLeftoversOnlyWhenIdle(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "jobs")
	config := RuntimeConfig{BuildkitStateDir: filepath.Join(root, "builder", "buildkit")}
	manager := NewManager(config, workspace, filepath.Join(root, "askpass"), nil)

	job := filepath.Join(workspace, "11111111-1111-4111-8111-111111111111")
	secrets := filepath.Join(workspace, ".opfield-build-secrets-1")
	control := filepath.Join(workspace, ".opfield-pages-control-1")
	other := filepath.Join(workspace, "keep-me")
	for _, dir := range []string{job, secrets, control, other} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	previousTemp, previousCache := scanTempRoot, userCacheDir
	t.Cleanup(func() { scanTempRoot, userCacheDir = previousTemp, previousCache })
	scanTempRoot = filepath.Join(root, "tmp")
	cache := filepath.Join(root, "cache")
	userCacheDir = func() (string, error) { return cache, nil }
	oldScan := filepath.Join(scanTempRoot, "stereoscope-1")
	freshScan := filepath.Join(scanTempRoot, "stereoscope-2")
	legacyDB := filepath.Join(cache, "grype", "db", "6")
	grypeDB := config.GrypeDBDir()
	for _, dir := range []string{oldScan, freshScan, legacyDB, filepath.Join(grypeDB, "5"), filepath.Join(grypeDB, "6")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldScan, old, old); err != nil {
		t.Fatal(err)
	}

	// A running build blocks housekeeping.
	manager.mu.Lock()
	manager.jobs["11111111-1111-4111-8111-111111111111"] = func() {}
	manager.mu.Unlock()
	if ran, _ := manager.IdleHousekeeping(context.Background()); ran {
		t.Fatal("housekeeping ran while a build runs")
	}
	if _, err := os.Lstat(job); err != nil {
		t.Fatal("running job removed")
	}
	manager.mu.Lock()
	delete(manager.jobs, "11111111-1111-4111-8111-111111111111")
	manager.mu.Unlock()

	ran, err := manager.IdleHousekeeping(context.Background())
	if !ran || err != nil {
		t.Fatalf("housekeeping = %v, %v", ran, err)
	}
	for _, gone := range []string{job, secrets, control, oldScan, filepath.Join(cache, "grype", "db"), filepath.Join(grypeDB, "5")} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s kept: %v", gone, err)
		}
	}
	for _, kept := range []string{other, freshScan, filepath.Join(grypeDB, "6")} {
		if _, err := os.Lstat(kept); err != nil {
			t.Fatalf("%s removed: %v", kept, err)
		}
	}
	// Builds start again after the run.
	if !manager.TryPause() {
		t.Fatal("housekeeping left the builder paused")
	}
}

func TestScanEnvironmentConfinesScannerDisk(t *testing.T) {
	jobDir := t.TempDir()
	dbDir := filepath.Join(t.TempDir(), "grype-db")
	env, err := scanEnvironment([]string{"PATH=/bin", "TMPDIR=/tmp", "GRYPE_DB_CACHE_DIR=/root/.cache"}, jobDir, dbDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"PATH=/bin", "TMPDIR=" + filepath.Join(jobDir, "tmp"), "GRYPE_DB_CACHE_DIR=" + dbDir}
	if !slices.Equal(env, want) {
		t.Fatalf("env = %v", strings.Join(env, " "))
	}
	for _, dir := range []string{filepath.Join(jobDir, "tmp"), dbDir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("%s not created: %v", dir, err)
		}
	}
}
