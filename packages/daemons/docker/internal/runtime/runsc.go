package runtime

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	RunscRelease = "20260810"
	RunscVersion = "release-20260810.0"
)

var runscSHA512 = map[string]string{
	"x86_64":  "3de91138cda15682c11807387f6ecad9e7c8932262018a2813277e1b4efa03efe33b0a948e148c6b1ccfe7345bfab5d5e0d072519505465751273898bae19c62",
	"aarch64": "dc21bdc7a4f52d049f4da74a337fc7437b2ac1465c7479816a852120a8cff5292d72ae78bc4c581f857836bc9a56a1ba18ad687e6bef13d03fdd670d6f2071f7",
}

type State string
type InstallStep string

const (
	StateHealthy           State       = "healthy"
	StateInstallable       State       = "installable"
	StateUnsupported       State       = "unsupported"
	StateUnknown           State       = "unknown"
	StateInstalling        State       = "installing"
	StateFailed            State       = "failed"
	StepPreparing          InstallStep = "preparing"
	StepDownloading        InstallStep = "downloading"
	StepVerifyingDownload  InstallStep = "verifying_download"
	StepInstallingBinaries InstallStep = "installing_binaries"
	StepConfiguringDocker  InstallStep = "configuring_docker"
	StepRestartingDocker   InstallStep = "restarting_docker"
	StepVerifyingRuntime   InstallStep = "verifying_runtime"
	runtimeSmokeRuns                   = 6
	// RuntimeSmokeLabel marks the daemon's own Secure Runtime smoke containers, so they never count as changes
	// made outside Opfield.
	RuntimeSmokeLabel = "net.opfield.runtime-smoke"
)

// runtimeSmokeImages are the references of the smoke test image, in pull
// order: busybox pinned by digest, mirrored to GHCR with the other
// third-party images (config/third-party-images.json; the docker package's
// allow-list names the upstream reference), then Docker Hub.
var runtimeSmokeImages = []string{
	"ghcr.io/opfield/opfield/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e",
	"docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e",
}

type Status struct {
	State               State       `json:"state"`
	InstalledVersion    string      `json:"installedVersion,omitempty"`
	TargetVersion       string      `json:"targetVersion,omitempty"`
	ReasonCode          string      `json:"reasonCode,omitempty"`
	Message             string      `json:"message,omitempty"`
	CheckedAt           time.Time   `json:"checkedAt"`
	RemoteInstallable   bool        `json:"remoteInstallable"`
	LocalInstallCommand string      `json:"localInstallCommand,omitempty"`
	Step                InstallStep `json:"step,omitempty"`
	ProgressPercent     *uint32     `json:"progressPercent,omitempty"`
}

type Manager struct {
	DockerHost       string
	DockerConfig     string
	InstallDir       string
	HTTPClient       *http.Client
	ProgressWriter   io.Writer
	ProgressReporter func(Status)
}

func NewManager() *Manager {
	dockerHost := strings.TrimSpace(os.Getenv("DOCKER_HOST"))
	return &Manager{
		DockerHost:   dockerHost,
		DockerConfig: "/etc/docker/daemon.json",
		InstallDir:   "/usr/local/bin",
		HTTPClient:   &http.Client{Timeout: 20 * time.Minute},
	}
}

// Preflight reports the runsc runtime state; an installed and registered runsc
// is verified with the Docker smoke test.
func (m *Manager) Preflight(ctx context.Context) Status {
	status, verify := m.PreflightWithoutSmokeTest(ctx)
	if !verify {
		return status
	}
	return m.VerifyRuntime(ctx, status)
}

