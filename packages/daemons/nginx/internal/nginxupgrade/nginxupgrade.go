// Package nginxupgrade keeps the host's nginx at the version Opfield requires: once nginx -v reports an older one,
// the nginx daemon has the embedded helper (nginx-upgrade.sh, the installer carries the same text) install the
// nginx.org stable package as root, then hands the running nginx over to the new binary without closing a
// connection. A daemon that runs as its own user reaches root only through the helper the installer sets up for it
// (a fixed command it cannot pass anything to); without one, the report names the command for an operator to run.
package nginxupgrade

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

//go:embed nginx-upgrade.sh
var Script []byte

// MinimumVersion is the oldest nginx Opfield accepts on an ingress node: 1.30.0-1.30.5 mishandle the regex map
// captures the maintenance and registry templates use (CVE-2026-93479), and older lines miss the fixes of 1.30.1-1.30.6.
// The installer (NGINX_MIN_VERSION), the helper (ONU_MIN_VERSION) and the backend (NGINX_MINIMUM_VERSION) name the
// same version; a test keeps them equal.
const MinimumVersion = "1.30.6"

const (
	StateDir   = "/var/lib/opfield-nginx-upgrade"
	StatusFile = StateDir + "/status"
	// RequestDir belongs to the daemon's user on a host whose installer set up the helper; the helper's trigger
	// (a systemd path unit, an OpenRC service) runs it as root when RequestFile appears.
	RequestDir  = StateDir + "/request"
	RequestFile = RequestDir + "/upgrade"
	// HelperPath is the helper the installer writes (root-owned).
	HelperPath = "/usr/local/libexec/opfield-nginx-upgrade"

	ModeDirect = "direct"
	ModeHelper = "helper"
	ModeManual = "manual"

	StateCurrent   = "current"
	StateDeferred  = "deferred"
	StateUpgrading = "upgrading"
	StateFailed    = "failed"
	StateManual    = "manual"
	StateUnknown   = "unknown"
)

const (
	// The first check waits for a daemon that just started (its update confirmed) to settle, and spreads the
	// nodes of an ingress group that updated together over a quarter of an hour.
	firstCheckDelay  = 2 * time.Minute
	firstCheckJitter = 15 * time.Minute
	checkInterval    = 6 * time.Hour
	maxDeferral      = 24 * time.Hour
	statusPoll       = 5 * time.Second
	installTimeout   = 30 * time.Minute
	swapTimeout      = 2 * time.Minute
	transientUnit    = "opfield-nginx-upgrade-run"
)

// ManualCommand is what an operator runs as root on a node whose daemon cannot upgrade nginx. A daemon with its own
// user and no upgrade helper predates the installer that sets the helper up; root never runs that user's binary, so
// the command is the node installer of this release again, with the same user: it upgrades nginx and sets up the
// helper, and an enrolled node needs no token. A root daemon upgrades nginx itself; its command is upgrade-nginx.
func ManualCommand() string {
	if os.Geteuid() == 0 {
		executable, err := os.Executable()
		if err != nil || !filepath.IsAbs(executable) || strings.ContainsAny(executable, " '\"$`\\") {
			executable = "/usr/local/bin/nginx-daemon"
		}
		return "sudo " + executable + " upgrade-nginx"
	}
	name := strconv.Itoa(os.Geteuid())
	if account, err := user.Current(); err == nil && account.Username != "" && !strings.ContainsAny(account.Username, " '\"$`\\") {
		name = account.Username
	}
	return "sudo bash setup-node.sh -y --user " + name + " --nginx-mode integrate"
}

// AtLeast reports whether the dotted version actual is required or newer.
func AtLeast(actual, required string) bool {
	a, ok := parseVersion(actual)
	if !ok {
		return false
	}
	r, _ := parseVersion(required)
	for i := range a {
		if a[i] != r[i] {
			return a[i] > r[i]
		}
	}
	return true
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimSpace(v), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return out, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Status is what the helper's install leaves in StatusFile.
type Status struct {
	State string // running, installed, current, failed
	From  string
	To    string
	Error string
	At    time.Time
}

func ParseStatus(data []byte) Status {
	var st Status
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), "=")
		if !ok {
			continue
		}
		switch key {
		case "state":
			st.State = value
		case "from":
			st.From = value
		case "to":
			st.To = value
		case "error":
			st.Error = strings.TrimSpace(value)
		case "at":
			if sec, err := strconv.ParseInt(value, 10, 64); err == nil {
				st.At = time.Unix(sec, 0)
			}
		}
	}
	return st
}

