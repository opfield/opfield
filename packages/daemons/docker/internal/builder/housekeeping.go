package builder

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// IdleHousekeepingInterval: how often an idle worker runs IdleHousekeeping after its first run at start.
	IdleHousekeepingInterval = 6 * time.Hour
	// idlePruneTimeout bounds the cache and image-store prune of one IdleHousekeeping run.
	idlePruneTimeout = 2 * time.Minute
	// scanTempLeftoverAge: a scanner temp directory older than this was left by a scan that was killed.
	scanTempLeftoverAge = time.Hour
)

// scanTempRoot is where scanners left image extractions before they got a per-job TMPDIR (a variable for tests).
var scanTempRoot = os.TempDir()

// userCacheDir is the scanner cache root used before GRYPE_DB_CACHE_DIR was set (a variable for tests).
var userCacheDir = os.UserCacheDir

// GrypeDBDir is where grype keeps its vulnerability database: next to the other builder state, so it is part of the
// builder's footprint, instead of the service user's ~/.cache.
func (c RuntimeConfig) GrypeDBDir() string {
	return filepath.Join(filepath.Dir(c.BuildkitStateDir), "grype-db")
}

// IdleHousekeeping removes what a crash, a kill or an older daemon left on the worker when no build runs: job,
// secret and Pages control directories, scanner temp directories, superseded grype database schemas and the old
// per-user database copy, then the BuildKit cache and the containerd image store (prune). It reports false without
// doing anything while a build runs or the runtime is paused; builds that arrive meanwhile wait for it (TryPause).
func (m *Manager) IdleHousekeeping(ctx context.Context) (bool, error) {
	if !m.TryPause() {
		return false, nil
	}
	m.mu.Lock()
	config, askpass := m.config, m.askpass
	m.mu.Unlock()
	defer m.Resume(config, askpass)
	var errs []error
	errs = append(errs, cleanupStaleSecretDirs(m.workspace), cleanupStaleJobDirs(m.workspace), cleanupStalePagesControlDirs(m.workspace))
	errs = append(errs, sweepScanTempDirs(scanTempRoot, time.Now()))
	errs = append(errs, pruneGrypeDB(config.GrypeDBDir()))
	if err := m.Ready(); err == nil {
		pruneCtx, cancel := context.WithTimeout(ctx, idlePruneTimeout)
		errs = append(errs, m.prune(pruneCtx, ""))
		cancel()
	}
	return true, errors.Join(errs...)
}

func cleanupStalePagesControlDirs(workspace string) error {
	matches, err := filepath.Glob(filepath.Join(workspace, ".opfield-pages-control-*"))
	if err != nil {
		return err
	}
	var errs []error
	for _, match := range matches {
		errs = append(errs, secureRemoveAll(match))
	}
	return errors.Join(errs...)
}

// sweepScanTempDirs removes image extractions syft (stereoscope) left in root when a scan was killed.
func sweepScanTempDirs(root string, now time.Time) error {
	matches, err := filepath.Glob(filepath.Join(root, "stereoscope-*"))
	if err != nil {
		return err
	}
	var errs []error
	for _, match := range matches {
		info, err := os.Lstat(match)
		if err != nil || !info.IsDir() || info.ModTime().After(now.Add(-scanTempLeftoverAge)) {
			continue
		}
		errs = append(errs, os.RemoveAll(match))
	}
	return errors.Join(errs...)
}

// pruneGrypeDB keeps only the newest database schema in dir (an upgraded grype leaves the old schema behind) and
// removes the per-user copy grype kept before GRYPE_DB_CACHE_DIR pointed at dir.
func pruneGrypeDB(dir string) error {
	var errs []error
	if cache, err := userCacheDir(); err == nil && cache != "" {
		legacy := filepath.Join(cache, "grype", "db")
		if filepath.Clean(legacy) != filepath.Clean(dir) {
			errs = append(errs, os.RemoveAll(legacy))
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return errors.Join(errs...)
		}
		return errors.Join(append(errs, err)...)
	}
	newest := -1
	for _, entry := range entries {
		schema, err := strconv.Atoi(strings.TrimPrefix(entry.Name(), "v"))
		if !entry.IsDir() || err != nil || schema < 0 {
			continue
		}
		newest = max(newest, schema)
	}
	for _, entry := range entries {
		schema, err := strconv.Atoi(strings.TrimPrefix(entry.Name(), "v"))
		if !entry.IsDir() || err != nil || schema == newest {
			continue
		}
		errs = append(errs, os.RemoveAll(filepath.Join(dir, entry.Name())))
	}
	return errors.Join(errs...)
}

// scanEnvironment confines the scanners' disk use: image extraction goes under the job directory (counted by the
// disk monitor, removed with the job) and the vulnerability database to GrypeDBDir.
func scanEnvironment(base []string, jobDir, grypeDBDir string) ([]string, error) {
	tempDir := filepath.Join(jobDir, "tmp")
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(grypeDBDir, 0o700); err != nil {
		return nil, err
	}
	environment := make([]string, 0, len(base)+2)
	for _, entry := range base {
		if strings.HasPrefix(entry, "TMPDIR=") || strings.HasPrefix(entry, "GRYPE_DB_CACHE_DIR=") {
			continue
		}
		environment = append(environment, entry)
	}
	return append(environment, "TMPDIR="+tempDir, "GRYPE_DB_CACHE_DIR="+grypeDBDir), nil
}
