package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"golang.org/x/sys/unix"
)

const (
	managedDatabaseLabel   = "wiolett.gateway.managed-database.id"
	managedDatabaseTypeTag = "wiolett.gateway.managed-database.type"
	minimumDatabaseBytes   = 64 * 1024 * 1024
	minimumClickHouseBytes = 512 * 1024 * 1024
	// Keep the daemon's bounded lifecycle operation and rollback shorter than
	// the controller-side command timeout. This prevents an operation from
	// continuing after the Gateway has already declared it failed.
	managedDatabaseCommandTimeout    = 13 * time.Minute
	managedDatabaseCleanupTimeout    = time.Minute
	managedDatabaseReadinessTimeout  = 90 * time.Second
	managedDatabaseReadinessInterval = 500 * time.Millisecond
)

const clickHouseRuntimeProfileVersion = 3

const clickHouseOwnerOverrideContainerPath = "/etc/clickhouse-server/users.d/zz-gateway-owner.xml"

// ClickHouse's upstream defaults are sized for dedicated analytics servers:
// they create large background pools and several MergeTree-backed system log
// tables. In a small managed container those logs can continuously merge until
// they consume the whole cgroup allowance, starving both user traffic and the
// monitoring queries. Keep the managed baseline intentionally small; a user's
// later gateway-managed.xml may still override these defaults when needed.
const clickHouseRuntimeConfig = `<clickhouse>
    <logger replace="replace">
        <level>warning</level>
        <console>1</console>
    </logger>
    <max_server_memory_usage_to_ram_ratio>0.75</max_server_memory_usage_to_ram_ratio>
    <background_buffer_flush_schedule_pool_size>2</background_buffer_flush_schedule_pool_size>
    <background_pool_size>16</background_pool_size>
    <background_move_pool_size>1</background_move_pool_size>
    <background_fetches_pool_size>1</background_fetches_pool_size>
    <background_common_pool_size>2</background_common_pool_size>
    <background_schedule_pool_size>8</background_schedule_pool_size>
    <background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>
    <background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
    <query_log remove="remove"/>
    <query_thread_log remove="remove"/>
    <query_views_log remove="remove"/>
    <query_metric_log remove="remove"/>
    <trace_log remove="remove"/>
    <instrumentation_trace_log remove="remove"/>
    <part_log remove="remove"/>
    <text_log remove="remove"/>
    <error_log remove="remove"/>
    <metric_log remove="remove"/>
    <asynchronous_metric_log remove="remove"/>
    <processors_profile_log remove="remove"/>
    <session_log remove="remove"/>
    <crash_log remove="remove"/>
    <background_schedule_pool_log remove="remove"/>
    <asynchronous_insert_log remove="remove"/>
    <backup_log remove="remove"/>
    <blob_storage_log remove="remove"/>
    <s3queue_log remove="remove"/>
    <opentelemetry_span_log remove="remove"/>
    <zookeeper_log remove="remove"/>
    <zookeeper_connection_log remove="remove"/>
    <aggregated_zookeeper_log remove="remove"/>
    <delta_lake_metadata_log remove="remove"/>
    <iceberg_metadata_log remove="remove"/>
</clickhouse>`

