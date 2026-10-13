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
	valid = err == nil
	m.configMu.Lock()
	m.configOK = valid
	m.checkedAt = time.Now()
	m.configMu.Unlock()
	if err != nil {
		return true, false, string(cmdOutput)
	}
	return true, true, string(cmdOutput)
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

func (m *Manager) IsRunning() bool {
	pidFile := m.findPidFile()
	if pidFile != "" {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr == nil {
				proc, findErr := os.FindProcess(pid)
				if findErr == nil {
					// On Unix, FindProcess always succeeds. Check if process exists via signal 0.
					if signalErr := proc.Signal(syscall.Signal(0)); signalErr == nil {
						return true
					}
				}
			}
		}
	}

	return m.hasRunningProcess()
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

func processStartTime(pid int) (time.Time, error) {
	statData, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return time.Time{}, fmt.Errorf("read nginx master process stat: %w", err)
	}
	fields := strings.Fields(string(statData))
	if len(fields) < 22 {
		return time.Time{}, fmt.Errorf("unexpected nginx master process stat format")
	}
	startTicks, err := strconv.ParseInt(fields[21], 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse nginx master process start time: %w", err)
	}
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Time{}, fmt.Errorf("read system uptime: %w", err)
	}
	uptimeFields := strings.Fields(string(uptimeData))
	if len(uptimeFields) == 0 {
		return time.Time{}, fmt.Errorf("unexpected system uptime format")
	}
	systemUptime, err := strconv.ParseFloat(uptimeFields[0], 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse system uptime: %w", err)
	}
	processUptime := systemUptime - float64(startTicks)/100
	if processUptime < 0 || processUptime > systemUptime {
		return time.Time{}, fmt.Errorf("nginx master process start time is outside system uptime")
	}
	return time.Now().Add(-time.Duration(processUptime * float64(time.Second))), nil
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
	// Read process start time from /proc
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	statData, err := os.ReadFile(statPath)
	if err != nil {
		return 0, fmt.Errorf("read proc stat: %w", err)
	}
	// Field 22 (0-indexed: 21) is starttime in clock ticks
	fields := strings.Fields(string(statData))
	if len(fields) < 22 {
		return 0, fmt.Errorf("unexpected stat format")
	}
	startTicks, err := strconv.ParseInt(fields[21], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse start time: %w", err)
	}

	// Get system uptime
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, fmt.Errorf("read uptime: %w", err)
	}
	uptimeFields := strings.Fields(string(uptimeData))
	if len(uptimeFields) < 1 {
		return 0, fmt.Errorf("unexpected uptime format")
	}
	systemUptime, err := strconv.ParseFloat(uptimeFields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parse system uptime: %w", err)
	}

	// Clock ticks per second (typically 100 on Linux)
	clkTck := int64(100)
	processStartSec := float64(startTicks) / float64(clkTck)
	processUptime := systemUptime - processStartSec
	if processUptime < 0 || processUptime > systemUptime {
		return 0, fmt.Errorf("process start time is outside system uptime")
	}

	return time.Duration(processUptime * float64(time.Second)), nil
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

func (m *Manager) findPidFile() string {
	candidates := []string{
		"/run/nginx.pid",
		"/var/run/nginx.pid",
		"/run/nginx/nginx.pid",
		"/var/run/nginx/nginx.pid",
		"/etc/nginx/nginx.pid",
	}
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

func (m *Manager) hasRunningProcess() bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}

		cmdline, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
		if err == nil {
			cmdlineText := strings.ReplaceAll(string(cmdline), "\x00", " ")
			if strings.Contains(cmdlineText, "nginx: master process") {
				return true
			}
			if strings.Contains(cmdlineText, m.binary) {
				return true
			}
		}

		comm, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err == nil && strings.TrimSpace(string(comm)) == "nginx" {
			return true
		}
	}

	return false
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
