package builder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	maxBuildLogChunk           = 64 * 1024
	maxScanVulnerabilities     = 100
	commandCancellationGrace   = 10 * time.Second
	terminalEventRetryInterval = 15 * time.Second
	// ACK confirms durable backend acceptance, not rollout completion. This is
	// only a bounded reconnect/retry window and is independent of build timeout.
	terminalEventAckTimeout = 2 * time.Minute
)

var (
	buildIDPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	commitSHAPattern   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	imageDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	repositoryPattern  = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)
	pagesPathPattern   = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	environmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	errDiskLimit       = errors.New("builder disk limit exceeded")
)

type EventSink func(*pb.DockerBuildEvent) error

type Manager struct {
	config                RuntimeConfig
	workspace             string
	askpass               string
	emit                  EventSink
	mu                    sync.Mutex
	jobs                  map[string]context.CancelFunc
	secrets               map[string][]string
	attempts              map[string]uint32
	generations           map[string]uint64
	liveAttempts          map[string]*atomic.Uint32
	statuses              map[string]string
	nextGeneration        uint64
	terminalEvents        map[string]*pb.DockerBuildEvent
	terminalAcks          map[string]chan string
	cleanupOnce           sync.Once
	cleanupErr            error
	sequence              atomic.Uint64
	executable            func(string) (string, error)
	cleanupAfterJob       func(string)
	terminalRetryInterval time.Duration
	terminalAckTimeout    time.Duration
	// paused is non-nil while the runtime moves to its Opfield names
	// (TryPause); Start waits until Resume closes it.
	paused chan struct{}
}

// builderPauseWait bounds how long a build waits for the runtime to come back
// from a rename.
var builderPauseWait = 3 * time.Minute

// TryPause stops new builds from starting when none runs, for a change of the
// runtime under it (the move to the Opfield names); it reports false while
// builds run. Resume ends the pause with the runtime's new configuration.
func (m *Manager) TryPause() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.jobs) > 0 || m.paused != nil {
		return false
	}
	m.paused = make(chan struct{})
	return true
}

// Resume ends a pause; config and askpass describe the runtime now.
func (m *Manager) Resume(config RuntimeConfig, askpass string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config, m.askpass = config, askpass
	m.executable = builderExecutableResolver(config.Naming)
	if m.paused != nil {
		close(m.paused)
		m.paused = nil
	}
}

func (m *Manager) waitUnpaused() error {
	m.mu.Lock()
	paused := m.paused
	m.mu.Unlock()
	if paused == nil {
		return nil
	}
	select {
	case <-paused:
		return nil
	case <-time.After(builderPauseWait):
		return errors.New("the builder runtime is being updated; retry the build")
	}
}

type checkoutCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type buildMetadata struct {
	Digest string
	Size   int64
}

func NewManager(config RuntimeConfig, workspace, askpass string, emit EventSink) *Manager {
	manager := &Manager{
		config: config, workspace: workspace, askpass: askpass, emit: emit, jobs: map[string]context.CancelFunc{}, secrets: map[string][]string{},
		attempts: map[string]uint32{}, generations: map[string]uint64{}, liveAttempts: map[string]*atomic.Uint32{},
		statuses:       map[string]string{},
		terminalEvents: map[string]*pb.DockerBuildEvent{}, terminalAcks: map[string]chan string{},
		executable: builderExecutableResolver(config.Naming), terminalRetryInterval: terminalEventRetryInterval, terminalAckTimeout: terminalEventAckTimeout,
	}
	manager.cleanupAfterJob = manager.pruneAfterJob
	return manager
}