const clickHouseSystemLogCleanupSQL = `
TRUNCATE TABLE IF EXISTS system.query_log;
TRUNCATE TABLE IF EXISTS system.query_thread_log;
TRUNCATE TABLE IF EXISTS system.query_views_log;
TRUNCATE TABLE IF EXISTS system.query_metric_log;
TRUNCATE TABLE IF EXISTS system.trace_log;
TRUNCATE TABLE IF EXISTS system.instrumentation_trace_log;
TRUNCATE TABLE IF EXISTS system.part_log;
TRUNCATE TABLE IF EXISTS system.text_log;
TRUNCATE TABLE IF EXISTS system.error_log;
TRUNCATE TABLE IF EXISTS system.metric_log;
TRUNCATE TABLE IF EXISTS system.asynchronous_metric_log;
TRUNCATE TABLE IF EXISTS system.processors_profile_log;
TRUNCATE TABLE IF EXISTS system.session_log;
TRUNCATE TABLE IF EXISTS system.crash_log;
TRUNCATE TABLE IF EXISTS system.background_schedule_pool_log;
TRUNCATE TABLE IF EXISTS system.asynchronous_insert_log;
TRUNCATE TABLE IF EXISTS system.backup_log;
TRUNCATE TABLE IF EXISTS system.blob_storage_log;
TRUNCATE TABLE IF EXISTS system.s3queue_log;
TRUNCATE TABLE IF EXISTS system.opentelemetry_span_log;
TRUNCATE TABLE IF EXISTS system.zookeeper_log;
TRUNCATE TABLE IF EXISTS system.zookeeper_connection_log;
TRUNCATE TABLE IF EXISTS system.aggregated_zookeeper_log;
TRUNCATE TABLE IF EXISTS system.delta_lake_metadata_log;
TRUNCATE TABLE IF EXISTS system.iceberg_metadata_log;
`

var (
	managedDatabaseIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
	managedDatabaseName      = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)
	digestImagePattern       = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)
)

// managedDatabaseCommand is deliberately private to the database-profile
// daemon. It must never become a generic Docker container payload.
type managedDatabaseCommand struct {
	Type                string                 `json:"type"`
	Image               string                 `json:"image"`
	StorageSizeBytes    int64                  `json:"storageSizeBytes"`
	MemoryBytes         int64                  `json:"memoryBytes"`
	MemorySwapBytes     int64                  `json:"memorySwapBytes"`
	NanoCPUs            int64                  `json:"nanoCPUs"`
	CPUShares           int64                  `json:"cpuShares"`
	PidsLimit           int64                  `json:"pidsLimit"`
	OperationID         string                 `json:"operationId"`
	OwnerUsername       string                 `json:"ownerUsername"`
	OwnerPassword       string                 `json:"ownerPassword"`
	DatabaseName        string                 `json:"databaseName"`
	PublishTCP          bool                   `json:"publishTcp"`
	PublishNativeTCP    bool                   `json:"publishNativeTcp"`
	PublishedPort       uint16                 `json:"publishedPort"`
	PublishedNativePort uint16                 `json:"publishedNativePort"`
	TLSEnabled          bool                   `json:"tlsEnabled"`
	TLSCertificatePEM   string                 `json:"tlsCertificatePem"`
	TLSPrivateKeyPEM    string                 `json:"tlsPrivateKeyPem"`
	TLSCACertificatePEM string                 `json:"tlsCaCertificatePem"`
	TLSCertificateID    string                 `json:"tlsCertificateId"`
	ClickhouseConfig    string                 `json:"clickhouseConfigXml"`
	RedisConfig         *managedRedisConfig    `json:"redisConfig,omitempty"`
	PostgresConfig      *managedPostgresConfig `json:"postgresConfig,omitempty"`
	// Internal runtime preparation must not replace the durable lifecycle
	// operation ID used by controller reconciliation after a lost response.
	PreserveLifecycleOperationID bool `json:"preserveLifecycleOperationId,omitempty"`
	// Host ports other Gateway workloads on this node reserve. The node never
	// picks one of them for a published port the controller leaves to it
	// (PublishedPort or PublishedNativePort is 0): the port is free only while
	// that workload is stopped.
	ExcludedHostPorts []uint16 `json:"excludedHostPorts,omitempty"`
}

