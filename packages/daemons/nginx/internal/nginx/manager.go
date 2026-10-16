package nginx

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Manager struct {
	binary             string
	configDir          string
	certsDir           string
	globalCfg          string
	testMu             sync.Mutex
	configMu           sync.RWMutex
	configOK           bool
	checkedAt          time.Time
	observerMu         sync.RWMutex
	configTestObserver func() func()
	pids               masterPIDCache
	// resolvePIDFile and readPID are the slow and the cheap step of CachedPID
	// (replaceable in tests).
	resolvePIDFile func() (string, error)
	readPID        func(pidFile string) (int, error)
	// Config generation (ingress health): bumped with every successful reload, see ingress_health.go.
	reloadMu     sync.Mutex
	generationMu sync.Mutex
	generation   uint64
	// The configuration on disk may be ahead of the one nginx runs: a change was written and its reload has not
	// succeeded yet (deferred, failed, or the daemon stopped in between). See BeginChange.
	pendingMu     sync.Mutex
	reloadPending bool
	pendingSeq    uint64
	pendingMarker string
	// pidProblem is what root has to do for nginx -t to run (pid_repair.go).
	problemMu  sync.Mutex
	pidProblem string
}

var effectivePIDDirectivePattern = regexp.MustCompile(`(?m)^\s*pid\s+(?:"([^"]+)"|'([^']+)'|([^;\s]+))\s*;`)

func NewManager(binary, configDir, certsDir, globalConfig string) *Manager {
	m := &Manager{
		binary:    binary,
		configDir: configDir,
		certsDir:  certsDir,
		globalCfg: globalConfig,
	}
	m.resolvePIDFile = func() (string, error) {
		path, err := m.authoritativePidFile()
		if err == nil {
			err = prepareOpenRCPIDDirectory(path)
		}
		return path, err
	}
	m.readPID = m.readMasterPID
	return m
}

func (m *Manager) TestConfig() (bool, string) {
	_, valid, output := m.testConfigIf(nil)
	return valid, output
}

// TestConfigIf serializes with every other nginx -t and evaluates shouldRun
// only after acquiring that serialization lock. This lets callers suppress a
// check that became redundant while waiting for another validation.
func (m *Manager) TestConfigIf(shouldRun func() bool) (ran bool, valid bool, output string) {
	return m.testConfigIf(shouldRun)
}