func (m *Manager) Ready() error {
	if err := m.config.Validate(); err != nil {
		return err
	}
	for _, binary := range []string{"git", "buildctl", "syft", "grype"} {
		if _, err := m.executable(binary); err != nil {
			return fmt.Errorf("required builder tool %s is unavailable", binary)
		}
	}
	for _, socket := range []string{m.config.BuildkitSocket, m.config.ContainerdSocket} {
		info, err := os.Stat(socket)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("builder runtime socket is unavailable: %s", socket)
		}
	}
	if info, err := os.Stat(m.askpass); err != nil || info.Mode().Perm()&0o022 != 0 {
		return errors.New("builder Git askpass helper is missing or writable by an untrusted user")
	}
	return nil
}

func (m *Manager) Start(command *pb.DockerBuildCommand) error {
	if err := m.validate(command); err != nil {
		return err
	}
	m.mu.Lock()
	if _, exists := m.jobs[command.GetBuildId()]; exists {
		return m.continueRunningLocked(command)
	}
	m.mu.Unlock()
	if err := m.waitUnpaused(); err != nil {
		return err
	}
	if err := m.Ready(); err != nil {
		return err
	}
	m.cleanupOnce.Do(func() {
		if err := cleanupStaleSecretDirs(m.workspace); err != nil {
			m.cleanupErr = err
			return
		}
		m.cleanupErr = cleanupStaleJobDirs(m.workspace)
	})
	if m.cleanupErr != nil {
		return fmt.Errorf("clean stale builder workspace: %w", m.cleanupErr)
	}
	jobCtx, cancelJob := context.WithCancel(context.Background())
	ctx, cancelBuild := context.WithTimeout(jobCtx, time.Duration(command.GetTimeoutSeconds())*time.Second)
	m.mu.Lock()
	if _, exists := m.jobs[command.GetBuildId()]; exists {
		cancelBuild()
		cancelJob()
		return m.continueRunningLocked(command)
	}
	capacity := int(command.GetWorkerParallelism())
	if capacity == 0 {
		capacity = 1
	}
	if len(m.jobs) >= capacity {
		m.mu.Unlock()
		cancelBuild()
		cancelJob()
		return errors.New("builder is at its isolated job capacity")
	}
	// Cancellation stops build execution, while the parent job context keeps
	// heartbeats alive through cleanup and terminal acknowledgement.
	m.nextGeneration++
	generation := m.nextGeneration
	m.jobs[command.GetBuildId()] = cancelBuild
	m.attempts[command.GetBuildId()] = command.GetAttempt()
	m.generations[command.GetBuildId()] = generation
	// Heartbeats outlive the job's slot (they run through terminal delivery), so
	// they follow the attempt through this reference rather than the maps.
	liveAttempt := &atomic.Uint32{}
	liveAttempt.Store(command.GetAttempt())
	m.liveAttempts[command.GetBuildId()] = liveAttempt
	secretValues := make([]string, 0, len(command.GetBuildSecrets())+1)
	for _, value := range command.GetBuildSecrets() {
		secretValues = append(secretValues, string(value))
	}
	var credential checkoutCredential
	if json.Unmarshal(command.GetCheckoutCredential(), &credential) == nil && credential.Password != "" {
		secretValues = append(secretValues, credential.Password)
	}
	m.secrets[command.GetBuildId()] = secretValues
	m.mu.Unlock()
	go func() {
		defer func() {
			cancelBuild()
			cancelJob()
			m.releaseJobState(command.GetBuildId(), generation)
		}()
		heartbeatDone := make(chan struct{})
		go m.emitHeartbeats(jobCtx, command.GetBuildId(), liveAttempt, heartbeatDone)
		m.run(ctx, command)
		terminal := m.prepareCompletedJob(command.GetBuildId(), generation)
		if terminal != nil {
			m.deliverTerminal(terminal)
		}
		close(heartbeatDone)
	}()
	return nil
}