// PreflightWithoutSmokeTest runs every check except the Docker smoke test,
// which starts runtimeSmokeRuns gVisor containers one after another (about
// 8 s). With verify, runsc is installed and registered and the smoke test is
// still to run: status says so (unknown, verification_pending) and
// VerifyRuntime completes it.
func (m *Manager) PreflightWithoutSmokeTest(ctx context.Context) (status Status, verify bool) {
	status = Status{
		State:               StateUnknown,
		TargetVersion:       RunscVersion,
		CheckedAt:           time.Now().UTC(),
		LocalInstallCommand: localInstallCommand(),
	}
	arch, ok := supportedArchitecture(runtime.GOARCH)
	if runtime.GOOS != "linux" || !ok {
		status.State = StateUnsupported
		status.ReasonCode = "unsupported_platform"
		status.Message = "Secure Runtime requires Linux on x86_64 or arm64"
		return status, false
	}
	if !isLocalDockerHost(m.DockerHost) {
		status.State = StateUnsupported
		status.ReasonCode = "remote_docker_host"
		status.Message = "Secure Runtime setup requires a daemon connected to the local Docker host"
		return status, false
	}
	if _, ok := runscSHA512[arch]; !ok {
		status.State = StateUnsupported
		status.ReasonCode = "release_unavailable"
		status.Message = "No verified gVisor bundle is available for this architecture"
		return status, false
	}
	if _, err := exec.LookPath("docker"); err != nil {
		status.State = StateUnsupported
		status.ReasonCode = "docker_cli_missing"
		status.Message = "Docker CLI is required for runtime verification"
		return status, false
	}
	if _, err := m.runDocker(ctx, "version", "--format", "{{.Server.Version}}"); err != nil {
		status.State = StateUnknown
		status.ReasonCode = "docker_unreachable"
		status.Message = "Docker is not reachable from the daemon environment"
		return status, false
	}
	service, err := detectDockerService(ctx)
	if err != nil {
		status.State = StateUnsupported
		status.ReasonCode = "docker_reload_unavailable"
		status.Message = err.Error()
		return status, false
	}
	_ = service

	status.RemoteInstallable = os.Geteuid() == 0
	runscPath := filepath.Join(m.InstallDir, "runsc")
	installedVersion, runscFound := installedRunscVersion(ctx, runscPath)
	status.InstalledVersion = installedVersion
	registered, currentConfig, configErr := runscDockerConfigStatus(
		m.DockerConfig,
		runscPath,
	)
	if configErr != nil {
		status.State = StateFailed
		status.ReasonCode = "docker_config_invalid"
		status.Message = configErr.Error()
		return status, false
	}
	if runscFound && registered && !currentConfig {
		status.State = StateFailed
		status.ReasonCode = "configuration_outdated"
		status.Message = "runsc Docker configuration requires migration"
		return status, false
	}
	if runscFound && registered {
		status.State = StateUnknown
		status.ReasonCode = "verification_pending"
		status.Message = "runsc is configured; its Docker smoke test is running"
		return status, true
	}

	status.State = StateInstallable
	if !status.RemoteInstallable {
		status.ReasonCode = "host_privileges_required"
		status.Message = "Run the local sudo command on this node to install Secure Runtime"
		return status, false
	}
	status.ReasonCode = "installation_available"
	status.Message = "This node can install and verify Secure Runtime"
	return status, false
}

// VerifyRuntime runs the Docker smoke test for a status PreflightWithoutSmokeTest
// left pending and returns the verified status.
func (m *Manager) VerifyRuntime(ctx context.Context, pending Status) Status {
	status := pending
	smokeErr := m.verifyDockerRuntime(ctx)
	status.CheckedAt = time.Now().UTC()
	if smokeErr != nil {
		status.State = StateFailed
		status.ReasonCode = "smoke_test_failed"
		status.Message = fmt.Sprintf("runsc is configured but the Docker smoke test failed: %v", smokeErr)
		return status
	}
	status.State = StateHealthy
	status.ReasonCode = "smoke_test_passed"
	status.Message = fmt.Sprintf("runsc completed %d consecutive Docker smoke tests", runtimeSmokeRuns)
	return status
}

// ReconcileInstalledConfig migrates Opfield-managed runsc installations from
// older daemon releases and restarts their running containers so the new
// runtime arguments take effect immediately.
func (m *Manager) ReconcileInstalledConfig(ctx context.Context) (bool, error) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 || !isLocalDockerHost(m.DockerHost) {
		return false, nil
	}
	runscPath := filepath.Join(m.InstallDir, "runsc")
	if _, err := os.Stat(runscPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	registered, current, err := runscDockerConfigStatus(m.DockerConfig, runscPath)
	if err != nil || !registered || current {
		return false, err
	}
	service, err := detectDockerService(ctx)
	if err != nil {
		return false, err
	}
	containerIDs, err := m.runningRunscContainers(ctx)
	if err != nil {
		return false, err
	}
	rollback, err := writeRunscDockerConfig(m.DockerConfig, runscPath)
	if err != nil {
		return false, err
	}
	if err := restartDocker(ctx, service); err != nil {
		_ = rollback()
		_ = restartDocker(context.Background(), service)
		return false, err
	}
	if len(containerIDs) > 0 {
		args := append([]string{"restart"}, containerIDs...)
		if _, err := m.runDocker(ctx, args...); err != nil {
			return true, fmt.Errorf("restart migrated runsc containers: %w", err)
		}
	}
	return true, nil
}

