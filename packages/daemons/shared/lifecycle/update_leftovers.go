package lifecycle

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
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

// installerBackupAge: the installer keeps the binary it replaced as <binary>.backup.<YYYYMMDD_HHMMSS> for a manual
// rollback. Past this age the running binary has proven itself, and the copy (14-28 MB per daemon) goes.
const installerBackupAge = 14 * 24 * time.Hour

// sweepInstallerBackups removes the installer's backups of this daemon's own binary (only <binary>.backup.<stamp>
// next to it, never another program's file) older than installerBackupAge, and returns how many.
func sweepInstallerBackups(executable string, now time.Time) int {
	dir, base := filepath.Dir(executable), filepath.Base(executable)
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(base) + `\.backup\.[0-9]{8}_[0-9]{6}$`)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !pattern.MatchString(entry.Name()) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.ModTime().After(now.Add(-installerBackupAge)) {
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

// stateLeftoverPatterns are the temporary files of the state writers every daemon uses, left by a crash between
// their write and rename: atomicfile (".<name>.tmp-<digits>") and statecompat ("<name>.pending-<pid>").
var stateLeftoverPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^\..+\.tmp-[0-9]+$`),
	regexp.MustCompile(`^.+\.pending-[0-9]+$`),
}

// sweepStateLeftovers removes those temporary files older than updateLeftoverAge from the daemon's state directory
// and its direct subdirectories. It stays on the state directory's filesystem and never follows a link, so mounted
// data (managed database and volume images) and deeper runtime trees are never looked at.
func sweepStateLeftovers(stateDir string, now time.Time) int {
	root, err := os.Lstat(stateDir)
	if err != nil || !root.IsDir() {
		return 0
	}
	removed := 0
	dirs := []string{stateDir}
	if entries, err := os.ReadDir(stateDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(stateDir, entry.Name())
			if info, err := os.Lstat(path); err == nil && info.IsDir() && sameDevice(root, info) {
				dirs = append(dirs, path)
			}
		}
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !matchesStateLeftover(entry.Name()) {
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
	}
	return removed
}

func matchesStateLeftover(name string) bool {
	for _, pattern := range stateLeftoverPatterns {
		if pattern.MatchString(name) {
			return true
		}
	}
	return false
}

func sameDevice(a, b os.FileInfo) bool {
	first, ok := a.Sys().(*syscall.Stat_t)
	second, ok2 := b.Sys().(*syscall.Stat_t)
	return ok && ok2 && first.Dev == second.Dev
}
