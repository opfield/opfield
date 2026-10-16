package nginx

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// The nginx log budget (nginx_log_budget_v1). nginx writes one access and one
// error log per route (proxy-<id>.{access,error}.log) and its default
// access.log/error.log into the log directory; distro logrotate, where it is
// installed at all, bounds them by time only (Alpine keeps four uncompressed
// weeks, no size cap). The daemon bounds them itself, on every install and
// whatever rotates them besides:
//   - a live log over MaxFileBytes is cut in place: its last TailBytes go to
//     <name>.1, then the file is truncated. nginx opens its logs O_APPEND, so it
//     writes on at the new end without a reopen, as root, non-root or in
//     integrate mode;
//   - rotated logs (<name>.log.N, <name>.log-<date>, compressed or not) older
//     than MaxAge are deleted;
//   - the logs of routes no config references any more are deleted once nginx
//     stopped writing them (InactiveGrace), whatever their suffix;
//   - when everything together is over BudgetBytes, rotated logs go first,
//     oldest first, then the largest live logs are truncated.
// Only these files are touched: logs other configs write under the directory
// (an integrate-mode host's own sites) are left alone, and a live log a config
// references is never deleted (nginx would write on into the unlinked inode).

const (
	// LogBudgetCapability is advertised by daemons that bound their nginx logs
	// and accept ConfigureNginxLogsCommand.
	LogBudgetCapability = "nginx_log_budget_v1"

	// DefaultLogRetention keeps rotated logs a month until Housekeeping sends
	// its own retention (the Housekeeping default is 30 days too).
	DefaultLogRetention = 30 * 24 * time.Hour

	maxLogBudgetBytes   = 2 << 30
	minLogBudgetBytes   = 64 << 20
	maxLogFileBytes     = 100 << 20
	minLogFileBytes     = 8 << 20
	logBudgetFSFraction = 20 // 1/20 = 5 % of the filesystem
	logInactiveGrace    = time.Hour
)

// LogBudgetPolicy is what the budget enforces.
type LogBudgetPolicy struct {
	MaxFileBytes  int64
	TailBytes     int64
	BudgetBytes   int64
	MaxAge        time.Duration // 0: no age limit
	InactiveGrace time.Duration
}

// DefaultLogBudgetPolicy sizes the budget for a filesystem of fsBytes: 5 % of
// it within 64 MiB..2 GiB, each live log at most a quarter of that (8..100
// MiB), cut down to a tenth of its cap.
func DefaultLogBudgetPolicy(fsBytes int64, maxAge time.Duration) LogBudgetPolicy {
	budget := int64(maxLogBudgetBytes)
	if fsBytes > 0 {
		budget = fsBytes / logBudgetFSFraction
		if budget > maxLogBudgetBytes {
			budget = maxLogBudgetBytes
		}
		if budget < minLogBudgetBytes {
			budget = minLogBudgetBytes
		}
	}
	file := budget / 4
	if file > maxLogFileBytes {
		file = maxLogFileBytes
	}
	if file < minLogFileBytes {
		file = minLogFileBytes
	}
	return LogBudgetPolicy{
		MaxFileBytes:  file,
		TailBytes:     file / 10,
		BudgetBytes:   budget,
		MaxAge:        maxAge,
		InactiveGrace: logInactiveGrace,
	}
}

// LogBudgetResult is what one pass found and did.
type LogBudgetResult struct {
	RemovedFiles   int   `json:"removedFiles"`
	TruncatedFiles int   `json:"truncatedFiles"`
	FreedBytes     int64 `json:"freedBytes"`
	// What the managed logs take after the pass.
	Bytes      int64 `json:"bytes"`
	Files      int   `json:"files"`
	OldestUnix int64 `json:"oldestUnix,omitempty"`
}