func (m *Manager) runningRunscContainers(ctx context.Context) ([]string, error) {
	output, err := m.runDocker(ctx, "ps", "-q")
	if err != nil || output == "" {
		return nil, err
	}
	ids := make([]string, 0)
	for _, id := range strings.Fields(output) {
		runtimeName, inspectErr := m.runDocker(ctx, "inspect", "--format", "{{.HostConfig.Runtime}}", id)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if runtimeName == "runsc" {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (m *Manager) Install(ctx context.Context) (Status, error) {
	preflight := m.Preflight(ctx)
	if preflight.State == StateHealthy {
		return preflight, nil
	}
	if preflight.State != StateInstallable && preflight.State != StateFailed {
		return preflight, fmt.Errorf("runsc installation unavailable: %s", preflight.Message)
	}
	if os.Geteuid() != 0 {
		preflight.RemoteInstallable = false
		return preflight, errors.New("runsc installation requires root privileges")
	}
	m.reportProgress(StepPreparing, "Preparing Secure Runtime setup", nil)

	arch, _ := supportedArchitecture(runtime.GOARCH)
	workDir, err := os.MkdirTemp("", "opfield-runsc-install-*")
	if err != nil {
		return failedStatus("temporary_directory_failed", err), err
	}
	defer os.RemoveAll(workDir)
	archivePath := filepath.Join(workDir, "gvisor.tar.bz2")
	url := fmt.Sprintf("https://storage.googleapis.com/gvisor/releases/release/%s/%s/gvisor.tar.bz2", RunscRelease, arch)
	initialPercent := uint32(0)
	m.reportProgress(StepDownloading, "Downloading gVisor", &initialPercent)
	if err := m.download(ctx, url, archivePath); err != nil {
		return failedStatus("download_failed", err), err
	}
	m.reportProgress(StepVerifyingDownload, "Verifying downloaded gVisor bundle", nil)
	if err := verifySHA512(archivePath, runscSHA512[arch]); err != nil {
		return failedStatus("checksum_mismatch", err), err
	}

	extractDir := filepath.Join(workDir, "bundle")
	if err := os.Mkdir(extractDir, 0o700); err != nil {
		return failedStatus("extract_directory_failed", err), err
	}
	if extractErr := extractBzip2Tar(archivePath, extractDir); extractErr != nil {
		err = fmt.Errorf("extract gVisor bundle: %w", extractErr)
		return failedStatus("extract_failed", err), err
	}
	files, err := bundleFiles(extractDir)
	if err != nil {
		return failedStatus("invalid_bundle", err), err
	}
	if _, ok := files["runsc"]; !ok {
		err = errors.New("verified gVisor bundle does not contain runsc")
		return failedStatus("invalid_bundle", err), err
	}

	m.reportProgress(StepInstallingBinaries, "Installing verified gVisor binaries", nil)
	service, err := detectDockerService(ctx)
	if err != nil {
		return failedStatus("docker_reload_unavailable", err), err
	}
	rollbackFiles, err := m.installBundleFiles(files, workDir)
	if err != nil {
		return failedStatus("binary_install_failed", err), err
	}
	m.reportProgress(StepConfiguringDocker, "Configuring Docker Secure Runtime", nil)
	configRollback, err := writeRunscDockerConfig(m.DockerConfig, filepath.Join(m.InstallDir, "runsc"))
	if err != nil {
		_ = rollbackFiles()
		return failedStatus("docker_config_failed", err), err
	}
	rollback := func() {
		_ = configRollback()
		_ = rollbackFiles()
		_ = restartDocker(context.Background(), service)
	}
	m.reportProgress(StepRestartingDocker, "Restarting Docker", nil)
	if err := restartDocker(ctx, service); err != nil {
		rollback()
		return failedStatus("docker_restart_failed", err), err
	}
	m.reportProgress(StepVerifyingRuntime, "Running Secure Runtime verification", nil)
	status := m.Preflight(ctx)
	if status.State != StateHealthy {
		err := fmt.Errorf("runsc post-install verification returned %s: %s", status.State, status.Message)
		rollback()
		return failedStatus("post_install_verification_failed", err), err
	}
	return status, nil
}

func (m *Manager) reportProgress(step InstallStep, message string, percent *uint32) {
	if m.ProgressReporter == nil {
		return
	}
	m.ProgressReporter(Status{
		State:               StateInstalling,
		TargetVersion:       RunscVersion,
		Message:             message,
		CheckedAt:           time.Now().UTC(),
		RemoteInstallable:   os.Geteuid() == 0,
		LocalInstallCommand: localInstallCommand(),
		Step:                step,
		ProgressPercent:     percent,
	})
}

// runtimeSmokeImage makes the smoke test image available and returns the
// reference it is present under: one already on the node, else the first that
// pulls.
func (m *Manager) runtimeSmokeImage(ctx context.Context) (string, error) {
	for _, reference := range runtimeSmokeImages {
		if _, err := m.runDocker(ctx, "image", "inspect", "--format", "{{.Id}}", reference); err == nil {
			return reference, nil
		}
	}
	var failures []string
	for _, reference := range runtimeSmokeImages {
		if _, err := m.runDocker(ctx, "pull", "--quiet", reference); err != nil {
			failures = append(failures, err.Error())
			continue
		}
		return reference, nil
	}
	return "", fmt.Errorf("pull the smoke test image: %s", strings.Join(failures, "; "))
}

func (m *Manager) verifyDockerRuntime(ctx context.Context) error {
	runtimeSmokeImage, err := m.runtimeSmokeImage(ctx)
	if err != nil {
		return err
	}
	for attempt := 1; attempt <= runtimeSmokeRuns; attempt++ {
		// A process that exits immediately can race containerd's post-start OOM
		// adjustment in nested LXC environments and report a false failure.
		if _, err := m.runDocker(
			ctx,
			"run",
			"--rm",
			"--runtime=runsc",
			"--label", RuntimeSmokeLabel+"=1",
			runtimeSmokeImage,
			"sleep",
			"1",
		); err != nil {
			return fmt.Errorf("smoke test %d/%d failed: %w", attempt, runtimeSmokeRuns, err)
		}
	}
	return nil
}

func (m *Manager) download(ctx context.Context, url, destination string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := m.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Minute}
	}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download gVisor bundle: HTTP %d", response.StatusCode)
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := io.Reader(response.Body)
	if m.ProgressWriter != nil || m.ProgressReporter != nil {
		reader = &progressReader{
			reader: response.Body,
			total:  response.ContentLength,
			writer: m.ProgressWriter,
			onProgress: func(percent uint32) {
				m.reportProgress(StepDownloading, "Downloading gVisor", &percent)
			},
		}
	}
	_, err = io.Copy(file, reader)
	if err == nil {
		if m.ProgressWriter != nil {
			fmt.Fprintln(m.ProgressWriter, "gVisor download complete")
		}
		percent := uint32(100)
		m.reportProgress(StepDownloading, "Downloading gVisor", &percent)
	}
	return err
}

func (m *Manager) runDocker(ctx context.Context, args ...string) (string, error) {
	commandArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(m.DockerHost) != "" {
		commandArgs = append(commandArgs, "--host", m.DockerHost)
	}
	commandArgs = append(commandArgs, args...)
	output, err := exec.CommandContext(ctx, "docker", commandArgs...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func supportedArchitecture(goarch string) (string, bool) {
	switch goarch {
	case "amd64":
		return "x86_64", true
	case "arm64":
		return "aarch64", true
	default:
		return "", false
	}
}

func isLocalDockerHost(host string) bool {
	host = strings.TrimSpace(host)
	return host == "" || strings.HasPrefix(host, "unix://") || strings.HasPrefix(host, "/")
}

func installedRunscVersion(ctx context.Context, path string) (string, bool) {
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	output, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return "", true
	}
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "runsc version ") {
			return strings.TrimPrefix(line, "runsc version "), true
		}
	}
	return strings.TrimSpace(string(output)), true
}