// continueRunningLocked answers a dispatch for a build this worker already
// runs. A newer attempt is adopted and succeeds; a duplicate or stale one keeps
// the legacy "already running" answer. Callers hold m.mu; it is released here.
func (m *Manager) continueRunningLocked(command *pb.DockerBuildCommand) error {
	adopted, status := m.adoptAttemptLocked(command.GetBuildId(), command.GetAttempt())
	m.mu.Unlock()
	if !adopted {
		return errors.New("build is already running")
	}
	m.announceAdoptedAttempt(command.GetBuildId(), command.GetAttempt(), status)
	return nil
}

// adoptAttemptLocked moves a running job to a newer attempt of the same build.
// Gateway claims a new attempt when the lease of a running build expires, for
// example across a Gateway restart; the job keeps running and reports under the
// attempt Gateway now owns. Callers hold m.mu.
func (m *Manager) adoptAttemptLocked(buildID string, attempt uint32) (bool, string) {
	current := m.attempts[buildID]
	if attempt == 0 || attempt <= current {
		return false, ""
	}
	m.attempts[buildID] = attempt
	if live := m.liveAttempts[buildID]; live != nil {
		live.Store(attempt)
	}
	return true, m.statuses[buildID]
}

// announceAdoptedAttempt reports the progress the job already reached under
// the adopted attempt, so Gateway can advance the freshly claimed build.
func (m *Manager) announceAdoptedAttempt(buildID string, attempt uint32, status string) {
	now := time.Now().UnixMilli()
	if status != "" {
		_ = m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: status, Attempt: attempt, OccurredAtUnixMs: now})
	}
	_ = m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: "heartbeat", Attempt: attempt, OccurredAtUnixMs: now})
}

func (m *Manager) prepareCompletedJob(buildID string, generation uint64) *pb.DockerBuildEvent {
	m.cleanupAfterJob(buildID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, exists := m.generations[buildID]; !exists || current != generation {
		return nil
	}
	terminal := m.terminalEvents[buildID]
	// The job may have adopted a newer attempt after its result was recorded.
	if terminal != nil && terminal.GetAttempt() != 0 && m.attempts[buildID] > terminal.GetAttempt() {
		terminal.Attempt = m.attempts[buildID]
	}
	m.releaseJobStateLocked(buildID)
	return terminal
}

// releaseJobState frees the job's slot unless a replacement job for the same
// build (a later generation) already owns it.
func (m *Manager) releaseJobState(buildID string, generation uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if current, exists := m.generations[buildID]; !exists || current != generation {
		return
	}
	m.releaseJobStateLocked(buildID)
}

func (m *Manager) releaseJobStateLocked(buildID string) {
	delete(m.jobs, buildID)
	delete(m.secrets, buildID)
	delete(m.attempts, buildID)
	delete(m.generations, buildID)
	delete(m.liveAttempts, buildID)
	delete(m.statuses, buildID)
	delete(m.terminalEvents, buildID)
}

func (m *Manager) emitHeartbeats(ctx context.Context, buildID string, attempt *atomic.Uint32, done <-chan struct{}) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			_ = m.emitEvent(&pb.DockerBuildEvent{BuildId: buildID, Status: "heartbeat", Attempt: attempt.Load(), OccurredAtUnixMs: time.Now().UnixMilli()})
		}
	}
}

func terminalAckKey(buildID string, attempt uint32) string {
	return fmt.Sprintf("%s:%d", buildID, attempt)
}

func (m *Manager) Acknowledge(buildID string, attempt uint32, disposition string) bool {
	if buildID == "" || attempt == 0 {
		return false
	}
	if disposition == "" {
		disposition = "accepted"
	}
	if disposition != "accepted" && disposition != "obsolete" {
		return false
	}
	key := terminalAckKey(buildID, attempt)
	m.mu.Lock()
	ack := m.terminalAcks[key]
	if ack != nil {
		delete(m.terminalAcks, key)
		ack <- disposition
		close(ack)
	}
	m.mu.Unlock()
	return ack != nil
}

