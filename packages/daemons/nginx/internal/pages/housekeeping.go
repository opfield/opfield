package pages

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// uploadRetention: an upload nobody appended to or finalized for this long is abandoned. Opfield sends a whole
	// archive (at most 1 GiB) in one pass, so a live transfer never pauses that long.
	uploadRetention = 6 * time.Hour
	// crashLeftoverAge: extraction stages and temporary files exist only while one command runs; older ones were
	// left by a crash.
	crashLeftoverAge = time.Hour
	// runtimeConfigStagedGrace: a generation newer than the active one is a publication between its stage and
	// activate commands for this long; after that it was abandoned.
	runtimeConfigStagedGrace = time.Hour
	// revokedPreviewRetention: how long the denial vhost of a revoked preview is kept.
	revokedPreviewRetention = 30 * 24 * time.Hour
	// Node reserve: Pages never fills the last 10 % of the node's filesystem (at most 4 GiB), so routes,
	// certificates and logs keep room to be written.
	nodeReservePercent  = 10
	nodeReserveMaxBytes = 4 << 30
)

// filesystemSpace returns the free and total bytes of the filesystem holding path (a variable for tests).
var filesystemSpace = func(path string) (free, total int64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), int64(stat.Blocks) * int64(stat.Bsize), nil
}

// nodeReserveBytes is the free space Pages leaves on a filesystem of total bytes.
func nodeReserveBytes(total int64) int64 {
	reserve := total / 100 * nodeReservePercent
	if reserve > nodeReserveMaxBytes {
		return nodeReserveMaxBytes
	}
	return reserve
}

// SweepResult counts what one Sweep removed.
type SweepResult struct {
	Uploads               int
	Stages                int
	RuntimeConfigVersions int
	RevokedPreviews       int
	TemporaryFiles        int
}

// Total is the number of removed entries.
func (s SweepResult) Total() int {
	return s.Uploads + s.Stages + s.RuntimeConfigVersions + s.RevokedPreviews + s.TemporaryFiles
}

// Sweep removes what Pages commands leave behind on the node: abandoned uploads, extraction stages and temporary
// files of a crash, runtime-config generations that are neither active nor the rollback target, and, when
// expireRevokedPreviews is set, revoked-preview denial vhosts older than 30 days (all of them while the managed default
// servers answer unknown hostnames, SetUnknownHostsAnswered). The caller serializes it with
// every Pages command. Errors of one entry do not stop the others; the first one is returned.
func (r *Runtime) Sweep(now time.Time, expireRevokedPreviews bool) (SweepResult, error) {
	result := SweepResult{}
	var errs []error
	uploads, temps, err := r.sweepUploads(now)
	result.Uploads, result.TemporaryFiles = uploads, temps
	errs = append(errs, err)
	result.Stages, err = r.sweepReleaseStages(now)
	errs = append(errs, err)
	versions, temps, err := r.sweepRuntimeConfigs(now)
	result.RuntimeConfigVersions = versions
	result.TemporaryFiles += temps
	errs = append(errs, err)
	if expireRevokedPreviews {
		// Where the managed default servers answer every unknown hostname a denial vhost guards nothing: all go now.
		retention := revokedPreviewRetention
		if r.answersUnknownHosts() {
			retention = 0
		}
		result.RevokedPreviews, err = r.expireRevokedPreviews(now, retention)
		errs = append(errs, err)
	}
	return result, errors.Join(errs...)
}