// Host is what the upgrade needs from the daemon.
type Host interface {
	// Version is what nginx -v of the installed binary reports.
	Version() (string, error)
	// DeferReason names what an upgrade has to wait for now, empty when it may run.
	DeferReason() string
	// MasterPID is the running nginx master, an error when none runs.
	MasterPID() (int, error)
	// WithReloadLock runs fn with the daemon's reloads held off.
	WithReloadLock(fn func() error) error
	// Swapped is called after the running nginx moved to the installed binary.
	Swapped(version string)
}

type Upgrader struct {
	host   Host
	logger *slog.Logger

	mu      sync.Mutex
	report  pb.NginxUpgradeReport
	running bool
	// deferredSince is when the current run of deferrals began.
	deferredSince time.Time

	// Replaceable in tests.
	euid        func() int
	mode        func() string
	trigger     func(ctx context.Context, mode string) error
	readStatus  func() (Status, error)
	runSwap     func(ctx context.Context) (string, error)
	exeReplaced func(pid int) bool
	now         func() time.Time
	poll        time.Duration
}

func New(host Host, logger *slog.Logger) *Upgrader {
	u := &Upgrader{
		host:        host,
		logger:      logger,
		euid:        os.Geteuid,
		readStatus:  readStatusFile,
		runSwap:     runSwapScript,
		exeReplaced: masterBinaryReplaced,
		now:         time.Now,
		poll:        statusPoll,
	}
	u.mode = u.detectMode
	u.trigger = u.triggerInstall
	u.report = pb.NginxUpgradeReport{MinimumVersion: MinimumVersion}
	return u
}