func (m *Manager) Cancel(buildID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	cancel := m.jobs[buildID]
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func (m *Manager) validate(command *pb.DockerBuildCommand) error {
	if command == nil || !buildIDPattern.MatchString(command.GetBuildId()) {
		return errors.New("invalid build id")
	}
	if !commitSHAPattern.MatchString(command.GetCommitSha()) {
		return errors.New("build commit must be an exact lowercase SHA-1")
	}
	repositoryURL, err := url.Parse(command.GetRepositoryUrl())
	if err != nil || repositoryURL.Scheme != "https" || repositoryURL.Host == "" || repositoryURL.User != nil {
		return errors.New("builder checkout requires an HTTPS repository URL without embedded credentials")
	}
	if !repositoryPattern.MatchString(command.GetOutputRepository()) {
		return errors.New("invalid output repository")
	}
	if command.GetOutputTag() == "" || strings.ContainsAny(command.GetOutputTag(), "@/ \\") {
		return errors.New("invalid output tag")
	}
	if command.GetPlatform() != "linux/amd64" && command.GetPlatform() != "linux/arm64" {
		return errors.New("unsupported build platform")
	}
	for _, path := range []string{command.GetDockerfilePath(), command.GetContextPath()} {
		if path == "" || filepath.IsAbs(path) || filepath.Clean(path) != path || path == ".." || strings.HasPrefix(path, "../") {
			return errors.New("Dockerfile and context paths must remain inside the checkout")
		}
	}
	outputKind := command.GetOutputKind()
	if outputKind == "" {
		outputKind = "oci_image"
	}
	if outputKind != "oci_image" && outputKind != "pages_archive" {
		return errors.New("unsupported build output kind")
	}
	if outputKind == "pages_archive" {
		for _, path := range []string{command.GetApplicationRoot(), command.GetArtifactDirectory()} {
			if path == "" || !pagesPathPattern.MatchString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path || path == ".." || strings.HasPrefix(path, "../") {
				return errors.New("Pages build paths must remain inside the checkout")
			}
		}
		if command.GetPackageManager() != "npm" && command.GetPackageManager() != "pnpm" && command.GetPackageManager() != "yarn" {
			return errors.New("unsupported Pages package manager")
		}
		if command.GetNodeVersion() != "20" && command.GetNodeVersion() != "22" && command.GetNodeVersion() != "24" {
			return errors.New("unsupported Pages Node.js version")
		}
		if command.GetBuildScript() == "" || len(command.GetBuildScript()) > 128 || strings.ContainsAny(command.GetBuildScript(), "\x00\r\n") {
			return errors.New("invalid Pages build script")
		}
		if version := command.GetPackageManagerVersion(); version != "" && !regexp.MustCompile(`^[A-Za-z0-9._+:-]+$`).MatchString(version) {
			return errors.New("invalid package manager version")
		}
		for name := range command.GetBuildArgs() {
			if !environmentPattern.MatchString(name) {
				return errors.New("invalid Pages build variable name")
			}
		}
	}
	for name, value := range command.GetBuildSecrets() {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`).MatchString(name) {
			return errors.New("invalid build secret name")
		}
		if len(value) == 0 || len(value) > 65_536 {
			return errors.New("build secret value must be between 1 byte and 64 KiB")
		}
		if outputKind == "pages_archive" && (!environmentPattern.MatchString(name) || strings.HasPrefix(name, "VITE_")) {
			return errors.New("Pages Build Secret names must be private environment variable names")
		}
	}
	if command.GetCpuLimitMillis() <= 0 || command.GetMemoryLimitBytes() <= 0 || command.GetDiskLimitBytes() <= 0 {
		return errors.New("builder resource limits are required")
	}
	if command.GetCpuLimitMillis() != m.config.CPULimitMillis ||
		command.GetMemoryLimitBytes() != m.config.MemoryLimitBytes ||
		command.GetDiskLimitBytes() != m.config.DiskLimitBytes {
		return errors.New("build resource limits do not match the enforced isolated worker profile")
	}
	if command.GetTimeoutSeconds() < 30 || command.GetTimeoutSeconds() > 6*60*60 {
		return errors.New("builder timeout must be between 30 seconds and 6 hours")
	}
	if command.GetWorkerParallelism() < 0 || command.GetWorkerParallelism() > 16 {
		return errors.New("builder worker parallelism must be between 1 and 16")
	}
	return nil
}

func (m *Manager) run(ctx context.Context, command *pb.DockerBuildCommand) {
	jobDir := filepath.Join(m.workspace, command.GetBuildId())
	defer os.RemoveAll(jobDir)
	if err := prepareJobDirectory(jobDir); err != nil {
		m.fail(command, "WORKSPACE_CREATE_FAILED", err)
		return
	}
	if err := m.prune(ctx, command.GetBuildId()); err != nil {
		m.fail(command, "BUILDER_CACHE_RESET_FAILED", err)
		return
	}
	jobCtx, cancelJob := context.WithCancelCause(ctx)
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		if err := m.monitorStorage(
			jobCtx,
			command.GetDiskLimitBytes(),
			jobDir,
			m.config.BuildkitStateDir,
			m.config.ContainerdRootDir,
		); err != nil {
			cancelJob(err)
		}
	}()
	defer func() {
		cancelJob(nil)
		<-monitorDone
	}()
	m.status(command, "checking_out")
	if err := m.checkout(jobCtx, command, jobDir); err != nil {
		m.failForContext(command, jobCtx, "CHECKOUT_FAILED", err)
		return
	}
	m.status(command, "building")
	metadataPath := filepath.Join(jobDir, "build-metadata.json")
	imageRef := "127.0.0.1:5443/" + command.GetOutputRepository() + ":" + command.GetOutputTag()
	build := m.build
	if command.GetOutputKind() == "pages_archive" {
		build = m.buildPages
	}
	if err := build(jobCtx, command, jobDir, metadataPath, imageRef); err != nil {
		m.failForContext(command, jobCtx, "BUILD_FAILED", err)
		return
	}
	metadata, err := readBuildMetadata(metadataPath)
	if err != nil {
		m.fail(command, "BUILD_METADATA_INVALID", err)
		return
	}
	if measured, measureErr := m.measureImage(jobCtx, command.GetOutputRepository(), metadata.Digest); measureErr == nil {
		metadata.Size = measured
	} else {
		m.log(command.GetBuildId(), []byte("artifact size measurement failed: "+measureErr.Error()))
	}
	if command.GetSkipVulnerabilityScan() && command.GetOutputKind() != "pages_archive" {
		m.status(command, "pushing")
	} else {
		m.status(command, "scanning")
	}
	if command.GetOutputKind() == "pages_archive" {
		m.emitTerminal(&pb.DockerBuildEvent{
			BuildId: command.GetBuildId(), Status: "succeeded", ArtifactRepository: command.GetOutputRepository(),
			ArtifactDigest: metadata.Digest, ArtifactSizeBytes: metadata.Size, Platform: command.GetPlatform(),
			PolicyDecision: "pending", Attempt: command.GetAttempt(), OccurredAtUnixMs: time.Now().UnixMilli(),
		})
		return
	}
	scanSummary, err := m.scan(jobCtx, command, jobDir, imageRef, metadata.Digest)
	if err != nil {
		m.failForContext(command, jobCtx, "ARTIFACT_POLICY_FAILED", err)
		return
	}
	m.emitTerminal(&pb.DockerBuildEvent{
		BuildId: command.GetBuildId(), Status: "succeeded", ArtifactRepository: command.GetOutputRepository(),
		ArtifactDigest: metadata.Digest, ArtifactSizeBytes: metadata.Size, Platform: command.GetPlatform(),
		ScanSummaryJson: scanSummary,
		PolicyDecision:  "pending", Attempt: command.GetAttempt(), OccurredAtUnixMs: time.Now().UnixMilli(),
	})
}