func (r *Runtime) sweepUploads(now time.Time) (int, int, error) {
	entries, err := os.ReadDir(r.uploadsDir())
	if os.IsNotExist(err) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	removed, temps := 0, 0
	var errs []error
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".tmp-") {
			if removeIfOlder(filepath.Join(r.uploadsDir(), name), now, crashLeftoverAge) {
				temps++
			}
			continue
		}
		id, isMeta := strings.CutSuffix(name, ".json")
		if !isMeta {
			id, _ = strings.CutSuffix(name, ".tar.gz")
		}
		if validateID(id) != nil || (!isMeta && !strings.HasSuffix(name, ".tar.gz")) {
			continue
		}
		// One decision per upload, from whichever of its two files changed last.
		if !isMeta {
			if _, err := os.Lstat(r.uploadMetaPath(id)); err == nil {
				continue
			}
			if _, err := os.Lstat(r.uploadArchivePath(id)); err != nil {
				continue // removed with its meta file
			}
		}
		if lastUploadChange(r.uploadMetaPath(id), r.uploadArchivePath(id)).After(now.Add(-uploadRetention)) {
			continue
		}
		if err := r.removeUpload(id); err != nil {
			errs = append(errs, err)
			continue
		}
		removed++
	}
	return removed, temps, errors.Join(errs...)
}

func lastUploadChange(paths ...string) time.Time {
	var latest time.Time
	for _, path := range paths {
		if info, err := os.Lstat(path); err == nil && info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	return latest
}

// removeOtherUploads drops the other uploads of a Deployment when a new one starts: Opfield sends one Deployment to a
// node at a time, so an older upload of it was abandoned (a retry starts a new upload).
func (r *Runtime) removeOtherUploads(uploadID, deploymentID string) {
	entries, err := os.ReadDir(r.uploadsDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		id, found := strings.CutSuffix(entry.Name(), ".json")
		if !found || id == uploadID || validateID(id) != nil {
			continue
		}
		if meta, err := r.readUploadMeta(id); err == nil && meta.DeploymentID == deploymentID {
			_ = r.removeUpload(id)
		}
	}
}

func (r *Runtime) sweepReleaseStages(now time.Time) (int, error) {
	entries, err := os.ReadDir(r.releasesDir())
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".stage-") && !strings.HasPrefix(entry.Name(), ".tmp-") {
			continue
		}
		if removeIfOlder(filepath.Join(r.releasesDir(), entry.Name()), now, crashLeftoverAge) {
			removed++
		}
	}
	return removed, nil
}

// removeIfOlder removes path (a file or a whole directory, never following a symlink) when it was last changed
// before now-age.
func removeIfOlder(path string, now time.Time, age time.Duration) bool {
	info, err := os.Lstat(path)
	if err != nil || info.ModTime().After(now.Add(-age)) {
		return false
	}
	return os.RemoveAll(path) == nil
}

func (r *Runtime) sweepRuntimeConfigs(now time.Time) (int, int, error) {
	removed, temps := 0, 0
	var errs []error
	for _, kind := range []RuntimeConfigBindingKind{RuntimeConfigBindingRoute, RuntimeConfigBindingPreview} {
		base := filepath.Join(r.root, "runtime-configs", string(kind)+"s")
		entries, err := os.ReadDir(base)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, entry := range entries {
			bindingDir := filepath.Join(base, entry.Name())
			if info, err := os.Lstat(bindingDir); err != nil || validateDirectoryInfo(bindingDir, info) != nil {
				continue
			}
			for _, dir := range []string{bindingDir, filepath.Join(bindingDir, "versions")} {
				leftovers, _ := filepath.Glob(filepath.Join(dir, ".tmp-*"))
				for _, leftover := range leftovers {
					if removeIfOlder(leftover, now, crashLeftoverAge) {
						temps++
					}
				}
			}
			count, err := pruneRuntimeConfigVersions(bindingDir, 0, now)
			removed += count
			errs = append(errs, err)
		}
	}
	return removed, temps, errors.Join(errs...)
}