func detectDockerService(ctx context.Context) (string, error) {
	if _, err := exec.LookPath("systemctl"); err != nil {
		manager := "a service manager other than systemd"
		if _, openrcErr := exec.LookPath("rc-service"); openrcErr == nil {
			manager = "OpenRC"
		}
		return "", fmt.Errorf("Secure Runtime needs Docker run by systemd; this host runs Docker under %s", manager)
	}
	for _, service := range []string{"docker.service", "snap.docker.dockerd.service"} {
		if exec.CommandContext(ctx, "systemctl", "cat", service).Run() == nil {
			return service, nil
		}
	}
	return "", errors.New("could not identify the local Docker systemd service")
}

func restartDocker(ctx context.Context, service string) error {
	output, err := exec.CommandContext(ctx, "systemctl", "restart", service).CombinedOutput()
	if err != nil {
		return fmt.Errorf("restart %s: %w: %s", service, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func verifySHA512(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha512.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("gVisor SHA-512 mismatch: expected %s, received %s", expected, actual)
	}
	return nil
}

func extractBzip2Tar(archivePath, destination string) error {
	archive, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()

	return extractTar(tar.NewReader(bzip2.NewReader(archive)), destination)
}

func extractTar(reader *tar.Reader, destination string) error {
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			return nil
		}
		if nextErr != nil {
			return nextErr
		}

		name := filepath.Clean(header.Name)
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe archive path %q", header.Name)
		}
		target := filepath.Join(destination, name)
		relative, relErr := filepath.Rel(destination, target)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe archive path %q", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			file, openErr := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if openErr != nil {
				return openErr
			}
			_, copyErr := io.Copy(file, reader)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("unsupported archive entry %q", header.Name)
		}
	}
}

