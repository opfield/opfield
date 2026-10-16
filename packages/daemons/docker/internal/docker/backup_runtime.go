package docker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

const (
	backupStateDirectory = "backups"
	backupDefaultTimeout = time.Hour
	backupMaxTimeout     = 24 * time.Hour
	backupMaxWorkspace   = int64(1 << 40)
	backupMinWorkspace   = int64(1 << 30)
	backupResultMaxBytes = 512 * 1024
)

const (
	backupRunnerManagedLabel  = "net.opfield.managed"
	backupRunnerRunLabel      = "net.opfield.backup-run-id"
	backupRunnerDeadlineLabel = "net.opfield.backup-deadline"
	// The staging Redis of a Redis restore, labelled with backupRunnerRunLabel.
	backupRedisStageManagedValue = "backup-redis-stage"
	// A runner found after a daemon restart is stopped only once it is
	// clearly past its deadline, so small clock differences never stop a
	// runner that its original context would still have allowed.
	backupRunnerDeadlineGrace = 30 * time.Second
	// A cancelled or overdue runner gets SIGTERM and this long to undo what it
	// changed outside its workspace (a Redis restore target it made a replica)
	// before it is killed.
	backupRunnerStopGrace = 30 * time.Second
)

type backupPayload struct {
	RunID                   string          `json:"runId"`
	Version                 int             `json:"version"`
	Direction               string          `json:"direction"`
	Engine                  string          `json:"engine"`
	Source                  backupEndpoint  `json:"source"`
	Destination             backupEndpoint  `json:"destination"`
	Staging                 *backupEndpoint `json:"staging,omitempty"`
	RestoreTarget           *backupEndpoint `json:"restoreTarget,omitempty"`
	Limits                  backupLimits    `json:"limits"`
	ToolImage               string          `json:"toolImage"`
	RestoreArtifact         json.RawMessage `json:"restoreArtifact,omitempty"`
	RedisStaging            *backupEndpoint `json:"redisStaging,omitempty"`
	RedisStageImage         string          `json:"redisStageImage,omitempty"`
	RedisStageAdvertiseHost string          `json:"redisStageAdvertiseHost,omitempty"`
	// DeadlineAt is sent only to nodes advertising database_backups_deadline_v1.
	// It is daemon-only and never reaches the runner's config.json.
	DeadlineAt *time.Time `json:"deadlineAt,omitempty"`
}