var (
	// proxy-<id>.access.log, proxy-<id>.error.log and their rotations.
	routeLogPattern = regexp.MustCompile(`^(proxy-[A-Za-z0-9_-]+\.(?:access|error)\.log)(.*)$`)
	// nginx's own default logs and their rotations.
	defaultLogPattern = regexp.MustCompile(`^((?:access|error)\.log)(.*)$`)
	// The route log names a config references.
	routeLogReference = regexp.MustCompile(`proxy-[A-Za-z0-9_-]+\.(?:access|error)\.log`)
)

type managedLog struct {
	name    string
	path    string
	base    string // the live log's name
	live    bool
	route   bool
	size    int64
	modTime time.Time
}

// ReferencedRouteLogs returns the route log names (proxy-<id>.access.log, ...)
// the nginx configs in configDir and the global config reference. ok is false
// when the configs cannot be read: nothing may then count as a removed route.
func ReferencedRouteLogs(configDir, globalConfig string) (map[string]bool, bool) {
	refs := map[string]bool{}
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return nil, false
	}
	paths := make([]string, 0, len(entries)+1)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".conf") {
			continue
		}
		paths = append(paths, filepath.Join(configDir, entry.Name()))
	}
	if globalConfig != "" {
		paths = append(paths, globalConfig)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, false
		}
		for _, match := range routeLogReference.FindAll(data, -1) {
			refs[string(match)] = true
		}
	}
	return refs, true
}

func classifyLog(name string) (base string, route bool, ok bool) {
	var match []string
	if match = routeLogPattern.FindStringSubmatch(name); match != nil {
		route = true
	} else if match = defaultLogPattern.FindStringSubmatch(name); match == nil {
		return "", false, false
	}
	suffix := match[2]
	if suffix != "" && suffix[0] != '.' && suffix[0] != '-' {
		return "", false, false
	}
	// Temporary files of a cut in progress are not logs.
	if strings.HasSuffix(suffix, ".opfield-tmp") {
		return "", false, false
	}
	return match[1], route, true
}

func listManagedLogs(logsDir string) ([]*managedLog, error) {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		return nil, err
	}
	logs := make([]*managedLog, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		base, route, ok := classifyLog(entry.Name())
		if !ok {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		logs = append(logs, &managedLog{
			name:    entry.Name(),
			path:    filepath.Join(logsDir, entry.Name()),
			base:    base,
			live:    entry.Name() == base,
			route:   route,
			size:    info.Size(),
			modTime: info.ModTime(),
		})
	}
	return logs, nil
}