func bundleFiles(root string) (map[string]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	files := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() || !entry.Type().IsRegular() {
			continue
		}
		name := filepath.Base(entry.Name())
		if name == "." || name == "" {
			continue
		}
		files[name] = filepath.Join(root, entry.Name())
	}
	if len(files) == 0 {
		return nil, errors.New("gVisor bundle contains no regular files")
	}
	return files, nil
}

func (m *Manager) installBundleFiles(files map[string]string, workDir string) (func() error, error) {
	if err := os.MkdirAll(m.InstallDir, 0o755); err != nil {
		return nil, err
	}
	backupDir := filepath.Join(workDir, "backup")
	if err := os.Mkdir(backupDir, 0o700); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	installed := make([]string, 0, len(names))
	backedUp := make([]string, 0, len(names))
	rollback := func() error {
		var rollbackErr error
		for _, name := range installed {
			if err := os.Remove(filepath.Join(m.InstallDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				rollbackErr = errors.Join(rollbackErr, err)
			}
		}
		for _, name := range backedUp {
			if err := os.Rename(filepath.Join(backupDir, name), filepath.Join(m.InstallDir, name)); err != nil {
				rollbackErr = errors.Join(rollbackErr, err)
			}
		}
		return rollbackErr
	}
	for _, name := range names {
		target := filepath.Join(m.InstallDir, name)
		if _, err := os.Stat(target); err == nil {
			if err := os.Rename(target, filepath.Join(backupDir, name)); err != nil {
				_ = rollback()
				return nil, err
			}
			backedUp = append(backedUp, name)
		} else if !errors.Is(err, os.ErrNotExist) {
			_ = rollback()
			return nil, err
		}
		staged := filepath.Join(m.InstallDir, ".opfield-"+name+"-new")
		if err := copyExecutable(files[name], staged); err != nil {
			_ = rollback()
			return nil, err
		}
		if err := os.Rename(staged, target); err != nil {
			_ = os.Remove(staged)
			_ = rollback()
			return nil, err
		}
		installed = append(installed, name)
	}
	return rollback, nil
}

func copyExecutable(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(target)
		return copyErr
	}
	return closeErr
}

// localInstallCommand is the command that installs Secure Runtime on this node. Root never runs the binary of a
// daemon that runs as its own user, since that user can replace it: there the node installer installs Secure Runtime
// from a copy it downloads and verifies, and keeps the daemon's user.
func localInstallCommand() string {
	if os.Geteuid() == 0 {
		return "sudo docker-daemon runtime install runsc"
	}
	name := strconv.Itoa(os.Geteuid())
	if account, err := user.LookupId(name); err == nil {
		name = account.Username
	}
	// Without a version: every Opfield since 2.11.1 rc builds matches exactly this form to show the
	// download-and-verify command, and adds the node's daemon version there itself (F-B6, F-R1).
	return "sudo bash setup-docker-node.sh --user " + name + " --secure-runtime"
}

func failedStatus(reason string, err error) Status {
	return Status{
		State:               StateFailed,
		TargetVersion:       RunscVersion,
		ReasonCode:          reason,
		Message:             err.Error(),
		CheckedAt:           time.Now().UTC(),
		RemoteInstallable:   os.Geteuid() == 0,
		LocalInstallCommand: localInstallCommand(),
	}
}

type progressReader struct {
	reader     io.Reader
	total      int64
	read       int64
	next       int64
	writer     io.Writer
	onProgress func(uint32)
}

func (p *progressReader) Read(buffer []byte) (int, error) {
	n, err := p.reader.Read(buffer)
	p.read += int64(n)
	if p.total > 0 {
		percent := p.read * 100 / p.total
		if percent >= p.next {
			if p.writer != nil {
				fmt.Fprintf(p.writer, "Downloading gVisor: %d%%\n", percent)
			}
			if p.onProgress != nil {
				p.onProgress(uint32(percent))
			}
			p.next = percent + 5
		}
	}
	return n, err
}