// backupEndpoint.TLSVerifyCertificate is the connection's explicit server
// certificate verification setting. It is sent only to nodes advertising
// database_backups_tls_verification_v1; nil keeps the runner's behavior for
// endpoints without it (managed relay routes).
type backupEndpoint struct {
	ConnectionID         string `json:"connectionId"`
	Provider             string `json:"provider,omitempty"`
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Database             string `json:"database,omitempty"`
	Username             string `json:"username,omitempty"`
	Password             string `json:"password,omitempty"`
	TLS                  bool   `json:"tls,omitempty"`
	TLSVerifyCertificate *bool  `json:"tlsVerifyCertificate,omitempty"`
	CAPEM                string `json:"caPem,omitempty"`
	ServerName           string `json:"serverName,omitempty"`
	Endpoint             string `json:"endpoint,omitempty"`
	NativeEndpoint       string `json:"nativeEndpoint,omitempty"`
	Region               string `json:"region,omitempty"`
	Bucket               string `json:"bucket,omitempty"`
	Prefix               string `json:"prefix,omitempty"`
	AccessKeyID          string `json:"accessKeyId,omitempty"`
	SecretAccessKey      string `json:"secretAccessKey,omitempty"`
	SessionToken         string `json:"sessionToken,omitempty"`
	PrivateKey           string `json:"privateKey,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	HostKeyFingerprint   string `json:"hostKeyFingerprint,omitempty"`
	BasePath             string `json:"basePath,omitempty"`
	ImplicitTLS          bool   `json:"implicitTls,omitempty"`
	ForcePathStyle       bool   `json:"forcePathStyle,omitempty"`
	RelayRouteID         string `json:"relayRouteId,omitempty"`
	ManagedDatabaseID    string `json:"managedDatabaseId,omitempty"`
	NewManagedDatabaseID string `json:"newManagedDatabaseId,omitempty"`
}

type backupLimits struct {
	WorkspaceBytes int64 `json:"workspaceBytes"`
	TimeoutSeconds int   `json:"timeoutSeconds"`
	CPUCores       int64 `json:"cpuCores"`
	MemoryMB       int64 `json:"memoryMb"`
}

type backupRunStatus struct {
	RunID          string          `json:"runId"`
	Status         string          `json:"status"`
	Phase          string          `json:"phase"`
	StartedAt      *time.Time      `json:"startedAt,omitempty"`
	CompletedAt    *time.Time      `json:"completedAt,omitempty"`
	Bytes          int64           `json:"bytes,omitempty"`
	Manifest       json.RawMessage `json:"manifest,omitempty"`
	Error          string          `json:"error,omitempty"`
	Fingerprint    string          `json:"fingerprint,omitempty"`
	ContainerID    string          `json:"containerId,omitempty"`
	CleanupPending bool            `json:"cleanupPending,omitempty"`
	CleanupError   string          `json:"cleanupError,omitempty"`
	DeadlineAt     *time.Time      `json:"deadlineAt,omitempty"`
}

type backupRuntime struct {
	plugin *DockerPlugin
	root   string
	mu     sync.Mutex
	runs   map[string]*backupRunStatus
	cancel map[string]context.CancelFunc
	// active holds the runs whose runTool is executing in this process; their
	// workspaces are released by runTool itself, never by reconciliation.
	active map[string]bool
}

// backupWorkspace is a non-sparse ext4 image in the same storage root and
// reservation domain as managed databases. A Docker bind mount alone cannot
// enforce workspaceBytes.
type backupWorkspace struct {
	imagePath string
	mountPath string
	loops     *loopHost
}

var backupRuntimes sync.Map // map[*DockerPlugin]*backupRuntime; avoids parent-owned DockerPlugin edits.

// backupRuntimeInitMu serializes first initialization. reconcileWorkspaces
// unmounts, detaches and deletes workspaces, so concurrent first calls must
// not each run it. A mutex rather than sync.Once lets a failed init retry.
var backupRuntimeInitMu sync.Mutex

// Installed by the parent relay integration. It keeps this chunk compilable
// until relay_tunnel.go lands in this isolated worktree.
type BackupRelayOpen func(context.Context, *DockerPlugin, string, string) (string, func(), error)

var OpenBackupRelayRouteForBackup BackupRelayOpen = func(_ context.Context, _ *DockerPlugin, _ string, _ string) (string, func(), error) {
	return "", nil, errors.New("backup relay support is not integrated")
}

func backupRuntimeFor(plugin *DockerPlugin) (*backupRuntime, error) {
	if plugin == nil || plugin.cfg == nil || plugin.client == nil {
		return nil, errors.New("backup runtime is not initialized")
	}
	if existing, ok := backupRuntimes.Load(plugin); ok {
		return existing.(*backupRuntime), nil
	}
	backupRuntimeInitMu.Lock()
	defer backupRuntimeInitMu.Unlock()
	if existing, ok := backupRuntimes.Load(plugin); ok {
		return existing.(*backupRuntime), nil
	}
	root := filepath.Join(plugin.cfg.StateDir, backupStateDirectory)
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create backup state directory: %w", err)
	}
	runtime := &backupRuntime{plugin: plugin, root: root, runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}, active: map[string]bool{}}
	runtime.reconcileWorkspaces()
	backupRuntimes.Store(plugin, runtime)
	return runtime, nil
}

// A daemon restart can interrupt defer-based teardown, and a run nobody asks
// about again is never reconciled through its status. This pass runs at the
// first backup command and with the periodic loop-image repair. It reclaims
// the workspace of every run that is not executing in this process and whose
// runner is gone: terminal runs, runs whose runner finished or vanished, and
// runs the daemon lost before it started a runner. A runner that is still
// running keeps its mounted ext4 image.
func (r *backupRuntime) reconcileWorkspaces() {
	if r.plugin.databaseManager == nil || r.plugin.client == nil {
		return
	}
	imageDir := filepath.Join(r.plugin.databaseManager.root, "backups", "images")
	images, err := filepath.Glob(filepath.Join(imageDir, "*.img"))
	if err != nil {
		return
	}
	for _, imagePath := range images {
		runID := strings.TrimSuffix(filepath.Base(imagePath), ".img")
		r.mu.Lock()
		active := r.active[runID]
		r.mu.Unlock()
		if active {
			continue
		}
		_, loadErr := r.load(runID)
		// status() reconciles a persisted run whose runner is gone, which
		// releases its workspace.
		status, statusErr := r.status(runID)
		switch {
		case statusErr == nil && isTerminalBackupStatus(status.Status) && workspaceImageExists(imagePath):
			_, _ = r.reconcileTerminalCleanup(status, true)
		case statusErr != nil && loadErr != nil && statusErr.Error() == "BACKUP_RUN_UNKNOWN":
			// No status, no runner container and no result: the run was lost
			// before its runner existed.
			if err := r.removeWorkspace(runID, imagePath); err != nil {
				r.plugin.databaseManager.logger.Warn("orphaned backup workspace could not be released", "run_id", runID, "error", err)
			} else {
				r.plugin.databaseManager.logger.Info("released orphaned backup workspace", "run_id", runID)
			}
		}
	}
	r.removeOrphanedRedisStages()
}

// workspaceImageExists is false once status() already released the workspace.
func workspaceImageExists(imagePath string) bool {
	_, err := os.Stat(imagePath)
	return err == nil
}

func (r *backupRuntime) removeWorkspace(runID, imagePath string) error {
	if r.plugin.databaseManager == nil {
		return errors.New("managed storage manager is not initialized")
	}
	r.plugin.databaseManager.mu.Lock()
	defer r.plugin.databaseManager.mu.Unlock()
	return r.removeWorkspaceLocked(runID, imagePath)
}

func (r *backupRuntime) removeWorkspaceLocked(runID, imagePath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
	defer cancel()
	// A staging Redis left by a daemon restart keeps the workspace mounted.
	if err := r.removeRedisStages(ctx, runID); err != nil {
		return err
	}
	if err := r.plugin.databaseManager.loopHost().release(ctx, imagePath, filepath.Join(r.root, runID, "work")); err != nil {
		return fmt.Errorf("release backup workspace: %w", err)
	}
	if err := os.Remove(imagePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove backup workspace image: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(r.root, runID)); err != nil {
		return fmt.Errorf("remove backup workspace state: %w", err)
	}
	return nil
}

// removeRedisStages removes the staging Redis containers of one run.
func (r *backupRuntime) removeRedisStages(ctx context.Context, runID string) error {
	containers, err := r.plugin.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All: true,
		Filters: mobyclient.Filters{}.
			Add("label", backupRunnerManagedLabel+"="+backupRedisStageManagedValue).
			Add("label", backupRunnerRunLabel+"="+runID),
	})
	if err != nil {
		return fmt.Errorf("list Redis staging containers: %w", err)
	}
	for _, candidate := range containers.Items {
		if _, err := r.plugin.client.cli.ContainerRemove(ctx, candidate.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove Redis staging container: %w", err)
		}
	}
	return nil
}

// removeOrphanedRedisStages removes staging Redis containers no run owns any
// more: their run is not executing in this process and its workspace is gone.
// The workspace pass above keeps the workspace of every run whose runner is
// still running, and runTool creates the stage only inside a workspace.
func (r *backupRuntime) removeOrphanedRedisStages() {
	ctx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
	defer cancel()
	containers, err := r.plugin.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", backupRunnerManagedLabel+"="+backupRedisStageManagedValue),
	})
	if err != nil {
		return
	}
	imageDir := filepath.Join(r.plugin.databaseManager.root, "backups", "images")
	for _, candidate := range containers.Items {
		runID := candidate.Labels[backupRunnerRunLabel]
		r.mu.Lock()
		active := r.active[runID]
		r.mu.Unlock()
		if active || (runID != "" && workspaceImageExists(filepath.Join(imageDir, runID+".img"))) {
			continue
		}
		if _, err := r.plugin.client.cli.ContainerRemove(ctx, candidate.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			r.plugin.databaseManager.logger.Warn("orphaned Redis staging container could not be removed", "run_id", runID, "error", err)
		}
	}
}

func (r *backupRuntime) apply(action, runID, raw string) (backupRunStatus, error) {
	if _, err := uuid.Parse(runID); err != nil {
		return backupRunStatus{}, errors.New("backup run id must be a UUID")
	}
	switch action {
	case "status":
		return r.status(runID)
	case "cancel":
		return r.cancelRun(runID)
	case "preflight", "start":
		payload, fingerprint, err := parseBackupPayload(raw)
		if err != nil {
			if action == "preflight" && payload.RunID == runID {
				if persistErr := r.persistPreflightFailure(runID, "validation", err); persistErr != nil {
					return backupRunStatus{}, persistErr
				}
			}
			return backupRunStatus{}, err
		}
		if payload.RunID != runID {
			if action == "preflight" {
				if persistErr := r.persistPreflightFailure(runID, "validation", errors.New("backup run id does not match immutable request")); persistErr != nil {
					return backupRunStatus{}, persistErr
				}
			}
			return backupRunStatus{}, errors.New("backup run id does not match immutable request")
		}
		if action == "preflight" {
			return r.preflight(runID, payload, fingerprint)
		}
		return r.start(runID, payload, fingerprint)
	default:
		return backupRunStatus{}, errors.New("backup action is not allowed")
	}
}

func (r *backupRuntime) persistPreflightFailure(runID, phase string, err error) error {
	now := time.Now().UTC()
	status := backupRunStatus{
		RunID:       runID,
		Status:      "failed",
		Phase:       phase,
		Error:       sanitizeBackupError(err.Error()),
		CompletedAt: &now,
	}
	r.mu.Lock()
	r.runs[runID] = &status
	r.mu.Unlock()
	return r.persist(status)
}

func parseBackupPayload(raw string) (backupPayload, string, error) {
	var payload backupPayload
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, "", errors.New("backup configuration is invalid JSON")
	}
	if err := payload.validate(); err != nil {
		return payload, "", err
	}
	sum := sha256.Sum256([]byte(raw))
	return payload, hex.EncodeToString(sum[:]), nil
}

func (p backupPayload) validate() error {
	if _, err := uuid.Parse(p.RunID); err != nil || p.Version != 1 || (p.Direction != "backup" && p.Direction != "restore") || (p.Engine != "postgres" && p.Engine != "redis" && p.Engine != "clickhouse") {
		return errors.New("backup version, direction, or engine is invalid")
	}
	if !strings.Contains(p.ToolImage, "@sha256:") {
		return errors.New("backup tool image must be an immutable digest reference")
	}
	if err := p.Limits.validate(); err != nil {
		return err
	}
	if p.Direction == "backup" && p.Source.ConnectionID == "" {
		return errors.New("backup source is required")
	}
	if p.Direction == "backup" {
		if err := p.Source.validateDatabase(); err != nil {
			return fmt.Errorf("source: %w", err)
		}
	}
	if err := p.Destination.validateDestination(); err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	if p.Destination.Provider == "sftp" && !strings.HasPrefix(p.Destination.HostKeyFingerprint, "SHA256:") {
		return errors.New("sftp destination requires SHA256 host key fingerprint")
	}
	if p.Engine == "clickhouse" && p.Destination.Provider != "s3" && p.Staging == nil {
		return errors.New("clickhouse file-protocol destination requires S3 staging")
	}
	if p.Engine == "clickhouse" && p.Staging != nil && p.Staging.Provider != "s3" {
		return errors.New("clickhouse staging must use S3")
	}
	if p.Direction == "restore" && p.RestoreTarget == nil {
		return errors.New("restore requires a new target")
	}
	if p.Direction == "restore" && p.Engine == "redis" && p.RestoreTarget != nil && p.RestoreTarget.ManagedDatabaseID == "" {
		if p.RedisStageAdvertiseHost == "" || isBackupLoopbackHost(p.RedisStageAdvertiseHost) {
			return errors.New("external Redis restore requires an executor-reachable staging address")
		}
	}
	return nil
}

func isBackupLoopbackHost(value string) bool {
	value = strings.TrimSpace(strings.ToLower(value))
	return value == "localhost" || value == "::1" || strings.HasPrefix(value, "127.")
}

func (l backupLimits) validate() error {
	if l.WorkspaceBytes < backupMinWorkspace || l.WorkspaceBytes > backupMaxWorkspace {
		return errors.New("backup workspace limit is outside allowed bounds")
	}
	if l.TimeoutSeconds < int(time.Minute.Seconds()) || time.Duration(l.TimeoutSeconds)*time.Second > backupMaxTimeout {
		return errors.New("backup timeout is outside allowed bounds")
	}
	if l.CPUCores < 1 || l.CPUCores > 32 || l.MemoryMB < 128 || l.MemoryMB > 262144 {
		return errors.New("backup runtime limit is outside allowed bounds")
	}
	return nil
}

func (e backupEndpoint) validateDatabase() error {
	if e.ConnectionID == "" || e.Host == "" || e.Port < 1 || e.Port > 65535 {
		return errors.New("database endpoint is incomplete")
	}
	return nil
}

func (e backupEndpoint) validateDestination() error {
	if e.ConnectionID == "" || (e.Provider != "s3" && e.Provider != "ftp" && e.Provider != "ftps" && e.Provider != "sftp") {
		return errors.New("destination provider is invalid")
	}
	if !isSafeBackupPath(e.Prefix, false) || !isSafeBackupBasePath(e.BasePath) || !isSafeBackupPath(e.Bucket, false) {
		return errors.New("destination path is invalid")
	}
	if e.Provider == "s3" && (e.Bucket == "" || e.Endpoint == "") {
		return errors.New("s3 destination is incomplete")
	}
	if e.Provider != "s3" && (e.Host == "" || e.Port < 1 || e.Port > 65535) {
		return errors.New("file destination is incomplete")
	}
	return nil
}

func isSafeBackupBasePath(value string) bool {
	if value == "" {
		return true
	}
	return isSafeBackupPath(strings.TrimPrefix(value, "/"), false)
}

func isSafeBackupPath(value string, allowEmpty bool) bool {
	if value == "" {
		return allowEmpty
	}
	if strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		for _, character := range segment {
			if character < 0x20 || character == 0x7f {
				return false
			}
		}
	}
	return true
}

func (r *backupRuntime) preflight(runID string, payload backupPayload, fingerprint string) (backupRunStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	status, err := r.runTool(ctx, runID, payload, fingerprint, "preflight")
	if err != nil {
		if status.CleanupPending {
			now := time.Now().UTC()
			status.RunID, status.Status, status.Phase, status.Error, status.CompletedAt = runID, "failed", "preflight", sanitizeBackupError(err.Error()), &now
			r.mu.Lock()
			r.runs[runID] = &status
			r.mu.Unlock()
			if persistErr := r.persist(status); persistErr != nil {
				return backupRunStatus{}, persistErr
			}
			return status, err
		}
		// The controller only trusts persisted runner status. Without it a
		// preflight that failed before the runner wrote a result (no workspace
		// capacity, image pull, relay route) keeps the run and its node lease
		// alive until someone cancels it by hand.
		if persistErr := r.persistPreflightFailure(runID, "preflight", err); persistErr != nil {
			return backupRunStatus{}, persistErr
		}
		return backupRunStatus{}, err
	}
	if status.Status != "completed" {
		now := time.Now().UTC()
		status.CompletedAt = &now
		r.mu.Lock()
		r.runs[runID] = &status
		r.mu.Unlock()
		if persistErr := r.persist(status); persistErr != nil {
			return backupRunStatus{}, persistErr
		}
		return status, errors.New(status.Error)
	}
	if status.CleanupPending {
		now := time.Now().UTC()
		status.Status, status.Phase, status.Error, status.CompletedAt = "failed", "cleanup", status.CleanupError, &now
		r.mu.Lock()
		r.runs[runID] = &status
		r.mu.Unlock()
		if persistErr := r.persist(status); persistErr != nil {
			return backupRunStatus{}, persistErr
		}
		return status, errors.New(status.Error)
	}
	status.Status, status.Phase = "queued", "preflight_complete"
	status.CompletedAt = nil
	if err := r.persist(status); err != nil {
		return backupRunStatus{}, err
	}
	return status, nil
}

func (r *backupRuntime) start(runID string, payload backupPayload, fingerprint string) (backupRunStatus, error) {
	r.mu.Lock()
	if r.runs[runID] == nil {
		if persisted, err := r.load(runID); err == nil {
			r.runs[runID] = &persisted
		}
	}
	if existing := r.runs[runID]; existing != nil {
		// A preflight recovered from the runner's result file after a daemon
		// restart has no request fingerprint left to compare, so its start is
		// accepted rather than stranding the run.
		recoveredPreflight := existing.Phase == "preflight_complete" && existing.Fingerprint == ""
		if existing.Fingerprint != fingerprint && !recoveredPreflight {
			r.mu.Unlock()
			return backupRunStatus{}, errors.New("backup run id was replayed with different immutable request")
		}
		if existing.Phase != "preflight_complete" {
			copy := *existing
			r.mu.Unlock()
			return copy, nil
		}
		delete(r.runs, runID)
	}
	started := time.Now().UTC()
	if payload.DeadlineAt != nil && !started.Before(*payload.DeadlineAt) {
		deadlineAt := payload.DeadlineAt.UTC()
		expired := &backupRunStatus{RunID: runID, Status: "failed", Phase: "timeout", Error: "Backup run exceeded its deadline before it started", CompletedAt: &started, Fingerprint: fingerprint, DeadlineAt: &deadlineAt}
		r.runs[runID] = expired
		r.mu.Unlock()
		if err := r.persist(*expired); err != nil {
			r.mu.Lock()
			delete(r.runs, runID)
			r.mu.Unlock()
			return backupRunStatus{}, err
		}
		return *expired, nil
	}
	deadline := effectiveBackupDeadline(started, payload.Limits.TimeoutSeconds, payload.DeadlineAt)
	status := &backupRunStatus{RunID: runID, Status: "queued", Phase: "queued", StartedAt: &started, Fingerprint: fingerprint, DeadlineAt: &deadline}
	r.runs[runID] = status
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	r.cancel[runID] = cancel
	r.mu.Unlock()
	if err := r.persist(*status); err != nil {
		r.mu.Lock()
		delete(r.runs, runID)
		delete(r.cancel, runID)
		r.mu.Unlock()
		cancel()
		return backupRunStatus{}, err
	}
	go func() {
		defer cancel()
		result, err := r.runTool(ctx, runID, payload, fingerprint, payload.Direction)
		if err != nil {
			cleanupPending, cleanupError := result.CleanupPending, result.CleanupError
			result = backupRunFailure(ctx, err, runID, fingerprint)
			result.CleanupPending, result.CleanupError = cleanupPending, cleanupError
		}
		result.DeadlineAt = &deadline
		now := time.Now().UTC()
		result.CompletedAt = &now
		r.mu.Lock()
		r.runs[runID] = &result
		delete(r.cancel, runID)
		r.mu.Unlock()
		_ = r.persist(result)
	}()
	return *status, nil
}

func (r *backupRuntime) runTool(ctx context.Context, runID string, payload backupPayload, fingerprint, operation string) (status backupRunStatus, err error) {
	// First, so it is cleared last: after the workspace below is released.
	r.mu.Lock()
	r.active[runID] = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.active, runID)
		r.mu.Unlock()
	}()
	workdir := filepath.Join(r.root, runID)
	if err := os.MkdirAll(workdir, 0700); err != nil {
		return backupRunStatus{}, err
	}
	configDir := filepath.Join(workdir, "config")
	resultDir := filepath.Join(workdir, "work")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return backupRunStatus{}, err
	}
	if err := os.Chown(configDir, 65532, 65532); err != nil {
		return backupRunStatus{}, fmt.Errorf("own backup configuration directory: %w", err)
	}
	workspace, err := r.allocateWorkspace(ctx, runID, resultDir, payload.Limits.WorkspaceBytes)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer func() {
		if cleanupErr := cleanupBackupWorkspace(workspace, workdir); cleanupErr != nil {
			status.CleanupPending = true
			status.CleanupError = sanitizeBackupError(cleanupErr.Error())
		}
	}()
	stageCleanup, err := r.startRedisStage(ctx, runID, &payload, resultDir)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer stageCleanup()
	nativeStorageCleanup, err := r.prepareBackupNativeS3(ctx, &payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer nativeStorageCleanup()
	closers, err := r.prepareRelayEndpoints(ctx, &payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer func() {
		for _, close := range closers {
			close()
		}
	}()
	configPath := filepath.Join(configDir, "config.json")
	data, err := backupRunnerConfig(payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return backupRunStatus{}, err
	}
	if err := os.Chown(configPath, 65532, 65532); err != nil {
		return backupRunStatus{}, fmt.Errorf("own backup configuration: %w", err)
	}
	if err := r.plugin.client.EnsureImage(ctx, payload.ToolImage, ""); err != nil {
		return backupRunStatus{}, fmt.Errorf("ensure backup runner image: %w", err)
	}
	pids := int64(256)
	labels := map[string]string{backupRunnerManagedLabel: "backup-runner", backupRunnerRunLabel: runID}
	if deadline, ok := ctx.Deadline(); ok {
		// Survives a daemon restart, which loses ctx and its timer.
		labels[backupRunnerDeadlineLabel] = deadline.UTC().Format(time.RFC3339)
	}
	created, err := r.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     &container.Config{Image: payload.ToolImage, Cmd: []string{operation}, Labels: labels},
		HostConfig: &container.HostConfig{LogConfig: internalContainerLogConfig(), NetworkMode: "host", ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"}, Resources: container.Resources{Memory: payload.Limits.MemoryMB * 1024 * 1024, NanoCPUs: payload.Limits.CPUCores * 1_000_000_000, PidsLimit: &pids}, Mounts: append(backupRunnerConfigMounts(configDir), mount.Mount{Type: mount.TypeBind, Source: resultDir, Target: "/work"})},
	})
	if err != nil {
		return backupRunStatus{}, fmt.Errorf("create backup runner: %w", err)
	}
	// Runs before the Redis stage, relay and workspace cleanups below: a runner
	// stopped by a cancel or its deadline still reaches what it has to undo.
	defer func() {
		_ = r.stopRunnerContainer(created.ID)
		_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	}()
	if err := r.recordRunnerContainer(runID, operation, created.ID); err != nil {
		return backupRunStatus{}, err
	}
	if _, err := r.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return backupRunStatus{}, fmt.Errorf("start backup runner: %w", err)
	}
	wait := r.plugin.client.cli.ContainerWait(ctx, created.ID, mobyclient.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case err := <-wait.Error:
		if err != nil {
			return backupRunStatus{}, fmt.Errorf("wait backup runner: %w", err)
		}
	case result := <-wait.Result:
		if result.StatusCode != 0 {
			if resultData, readErr := os.ReadFile(filepath.Join(resultDir, "result.json")); readErr == nil {
				if terminal, parseErr := parseBackupRunnerResult(resultData, runID, fingerprint, operation); parseErr == nil {
					return terminal, nil
				}
			}
			lines, _ := r.plugin.client.ContainerLogs(context.Background(), created.ID, 100, false, "", "")
			return backupRunStatus{}, fmt.Errorf("backup runner exited %d: %s", result.StatusCode, sanitizeBackupError(strings.Join(lines, " ")))
		}
	case <-ctx.Done():
		return backupRunStatus{}, ctx.Err()
	}
	resultData, err := os.ReadFile(filepath.Join(resultDir, "result.json"))
	if err != nil {
		return backupRunStatus{}, errors.New("backup runner did not write result")
	}
	return parseBackupRunnerResult(resultData, runID, fingerprint, operation)
}

// backupRunFailure is the terminal status of a started run whose runner did
// not return a result. Cancellation wins over the deadline because a cancel
// is an explicit request.
func backupRunFailure(ctx context.Context, err error, runID, fingerprint string) backupRunStatus {
	switch {
	case errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled):
		return backupRunStatus{RunID: runID, Status: "cancelled", Phase: "cancelled", Fingerprint: fingerprint}
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
		return backupRunStatus{RunID: runID, Status: "failed", Phase: "timeout", Error: "Backup run exceeded its time limit", Fingerprint: fingerprint}
	default:
		return backupRunStatus{RunID: runID, Status: "failed", Phase: "failed", Error: sanitizeBackupError(err.Error()), Fingerprint: fingerprint}
	}
}

// backupRunnerConfig is the runner's config.json. The runner image is
// released separately and rejects unknown fields, so daemon-only fields are
// removed before the payload reaches it.
func backupRunnerConfig(payload backupPayload) ([]byte, error) {
	payload.DeadlineAt = nil
	return json.Marshal(payload)
}

// effectiveBackupDeadline is the run's own time limit, cut short by the
// control plane's deadline when that comes first.
func effectiveBackupDeadline(now time.Time, timeoutSeconds int, deadlineAt *time.Time) time.Time {
	deadline := now.Add(time.Duration(timeoutSeconds) * time.Second)
	if deadlineAt != nil && deadlineAt.Before(deadline) {
		deadline = *deadlineAt
	}
	return deadline.UTC()
}

func parseBackupRunnerDeadline(label string) *time.Time {
	if label == "" {
		return nil
	}
	deadline, err := time.Parse(time.RFC3339, label)
	if err != nil {
		return nil
	}
	deadline = deadline.UTC()
	return &deadline
}

// backupRunOverdue reports whether a runner found after a daemon restart has
// outlived its deadline: the persisted one, else the one labelled on its
// container. A runner started by a daemon that predates deadlines has
// neither, but no run may last longer than backupMaxTimeout after its
// container was created, so that bound still ends it. A zero created time is
// unknown and adds no bound.
func backupRunOverdue(deadline *time.Time, label string, created, now time.Time) bool {
	effective := deadline
	if effective == nil {
		effective = parseBackupRunnerDeadline(label)
	}
	if effective == nil && !created.IsZero() {
		bound := created.Add(backupMaxTimeout)
		effective = &bound
	}
	return effective != nil && now.After(effective.Add(backupRunnerDeadlineGrace))
}

// stopOverdueRunner ends a runner that no daemon context can end any more.
// A stop failure other than a missing container is returned so the control
// plane retries instead of seeing a terminal status for a live runner.
func (r *backupRuntime) stopOverdueRunner(status backupRunStatus) (backupRunStatus, error) {
	if err := r.stopRunnerContainer(status.ContainerID); err != nil {
		return backupRunStatus{}, fmt.Errorf("stop overdue backup runner: %w", err)
	}
	now := time.Now().UTC()
	stopped := backupRunStatus{
		RunID:       status.RunID,
		Status:      "failed",
		Phase:       "timeout",
		StartedAt:   status.StartedAt,
		CompletedAt: &now,
		Error:       "Backup runner exceeded its time limit and was stopped",
		Fingerprint: status.Fingerprint,
		ContainerID: status.ContainerID,
		DeadlineAt:  status.DeadlineAt,
	}
	return r.reconcileTerminalCleanup(stopped, true)
}

// stopRunnerContainer stops a runner with SIGTERM, killing it only after
// backupRunnerStopGrace. A runner that already exited or is gone is no error.
func (r *backupRuntime) stopRunnerContainer(containerID string) error {
	stopTimeout := int(backupRunnerStopGrace / time.Second)
	stopContext, stopCancel := context.WithTimeout(context.Background(), backupRunnerStopGrace+15*time.Second)
	defer stopCancel()
	if _, err := r.plugin.client.cli.ContainerStop(stopContext, containerID, mobyclient.ContainerStopOptions{Timeout: &stopTimeout}); err != nil && !isNotFoundErr(err) {
		return err
	}
	return nil
}

func (r *backupRuntime) recordRunnerContainer(runID, operation, containerID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.runs[runID]; current != nil {
		current.Status, current.Phase, current.ContainerID = "running", operation, containerID
		return r.persist(*current)
	}
	return nil
}

func cleanupBackupWorkspace(workspace *backupWorkspace, workdir string) error {
	if err := workspace.close(); err != nil {
		return err
	}
	return os.RemoveAll(workdir)
}

func (r *backupRuntime) allocateWorkspace(ctx context.Context, runID, mountPath string, bytes int64) (*backupWorkspace, error) {
	manager := r.plugin.databaseManager
	if manager == nil {
		return nil, errors.New("managed storage manager is not initialized")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	root := filepath.Join(manager.root, "backups")
	imageDir := filepath.Join(root, "images")
	if err := os.MkdirAll(imageDir, 0700); err != nil {
		return nil, fmt.Errorf("create backup workspace image directory: %w", err)
	}
	release, err := manager.reserveCapacity(bytes)
	if err != nil {
		return nil, fmt.Errorf("reserve backup workspace: %w", err)
	}
	defer release()
	imagePath := filepath.Join(imageDir, runID+".img")
	image, err := os.OpenFile(imagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("create backup workspace image: %w", err)
	}
	defer image.Close()
	loops := manager.loopHost()
	removeImage := true
	defer func() {
		if !removeImage {
			return
		}
		// The run context may be spent; the image goes only once released.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		if err := loops.release(cleanupCtx, imagePath, mountPath); err != nil {
			manager.logger.Warn("failed backup workspace allocation left storage behind; the repair pass releases it", "run_id", runID, "error", err)
			return
		}
		_ = os.Remove(imagePath)
	}()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", strconv.FormatInt(bytes, 10), imagePath).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("allocate bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := image.Sync(); err != nil {
		return nil, fmt.Errorf("sync backup workspace image: %w", err)
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", imagePath).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("format bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := os.MkdirAll(mountPath, 0700); err != nil {
		return nil, fmt.Errorf("create backup workspace mount point: %w", err)
	}
	loopDevice, err := attachDatabaseLoopDevice(ctx, imagePath)
	if err != nil {
		return nil, fmt.Errorf("attach backup workspace loop device: %w", err)
	}
	if output, err := exec.CommandContext(ctx, "mount", "-o", "noatime", loopDevice, mountPath).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("mount bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := os.Chown(mountPath, 65532, 65532); err != nil {
		return nil, fmt.Errorf("own backup workspace: %w", err)
	}
	removeImage = false
	return &backupWorkspace{imagePath: imagePath, mountPath: mountPath, loops: loops}, nil
}

// close releases the workspace (mount, then loop device, waiting until the
// kernel has let go of it) before its image is removed.
func (w *backupWorkspace) close() error {
	if w == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
	defer cancel()
	if err := w.loops.release(ctx, w.imagePath, w.mountPath); err != nil {
		return fmt.Errorf("release backup workspace: %w", err)
	}
	if err := os.Remove(w.imagePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove backup workspace image: %w", err)
	}
	return nil
}

func (r *backupRuntime) startRedisStage(ctx context.Context, runID string, payload *backupPayload, workdir string) (func(), error) {
	if payload.Direction != "restore" || payload.Engine != "redis" || payload.RestoreTarget == nil {
		return func() {}, nil
	}
	if !strings.Contains(payload.RedisStageImage, "@sha256:") {
		return nil, errors.New("immutable Redis staging image is required for external Redis restore")
	}
	stageImage, err := r.plugin.client.EnsureThirdPartyImage(ctx, payload.RedisStageImage)
	if err != nil {
		return nil, err
	}
	stageMemory, redisMaxMemory, err := redisStageMemoryLimits(payload.Limits.MemoryMB)
	if err != nil {
		return nil, err
	}
	port := 6379
	stageHost := ""
	hostConfig := &container.HostConfig{LogConfig: internalContainerLogConfig(), ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"}, Resources: container.Resources{Memory: stageMemory, NanoCPUs: 500_000_000}}
	var networking *network.NetworkingConfig
	if payload.RestoreTarget.ManagedDatabaseID == "" {
		allocated, err := allocateBackupStagePort()
		if err != nil {
			return nil, err
		}
		port = allocated
		stageHost = payload.RedisStageAdvertiseHost
		hostConfig.NetworkMode = "host"
	} else {
		if r.plugin.databaseManager == nil {
			return nil, errors.New("managed database runtime is not initialized")
		}
		record, err := r.plugin.databaseManager.loadRecord(payload.RestoreTarget.ManagedDatabaseID)
		if err != nil || record.Type != "redis" || record.NetworkName == "" {
			return nil, errors.New("managed Redis restore target network is unavailable")
		}
		networking = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{record.NetworkName: {}}}
	}
	secretBytes := make([]byte, 24)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	password := hex.EncodeToString(secretBytes)
	pids := int64(128)
	hostConfig.Resources.PidsLimit = &pids
	stageDir := filepath.Join(workdir, "redis-stage")
	if err := os.MkdirAll(stageDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chown(stageDir, 65532, 65532); err != nil {
		return nil, err
	}
	stageConfig := filepath.Join(stageDir, "redis.conf")
	configText := "bind 0.0.0.0\nport " + strconv.Itoa(port) + "\ndir /work/redis-stage\ndbfilename dump.rdb\nappendonly no\nsave \"\"\nmaxmemory " + strconv.FormatInt(redisMaxMemory, 10) + "\nmaxmemory-policy noeviction\nrequirepass " + password + "\n"
	if err := os.WriteFile(stageConfig, []byte(configText), 0600); err != nil {
		return nil, err
	}
	if err := os.Chown(stageConfig, 65532, 65532); err != nil {
		return nil, err
	}
	command := redisStageCommand()
	created, err := r.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{Image: stageImage, User: "65532:65532", Cmd: []string{"sh", "-ec", command}, Labels: map[string]string{backupRunnerManagedLabel: backupRedisStageManagedValue, backupRunnerRunLabel: runID}},
		HostConfig: func() *container.HostConfig {
			hostConfig.Mounts = []mount.Mount{{Type: mount.TypeBind, Source: workdir, Target: "/work"}}
			return hostConfig
		}(),
		NetworkingConfig: networking,
	})
	if err != nil {
		return nil, fmt.Errorf("create Redis staging container: %w", err)
	}
	if _, err := r.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
		return nil, err
	}
	if networking != nil {
		inspect, inspectErr := r.plugin.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
		if inspectErr != nil || inspect.Container.NetworkSettings == nil {
			_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
			return nil, errors.New("inspect managed Redis staging network")
		}
		for _, endpoint := range inspect.Container.NetworkSettings.Networks {
			if endpoint != nil && endpoint.IPAddress.IsValid() {
				stageHost = endpoint.IPAddress.String()
				break
			}
		}
		if stageHost == "" {
			_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
			return nil, errors.New("managed Redis staging container has no private address")
		}
	}
	payload.RedisStaging = &backupEndpoint{ConnectionID: "redis-stage", Host: stageHost, Port: port, Password: password}
	return func() {
		_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	}, nil
}

// redisStageCommand starts the staging key-value server of a restore once the
// dump is complete, with the modules of its image, so a dump holding JSON,
// Bloom or Search data loads: the Redis 8 images keep theirs in
// /usr/local/lib/redis/modules, the valkey-bundle image in /usr/lib/valkey
// (its LDAP module is left out). An image's own entrypoint adds them only when
// it starts the server itself, which a staging container does not.
func redisStageCommand() string {
	modules := "/usr/local/lib/redis/modules/*.so " + strings.Join(managedValkeyModules, " ")
	return `until [ -f /work/redis-stage/dump.rdb ]; do sleep 0.1; done
set --
for module in ` + modules + `; do
  if [ -f "$module" ]; then set -- "$@" --loadmodule "$module"; fi
done
exec redis-server /work/redis-stage/redis.conf "$@"`
}

func redisStageMemoryLimits(memoryMB int64) (int64, int64, error) {
	const reserveBytes = int64(32 * 1024 * 1024)
	approved := memoryMB * 1024 * 1024
	if approved <= reserveBytes {
		return 0, 0, errors.New("approved Redis staging memory is too small")
	}
	return approved, approved - reserveBytes, nil
}

func allocateBackupStagePort() (int, error) {
	const minPort = 20000
	const portRange = 20000
	for range 32 {
		var bytes [2]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return 0, err
		}
		raw := int(bytes[0])<<8 | int(bytes[1])
		port := minPort + raw%portRange
		listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero, Port: port})
		if err == nil {
			_ = listener.Close()
			return port, nil
		}
	}
	return 0, errors.New("no bounded Redis staging port is available")
}

func (r *backupRuntime) status(runID string) (backupRunStatus, error) {
	r.mu.Lock()
	if current := r.runs[runID]; current != nil {
		status := *current
		r.mu.Unlock()
		if isTerminalBackupStatus(status.Status) {
			return r.reconcileTerminalCleanup(status, false)
		}
		return status, nil
	}
	r.mu.Unlock()
	status, err := r.load(runID)
	if err != nil {
		return r.recoverUnknownRun(runID)
	}
	if isTerminalBackupStatus(status.Status) {
		return r.reconcileTerminalCleanup(status, false)
	}
	return r.reconcilePersistedRun(status)
}

func isTerminalBackupStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func (r *backupRuntime) recoverUnknownRun(runID string) (backupRunStatus, error) {
	containers, err := r.plugin.client.cli.ContainerList(context.Background(), mobyclient.ContainerListOptions{
		All: true,
		Filters: mobyclient.Filters{}.
			Add("label", backupRunnerManagedLabel+"=backup-runner").
			Add("label", backupRunnerRunLabel+"="+runID),
	})
	if err != nil {
		return backupRunStatus{}, fmt.Errorf("inspect unknown backup run: %w", err)
	}
	for _, candidate := range containers.Items {
		if candidate.State == "running" {
			status := backupRunStatus{RunID: runID, Status: "running", Phase: "recovered", ContainerID: candidate.ID, DeadlineAt: parseBackupRunnerDeadline(candidate.Labels[backupRunnerDeadlineLabel])}
			created := time.Time{}
			if candidate.Created > 0 {
				created = time.Unix(candidate.Created, 0)
			}
			if backupRunOverdue(status.DeadlineAt, "", created, time.Now()) {
				return r.stopOverdueRunner(status)
			}
			if err := r.persist(status); err != nil {
				return backupRunStatus{}, err
			}
			return status, nil
		}
		status := backupRunStatus{RunID: runID, ContainerID: candidate.ID}
		if recovered, resultErr := r.readPersistedRunnerResult(status); resultErr == nil {
			return r.reconcileTerminalCleanup(recovered, true)
		}
		status.Status, status.Phase, status.Error = "failed", "runner_lost", "Backup runner exited without a verified result"
		now := time.Now().UTC()
		status.CompletedAt = &now
		return r.reconcileTerminalCleanup(status, true)
	}
	if recovered, resultErr := r.readPersistedRunnerResult(backupRunStatus{RunID: runID}); resultErr == nil {
		return r.reconcileTerminalCleanup(recovered, true)
	}
	return backupRunStatus{}, errors.New("BACKUP_RUN_UNKNOWN")
}

func (r *backupRuntime) reconcilePersistedRun(status backupRunStatus) (backupRunStatus, error) {
	if status.Status == "queued" && status.Phase == "preflight_complete" && status.ContainerID == "" {
		return status, nil
	}
	if status.ContainerID == "" {
		recovered, err := r.recoverUnknownRun(status.RunID)
		r.mu.Lock()
		active := r.active[status.RunID]
		r.mu.Unlock()
		if err == nil || err.Error() != "BACKUP_RUN_UNKNOWN" || active {
			return recovered, err
		}
		// Accepted and persisted, but the daemon restarted before its runner
		// existed: nothing will start it any more. It ends here, and its
		// workspace and staging Redis go with it.
		if status.Phase == "cancelling" {
			status.Status, status.Phase, status.Error = "cancelled", "cancelled", ""
		} else {
			status.Status, status.Phase, status.Error = "failed", "interrupted", "The executor restarted before the backup runner started; start the run again"
		}
		now := time.Now().UTC()
		status.CompletedAt = &now
		return r.reconcileTerminalCleanup(status, true)
	}
	inspect, err := r.plugin.client.cli.ContainerInspect(context.Background(), status.ContainerID, mobyclient.ContainerInspectOptions{})
	if err == nil {
		labels := map[string]string(nil)
		if inspect.Container.Config != nil {
			labels = inspect.Container.Config.Labels
		}
		if labels[backupRunnerManagedLabel] != "backup-runner" || labels[backupRunnerRunLabel] != status.RunID {
			return backupRunStatus{}, errors.New("BACKUP_RUN_UNKNOWN")
		}
		if inspect.Container.State != nil && inspect.Container.State.Running {
			created, _ := time.Parse(time.RFC3339Nano, inspect.Container.Created)
			if backupRunOverdue(status.DeadlineAt, labels[backupRunnerDeadlineLabel], created, time.Now()) {
				if status.DeadlineAt == nil {
					status.DeadlineAt = parseBackupRunnerDeadline(labels[backupRunnerDeadlineLabel])
				}
				return r.stopOverdueRunner(status)
			}
			return status, nil
		}
	} else if !isNotFoundErr(err) {
		return backupRunStatus{}, fmt.Errorf("inspect persisted backup runner: %w", err)
	}
	if recovered, resultErr := r.readPersistedRunnerResult(status); resultErr == nil {
		if status.Phase == "cancelling" && recovered.Status == "failed" {
			// The runner reports the stop that the cancel asked for as a failure.
			recovered.Status, recovered.Phase, recovered.Error = "cancelled", "cancelled", ""
		}
		return r.reconcileTerminalCleanup(recovered, true)
	}
	if status.Phase == "cancelling" {
		status.Status, status.Phase, status.Error = "cancelled", "cancelled", ""
	} else {
		status.Status, status.Phase, status.Error = "failed", "runner_lost", "Backup runner exited without a verified result"
	}
	now := time.Now().UTC()
	status.CompletedAt = &now
	return r.reconcileTerminalCleanup(status, true)
}

// readPersistedRunnerResult recovers a runner's result after a daemon restart.
// A recovered preflight is not terminal: it returns to preflight_complete so
// the run can still be started. The caller still reclaims the workspace.
func (r *backupRuntime) readPersistedRunnerResult(status backupRunStatus) (backupRunStatus, error) {
	data, err := os.ReadFile(filepath.Join(r.root, status.RunID, "work", "result.json"))
	if err != nil {
		return backupRunStatus{}, err
	}
	recovered, err := parseBackupRunnerResult(data, status.RunID, status.Fingerprint, backupRunnerOperation(status.Phase))
	if err != nil {
		return backupRunStatus{}, err
	}
	return normalizeRecoveredRunnerResult(recovered), nil
}

// backupRunnerOperation is the operation recordRunnerContainer stored in the
// phase of a running status, or "" when the phase does not name one.
func backupRunnerOperation(phase string) string {
	switch phase {
	case "preflight", "backup", "restore":
		return phase
	default:
		return ""
	}
}

func normalizeRecoveredRunnerResult(status backupRunStatus) backupRunStatus {
	if status.Status == "completed" && status.Phase == "preflight" {
		status.Status, status.Phase, status.CompletedAt = "queued", "preflight_complete", nil
	}
	return status
}

func (r *backupRuntime) reconcileTerminalCleanup(status backupRunStatus, force bool) (backupRunStatus, error) {
	if !force && !status.CleanupPending {
		return status, nil
	}
	if r.plugin == nil || r.plugin.databaseManager == nil {
		status.CleanupPending = true
		status.CleanupError = "managed storage manager is not initialized"
	} else if err := r.removeWorkspace(status.RunID, filepath.Join(r.plugin.databaseManager.root, "backups", "images", status.RunID+".img")); err != nil {
		status.CleanupPending = true
		status.CleanupError = sanitizeBackupError(err.Error())
	} else {
		status.CleanupPending = false
		status.CleanupError = ""
	}
	if err := r.persist(status); err != nil {
		return backupRunStatus{}, err
	}
	r.mu.Lock()
	if r.runs != nil {
		updated := status
		r.runs[status.RunID] = &updated
	}
	r.mu.Unlock()
	return status, nil
}
func (r *backupRuntime) cancelRun(runID string) (backupRunStatus, error) {
	r.mu.Lock()
	cancel := r.cancel[runID]
	current := r.runs[runID]
	r.mu.Unlock()
	if current == nil {
		recovered, err := r.status(runID)
		if err != nil {
			return backupRunStatus{}, err
		}
		if recovered.Status == "completed" || recovered.Status == "failed" || recovered.Status == "cancelled" {
			return recovered, nil
		}
		current = &recovered
	}
	if cancel != nil {
		cancel()
	} else if current.ContainerID != "" {
		// The runner gets its stop grace period, longer than the control plane
		// waits for this answer. A failed stop leaves the run cancelling, and
		// the control plane cancels again.
		containerID := current.ContainerID
		go func() {
			if err := r.stopRunnerContainer(containerID); err != nil && r.plugin.databaseManager != nil {
				r.plugin.databaseManager.logger.Warn("cancelled backup runner could not be stopped", "run_id", runID, "error", err)
			}
		}()
	}
	result := *current
	result.Status, result.Phase = "running", "cancelling"
	if err := r.persist(result); err != nil {
		return backupRunStatus{}, err
	}
	return result, nil
}
func (r *backupRuntime) persist(status backupRunStatus) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(r.root, status.RunID+".json"), data, 0600)
}
func (r *backupRuntime) load(runID string) (backupRunStatus, error) {
	data, err := os.ReadFile(filepath.Join(r.root, runID+".json"))
	if err != nil {
		return backupRunStatus{}, errors.New("backup run is unknown")
	}
	var status backupRunStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return backupRunStatus{}, err
	}
	return status, nil
}

func (r *backupRuntime) prepareRelayEndpoints(ctx context.Context, payload *backupPayload) ([]func(), error) {
	closers := make([]func(), 0, 3)
	open := func(ownerKind string, endpoint *backupEndpoint) error {
		if endpoint.RelayRouteID == "" {
			return nil
		}
		address, close, err := OpenBackupRelayRouteForBackup(ctx, r.plugin, ownerKind, endpoint.RelayRouteID)
		if err != nil {
			return err
		}
		if err := endpoint.replaceWithRelay(address); err != nil {
			close()
			return err
		}
		closers = append(closers, close)
		return nil
	}
	if payload.Direction == "backup" {
		if err := open("database_backup_source", &payload.Source); err != nil {
			return nil, err
		}
	}
	if err := open("storage_backup_target", &payload.Destination); err != nil {
		return nil, err
	}
	if payload.Staging != nil {
		if err := open("storage_backup_staging", payload.Staging); err != nil {
			return nil, err
		}
	}
	if payload.Direction == "restore" && payload.RestoreTarget != nil {
		if err := open("database_backup_restore", payload.RestoreTarget); err != nil {
			return nil, err
		}
	}
	return closers, nil
}

func (e *backupEndpoint) replaceWithRelay(address string) error {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("backup relay returned invalid address")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("backup relay returned invalid port")
	}
	e.Host, e.Port = host, port
	if e.Provider == "s3" {
		endpoint, err := url.Parse(e.Endpoint)
		if err != nil || endpoint.Scheme == "" {
			return errors.New("s3 relay requires an absolute endpoint")
		}
		endpoint.Host = net.JoinHostPort(host, portText)
		e.Endpoint = endpoint.String()
	}
	return nil
}

// parseBackupRunnerResult verifies result.json against the operation that ran;
// operation is "" when a recovery cannot tell which one did.
func parseBackupRunnerResult(data []byte, runID, fingerprint, operation string) (backupRunStatus, error) {
	if len(data) > backupResultMaxBytes {
		return backupRunStatus{}, errors.New("backup runner output exceeded limit")
	}
	var status backupRunStatus
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return backupRunStatus{}, errors.New("backup runner returned invalid result")
	}
	if status.RunID != runID || !isTerminalBackupStatus(status.Status) || !backupRunnerPhaseMatches(operation, status) {
		return backupRunStatus{}, errors.New("backup runner result is invalid")
	}
	status.Fingerprint = fingerprint
	status.Error = sanitizeBackupError(status.Error)
	return status, nil
}

// A preflight also ends with status "completed", so only the phase tells a
// finished backup or restore apart from a preflight that merely passed.
func backupRunnerPhaseMatches(operation string, status backupRunStatus) bool {
	switch operation {
	case "preflight":
		return status.Status != "completed" || status.Phase == "preflight"
	case "backup", "restore":
		return status.Status != "completed" || status.Phase == "completed"
	case "":
		return status.Status != "completed" || status.Phase == "completed" || status.Phase == "preflight"
	default:
		return false
	}
}
func sanitizeBackupError(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	for _, key := range []string{"password=", "secret=", "token=", "privateKey="} {
		if index := strings.Index(strings.ToLower(value), strings.ToLower(key)); index >= 0 {
			value = value[:index] + key + "[redacted]"
		}
	}
	if len(value) > 2048 {
		value = value[:2048]
	}
	return value
}

// backupRunnerConfigMounts binds the runner's configuration directory where
// the runner reads it: /run/opfield-backup, and the pre-2.12.1 path a pinned
// older runner image (BACKUP_RUNNER_IMAGE) reads only (N-2).
func backupRunnerConfigMounts(configDir string) []mount.Mount {
	return []mount.Mount{
		{Type: mount.TypeBind, Source: configDir, Target: "/run/opfield-backup", ReadOnly: true},
		// legacy-name: /run/gateway-backup of pre-2.12.1 backup runner images — remove once no supported release pins one
		{Type: mount.TypeBind, Source: configDir, Target: "/run/gateway-backup", ReadOnly: true},
	}
}