func (m *Manager) testConfigIf(shouldRun func() bool) (ran bool, valid bool, output string) {
	m.testMu.Lock()
	defer m.testMu.Unlock()
	if shouldRun != nil && !shouldRun() {
		return false, false, ""
	}
	m.observerMu.RLock()
	observer := m.configTestObserver
	m.observerMu.RUnlock()
	if observer != nil {
		if complete := observer(); complete != nil {
			defer complete()
		}
	}

	args := []string{"-t"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	cmdOutput, err := m.runNginx(args...)
	// A pid file nginx -t could not open says nothing about the
	// configuration: the service problem reports it (pid_repair.go).
	valid = err == nil || m.validDespitePIDFile(cmdOutput)
	m.configMu.Lock()
	m.configOK = valid
	m.checkedAt = time.Now()
	m.configMu.Unlock()
	return true, valid, string(cmdOutput)
}

// SetConfigTestObserver registers a lightweight before/after hook used by the
// daemon's filesystem watcher to associate every explicit nginx -t with the
// exact configuration fingerprint it covered.
func (m *Manager) SetConfigTestObserver(observer func() func()) {
	m.observerMu.Lock()
	m.configTestObserver = observer
	m.observerMu.Unlock()
}

// CachedConfigValidity returns the result of the latest explicit or scheduled
// nginx configuration test without spawning another nginx process.
func (m *Manager) CachedConfigValidity() (valid bool, checkedAt time.Time, checked bool) {
	m.configMu.RLock()
	defer m.configMu.RUnlock()
	return m.configOK, m.checkedAt, !m.checkedAt.IsZero()
}

// Reload asks nginx to load the configuration on disk. Every reload carries the next config generation (a
// managed http-level variable), so the ingress health responder can tell whether nginx really runs the
// configuration of the last successful reload: a reload signal nginx accepts but fails to apply leaves the old
// generation in service.
func (m *Manager) Reload() error {
	m.reloadMu.Lock()
	defer m.reloadMu.Unlock()
	m.pendingMu.Lock()
	loadedSeq := m.pendingSeq
	m.pendingMu.Unlock()
	commit := m.stageNextGeneration()
	args := []string{"-s", "reload"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	// Through runNginx: a pid file nginx cannot open is repaired or reported as for nginx -t.
	output, err := m.runNginx(args...)
	// A reload may load a pid directive the cached path does not know.
	m.pids.invalidatePath()
	if err != nil {
		if !nginxNotRunningFailure.Match(output) {
			commit(false)
			return fmt.Errorf("nginx reload failed: %s: %w", string(output), err)
		}
		// No nginx master runs: the configuration on disk loads when nginx starts.
		if startErr := m.startStoppedNginx(); startErr != nil {
			commit(false)
			return startErr
		}
	}
	commit(true)
	// nginx runs what was on disk when the reload started; a change begun meanwhile still waits for one.
	m.pendingMu.Lock()
	if m.pendingSeq == loadedSeq {
		m.clearReloadPendingLocked()
	}
	m.pendingMu.Unlock()
	return nil
}

// SetReloadPendingMarker keeps the reload-pending state in a file, so a change written before the daemon stopped is
// loaded when it starts again, and reports whether one is pending.
func (m *Manager) SetReloadPendingMarker(path string) bool {
	m.pendingMu.Lock()
	defer m.pendingMu.Unlock()
	m.pendingMarker = path
	if _, err := os.Stat(path); err == nil {
		m.reloadPending = true
	}
	return m.reloadPending
}

// ReloadPending reports a configuration on disk that nginx may not run yet.
func (m *Manager) ReloadPending() bool {
	m.pendingMu.Lock()
	defer m.pendingMu.Unlock()
	return m.reloadPending
}

// BeginChange is called before a change to the configuration on disk: until a reload succeeds, the configuration
// is known to be ahead of what nginx runs, and content that equals the file on disk no longer means it is loaded.
// The returned function takes the mark back for a change that was rolled back without a reload, unless the mark
// predates the change or another change began since.
func (m *Manager) BeginChange() (func(), error) {
	m.pendingMu.Lock()
	defer m.pendingMu.Unlock()
	wasPending := m.reloadPending
	if !wasPending && m.pendingMarker != "" {
		if err := WriteAtomic(m.pendingMarker, []byte("reload pending\n")); err != nil {
			return func() {}, fmt.Errorf("record pending nginx reload: %w", err)
		}
	}
	m.reloadPending = true
	m.pendingSeq++
	seq := m.pendingSeq
	return func() {
		m.pendingMu.Lock()
		defer m.pendingMu.Unlock()
		if !wasPending && m.pendingSeq == seq {
			m.clearReloadPendingLocked()
		}
	}, nil
}

func (m *Manager) clearReloadPendingLocked() {
	if !m.reloadPending {
		return
	}
	m.reloadPending = false
	if m.pendingMarker != "" {
		_ = RemoveFile(m.pendingMarker)
	}
}

func (m *Manager) GetVersion() (string, error) {
	cmd := exec.Command(m.binary, "-v")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("nginx version check failed: %w", err)
	}
	// nginx -v outputs to stderr: "nginx version: nginx/1.27.0"
	s := strings.TrimSpace(string(output))
	if idx := strings.Index(s, "nginx/"); idx >= 0 {
		return s[idx+len("nginx/"):], nil
	}
	return s, nil
}

// HasSecureLinkModule verifies that this nginx build did not explicitly omit
// the built-in secure-link module required by Opfield maintenance admission.
func (m *Manager) HasSecureLinkModule() (bool, error) {
	cmd := exec.Command(m.binary, "-V")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("nginx build check failed: %w", err)
	}
	return !strings.Contains(string(output), "--without-http_secure_link_module"), nil
}

// IsRunning reports whether the nginx this daemon manages runs: the master
// process named by its pid file. Another nginx on the host (a container's, a
// second instance) does not count (F-7: a stopped node nginx reported running
// next to a foreign one).
func (m *Manager) IsRunning() bool {
	if pid, err := m.CachedPID(); err == nil && managedMasterAlive(pid) {
		return true
	}
	// The authoritative path needs nginx -T, which a broken configuration
	// fails: the pid file nginx.conf or the distribution names.
	pidFile := m.findPidFile()
	if pidFile == "" {
		return false
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	return err == nil && managedMasterAlive(pid)
}

// processCmdline reads a process's command line (replaceable in tests).
var processCmdline = func(pid int) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	return strings.ReplaceAll(string(data), "\x00", " "), err
}

