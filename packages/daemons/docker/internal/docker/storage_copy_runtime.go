package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/atomicfile"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Storage copy jobs copy or sync objects between two S3 connections with the
// backup runner image (rclone), then report an `rclone check` of the result.
// The runner is a fixed program: the payload names endpoints, buckets and a
// mode, never a command. They travel over the DockerBackupCommand transport
// with the copy_start, copy_status and copy_cancel actions.
const (
	storageCopyCapability       = "storage_copy_v1"
	storageCopyStateDirectory   = "storage-copies"
	storageCopyMaxTimeout       = 7 * 24 * time.Hour
	storageCopyResultMaxBytes   = 1 << 20
	storageCopyProgressMaxBytes = 64 << 10
	storageCopyMaxBuckets       = 200
	// A safeguard behind the control plane's own per-executor limit.
	storageCopyMaxActive  = 4
	storageCopyRunnerKind = "storage-copy-runner"
	storageCopyJobLabel   = "net.opfield.storage-copy-job-id"
	storageCopyUnknownJob = "STORAGE_COPY_JOB_UNKNOWN"
	// Finished statuses are kept long enough for the control plane to collect
	// the report after an outage; cancel records only have to outlive a late
	// start, which startBy bounds to well under an hour.
	storageCopyStatusRetained       = 7 * 24 * time.Hour
	storageCopyCancelRecordRetained = 24 * time.Hour
	storageCopyPruneInterval        = 10 * time.Minute
	// storageCopyStartGrace tolerates a node clock that runs ahead of
	// Opfield's before a start counts as delivered too late.
	storageCopyStartGrace   = 10 * time.Minute
	storageCopyStartExpired = "STORAGE_COPY_START_EXPIRED"
	// Relay owner kinds of the job's two per-run storage routes. They are the
	// kinds storage-node daemons already serve for backups, so the storage
	// side needs no newer daemon.
	storageCopySourceRelayKind      = "storage_backup_staging"
	storageCopyDestinationRelayKind = "storage_backup_target"
)

var storageCopyBucketPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$`)

func isStorageCopyAction(action string) bool {
	return action == "copy_start" || action == "copy_status" || action == "copy_cancel"
}

type storageCopyEndpoint struct {
	ConnectionID    string `json:"connectionId"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	ForcePathStyle  bool   `json:"forcePathStyle,omitempty"`
	CAPEM           string `json:"caPem,omitempty"`
	RelayRouteID    string `json:"relayRouteId,omitempty"`
}

type storageCopyLimits struct {
	TimeoutSeconds int   `json:"timeoutSeconds"`
	CPUCores       int64 `json:"cpuCores"`
	MemoryMB       int64 `json:"memoryMb"`
	Transfers      int   `json:"transfers"`
}

type storageCopyPayload struct {
	JobID         string              `json:"jobId"`
	Version       int                 `json:"version"`
	Mode          string              `json:"mode"`
	DryRun        bool                `json:"dryRun"`
	AllBuckets    bool                `json:"allBuckets"`
	Buckets       []string            `json:"buckets"`
	CreateBuckets bool                `json:"createBuckets"`
	Source        storageCopyEndpoint `json:"source"`
	Destination   storageCopyEndpoint `json:"destination"`
	Limits        storageCopyLimits   `json:"limits"`
	ToolImage     string              `json:"toolImage"`
	// DeadlineAt is enforced by the daemon and never reaches the runner.
	DeadlineAt *time.Time `json:"deadlineAt,omitempty"`
	// StartBy bounds how late the request may arrive: a start delivered after
	// the control plane gave up on it must not run unobserved.
	StartBy *time.Time `json:"startBy,omitempty"`
}

// storageCopyRunnerConfig is the runner's config.json. The runner rejects
// unknown fields, so it carries exactly what the copy program reads.
type storageCopyRunnerConfig struct {
	Kind          string              `json:"kind"`
	JobID         string              `json:"jobId"`
	Version       int                 `json:"version"`
	Mode          string              `json:"mode"`
	DryRun        bool                `json:"dryRun"`
	AllBuckets    bool                `json:"allBuckets"`
	Buckets       []string            `json:"buckets"`
	CreateBuckets bool                `json:"createBuckets"`
	Source        storageCopyEndpoint `json:"source"`
	Destination   storageCopyEndpoint `json:"destination"`
	Limits        storageCopyLimits   `json:"limits"`
}