type managedRedisConfig struct {
	MaxmemoryPercent             int    `json:"maxmemoryPercent"`
	MaxmemoryPolicy              string `json:"maxmemoryPolicy"`
	AppendOnly                   bool   `json:"appendOnly"`
	AppendFsync                  string `json:"appendFsync"`
	RDBSnapshotsEnabled          bool   `json:"rdbSnapshotsEnabled"`
	RDBSaveSeconds               int    `json:"rdbSaveSeconds"`
	RDBSaveChanges               int    `json:"rdbSaveChanges"`
	AutoAOFRewritePercentage     int    `json:"autoAofRewritePercentage"`
	AutoAOFRewriteMinSizeMB      int    `json:"autoAofRewriteMinSizeMb"`
	MaxClients                   int    `json:"maxclients"`
	TimeoutSeconds               int    `json:"timeoutSeconds"`
	TCPKeepaliveSeconds          int    `json:"tcpKeepaliveSeconds"`
	SlowlogThresholdMicroseconds int64  `json:"slowlogThresholdMicroseconds"`
	SlowlogMaxLen                int    `json:"slowlogMaxLen"`
	ActiveDefrag                 bool   `json:"activeDefrag"`
}

// managedPostgresConfig holds the PostgreSQL server settings Gateway exposes.
// A zero value keeps the engine default (max_connections 100).
type managedPostgresConfig struct {
	MaxConnections int `json:"maxConnections"`
}

// managedDatabaseBindingCommand is intentionally separate from the instance
// lifecycle payload. It carries a short-lived command to create or revoke one
// engine-level account; credentials are never persisted by the database node.
type managedDatabaseBindingCommand struct {
	BindingID     string `json:"bindingId"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	DatabaseName  string `json:"databaseName"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
}

// managedDatabasePrincipalV2Command is the fail-closed identity-v2 contract.
// Principal and application-role names are persisted by Gateway before this
// command is dispatched, so retries converge the same engine identities.
type managedDatabasePrincipalV2Command struct {
	OperationID              string `json:"operationId"`
	PrincipalName            string `json:"principalName"`
	Password                 string `json:"password"`
	DatabaseName             string `json:"databaseName"`
	ApplicationPrincipalName string `json:"applicationPrincipalName"`
	OwnerUsername            string `json:"ownerUsername"`
	OwnerPassword            string `json:"ownerPassword"`
}

type managedDatabaseOwnerSeparationCommand struct {
	OperationID              string `json:"operationId"`
	DatabaseName             string `json:"databaseName"`
	ApplicationPrincipalName string `json:"applicationPrincipalName"`
	CurrentOwnerUsername     string `json:"currentOwnerUsername"`
	CurrentOwnerPassword     string `json:"currentOwnerPassword"`
	PendingOwnerUsername     string `json:"pendingOwnerUsername"`
	PendingOwnerPassword     string `json:"pendingOwnerPassword"`
}

// clickHousePrincipalCommand is a versioned, ClickHouse-only principal
// contract. It must not be folded into binding_create: old daemons ignore
// unknown JSON fields on that action and could recreate the legacy grant set.
type clickHousePrincipalCommand struct {
	PrincipalType string `json:"principalType"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	DatabaseName  string `json:"databaseName"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
}

type managedDatabaseOperationCommand struct {
	OperationID string `json:"operationId"`
}

// managedDatabaseRecord is enough to remount a fixed-size image before a
// database container is started after a daemon or host restart. It contains
// neither owner credentials nor arbitrary configuration.
type managedDatabaseRecord struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	ContainerID          string `json:"containerId"`
	ContainerName        string `json:"containerName"`
	NetworkName          string `json:"networkName"`
	ImagePath            string `json:"imagePath"`
	MountPath            string `json:"mountPath"`
	LoopDevice           string `json:"loopDevice,omitempty"`
	StorageSize          int64  `json:"storageSizeBytes"`
	DesiredRunning       bool   `json:"desiredRunning"`
	PublishedPort        uint16 `json:"publishedPort,omitempty"`
	PublishedNativePort  uint16 `json:"publishedNativePort,omitempty"`
	TLSEnabled           bool   `json:"tlsEnabled"`
	TLSCertificateID     string `json:"tlsCertificateId,omitempty"`
	ClickhouseConfigHash string `json:"clickhouseConfigHash,omitempty"`
	RedisConfigHash      string `json:"redisConfigHash,omitempty"`
	// PostgresMaxConnections is the max_connections the container was started
	// with; 0 is the engine default.
	PostgresMaxConnections          int    `json:"postgresMaxConnections,omitempty"`
	ClickhouseRuntimeProfileVersion int    `json:"clickhouseRuntimeProfileVersion,omitempty"`
	OperationID                     string `json:"operationId"`
	// Deleting is set before a delete tears anything down. An instance whose
	// delete could not finish is never remounted; the repair pass and a
	// repeated delete complete it.
	Deleting bool `json:"deleting,omitempty"`
	// DiskRepair is the last repair of the image's filesystem after it went
	// read-only (see managed_disk_repair.go).
	DiskRepair *managedDiskRepair `json:"diskRepair,omitempty"`
	// AvailabilitySetID and AvailabilityMemberID: this database is this node's
	// member of an availability set. The member runtime starts, stops,
	// promotes and fences it; lifecycle commands change it live only.
	AvailabilitySetID    string `json:"availabilitySetId,omitempty"`
	AvailabilityMemberID string `json:"availabilityMemberId,omitempty"`
	// AvailabilityLiftedFrom is the member this single-node database was
	// lifted from (close or detach), so a repeated lift answers ready.
	AvailabilityLiftedFrom string `json:"availabilityLiftedFrom,omitempty"`
}