// managedMasterAlive reports whether pid, read from the managed nginx's pid
// file, is a live nginx master process (not a reused pid).
func managedMasterAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil && err != syscall.EPERM {
		return false
	}
	commandLine, err := processCmdline(pid)
	return err == nil && strings.Contains(commandLine, "nginx: master process")
}

// GetPID returns the PID of the nginx master process owned by this manager's
// configured pid file.
func (m *Manager) GetPID() (int, error) {
	pidFile, err := m.authoritativePidFile()
	if err != nil {
		return 0, err
	}
	if err := prepareOpenRCPIDDirectory(pidFile); err != nil {
		return 0, err
	}
	data, err := readTrustedPIDFile(pidFile)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("parse pid file %s", pidFile)
	}
	expectedBinary, err := canonicalBinaryPath(m.binary)
	if err != nil {
		return 0, err
	}
	if err := validateNginxMasterPID(pid, expectedBinary); err != nil {
		return 0, err
	}
	return pid, nil
}

func validateNginxMasterPID(pid int, expectedBinary string) error {
	actualBinary, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return fmt.Errorf("read nginx master executable: %w", err)
	}
	actualBinary = strings.TrimSuffix(actualBinary, " (deleted)")
	if filepath.Clean(actualBinary) != expectedBinary {
		return fmt.Errorf("authoritative pid does not belong to configured nginx executable")
	}
	commandLine, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil || !strings.Contains(strings.ReplaceAll(string(commandLine), "\x00", " "), "nginx: master process") {
		return fmt.Errorf("authoritative pid is not an nginx master process")
	}
	return nil
}

func canonicalBinaryPath(binary string) (string, error) {
	path, err := exec.LookPath(binary)
	if err != nil {
		return "", fmt.Errorf("resolve nginx executable: %w", err)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(path); resolveErr == nil {
		path = resolved
	}
	return filepath.Clean(path), nil
}

// EffectiveConfig returns what nginx -T prints: the global configuration and every file it includes.
func (m *Manager) EffectiveConfig() ([]byte, error) {
	args := []string{"-T"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	output, err := m.runNginx(args...)
	if err != nil {
		return nil, fmt.Errorf("print effective nginx configuration: %w: %s", err, nginxFailure(output))
	}
	return output, nil
}

func (m *Manager) authoritativePidFile() (string, error) {
	args := []string{"-T"}
	if m.globalCfg != "" {
		args = append(args, "-c", m.globalCfg)
	}
	effectiveConfig, err := m.runNginx(args...)
	if err != nil {
		return "", fmt.Errorf("resolve effective nginx configuration: %w: %s", err, nginxFailure(effectiveConfig))
	}
	configured, err := effectivePIDDirective(effectiveConfig)
	if err != nil {
		return "", err
	}
	if configured != "" {
		return m.resolveNginxPath(configured)
	}
	pidPath, err := m.configureArgument("--pid-path=")
	if err != nil || pidPath == "" {
		return "", fmt.Errorf("authoritative nginx pid path is unavailable")
	}
	return m.resolveNginxPath(pidPath)
}

func effectivePIDDirective(effectiveConfig []byte) (string, error) {
	matches := effectivePIDDirectivePattern.FindAllSubmatch(effectiveConfig, -1)
	if len(matches) > 1 {
		return "", fmt.Errorf("effective nginx pid directive is ambiguous")
	}
	if len(matches) == 1 {
		for _, capture := range matches[0][1:] {
			if len(capture) > 0 {
				return string(capture), nil
			}
		}
		return "", fmt.Errorf("effective nginx pid directive is invalid")
	}
	return "", nil
}

func (m *Manager) resolveNginxPath(path string) (string, error) {
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	prefix, err := m.configureArgument("--prefix=")
	if err != nil || prefix == "" {
		return "", fmt.Errorf("relative nginx pid path has no authoritative prefix")
	}
	return filepath.Clean(filepath.Join(prefix, path)), nil
}

func (m *Manager) configureArgument(prefix string) (string, error) {
	output, err := exec.Command(m.binary, "-V").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("read nginx configure arguments: %w", err)
	}
	for _, field := range strings.Fields(string(output)) {
		if strings.HasPrefix(field, prefix) {
			return strings.Trim(strings.TrimPrefix(field, prefix), "'\""), nil
		}
	}
	return "", nil
}

// procRoot is /proc (replaceable in tests).
var procRoot = "/proc"

// processStartTime is when pid started: its start in clock ticks after boot
// (/proc/<pid>/stat) plus the boot time (btime in /proc/stat). Both count
// from the host's boot, in an LXC container too, whose /proc/uptime is the
// container's own (P-5: comparing the two gave no uptime there).
func processStartTime(pid int) (time.Time, error) {
	statData, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return time.Time{}, fmt.Errorf("read nginx master process stat: %w", err)
	}
	// The command name (field 2) may hold spaces; starttime is field 22, the
	// 20th after the name.
	stat := string(statData)
	fields := strings.Fields(stat[strings.LastIndexByte(stat, ')')+1:])
	if len(fields) < 20 {
		return time.Time{}, fmt.Errorf("unexpected nginx master process stat format")
	}
	startTicks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse nginx master process start time: %w", err)
	}
	systemStat, err := os.ReadFile(filepath.Join(procRoot, "stat"))
	if err != nil {
		return time.Time{}, fmt.Errorf("read system stat: %w", err)
	}
	for _, line := range strings.Split(string(systemStat), "\n") {
		value, found := strings.CutPrefix(line, "btime ")
		if !found {
			continue
		}
		bootTime, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("parse boot time: %w", err)
		}
		// Clock ticks per second: USER_HZ, 100 on Linux.
		return time.Unix(bootTime, 0).Add(time.Duration(startTicks) * (time.Second / 100)), nil
	}
	return time.Time{}, fmt.Errorf("system stat has no boot time")
}