// Report is the state for the health report.
func (u *Upgrader) Report() *pb.NginxUpgradeReport {
	if u == nil {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.report.State == "" {
		return nil
	}
	report := pb.NginxUpgradeReport{
		State:           u.report.State,
		MinimumVersion:  u.report.MinimumVersion,
		Mode:            u.report.Mode,
		Detail:          u.report.Detail,
		Command:         u.report.Command,
		LastAttemptAt:   u.report.LastAttemptAt,
		UpgradedAt:      u.report.UpgradedAt,
		PreviousVersion: u.report.PreviousVersion,
	}
	return &report
}

func (u *Upgrader) set(state, mode, detail, command string) {
	u.mu.Lock()
	changed := u.report.State != state || u.report.Detail != detail
	u.report.State, u.report.Mode, u.report.Detail, u.report.Command = state, mode, detail, command
	u.mu.Unlock()
	if !changed {
		return
	}
	// Each new state once in the daemon log too: the node page shows it, an operator on the host reads it here.
	switch state {
	case StateManual:
		u.logger.Warn("nginx is older than Opfield supports, and this daemon cannot upgrade it", "minimum", MinimumVersion,
			"detail", detail, "command", command)
	case StateUnknown:
		u.logger.Warn("cannot tell the nginx version for the nginx upgrade", "detail", detail)
	case StateDeferred:
		u.logger.Info("nginx upgrade deferred", "minimum", MinimumVersion, "reason", detail)
	}
}

// Run checks once shortly after the start, then every checkInterval, until ctx ends.
func (u *Upgrader) Run(ctx context.Context) {
	delay := firstCheckDelay + rand.N(firstCheckJitter)
	for {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		u.Check(ctx)
		delay = checkInterval
	}
}

// Check brings nginx to MinimumVersion when it is older and nothing defers it, and hands a running nginx over to a
// binary installed meanwhile (by an earlier run of this daemon, by the installer or by hand).
func (u *Upgrader) Check(ctx context.Context) {
	u.mu.Lock()
	if u.running {
		u.mu.Unlock()
		return
	}
	u.running = true
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.running = false
		u.mu.Unlock()
	}()

	mode := u.mode()
	version, err := u.host.Version()
	if err != nil || version == "" {
		u.set(StateUnknown, mode, fmt.Sprintf("nginx -v failed: %v", err), "")
		return
	}
	if AtLeast(version, MinimumVersion) {
		if detail, err := u.swapIfReplaced(ctx); err != nil {
			u.set(StateFailed, mode, fmt.Sprintf("nginx %s is installed, but the running nginx keeps the old binary: %v", version, err), "")
			return
		} else if detail != "" {
			u.logger.Info("nginx moved to the installed binary", "detail", detail)
		}
		u.set(StateCurrent, mode, "", "")
		return
	}
	if reason := u.host.DeferReason(); reason != "" {
		u.mu.Lock()
		if u.deferredSince.IsZero() {
			u.deferredSince = u.now()
		}
		waited := u.now().Sub(u.deferredSince)
		u.mu.Unlock()
		// A node that stays unhealthy (or keeps a reload pending) for a day still gets the security fix: the swap
		// keeps every connection, and waiting longer would leave it on the old nginx for good.
		if waited < maxDeferral {
			u.set(StateDeferred, mode, reason, "")
			return
		}
		u.logger.Warn("upgrading nginx although it was deferred for a day", "reason", reason)
	}
	u.mu.Lock()
	u.deferredSince = time.Time{}
	u.mu.Unlock()
	if mode == ModeManual {
		u.set(StateManual, ModeManual, fmt.Sprintf(
			"nginx %s is older than %s, and this daemon runs without root and without the installer's upgrade helper", version, MinimumVersion,
		), ManualCommand())
		return
	}

	started := u.now()
	u.mu.Lock()
	u.report.LastAttemptAt = started.Unix()
	u.mu.Unlock()
	u.set(StateUpgrading, mode, fmt.Sprintf("upgrading nginx %s to the nginx.org stable package", version), "")
	u.logger.Info("upgrading nginx to the nginx.org stable package", "version", version, "minimum", MinimumVersion, "mode", mode)
	if err := u.trigger(ctx, mode); err != nil {
		u.fail(mode, fmt.Errorf("start the nginx upgrade: %w", err))
		return
	}
	status, err := u.waitForInstall(ctx, started)
	if err != nil {
		u.fail(mode, err)
		return
	}
	if status.State == "failed" {
		u.fail(mode, errors.New(status.Error))
		return
	}
	detail, err := u.swapIfReplaced(ctx)
	if err != nil {
		u.fail(mode, fmt.Errorf("nginx %s is installed, but the running nginx keeps the old binary: %w", status.To, err))
		return
	}
	installed, _ := u.host.Version()
	u.mu.Lock()
	u.report.UpgradedAt = u.now().Unix()
	u.report.PreviousVersion = version
	u.mu.Unlock()
	u.set(StateCurrent, mode, "", "")
	u.logger.Info("upgraded nginx", "from", version, "to", installed, "detail", detail)
}

func (u *Upgrader) fail(mode string, err error) {
	u.logger.Warn("nginx upgrade failed; the running nginx keeps serving", "error", err)
	u.set(StateFailed, mode, err.Error(), u.commandFor(mode))
}

// commandFor is the command an operator can run after a failure the daemon cannot retry better itself.
func (u *Upgrader) commandFor(mode string) string {
	if mode == ModeManual {
		return ManualCommand()
	}
	return ""
}

func (u *Upgrader) waitForInstall(ctx context.Context, started time.Time) (Status, error) {
	deadline := time.NewTimer(installTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(u.poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return Status{}, ctx.Err()
		case <-deadline.C:
			return Status{}, fmt.Errorf("the nginx upgrade did not finish within %s", installTimeout)
		case <-ticker.C:
		}
		status, err := u.readStatus()
		if err != nil || status.At.Before(started.Truncate(time.Second)) {
			continue
		}
		switch status.State {
		case "installed", "current", "failed":
			return status, nil
		}
	}
}

// swapIfReplaced hands a running master whose binary was replaced over to the installed one, with the daemon's
// reloads held off. It returns what the swap did, empty when nothing had to move.
func (u *Upgrader) swapIfReplaced(ctx context.Context) (string, error) {
	pid, err := u.host.MasterPID()
	if err != nil || pid <= 0 || !u.exeReplaced(pid) {
		return "", nil
	}
	var detail string
	err = u.host.WithReloadLock(func() error {
		swapCtx, cancel := context.WithTimeout(ctx, swapTimeout)
		defer cancel()
		var swapErr error
		detail, swapErr = u.runSwap(swapCtx)
		return swapErr
	})
	if err != nil {
		return "", err
	}
	version, _ := u.host.Version()
	u.host.Swapped(version)
	return detail, nil
}