type storageCopyStatus struct {
	JobID       string          `json:"jobId"`
	Status      string          `json:"status"`
	Phase       string          `json:"phase"`
	StartedAt   *time.Time      `json:"startedAt,omitempty"`
	CompletedAt *time.Time      `json:"completedAt,omitempty"`
	DeadlineAt  *time.Time      `json:"deadlineAt,omitempty"`
	Progress    json.RawMessage `json:"progress,omitempty"`
	Report      json.RawMessage `json:"report,omitempty"`
	Error       string          `json:"error,omitempty"`
	ContainerID string          `json:"containerId,omitempty"`
}

// storageCopyRunnerResult is the runner's /work/result.json.
type storageCopyRunnerResult struct {
	JobID    string          `json:"jobId"`
	Status   string          `json:"status"`
	Phase    string          `json:"phase"`
	Progress json.RawMessage `json:"progress,omitempty"`
	Report   json.RawMessage `json:"report,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type storageCopyExecutor func(ctx context.Context, jobID string, payload storageCopyPayload, workdir string) (storageCopyStatus, error)

type storageCopyRuntime struct {
	plugin *DockerPlugin
	root   string
	mu     sync.Mutex
	// persistMu serializes status file writes: goroutines of one job (progress, cancel, completion) persist
	// concurrently, and an interleaved write through one temporary name used to leave a corrupt status file.
	persistMu sync.Mutex
	jobs      map[string]*storageCopyStatus
	cancel    map[string]context.CancelFunc
	execute   storageCopyExecutor
	// stopRunner stops and removes a job's runner container found after a
	// daemon restart; it reports whether one existed.
	stopRunner func(jobID, containerID string) (bool, error)
	openRelay  BackupRelayOpen
	now        func() time.Time
	lastPrune  time.Time
}

var storageCopyRuntimes sync.Map // map[*DockerPlugin]*storageCopyRuntime

// storageCopyRuntimeInitMu serializes first initialization: its recovery pass
// deletes work directories, so it must finish before any job starts.
var storageCopyRuntimeInitMu sync.Mutex

func storageCopyRuntimeFor(plugin *DockerPlugin) (*storageCopyRuntime, error) {
	if plugin == nil || plugin.cfg == nil || plugin.client == nil {
		return nil, errors.New("storage copy runtime is not initialized")
	}
	if existing, ok := storageCopyRuntimes.Load(plugin); ok {
		return existing.(*storageCopyRuntime), nil
	}
	storageCopyRuntimeInitMu.Lock()
	defer storageCopyRuntimeInitMu.Unlock()
	if existing, ok := storageCopyRuntimes.Load(plugin); ok {
		return existing.(*storageCopyRuntime), nil
	}
	root := filepath.Join(plugin.cfg.StateDir, storageCopyStateDirectory)
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create storage copy state directory: %w", err)
	}
	runtime := newStorageCopyRuntime(plugin, root)
	runtime.execute = runtime.runRunner
	runtime.stopRunner = runtime.stopRunnerContainer
	runtime.recoverLeftovers()
	runtime.pruneTerminal()
	storageCopyRuntimes.Store(plugin, runtime)
	return runtime, nil
}

// recoverStorageCopyJobs runs the startup recovery of storage copy jobs in
// the background, so credentials left by jobs that did not survive a daemon
// restart are removed without waiting for a control-plane poll.
func (p *DockerPlugin) recoverStorageCopyJobs() {
	go func() {
		if _, err := storageCopyRuntimeFor(p); err != nil && p.logger != nil {
			p.logger.Warn("storage copy recovery failed", "error", err)
		}
	}()
}

func newStorageCopyRuntime(plugin *DockerPlugin, root string) *storageCopyRuntime {
	return &storageCopyRuntime{
		plugin: plugin,
		root:   root,
		jobs:   map[string]*storageCopyStatus{},
		cancel: map[string]context.CancelFunc{},
		openRelay: func(ctx context.Context, p *DockerPlugin, kind, id string) (string, func(), error) {
			return OpenBackupRelayRouteForBackup(ctx, p, kind, id)
		},
		now: func() time.Time { return time.Now().UTC() },
	}
}

func (p *DockerPlugin) handleStorageCopyCommand(cmd *pb.DockerBackupCommand, result *pb.CommandResult) {
	runtime, err := storageCopyRuntimeFor(p)
	if err != nil {
		result.Success = false
		result.Error = sanitizeBackupError(err.Error())
		return
	}
	status, err := runtime.apply(cmd.GetAction(), cmd.GetRunId(), cmd.GetConfigJson())
	if err != nil {
		result.Success = false
		result.Error = sanitizeBackupError(err.Error())
		return
	}
	detail, err := json.Marshal(status)
	if err != nil {
		result.Success = false
		result.Error = "encode storage copy status"
		return
	}
	result.Detail = string(detail)
}

func (r *storageCopyRuntime) apply(action, jobID, raw string) (storageCopyStatus, error) {
	r.maybePrune()
	if _, err := uuid.Parse(jobID); err != nil {
		return storageCopyStatus{}, errors.New("STORAGE_COPY_INVALID: job id must be a UUID")
	}
	switch action {
	case "copy_start":
		payload, err := parseStorageCopyPayload(raw)
		if err != nil {
			return storageCopyStatus{}, err
		}
		if payload.JobID != jobID {
			return storageCopyStatus{}, errors.New("STORAGE_COPY_INVALID: job id does not match the request")
		}
		return r.start(payload)
	case "copy_status":
		return r.status(jobID)
	case "copy_cancel":
		return r.cancelJob(jobID)
	default:
		return storageCopyStatus{}, errors.New("STORAGE_COPY_INVALID: storage copy action is not allowed")
	}
}

func parseStorageCopyPayload(raw string) (storageCopyPayload, error) {
	var payload storageCopyPayload
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, errors.New("STORAGE_COPY_INVALID: configuration is invalid JSON")
	}
	if err := payload.validate(); err != nil {
		return payload, fmt.Errorf("STORAGE_COPY_INVALID: %w", err)
	}
	return payload, nil
}

func (p storageCopyPayload) validate() error {
	if _, err := uuid.Parse(p.JobID); err != nil || p.Version != 1 {
		return errors.New("job id or version is invalid")
	}
	if p.Mode != "copy" && p.Mode != "sync" {
		return errors.New("mode must be copy or sync")
	}
	if !strings.Contains(p.ToolImage, "@sha256:") {
		return errors.New("runner image must be an immutable digest reference")
	}
	if err := p.Limits.validate(); err != nil {
		return err
	}
	if p.AllBuckets == (len(p.Buckets) > 0) {
		return errors.New("select either all buckets or a list of buckets")
	}
	if len(p.Buckets) > storageCopyMaxBuckets {
		return errors.New("too many buckets")
	}
	seen := map[string]bool{}
	for _, bucket := range p.Buckets {
		if !isStorageCopyBucketName(bucket) || seen[bucket] {
			return fmt.Errorf("bucket name %q is invalid", truncateForError(bucket))
		}
		seen[bucket] = true
	}
	if err := p.Source.validate(p.JobID); err != nil {
		return fmt.Errorf("source: %w", err)
	}
	if err := p.Destination.validate(p.JobID); err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	if p.Source.ConnectionID == p.Destination.ConnectionID {
		return errors.New("source and destination must differ")
	}
	return nil
}

func (l storageCopyLimits) validate() error {
	if l.TimeoutSeconds < int(time.Minute.Seconds()) || time.Duration(l.TimeoutSeconds)*time.Second > storageCopyMaxTimeout {
		return errors.New("timeout is outside allowed bounds")
	}
	if l.CPUCores < 1 || l.CPUCores > 16 || l.MemoryMB < 256 || l.MemoryMB > 65536 || l.Transfers < 1 || l.Transfers > 32 {
		return errors.New("runtime limit is outside allowed bounds")
	}
	return nil
}

func (e storageCopyEndpoint) validate(jobID string) error {
	if e.ConnectionID == "" || len(e.ConnectionID) > 128 {
		return errors.New("connection id is required")
	}
	endpoint, err := url.Parse(e.Endpoint)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return errors.New("endpoint must be an absolute http or https URL")
	}
	for _, value := range []string{e.Endpoint, e.Region, e.AccessKeyID} {
		if strings.ContainsAny(value, "\r\n") {
			return errors.New("endpoint fields must not contain line breaks")
		}
	}
	if strings.ContainsAny(e.SecretAccessKey, "\r\n") || strings.ContainsAny(e.SessionToken, "\r\n") {
		return errors.New("credentials must not contain line breaks")
	}
	// The control plane names each per-job relay route after the job itself.
	if e.RelayRouteID != "" && e.RelayRouteID != jobID {
		return errors.New("relay route does not belong to this job")
	}
	return nil
}

func isStorageCopyBucketName(value string) bool {
	return len(value) >= 3 && len(value) <= 255 && storageCopyBucketPattern.MatchString(value) && !strings.Contains(value, "..")
}

func truncateForError(value string) string {
	if len(value) > 80 {
		return value[:80]
	}
	return value
}

func isTerminalStorageCopyStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func (r *storageCopyRuntime) start(payload storageCopyPayload) (storageCopyStatus, error) {
	jobID := payload.JobID
	r.mu.Lock()
	if existing := r.jobs[jobID]; existing != nil {
		// A replayed start (the control plane's first response was lost) reports the job.
		copy := *existing
		r.mu.Unlock()
		return copy, nil
	}
	if persisted, err := r.load(jobID); err == nil {
		r.mu.Unlock()
		if isTerminalStorageCopyStatus(persisted.Status) {
			return persisted, nil
		}
		return r.status(jobID)
	}
	started := r.now()
	if payload.StartBy != nil && started.After(payload.StartBy.Add(storageCopyStartGrace)) {
		r.mu.Unlock()
		// A late delivery gets no listener; an answer the control plane does
		// receive means this clock runs ahead of Opfield's, so name that.
		return storageCopyStatus{}, fmt.Errorf("%s: the start request was due by %s but this node's clock reads %s; if this repeats, the node clock is ahead of Opfield, fix its time synchronization",
			storageCopyStartExpired, payload.StartBy.UTC().Format(time.RFC3339), started.Format(time.RFC3339))
	}
	if len(r.cancel) >= storageCopyMaxActive {
		r.mu.Unlock()
		return storageCopyStatus{}, fmt.Errorf("STORAGE_COPY_CAPACITY: this node already runs %d copy jobs", storageCopyMaxActive)
	}
	deadline := effectiveBackupDeadline(started, payload.Limits.TimeoutSeconds, payload.DeadlineAt)
	if !started.Before(deadline) {
		r.mu.Unlock()
		expired := storageCopyStatus{JobID: jobID, Status: "failed", Phase: "timeout", Error: "Storage copy exceeded its deadline before it started", StartedAt: &started, CompletedAt: &started, DeadlineAt: &deadline}
		if err := r.persist(expired); err != nil {
			return storageCopyStatus{}, err
		}
		return expired, nil
	}
	status := &storageCopyStatus{JobID: jobID, Status: "running", Phase: "starting", StartedAt: &started, DeadlineAt: &deadline}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	r.jobs[jobID] = status
	r.cancel[jobID] = cancel
	r.mu.Unlock()
	if err := r.persist(*status); err != nil {
		r.mu.Lock()
		delete(r.jobs, jobID)
		delete(r.cancel, jobID)
		r.mu.Unlock()
		cancel()
		return storageCopyStatus{}, err
	}
	workdir := filepath.Join(r.root, jobID)
	go func() {
		defer cancel()
		result, err := r.execute(ctx, jobID, payload, workdir)
		if err != nil {
			result = storageCopyFailure(ctx, err, jobID, r.lastProgress(jobID))
		}
		if result.Status == "" || !isTerminalStorageCopyStatus(result.Status) {
			result = storageCopyFailure(ctx, errors.New("storage copy runner returned no terminal status"), jobID, r.lastProgress(jobID))
		}
		if ctx.Err() != nil && r.stopRunner != nil {
			// A cancel or the deadline can cut a Docker request short after
			// dockerd acted on it (a runner created without its id reaching the
			// daemon), so no container of the job may outlive the job.
			if _, err := r.stopRunner(jobID, ""); err != nil && r.plugin != nil && r.plugin.logger != nil {
				r.plugin.logger.Warn("storage copy runner cleanup failed", "jobId", jobID, "error", err)
			}
		}
		completed := r.now()
		result.JobID, result.StartedAt, result.DeadlineAt, result.CompletedAt = jobID, &started, &deadline, &completed
		if result.ContainerID == "" {
			result.ContainerID = r.containerID(jobID)
		}
		// The final status is on disk before any command can report it: a
		// cancelled or completed job the control plane has seen must still read
		// so after a daemon restart, not as interrupted.
		if err := r.persist(result); err != nil && r.plugin != nil && r.plugin.logger != nil {
			r.plugin.logger.Warn("storage copy final status was not saved", "jobId", jobID, "status", result.Status, "error", err)
		}
		_ = os.RemoveAll(workdir)
		r.mu.Lock()
		r.jobs[jobID] = &result
		delete(r.cancel, jobID)
		r.mu.Unlock()
	}()
	return *status, nil
}

// storageCopyFailure is the terminal status of a job whose runner returned no
// result. An explicit cancel wins over the deadline.
func storageCopyFailure(ctx context.Context, err error, jobID string, progress json.RawMessage) storageCopyStatus {
	switch {
	case errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled):
		return storageCopyStatus{JobID: jobID, Status: "cancelled", Phase: "cancelled", Progress: progress}
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		return storageCopyStatus{JobID: jobID, Status: "failed", Phase: "timeout", Error: "Storage copy exceeded its time limit", Progress: progress}
	default:
		return storageCopyStatus{JobID: jobID, Status: "failed", Phase: "failed", Error: sanitizeBackupError(err.Error()), Progress: progress}
	}
}

func (r *storageCopyRuntime) status(jobID string) (storageCopyStatus, error) {
	r.mu.Lock()
	if current := r.jobs[jobID]; current != nil {
		status := *current
		running := r.cancel[jobID] != nil
		r.mu.Unlock()
		if running && !isTerminalStorageCopyStatus(status.Status) {
			if progress := readStorageCopyProgress(filepath.Join(r.root, jobID, "work")); progress != nil {
				status.Progress = progress
				if phase := storageCopyProgressPhase(progress); phase != "" && status.Phase != "cancelling" {
					status.Phase = phase
				}
			}
		}
		return status, nil
	}
	r.mu.Unlock()
	persisted, err := r.load(jobID)
	if err != nil {
		return r.recoverUnknown(jobID)
	}
	if isTerminalStorageCopyStatus(persisted.Status) {
		return persisted, nil
	}
	return r.interrupt(persisted)
}

// interrupt ends a job that this daemon process did not start: the daemon
// restarted, which closed the job's relay routes, so its runner cannot finish.
func (r *storageCopyRuntime) interrupt(status storageCopyStatus) (storageCopyStatus, error) {
	workdir := filepath.Join(r.root, status.JobID)
	if _, err := r.stopRunner(status.JobID, status.ContainerID); err != nil {
		return storageCopyStatus{}, err
	}
	now := r.now()
	result := status
	if recovered, err := readStorageCopyResult(filepath.Join(workdir, "work", "result.json"), status.JobID); err == nil {
		result.Status, result.Phase, result.Report, result.Error = recovered.Status, recovered.Phase, recovered.Report, recovered.Error
		if recovered.Progress != nil {
			result.Progress = recovered.Progress
		}
	} else {
		if progress := readStorageCopyProgress(filepath.Join(workdir, "work")); progress != nil {
			result.Progress = progress
		}
		result.Status, result.Phase = "failed", "interrupted"
		result.Error = "The executor daemon restarted during the copy. Start the copy again; it only transfers what is still missing."
	}
	result.CompletedAt = &now
	_ = os.RemoveAll(workdir)
	if err := r.persist(result); err != nil {
		return storageCopyStatus{}, err
	}
	r.mu.Lock()
	r.jobs[status.JobID] = &result
	r.mu.Unlock()
	return result, nil
}

// recoverUnknown handles a job with no persisted status (lost state
// directory): a runner still labelled with it is stopped and reported,
// anything else is unknown to this executor.
func (r *storageCopyRuntime) recoverUnknown(jobID string) (storageCopyStatus, error) {
	found, err := r.stopRunner(jobID, "")
	if err != nil {
		return storageCopyStatus{}, err
	}
	if !found {
		return storageCopyStatus{}, errors.New(storageCopyUnknownJob)
	}
	return r.interrupt(storageCopyStatus{JobID: jobID, Status: "running", Phase: "recovered"})
}

func (r *storageCopyRuntime) cancelJob(jobID string) (storageCopyStatus, error) {
	r.mu.Lock()
	cancel := r.cancel[jobID]
	current := r.jobs[jobID]
	if cancel != nil && current != nil && !isTerminalStorageCopyStatus(current.Status) {
		current.Phase = "cancelling"
		status := *current
		r.mu.Unlock()
		cancel()
		_ = r.persist(status)
		return status, nil
	}
	r.mu.Unlock()
	status, err := r.status(jobID)
	if err != nil && err.Error() == storageCopyUnknownJob {
		// The start may still be on its way (a timed-out dispatch). Record the
		// cancellation so a late start for this job reports it instead of running.
		now := r.now()
		tombstone := storageCopyStatus{JobID: jobID, Status: "cancelled", Phase: "cancelled_before_start", CompletedAt: &now}
		if persistErr := r.persist(tombstone); persistErr != nil {
			return storageCopyStatus{}, persistErr
		}
		r.mu.Lock()
		r.jobs[jobID] = &tombstone
		r.mu.Unlock()
		return tombstone, nil
	}
	if err != nil {
		return storageCopyStatus{}, err
	}
	return status, nil
}

// recoverLeftovers runs once when the runtime is created, before any job of
// this daemon process exists. Work directories hold both storages'
// credentials: a job that was running when the daemon stopped is interrupted
// (its runner stopped, its result kept), and the directory of a terminal or
// unknown job is deleted.
func (r *storageCopyRuntime) recoverLeftovers() {
	entries, err := os.ReadDir(r.root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		jobID := entry.Name()
		if !entry.IsDir() {
			continue
		}
		workdir := filepath.Join(r.root, jobID)
		if _, err := uuid.Parse(jobID); err != nil {
			_ = os.RemoveAll(workdir)
			continue
		}
		status, err := r.load(jobID)
		switch {
		case err != nil:
			// No status: stop a runner still labelled with the job, then drop its files.
			_, _ = r.stopRunner(jobID, "")
			_ = os.RemoveAll(workdir)
		case isTerminalStorageCopyStatus(status.Status):
			_ = os.RemoveAll(workdir)
		default:
			if _, err := r.interrupt(status); err != nil {
				_ = os.RemoveAll(workdir)
			}
		}
	}
}

func (r *storageCopyRuntime) lastProgress(jobID string) json.RawMessage {
	return readStorageCopyProgress(filepath.Join(r.root, jobID, "work"))
}

func (r *storageCopyRuntime) containerID(jobID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.jobs[jobID]; current != nil {
		return current.ContainerID
	}
	return ""
}

func (r *storageCopyRuntime) recordContainer(jobID, containerID string) {
	r.mu.Lock()
	current := r.jobs[jobID]
	if current == nil {
		r.mu.Unlock()
		return
	}
	current.ContainerID = containerID
	if current.Phase == "starting" {
		current.Phase = "running"
	}
	status := *current
	r.mu.Unlock()
	_ = r.persist(status)
}

func (r *storageCopyRuntime) persist(status storageCopyStatus) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	r.persistMu.Lock()
	defer r.persistMu.Unlock()
	path := filepath.Join(r.root, status.JobID+".json")
	// A late progress or cancelling write never replaces the job's final status.
	if !isTerminalStorageCopyStatus(status.Status) {
		if previous, err := r.load(status.JobID); err == nil && isTerminalStorageCopyStatus(previous.Status) {
			return nil
		}
	}
	return atomicfile.WriteFile(path, data, 0o600)
}

func (r *storageCopyRuntime) load(jobID string) (storageCopyStatus, error) {
	data, err := os.ReadFile(filepath.Join(r.root, jobID+".json"))
	if err != nil {
		return storageCopyStatus{}, errors.New(storageCopyUnknownJob)
	}
	var status storageCopyStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return storageCopyStatus{}, err
	}
	return status, nil
}

// pruneTerminal deletes the work directory of every finished job and forgets
// finished jobs after the retention period; the control plane keeps their
// report.
// maybePrune runs pruneTerminal at most once per storageCopyPruneInterval,
// driven by the commands the control plane sends.
func (r *storageCopyRuntime) maybePrune() {
	r.mu.Lock()
	now := r.now()
	due := r.lastPrune.IsZero() || now.Sub(r.lastPrune) >= storageCopyPruneInterval
	if due {
		r.lastPrune = now
	}
	r.mu.Unlock()
	if due {
		r.pruneTerminal()
	}
}

func (r *storageCopyRuntime) pruneTerminal() {
	entries, err := os.ReadDir(r.root)
	if err != nil {
		return
	}
	now := r.now()
	r.mu.Lock()
	r.lastPrune = now
	r.mu.Unlock()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		jobID := strings.TrimSuffix(name, ".json")
		status, err := r.load(jobID)
		if err != nil || !isTerminalStorageCopyStatus(status.Status) {
			continue
		}
		// A finished job never needs its configuration again.
		_ = os.RemoveAll(filepath.Join(r.root, jobID))
		retained := storageCopyStatusRetained
		if status.Phase == "cancelled_before_start" {
			retained = storageCopyCancelRecordRetained
		}
		if status.CompletedAt != nil && status.CompletedAt.Before(now.Add(-retained)) {
			_ = os.Remove(filepath.Join(r.root, name))
			r.mu.Lock()
			if current := r.jobs[jobID]; current != nil && isTerminalStorageCopyStatus(current.Status) {
				delete(r.jobs, jobID)
			}
			r.mu.Unlock()
		}
	}
}

func (r *storageCopyRuntime) prepareRelays(ctx context.Context, payload *storageCopyPayload) ([]func(), error) {
	closers := make([]func(), 0, 2)
	closeAll := func() {
		for _, close := range closers {
			close()
		}
	}
	open := func(ownerKind string, endpoint *storageCopyEndpoint) error {
		if endpoint.RelayRouteID == "" {
			return nil
		}
		address, close, err := r.openRelay(ctx, r.plugin, ownerKind, endpoint.RelayRouteID)
		if err != nil {
			return err
		}
		closers = append(closers, close)
		return endpoint.replaceWithRelay(address)
	}
	if err := open(storageCopySourceRelayKind, &payload.Source); err != nil {
		closeAll()
		return nil, fmt.Errorf("open source relay route: %w", err)
	}
	if err := open(storageCopyDestinationRelayKind, &payload.Destination); err != nil {
		closeAll()
		return nil, fmt.Errorf("open destination relay route: %w", err)
	}
	return closers, nil
}

func (e *storageCopyEndpoint) replaceWithRelay(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || port == "" {
		return errors.New("storage relay returned an invalid address")
	}
	endpoint, err := url.Parse(e.Endpoint)
	if err != nil || endpoint.Scheme == "" {
		return errors.New("storage relay requires an absolute endpoint")
	}
	endpoint.Host = net.JoinHostPort(host, port)
	e.Endpoint = endpoint.String()
	return nil
}

func storageCopyRunnerConfigJSON(payload storageCopyPayload) ([]byte, error) {
	buckets := payload.Buckets
	if buckets == nil {
		buckets = []string{}
	}
	return json.Marshal(storageCopyRunnerConfig{
		Kind: "storage_copy", JobID: payload.JobID, Version: payload.Version, Mode: payload.Mode, DryRun: payload.DryRun,
		AllBuckets: payload.AllBuckets, Buckets: buckets, CreateBuckets: payload.CreateBuckets,
		Source: payload.Source, Destination: payload.Destination, Limits: payload.Limits,
	})
}

// runRunner runs the fixed runner program for one job. The work directory only
// holds configuration, CA bundles, progress and the result: objects stream
// through rclone without touching the node's disk.
func (r *storageCopyRuntime) runRunner(ctx context.Context, jobID string, payload storageCopyPayload, workdir string) (storageCopyStatus, error) {
	configDir := filepath.Join(workdir, "config")
	resultDir := filepath.Join(workdir, "work")
	for _, dir := range []string{configDir, resultDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return storageCopyStatus{}, err
		}
		if err := os.Chown(dir, 65532, 65532); err != nil {
			return storageCopyStatus{}, fmt.Errorf("own storage copy directory: %w", err)
		}
	}
	closers, err := r.prepareRelays(ctx, &payload)
	if err != nil {
		return storageCopyStatus{}, err
	}
	defer func() {
		for _, close := range closers {
			close()
		}
	}()
	data, err := storageCopyRunnerConfigJSON(payload)
	if err != nil {
		return storageCopyStatus{}, err
	}
	configPath := filepath.Join(configDir, "config.json")
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return storageCopyStatus{}, err
	}
	if err := os.Chown(configPath, 65532, 65532); err != nil {
		return storageCopyStatus{}, fmt.Errorf("own storage copy configuration: %w", err)
	}
	if err := r.plugin.client.EnsureImage(ctx, payload.ToolImage, ""); err != nil {
		return storageCopyStatus{}, fmt.Errorf("ensure backup runner image: %w", err)
	}
	pids := int64(256)
	labels := map[string]string{backupRunnerManagedLabel: storageCopyRunnerKind, storageCopyJobLabel: jobID}
	if deadline, ok := ctx.Deadline(); ok {
		labels[backupRunnerDeadlineLabel] = deadline.UTC().Format(time.RFC3339)
	}
	created, err := r.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{Image: payload.ToolImage, Cmd: []string{"storage-copy"}, Labels: labels},
		HostConfig: &container.HostConfig{
			// Host networking reaches the loopback relay listeners and external endpoints.
			NetworkMode: "host", ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
			Resources: container.Resources{Memory: payload.Limits.MemoryMB * 1024 * 1024, NanoCPUs: payload.Limits.CPUCores * 1_000_000_000, PidsLimit: &pids},
			Tmpfs:     map[string]string{"/tmp": "rw,noexec,nosuid,size=64m"},
			Mounts: []mount.Mount{
				{Type: mount.TypeBind, Source: configDir, Target: "/run/gateway-backup", ReadOnly: true},
				{Type: mount.TypeBind, Source: resultDir, Target: "/work"},
			},
		},
	})
	if err != nil {
		return storageCopyStatus{}, fmt.Errorf("create storage copy runner: %w", err)
	}
	defer r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	r.recordContainer(jobID, created.ID)
	if _, err := r.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return storageCopyStatus{}, fmt.Errorf("start storage copy runner: %w", err)
	}
	wait := r.plugin.client.cli.ContainerWait(ctx, created.ID, mobyclient.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case err := <-wait.Error:
		if err != nil {
			return storageCopyStatus{}, fmt.Errorf("wait storage copy runner: %w", err)
		}
	case result := <-wait.Result:
		if result.StatusCode != 0 {
			if status, readErr := readStorageCopyResult(filepath.Join(resultDir, "result.json"), jobID); readErr == nil {
				return status, nil
			}
			lines, _ := r.plugin.client.ContainerLogs(context.Background(), created.ID, 50, false, "", "")
			return storageCopyStatus{}, fmt.Errorf("storage copy runner exited %d: %s", result.StatusCode, sanitizeBackupError(strings.Join(lines, " ")))
		}
	case <-ctx.Done():
		return storageCopyStatus{}, ctx.Err()
	}
	return readStorageCopyResult(filepath.Join(resultDir, "result.json"), jobID)
}

func (r *storageCopyRuntime) stopRunnerContainer(jobID, containerID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ids := []string{}
	if containerID != "" {
		ids = append(ids, containerID)
	}
	listed, err := r.plugin.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", backupRunnerManagedLabel+"="+storageCopyRunnerKind).Add("label", storageCopyJobLabel+"="+jobID),
	})
	if err != nil {
		return false, fmt.Errorf("inspect storage copy runner: %w", err)
	}
	for _, item := range listed.Items {
		if item.ID != containerID {
			ids = append(ids, item.ID)
		}
	}
	found := len(listed.Items) > 0
	for _, id := range ids {
		if _, err := r.plugin.client.cli.ContainerRemove(ctx, id, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return found, fmt.Errorf("remove storage copy runner: %w", err)
		}
	}
	return found, nil
}

func readStorageCopyResult(path, jobID string) (storageCopyStatus, error) {
	data, err := readBoundedFile(path, storageCopyResultMaxBytes)
	if err != nil {
		return storageCopyStatus{}, errors.New("storage copy runner did not write a result")
	}
	return parseStorageCopyResult(data, jobID)
}

func parseStorageCopyResult(data []byte, jobID string) (storageCopyStatus, error) {
	var result storageCopyRunnerResult
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return storageCopyStatus{}, errors.New("storage copy runner returned an invalid result")
	}
	if result.JobID != jobID || (result.Status != "completed" && result.Status != "failed") {
		return storageCopyStatus{}, errors.New("storage copy runner result does not belong to this job")
	}
	if result.Report != nil && !isJSONObject(result.Report) {
		return storageCopyStatus{}, errors.New("storage copy report is invalid")
	}
	if result.Progress != nil && !isJSONObject(result.Progress) {
		result.Progress = nil
	}
	phase := result.Phase
	if phase == "" {
		phase = result.Status
	}
	return storageCopyStatus{JobID: jobID, Status: result.Status, Phase: truncateForError(phase), Report: result.Report, Progress: result.Progress, Error: sanitizeBackupError(result.Error)}, nil
}

// readStorageCopyProgress returns the runner's progress.json when it is a
// bounded JSON object, else nil.
func readStorageCopyProgress(workDir string) json.RawMessage {
	data, err := readBoundedFile(filepath.Join(workDir, "progress.json"), storageCopyProgressMaxBytes)
	if err != nil || !isJSONObject(data) {
		return nil
	}
	return json.RawMessage(data)
}

func storageCopyProgressPhase(progress json.RawMessage) string {
	var value struct {
		Phase string `json:"phase"`
	}
	if json.Unmarshal(progress, &value) != nil {
		return ""
	}
	switch value.Phase {
	case "listing", "copying", "checking":
		return value.Phase
	default:
		return ""
	}
}

func isJSONObject(data []byte) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("file is not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("file exceeds its size limit")
	}
	return data, nil
}