func (m *Manager) GetUptime() (time.Duration, error) {
	pidFile := m.findPidFile()
	if pidFile == "" {
		return 0, fmt.Errorf("pid file not found")
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return 0, fmt.Errorf("read pid file: %w", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, fmt.Errorf("parse pid: %w", err)
	}
	started, err := processStartTime(pid)
	if err != nil {
		return 0, err
	}
	uptime := time.Since(started)
	if uptime < 0 {
		return 0, fmt.Errorf("process start time is in the future")
	}
	return uptime, nil
}

func (m *Manager) GetWorkerCount() (int, error) {
	processes, err := filepath.Glob("/proc/[0-9]*/cmdline")
	if err != nil {
		return 0, fmt.Errorf("list processes: %w", err)
	}
	count := 0
	for _, process := range processes {
		data, readErr := os.ReadFile(process)
		if readErr != nil {
			continue
		}
		commandLine := strings.ReplaceAll(string(data), "\x00", " ")
		if strings.Contains(commandLine, "nginx: worker process") {
			count++
		}
	}
	return count, nil
}

// defaultPIDFiles are where distributions' nginx keeps its pid file.
var defaultPIDFiles = []string{
	"/run/nginx.pid",
	"/var/run/nginx.pid",
	"/run/nginx/nginx.pid",
	"/var/run/nginx/nginx.pid",
	"/etc/nginx/nginx.pid",
}

func (m *Manager) findPidFile() string {
	candidates := append([]string(nil), defaultPIDFiles...)
	// Also try to parse from nginx.conf
	if m.globalCfg != "" {
		data, err := os.ReadFile(m.globalCfg)
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "pid ") {
					pidPath := strings.TrimSuffix(strings.TrimPrefix(line, "pid "), ";")
					pidPath = strings.TrimSpace(pidPath)
					candidates = append([]string{pidPath}, candidates...)
					break
				}
			}
		}
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// GetProcessRSS scans /proc for all nginx processes and sums their RSS in bytes.
func (m *Manager) GetProcessRSS() int64 {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}

	var totalRSS int64

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// Skip non-numeric directory names (not PIDs)
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}

		// Read cmdline to check if this is an nginx process
		cmdline, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
		if err != nil {
			continue
		}
		// cmdline uses null bytes as separators
		if !strings.Contains(string(cmdline), "nginx") {
			continue
		}

		// Read VmRSS from /proc/<pid>/status
		statusData, err := os.ReadFile(filepath.Join("/proc", pid, "status"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(statusData), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					val, err := strconv.ParseInt(fields[1], 10, 64)
					if err == nil {
						// VmRSS is in kB
						totalRSS += val * 1024
					}
				}
				break
			}
		}
	}

	return totalRSS
}

func (m *Manager) ConfigPath(hostID string) string {
	return filepath.Join(m.configDir, fmt.Sprintf("proxy-host-%s.conf", hostID))
}

func (m *Manager) CertDir(certID string) string {
	return filepath.Join(m.certsDir, certID)
}