func (u *Upgrader) detectMode() string {
	if u.euid() == 0 {
		return ModeDirect
	}
	if helperInstalled() {
		return ModeHelper
	}
	return ModeManual
}

// helperInstalled: a root-owned helper nobody else can change, a trigger that runs it, and a request directory this
// daemon can write.
func helperInstalled() bool {
	info, err := os.Stat(HelperPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return false
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !ok || st.Uid != 0 {
		return false
	}
	triggered := false
	for _, trigger := range []string{"/etc/systemd/system/opfield-nginx-upgrade.path", "/etc/init.d/opfield-nginx-upgrade"} {
		if _, err := os.Stat(trigger); err == nil {
			triggered = true
		}
	}
	return triggered && syscall.Access(RequestDir, 2 /* W_OK */) == nil
}

func (u *Upgrader) triggerInstall(ctx context.Context, mode string) error {
	switch mode {
	case ModeHelper:
		return os.WriteFile(RequestFile, []byte("upgrade\n"), 0o640)
	case ModeDirect:
		return startDirectInstall(ctx)
	default:
		return fmt.Errorf("no way to upgrade nginx as root")
	}
}

// startDirectInstall runs the embedded helper as a process of its own: a systemd transient unit, or a new session,
// so a restart of the daemon (an update) does not end a package change halfway.
func startDirectInstall(ctx context.Context) error {
	if err := os.MkdirAll(StateDir, 0o755); err != nil {
		return err
	}
	script := filepath.Join(StateDir, "helper.sh")
	if err := writeFileAtomic(script, Script, 0o700); err != nil {
		return err
	}
	if info, err := os.Stat("/run/systemd/system"); err == nil && info.IsDir() {
		if systemdRun, err := exec.LookPath("systemd-run"); err == nil {
			_ = exec.CommandContext(ctx, "systemctl", "reset-failed", transientUnit+".service").Run()
			output, err := exec.CommandContext(ctx, systemdRun, "--unit="+transientUnit, "--collect", "--quiet",
				"--no-block", "--property=Type=oneshot", "/bin/sh", script, "install").CombinedOutput()
			if err != nil {
				return fmt.Errorf("systemd-run: %s: %w", strings.TrimSpace(string(output)), err)
			}
			return nil
		}
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer devNull.Close()
	cmd := exec.Command("/bin/sh", script, "install")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devNull, devNull, devNull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func readStatusFile() (Status, error) {
	data, err := os.ReadFile(StatusFile)
	if err != nil {
		return Status{}, err
	}
	return ParseStatus(data), nil
}

// runSwapScript runs the embedded helper's swap as this daemon's user (the master's, or root).
func runSwapScript(ctx context.Context) (string, error) {
	return RunScript(ctx, "swap")
}

// RunScript runs the embedded helper with mode and returns its last line, or its last lines as the error. The text
// goes to a private file first: a shell that reads its script from standard input would hand the rest of it to any
// command of it that reads standard input.
func RunScript(ctx context.Context, mode string) (string, error) {
	path, cleanup, err := scriptFile()
	if err != nil {
		return "", err
	}
	defer cleanup()
	output, err := exec.CommandContext(ctx, "/bin/sh", path, mode).CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if text == "" {
			return "", err
		}
		return "", errors.New(lastLines(text, 3))
	}
	return lastLines(text, 1), nil
}

// scriptFile writes the embedded helper to a new file only this user can read.
func scriptFile() (string, func(), error) {
	dir, err := os.MkdirTemp("", "opfield-nginx-upgrade-")
	if err != nil {
		return "", nil, err
	}
	path := filepath.Join(dir, "nginx-upgrade.sh")
	if err := os.WriteFile(path, Script, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	return path, func() { _ = os.RemoveAll(dir) }, nil
}

// ScriptFile is scriptFile for the operator command (upgrade-nginx).
func ScriptFile() (string, func(), error) { return scriptFile() }

func lastLines(text string, n int) string {
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimPrefix(strings.Join(lines, " "), "opfield-nginx-upgrade: ")
}

// masterBinaryReplaced: the package replaced the binary the master runs (its executable is unlinked).
func masterBinaryReplaced(pid int) bool {
	target, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	return err == nil && strings.HasSuffix(target, " (deleted)")
}