// managedDatabaseRuntimeStats is intentionally a narrow managed-database
// payload. It reuses Docker's live container accounting without exposing the
// generic container stats surface to a databases node.
type managedDatabaseRuntimeStats struct {
	Status           string  `json:"status"`
	CPUPercent       float64 `json:"cpuPercent,omitempty"`
	MemoryUsageBytes int64   `json:"memoryUsageBytes,omitempty"`
	MemoryLimitBytes int64   `json:"memoryLimitBytes,omitempty"`
	SwapUsageBytes   int64   `json:"swapUsageBytes,omitempty"`
	SwapLimitBytes   int64   `json:"swapLimitBytes,omitempty"`
	Pids             int64   `json:"pids,omitempty"`
}

type managedDatabaseManager struct {
	cfg     *config.Config
	client  *Client
	logger  *slog.Logger
	root    string
	reserve int64
	// dialTargets answers relay dials while dockerd does not (B-26).
	dialTargets dialTargetLookups
	// probeServed overrides the served-certificate probe (tests).
	probeServed func(ctx context.Context, address, protocol string) (servedCertificate, error)
	mu          sync.Mutex
	// generations and tlsReloads let a certificate reload wait without mu
	// (see handleTLSReload); generations is guarded by mu.
	generations lifecycleGenerations
	tlsReloads  resourceLocks
	// loops overrides the kernel loop-device surface (tests).
	loops *loopHost
	// statFilesystem overrides statfs of the storage root (tests).
	statFilesystem func(string, *unix.Statfs_t) error
	// runFsck overrides e2fsck (tests).
	runFsck func(ctx context.Context, image string) (int, string, error)
	// repairs are the disk repairs running now; incidents the engine stops
	// nobody asked for.
	repairs   diskRepairs
	incidents *engineIncidents
	// pgSets connects Postgres availability set members to the member
	// runtime (managed_database_pg_commands.go).
	pgSets pgSetHooks
}

func newManagedDatabaseManager(cfg *config.Config, client *Client, logger *slog.Logger) (*managedDatabaseManager, error) {
	root := filepath.Clean(cfg.Docker.Database.StorageRoot)
	if !filepath.IsAbs(root) || root == "/" {
		return nil, fmt.Errorf("database storage root must be an absolute non-root path")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create database storage root: %w", err)
	}
	for _, dir := range []string{"images", "mounts", "records", "tls"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, fmt.Errorf("create database storage directory: %w", err)
		}
	}
	reserve := cfg.Docker.Database.ReserveBytes
	if reserve < 0 {
		return nil, fmt.Errorf("database reserve bytes cannot be negative")
	}
	return &managedDatabaseManager{cfg: cfg, client: client, logger: logger, root: root, reserve: reserve, incidents: newEngineIncidents()}, nil
}