// EnforceLogBudget applies policy to the nginx logs in logsDir. referenced
// names the route logs the current configs write (ReferencedRouteLogs); nil
// means unknown, and no route then counts as removed. Errors of single files
// are joined into the returned error; the pass goes on past them.
func EnforceLogBudget(logsDir string, referenced map[string]bool, policy LogBudgetPolicy, now time.Time) (LogBudgetResult, error) {
	var result LogBudgetResult
	logs, err := listManagedLogs(logsDir)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	var errs []error
	remove := func(log *managedLog) {
		if err := os.Remove(log.path); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err)
			return
		}
		result.RemovedFiles++
		result.FreedBytes += log.size
		log.size = -1
	}

	// Logs of removed routes, once nginx stopped writing them, and rotated
	// logs past the retention.
	for _, log := range logs {
		quiet := now.Sub(log.modTime) >= policy.InactiveGrace
		if log.route && referenced != nil && !referenced[log.base] && quiet {
			remove(log)
			continue
		}
		if !log.live && policy.MaxAge > 0 && now.Sub(log.modTime) >= policy.MaxAge {
			remove(log)
		}
	}

	// Live logs over their cap keep their tail in <name>.1.
	byName := map[string]*managedLog{}
	for _, log := range logs {
		if log.size >= 0 {
			byName[log.name] = log
		}
	}
	for _, log := range logs {
		if !log.live || log.size < 0 || log.size <= policy.MaxFileBytes {
			continue
		}
		tailName := log.name + ".1"
		previous := byName[tailName]
		kept, err := cutLog(log.path, filepath.Join(logsDir, tailName), policy.TailBytes)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		result.TruncatedFiles++
		freed := log.size - kept
		if previous != nil {
			freed += previous.size
			previous.size = kept
			previous.modTime = now
		} else if kept > 0 {
			tail := &managedLog{name: tailName, path: filepath.Join(logsDir, tailName), base: log.base, route: log.route, size: kept, modTime: now}
			logs = append(logs, tail)
			byName[tailName] = tail
		}
		result.FreedBytes += freed
		log.size = 0
		log.modTime = now
	}

	// The whole budget: rotated logs oldest first, then the largest live logs.
	total := int64(0)
	for _, log := range logs {
		if log.size > 0 {
			total += log.size
		}
	}
	if total > policy.BudgetBytes {
		rotated := make([]*managedLog, 0, len(logs))
		live := make([]*managedLog, 0, len(logs))
		for _, log := range logs {
			if log.size <= 0 {
				continue
			}
			if log.live {
				live = append(live, log)
			} else {
				rotated = append(rotated, log)
			}
		}
		sort.Slice(rotated, func(i, j int) bool { return rotated[i].modTime.Before(rotated[j].modTime) })
		sort.Slice(live, func(i, j int) bool { return live[i].size > live[j].size })
		for _, log := range rotated {
			if total <= policy.BudgetBytes {
				break
			}
			size := log.size
			remove(log)
			if log.size < 0 {
				total -= size
			}
		}
		for _, log := range live {
			if total <= policy.BudgetBytes {
				break
			}
			if err := os.Truncate(log.path, 0); err != nil {
				errs = append(errs, err)
				continue
			}
			result.TruncatedFiles++
			result.FreedBytes += log.size
			total -= log.size
			log.size = 0
			log.modTime = now
		}
	}

	for _, log := range logs {
		if log.size < 0 {
			continue
		}
		result.Files++
		result.Bytes += log.size
		if unix := log.modTime.Unix(); result.OldestUnix == 0 || unix < result.OldestUnix {
			result.OldestUnix = unix
		}
	}
	return result, errors.Join(errs...)
}

// cutLog copies the last tailBytes of the live log at path (from its first
// whole line) to tailPath and truncates the log in place. It returns the bytes
// written to tailPath.
func cutLog(path, tailPath string, tailBytes int64) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	kept := int64(0)
	if tailBytes > 0 {
		start := info.Size() - tailBytes
		if start < 0 {
			start = 0
		}
		if _, err := file.Seek(start, io.SeekStart); err != nil {
			return 0, err
		}
		reader := bufio.NewReader(io.LimitReader(file, info.Size()-start))
		if start > 0 {
			// Start at the first whole line.
			if _, err := reader.ReadBytes('\n'); err != nil {
				reader = bufio.NewReader(bytes.NewReader(nil))
			}
		}
		tmp := tailPath + ".opfield-tmp"
		out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o640)
		if err != nil {
			return 0, err
		}
		kept, err = io.Copy(out, reader)
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			// The tail keeps the owner and mode of the log it comes from.
			if stat, ok := info.Sys().(*syscall.Stat_t); ok {
				_ = os.Chown(tmp, int(stat.Uid), int(stat.Gid))
			}
			_ = os.Chmod(tmp, info.Mode().Perm())
			err = os.Rename(tmp, tailPath)
		}
		if err != nil {
			_ = os.Remove(tmp)
			return 0, fmt.Errorf("keep the tail of %s: %w", filepath.Base(path), err)
		}
	}
	if err := os.Truncate(path, 0); err != nil {
		return kept, err
	}
	return kept, nil
}

// CleanTmpLogCuts removes the temporary tail files a pass interrupted by a
// crash left behind.
func CleanTmpLogCuts(logsDir string) {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".opfield-tmp") {
			_ = os.Remove(filepath.Join(logsDir, entry.Name()))
		}
	}
}

// FilesystemBytes is the size of the filesystem holding path; 0 when unknown.
func FilesystemBytes(path string) int64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	return int64(stat.Blocks) * int64(stat.Bsize)
}