// pruneRuntimeConfigVersions removes the generations of one binding that nothing can use any more. It keeps the
// generation current.js names, the newest one below it and keep (the generations a rollback activates), and newer
// generations staged within runtimeConfigStagedGrace (a publication between its stage and activate commands). A
// binding that was never activated (no current.js) keeps only generations staged within the grace.
func pruneRuntimeConfigVersions(bindingDir string, keep uint64, now time.Time) (int, error) {
	versionsDir := filepath.Join(bindingDir, "versions")
	if info, err := os.Lstat(versionsDir); err != nil || validateDirectoryInfo(versionsDir, info) != nil {
		return 0, nil
	}
	current, hasCurrent := runtimeConfigCurrentGeneration(bindingDir)
	if _, err := os.Lstat(filepath.Join(bindingDir, "current.js")); !hasCurrent && !os.IsNotExist(err) {
		// A pointer this daemon cannot read is left for an operator, with everything it might name.
		return 0, nil
	}
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		return 0, err
	}
	type version struct {
		generation uint64
		modified   time.Time
	}
	versions := make([]version, 0, len(entries))
	for _, entry := range entries {
		if !validRuntimeConfigVersionName(entry.Name()) {
			continue
		}
		info, err := os.Lstat(filepath.Join(versionsDir, entry.Name()))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		generation, _ := strconv.ParseUint(strings.TrimSuffix(entry.Name(), ".js"), 10, 64)
		versions = append(versions, version{generation: generation, modified: info.ModTime()})
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].generation > versions[j].generation })
	var below uint64
	for _, candidate := range versions {
		if hasCurrent && candidate.generation < current {
			below = candidate.generation
			break
		}
	}
	removed := 0
	var errs []error
	for _, candidate := range versions {
		switch {
		case candidate.generation == keep:
			continue
		case !hasCurrent:
			// Never activated: these are stages, and only abandoned ones go.
			if candidate.modified.After(now.Add(-runtimeConfigStagedGrace)) {
				continue
			}
		case candidate.generation == current || candidate.generation == below:
			continue
		case candidate.generation > current && candidate.modified.After(now.Add(-runtimeConfigStagedGrace)):
			continue
		}
		path := filepath.Join(versionsDir, strconv.FormatUint(candidate.generation, 10)+".js")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err)
			continue
		}
		removed++
	}
	return removed, errors.Join(errs...)
}

// runtimeConfigCurrentGeneration reads the generation current.js points to.
func runtimeConfigCurrentGeneration(bindingDir string) (uint64, bool) {
	currentPath := filepath.Join(bindingDir, "current.js")
	target, err := os.Readlink(currentPath)
	if err != nil || validateRuntimeConfigCurrentTarget(currentPath, target) != nil {
		return 0, false
	}
	generation, err := strconv.ParseUint(strings.TrimSuffix(filepath.Base(target), ".js"), 10, 64)
	if err != nil || generation == 0 {
		return 0, false
	}
	return generation, true
}

// expireRevokedPreviews removes revoked-preview denial vhosts older than retention in one change: written together,
// tested once and loaded with one reload; a failed test puts every file back.
func (r *Runtime) expireRevokedPreviews(now time.Time, retention time.Duration) (int, error) {
	paths, err := filepath.Glob(filepath.Join(r.configDir, "pages-preview-*.conf"))
	if err != nil {
		return 0, err
	}
	expired := map[string][]byte{}
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.ModTime().After(now.Add(-retention)) {
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil || !isRevokedPreview(content) {
			continue
		}
		expired[path] = content
	}
	if len(expired) == 0 {
		return 0, nil
	}
	undoChange := func() {}
	deferred := r.beginChange != nil && r.scheduleReload != nil
	if deferred {
		if undoChange, err = r.beginChange(); err != nil {
			return 0, err
		}
	}
	restore := func() {
		for path, content := range expired {
			_ = writeAtomic(path, content, publicFileMode)
		}
	}
	for path := range expired {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			restore()
			undoChange()
			return 0, err
		}
	}
	if valid, output := r.nginx.TestConfig(); !valid {
		restore()
		undoChange()
		return 0, errors.New("nginx config test failed after removing revoked previews: " + output)
	}
	if deferred {
		r.scheduleReload(false)
	} else if err := r.nginx.Reload(); err != nil {
		restore()
		return 0, err
	}
	return len(expired), nil
}