func (p *DockerPlugin) handleManagedDatabaseCommand(cmd *pb.DockerDatabaseCommand, result *pb.CommandResult) {
	if p.databaseManager == nil {
		result.Success = false
		result.Error = "managed database storage is not initialized"
		return
	}
	if cmd.Action == "logs" || cmd.Action == "logs_stop" {
		ctx, cancel := context.WithTimeout(context.Background(), dockerLogsCommandTimeout)
		defer cancel()
		containerID, err := p.databaseManager.resolveOwnedContainer(ctx, cmd.ManagedDatabaseId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		if cmd.Action == "logs_stop" {
			p.logStreamMu.Lock()
			stop := p.logStreamCancel[containerID]
			delete(p.logStreamCancel, containerID)
			p.logStreamMu.Unlock()
			if stop != nil {
				stop()
			}
			result.Detail = `{"streaming":false}`
			return
		}
		var input struct {
			TailLines  int32  `json:"tailLines"`
			Follow     bool   `json:"follow"`
			Timestamps bool   `json:"timestamps"`
			Since      string `json:"since"`
			Until      string `json:"until"`
		}
		if err := json.Unmarshal([]byte(cmd.ConfigJson), &input); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse managed database logs config: %v", err)
			return
		}
		p.handleLogsCommand(&pb.DockerLogsCommand{
			ContainerId: containerID,
			TailLines:   input.TailLines,
			Follow:      input.Follow,
			Timestamps:  input.Timestamps,
			Since:       input.Since,
			Until:       input.Until,
		}, result)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), managedDatabaseCommandTimeout)
	defer cancel()
	detail, err := p.databaseManager.handle(ctx, cmd.Action, cmd.ManagedDatabaseId, cmd.ConfigJson)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}

// resolveOwnedContainer keeps the database-profile daemon from becoming a
// generic Docker log reader: only the container recorded for this managed
// database and carrying the matching ownership label may be inspected.
func (m *managedDatabaseManager) resolveOwnedContainer(ctx context.Context, id string) (string, error) {
	if !managedDatabaseIDPattern.MatchString(id) {
		return "", errors.New("invalid managed database id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedDatabaseLabel] != id {
		return "", errors.New("managed database container ownership mismatch")
	}
	return record.ContainerID, nil
}

func (m *managedDatabaseManager) handle(ctx context.Context, action, id, configJSON string) (string, error) {
	if action == "leftovers" {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.leftovers(ctx)
	}
	if !managedDatabaseIDPattern.MatchString(id) {
		return "", errors.New("invalid managed database id")
	}
	if handled, detail, err := m.pgSetHandle(ctx, action, id, configJSON); handled {
		return detail, err
	}
	// Certificate reloads wait for the engine without the manager lock, and so
	// does a stats sample: Docker answers it after a second CPU reading, about
	// two seconds, which would hold up every other command on the node.
	switch action {
	case "reload_tls":
		return m.handleTLSReload(ctx, id, configJSON)
	case "probe_tls":
		return m.handleTLSProbe(ctx, id)
	case "stats":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		return m.runtimeStats(ctx, record)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch action {
	case "create", "start", "restart", "update", "stop", "pause", "unpause", "remove":
		m.generations.bump(id)
	}

	switch action {
	case "create":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.create(ctx, id, input)
		if err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "start":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.diskBlocksCommand(&record, true); err != nil {
			return "", err
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			return "", err
		}
		if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
			return "", runtimeFilesMissingError("managed database", missing)
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.DesiredRunning = true
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "restart":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if record.OperationID != input.OperationID {
			if err := m.diskBlocksCommand(&record, true); err != nil {
				return "", err
			}
		}
		if err := m.restart(ctx, &record, input); err != nil {
			return "", err
		}
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "update":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if record.OperationID != input.OperationID || input.PreserveLifecycleOperationID {
			if err := m.diskBlocksCommand(&record, false); err != nil {
				return "", err
			}
		}
		if err := m.update(ctx, &record, input); err != nil {
			return "", err
		}
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "stop":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if m.repairs.running(id) {
			return "", errDiskBeingRepaired("managed database")
		}
		if err := m.stopContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.DesiredRunning = false
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "stopped")
	case "pause", "unpause":
		var input managedDatabaseOperationCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database operation: %w", err)
		}
		if !managedDatabaseIDPattern.MatchString(input.OperationID) {
			return "", errors.New("managed database operation id is invalid")
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if m.repairs.running(id) {
			return "", errDiskBeingRepaired("managed database")
		}
		if action == "pause" {
			if err := m.pauseContainer(ctx, record.ContainerID); err != nil {
				return "", err
			}
		} else if err := m.unpauseContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.OperationID = input.OperationID
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		if action == "pause" {
			return marshalManagedDatabaseDetail(record, "paused")
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "remove":
		if isLeftoverRemove(configJSON) {
			// Gateway has no instance of the id (see managed_leftovers.go).
			if err := m.removeLeftover(ctx, id); err != nil {
				return "", err
			}
			return `{"status":"deleted"}`, nil
		}
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			// The prior remove may have completed while its response was lost,
			// or the node lost the record while the container and storage
			// stayed. Whatever is left of the id is removed, so control-plane
			// deletion stays safe to retry and leaves nothing behind.
			if err := m.removeLostRecord(ctx, id); err != nil {
				return "", err
			}
			return `{"status":"deleted"}`, nil
		}
		if err != nil {
			return "", err
		}
		if err := m.remove(ctx, record); err != nil {
			return "", err
		}
		return `{"status":"deleted"}`, nil
	case "inspect":
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			return m.missingRecordDetail(ctx, id)
		}
		if err != nil {
			return "", err
		}
		return m.inspectDetail(ctx, record)
	case "clickhouse_principal_apply_v1":
		var input clickHousePrincipalCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse ClickHouse principal config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateClickHousePrincipalInput(input); err != nil {
			return "", err
		}
		if err := m.applyClickHousePrincipal(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "postgres_query_principal_apply_v1":
		var input postgresQueryPrincipalCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse PostgreSQL query principal config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validatePostgresQueryPrincipalInput(input); err != nil {
			return "", err
		}
		if err := m.applyPostgresQueryPrincipal(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "postgres_query_writer_apply_v1":
		var input postgresQueryWriterCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse PostgreSQL query writer config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validatePostgresQueryWriterInput(input); err != nil {
			return "", err
		}
		if err := m.applyPostgresQueryWriter(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "binding_principal_apply_v2", "binding_principal_probe_v2", "binding_principal_drop_v2":
		var input managedDatabasePrincipalV2Command
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database principal v2 config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateManagedDatabasePrincipalV2Input(input); err != nil {
			return "", err
		}
		switch action {
		case "binding_principal_apply_v2":
			err = m.applyBindingPrincipalV2(ctx, record, input)
		case "binding_principal_probe_v2":
			err = m.probeBindingPrincipalV2(ctx, record, input)
		default:
			err = m.dropBindingPrincipalV2(ctx, record, input)
		}
		if err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "owner_separation_prepare_v1", "owner_separation_finalize_v1":
		var input managedDatabaseOwnerSeparationCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database owner separation config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateManagedDatabaseOwnerSeparationInput(input); err != nil {
			return "", err
		}
		if action == "owner_separation_prepare_v1" {
			err = m.prepareOwnerSeparation(ctx, record, input)
		} else {
			err = m.finalizeOwnerSeparation(ctx, record, input)
		}
		if err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "binding_create", "binding_remove", "binding_remove_v2":
		var input managedDatabaseBindingCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database binding config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateManagedDatabaseBindingInput(input); err != nil {
			return "", err
		}
		if action == "binding_create" {
			if err := m.createBindingPrincipal(ctx, record, input); err != nil {
				return "", err
			}
		} else if err := m.removeBindingPrincipal(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	default:
		return "", fmt.Errorf("unsupported managed database action: %s", action)
	}
}

func managedDatabaseContainerStatus(state *container.State) string {
	if state == nil || !state.Running {
		return "stopped"
	}
	if state.Paused {
		return "paused"
	}
	return "ready"
}
