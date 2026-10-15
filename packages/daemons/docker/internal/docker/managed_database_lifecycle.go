package docker

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func (m *managedDatabaseManager) runManagedDatabaseExec(ctx context.Context, containerID string, command []string, stdin string, env []string) error {
	return m.runManagedDatabaseExecTo(ctx, containerID, command, stdin, env, io.Discard)
}

// runManagedDatabaseExecTo runs an engine client command and writes what it
// prints to output, also when the command fails.
func (m *managedDatabaseManager) runManagedDatabaseExecTo(ctx context.Context, containerID string, command []string, stdin string, env []string, output io.Writer) error {
	created, err := m.client.cli.ExecCreate(ctx, containerID, mobyclient.ExecCreateOptions{
		Cmd: command, Env: env, AttachStdin: stdin != "", AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return errors.New("managed database engine command could not start")
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return errors.New("managed database engine command could not attach")
	}
	defer attached.Close()
	if stdin != "" {
		if _, err := io.WriteString(attached.Conn, stdin); err != nil {
			return errors.New("managed database engine command could not receive input")
		}
		if err := attached.CloseWrite(); err != nil {
			return errors.New("managed database engine command could not close input")
		}
	}
	_, _ = stdcopy.StdCopy(output, output, attached.Reader)
	inspect, err := m.client.cli.ExecInspect(ctx, created.ID, mobyclient.ExecInspectOptions{})
	if err != nil || inspect.ExitCode != 0 {
		return errors.New("managed database engine command failed")
	}
	return nil
}

func (m *managedDatabaseManager) update(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := validateManagedDatabaseInput(input); err != nil {
		return err
	}
	if input.Type != record.Type {
		return errors.New("managed database engine cannot be changed")
	}
	if record.OperationID == input.OperationID && !input.PreserveLifecycleOperationID {
		return nil
	}
	keepAssignedHostPorts(*record, &input)
	if input.StorageSizeBytes < record.StorageSize {
		return errors.New("managed database storage cannot be reduced")
	}
	if err := m.ensureStorageSize(ctx, record, input.StorageSizeBytes); err != nil {
		return err
	}
	if _, err := m.restageRuntimeFiles(*record, &input); err != nil {
		return err
	}
	if input.Type == "redis" {
		runsValkey, exists, err := m.managedRedisContainerRunsValkey(ctx, record.ContainerID)
		if err != nil {
			return fmt.Errorf("inspect managed database container: %w", err)
		}
		switch wantsValkey := managedRedisRunsValkey(input.Image); {
		case exists && !runsValkey && wantsValkey:
			if err := m.moveRedisToValkey(ctx, record, input); err != nil {
				return err
			}
			applyManagedDatabaseOperationID(record, input)
			return nil
		case exists && runsValkey && !wantsValkey:
			return errors.New("the key-value store runs Valkey and cannot go back to Redis")
		}
	}
	if record.clickHouseAvailabilityMember() && input.ClickhouseAvailability != nil &&
		clickHouseAvailabilitySetID(input) == record.ClickhouseAvailabilitySetID {
		// A ClickHouse member that stays one: the member update rule.
		return m.updateClickHouseMember(ctx, record, input)
	}
	// A newer engine image (a version change) recreates the container on it
	// with the data kept; Postgres only within its major version.
	imageChanged, err := m.containerImageChanged(ctx, *record, input)
	if err != nil {
		return err
	}
	if imageChanged {
		if err := m.checkPostgresMajor(ctx, *record, input); err != nil {
			return err
		}
	}
	requiresRecreate := managedDatabaseRequiresRecreate(*record, input)
	// Redis derives maxmemory from the memory limit; a running Redis applies a
	// new one without a restart, like the limit itself.
	currentMaxmemory, liveMaxmemory := int64(0), false
	if requiresRecreate && !managedDatabaseContainerSettingsChanged(*record, input) {
		currentMaxmemory, liveMaxmemory = m.redisMaxmemoryOnlyChange(*record, input)
		requiresRecreate = !liveMaxmemory
	}
	if !requiresRecreate {
		var err error
		requiresRecreate, err = m.publicationNeedsPinning(ctx, *record, input)
		if err != nil {
			return err
		}
	}
	requiresRecreate = requiresRecreate || imageChanged
	if requiresRecreate {
		if err := m.recreateClickHouseAware(ctx, record, input); err != nil {
			return err
		}
	} else {
		// A lower maxmemory is applied before the lower memory limit, a higher
		// one after the higher limit, so Redis never plans for memory its
		// container does not have.
		shrinking := liveMaxmemory && managedRedisMaxmemory(input) < currentMaxmemory
		if shrinking {
			if err := m.applyRedisMaxmemory(ctx, *record, input); err != nil {
				return err
			}
		}
		if err := m.client.LiveUpdateContainer(ctx, record.ContainerID, managedDatabaseRuntimeJSON(input)); err != nil {
			return err
		}
		if liveMaxmemory && !shrinking {
			if err := m.applyRedisMaxmemory(ctx, *record, input); err != nil {
				return err
			}
		}
		// A renewed certificate is loaded by the running engine (see
		// reloadTLS) instead of recreating the container; a restart is the
		// fallback only when the engine does not serve it.
		if input.TLSEnabled && record.TLSEnabled && input.TLSCertificateID != record.TLSCertificateID {
			leaf, err := leafCertificateFingerprint(input.TLSCertificatePEM, input.TLSPrivateKeyPEM)
			if err != nil {
				return err
			}
			if _, err := m.reloadTLS(ctx, record, input, leaf, record.ClickhouseAvailabilitySetID == ""); err != nil {
				return fmt.Errorf("apply renewed managed database certificate: %w", err)
			}
		}
	}
	// Extension bundles: a recreate installed them before the new container;
	// a live update installs them now and links them into the running server.
	if err := m.settlePostgresExtensionBundles(ctx, record, input); err != nil {
		return err
	}
	applyManagedDatabaseOperationID(record, input)
	return nil
}

// keepAssignedHostPorts fills a published port the controller leaves to the
// node (0) with the port the node already publishes it on. A controller that
// has not stored the port yet (its create answer is still being settled) sends
// 0; picking a new port then would replace the container and move its clients
// to a port the controller does not know. A publication the node has no port
// for yet still gets one picked when the container is created.
func keepAssignedHostPorts(record managedDatabaseRecord, input *managedDatabaseCommand) {
	if input.PublishTCP && input.PublishedPort == 0 {
		input.PublishedPort = record.PublishedPort
	}
	if input.PublishNativeTCP && input.PublishedNativePort == 0 {
		input.PublishedNativePort = record.PublishedNativePort
	}
}

func applyManagedDatabaseOperationID(record *managedDatabaseRecord, input managedDatabaseCommand) {
	if input.PreserveLifecycleOperationID {
		return
	}
	record.OperationID = input.OperationID
}

func clickHouseConfigHash(value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", digest)
}

// PostgreSQL max_connections bounds. Every connection is a server process, so a
// container process limit must leave room for the background processes too.
const (
	managedPostgresMinConnections      = 20
	managedPostgresMaxConnectionsLimit = 10000
	managedPostgresProcessHeadroom     = 32
)

// managedPostgresMaxConnections is the max_connections a PostgreSQL container
// starts with, or 0 for the engine default.
func managedPostgresMaxConnections(input managedDatabaseCommand) int {
	if input.Type != "postgres" || input.PostgresConfig == nil {
		return 0
	}
	return input.PostgresConfig.MaxConnections
}

func defaultManagedRedisConfig() managedRedisConfig {
	return managedRedisConfig{
		MaxmemoryPercent: 75, MaxmemoryPolicy: "noeviction", AppendOnly: true, AppendFsync: "everysec",
		RDBSnapshotsEnabled: true, RDBSaveSeconds: 3600, RDBSaveChanges: 1,
		AutoAOFRewritePercentage: 100, AutoAOFRewriteMinSizeMB: 64, MaxClients: 10000,
		TimeoutSeconds: 0, TCPKeepaliveSeconds: 300, SlowlogThresholdMicroseconds: 10000,
		SlowlogMaxLen: 128, ActiveDefrag: false,
	}
}

func normalizedManagedRedisConfig(input managedDatabaseCommand) managedRedisConfig {
	if input.RedisConfig == nil {
		return defaultManagedRedisConfig()
	}
	return *input.RedisConfig
}

func managedRedisConfigText(input managedDatabaseCommand) string {
	config := normalizedManagedRedisConfig(input)
	yesNo := func(value bool) string {
		if value {
			return "yes"
		}
		return "no"
	}
	save := `save ""`
	if config.RDBSnapshotsEnabled {
		save = fmt.Sprintf("save %d %d", config.RDBSaveSeconds, config.RDBSaveChanges)
	}
	modules := ""
	if managedRedisRunsValkey(input.Image) {
		modules = managedValkeyModuleConfig()
	}
	return fmt.Sprintf("aclfile /data/users.acl\nmaxmemory %d\nmaxmemory-policy %s\nappendonly %s\nappendfsync %s\naof-use-rdb-preamble yes\nauto-aof-rewrite-percentage %d\nauto-aof-rewrite-min-size %dmb\n%s\nmaxclients %d\ntimeout %d\ntcp-keepalive %d\nslowlog-log-slower-than %d\nslowlog-max-len %d\nactivedefrag %s\n%s",
		managedRedisMaxmemory(input),
		config.MaxmemoryPolicy,
		yesNo(config.AppendOnly),
		config.AppendFsync,
		config.AutoAOFRewritePercentage,
		config.AutoAOFRewriteMinSizeMB,
		save,
		config.MaxClients,
		config.TimeoutSeconds,
		config.TCPKeepaliveSeconds,
		config.SlowlogThresholdMicroseconds,
		config.SlowlogMaxLen,
		yesNo(config.ActiveDefrag),
		modules,
	)
}

func managedRedisMaxmemory(input managedDatabaseCommand) int64 {
	return input.MemoryBytes * int64(normalizedManagedRedisConfig(input).MaxmemoryPercent) / 100
}

// cutRedisMaxmemory splits a managed Redis config into its maxmemory value
// and the rest of the file.
func cutRedisMaxmemory(text string) (int64, string, bool) {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		value, ok := strings.CutPrefix(line, "maxmemory ")
		if !ok {
			continue
		}
		bytes, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return 0, "", false
		}
		return bytes, strings.Join(append(lines[:i:i], lines[i+1:]...), "\n"), true
	}
	return 0, "", false
}

// managedRedisBoundConfigPath is the config file the container was created
// with; a live maxmemory change rewrites it under that name.
func managedRedisBoundConfigPath(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, "gateway-redis-"+record.RedisConfigHash+".conf")
}

// redisMaxmemoryOnlyChange reports whether the config file the container
// reads differs from the requested config only in maxmemory, and the current
// value.
func (m *managedDatabaseManager) redisMaxmemoryOnlyChange(record managedDatabaseRecord, input managedDatabaseCommand) (int64, bool) {
	if record.Type != "redis" || record.RedisConfigHash == "" {
		return 0, false
	}
	raw, err := os.ReadFile(managedRedisBoundConfigPath(record))
	if err != nil {
		return 0, false
	}
	current, rest, ok := cutRedisMaxmemory(string(raw))
	if !ok {
		return 0, false
	}
	_, wanted, ok := cutRedisMaxmemory(managedRedisConfigText(input))
	return current, ok && rest == wanted
}

// applyRedisMaxmemory sets maxmemory on a running Redis and writes it to the
// bound config file for the next start. The file is rewritten in place: the
// container sees it through a bind mount of that very file.
func (m *managedDatabaseManager) applyRedisMaxmemory(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		if err := m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"redis-cli", "--no-auth-warning", "--user", "default", "CONFIG", "SET", "maxmemory", strconv.FormatInt(managedRedisMaxmemory(input), 10)},
			"",
			[]string{"REDISCLI_AUTH=" + input.OwnerPassword},
		); err != nil {
			return fmt.Errorf("apply Redis maxmemory: %w", err)
		}
	}
	if err := writeManagedRedisConfig(managedRedisBoundConfigPath(record), managedRedisConfigText(input)); err != nil {
		return fmt.Errorf("write Redis managed config: %w", err)
	}
	return nil
}

func managedRedisConfigHash(input managedDatabaseCommand) string {
	if input.Type != "redis" {
		return ""
	}
	digest := sha256.Sum256([]byte(managedRedisConfigText(input)))
	return fmt.Sprintf("%x", digest)
}

func managedRedisConfigPath(record managedDatabaseRecord, input managedDatabaseCommand) string {
	return filepath.Join(record.MountPath, "gateway-redis-"+managedRedisConfigHash(input)+".conf")
}

func clickHouseOwnerOverridePath(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, filepath.Base(clickHouseOwnerOverrideContainerPath))
}

func clickHouseOwnerOverrideConfig(username, password string) string {
	var escapedPassword strings.Builder
	_ = xml.EscapeText(&escapedPassword, []byte(password))
	return fmt.Sprintf(
		"<clickhouse><users><%s><profile>default</profile><networks><ip>::/0</ip></networks><password replace=\"replace\">%s</password><quota>default</quota><access_management>1</access_management></%s></users></clickhouse>\n",
		username,
		escapedPassword.String(),
		username,
	)
}

func writeClickHouseOwnerOverride(path, config string) error {
	if err := os.WriteFile(path, []byte(config), 0644); err != nil {
		return err
	}
	return os.Chmod(path, 0644)
}

// managedDatabaseRequiresRecreate reports settings fixed at container
// creation. A changed TLS certificate is not one of them: update applies it
// to the running engine through reloadTLS.
func managedDatabaseRequiresRecreate(record managedDatabaseRecord, input managedDatabaseCommand) bool {
	return managedDatabaseContainerSettingsChanged(record, input) ||
		(record.Type == "redis" && managedRedisConfigHash(input) != record.RedisConfigHash)
}

// managedDatabaseContainerSettingsChanged reports the settings fixed at
// container creation other than the Redis config file.
func managedDatabaseContainerSettingsChanged(record managedDatabaseRecord, input managedDatabaseCommand) bool {
	return input.PublishedPort != record.PublishedPort ||
		(record.Type == "postgres" && managedPostgresMaxConnections(input) != record.PostgresMaxConnections) ||
		(record.Type == "postgres" && managedPostgresPreloadKey(input) != record.PostgresPreloadLibraries) ||
		input.PublishedNativePort != record.PublishedNativePort ||
		(input.PublishNativeTCP != (record.PublishedNativePort != 0)) ||
		input.TLSEnabled != record.TLSEnabled ||
		(input.PublishTCP != (record.PublishedPort != 0)) ||
		(record.Type == "clickhouse" && (clickHouseConfigHash(input.ClickhouseConfig) != record.ClickhouseConfigHash ||
			record.ClickhouseRuntimeProfileVersion != clickHouseRuntimeProfileVersion)) ||
		clickHouseAvailabilityChanged(record, input)
}

func portBindingNeedsPinning(bindings network.PortMap, containerPort network.Port, expected uint16) bool {
	values := bindings[containerPort]
	if len(values) != 1 || values[0].HostPort == "" {
		return true
	}
	return expected != 0 && values[0].HostPort != strconv.FormatUint(uint64(expected), 10)
}

func (m *managedDatabaseManager) publicationNeedsPinning(
	ctx context.Context,
	record managedDatabaseRecord,
	input managedDatabaseCommand,
) (bool, error) {
	if !input.PublishTCP || (record.clickHouseAvailabilityMember() && clickHouseAvailabilitySetID(input) != "") {
		// A set member's published ports are its member proxy's.
		return false, nil
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return false, fmt.Errorf("inspect managed database publication: %w", err)
	}
	if inspect.Container.HostConfig == nil {
		return false, errors.New("managed database publication has no host configuration")
	}
	_, port := engineDataPathAndPort(input.Type, input.TLSEnabled)
	primaryPort, err := network.ParsePort(port)
	if err != nil {
		return false, fmt.Errorf("parse managed database publication port: %w", err)
	}
	if portBindingNeedsPinning(inspect.Container.HostConfig.PortBindings, primaryPort, input.PublishedPort) {
		return true, nil
	}
	if input.Type == "clickhouse" && input.PublishNativeTCP {
		nativePort, err := network.ParsePort(clickHouseNativePort(input.TLSEnabled))
		if err != nil {
			return false, fmt.Errorf("parse ClickHouse native publication port: %w", err)
		}
		if portBindingNeedsPinning(inspect.Container.HostConfig.PortBindings, nativePort, input.PublishedNativePort) {
			return true, nil
		}
	}
	return false, nil
}

func (m *managedDatabaseManager) restart(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := validateManagedDatabaseInput(input); err != nil {
		return err
	}
	if input.Type != record.Type {
		return errors.New("managed database engine cannot be changed")
	}
	if record.OperationID == input.OperationID {
		return nil
	}
	keepAssignedHostPorts(*record, &input)
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	if missing, err := m.restageRuntimeFiles(*record, &input); err != nil {
		return err
	} else if len(missing) > 0 {
		return runtimeFilesMissingError("managed database", missing)
	}
	needsPinning, err := m.publicationNeedsPinning(ctx, *record, input)
	if err != nil {
		return err
	}
	if needsPinning {
		if input.Type == "redis" {
			runsValkey, exists, err := m.managedRedisContainerRunsValkey(ctx, record.ContainerID)
			if err != nil {
				return fmt.Errorf("inspect managed database container: %w", err)
			}
			if exists && runsValkey != managedRedisRunsValkey(input.Image) {
				return errors.New("a restart cannot change the engine of the key-value store")
			}
		}
		if err := m.recreateContainer(ctx, record, input); err != nil {
			return err
		}
		record.OperationID = input.OperationID
		return nil
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		if err := m.client.RestartContainer(ctx, record.ContainerID, 30); err != nil {
			return fmt.Errorf("restart managed database container: %w", err)
		}
	} else if err := m.startContainer(ctx, record.ContainerID); err != nil {
		return err
	}
	if err := m.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
		return err
	}
	record.DesiredRunning = true
	record.OperationID = input.OperationID
	return nil
}

// recreateContainer applies the only Docker setting that cannot be changed
// live (port bindings) while deliberately retaining the mounted managed data
// image and its isolated network.
func (m *managedDatabaseManager) recreateContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	previous := *record
	migratingLegacyRedisACL := record.Type == "redis" && record.RedisConfigHash == "" && managedRedisConfigHash(input) != ""
	if migratingLegacyRedisACL {
		if err := m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"sh", "-ec", redisACLFileSnapshotCommand()},
			"",
			[]string{"REDISCLI_AUTH=" + input.OwnerPassword},
		); err != nil {
			return fmt.Errorf("snapshot legacy Redis ACLs: %w", err)
		}
	}
	rollbackName := previous.ContainerName + "-rollback"
	previousRenamed := false
	if record.ContainerID != "" {
		if err := m.stopContainer(ctx, record.ContainerID); err != nil {
			return err
		}
		if err := m.client.RenameContainer(ctx, record.ContainerID, rollbackName); err != nil {
			return fmt.Errorf("preserve managed database container for publication change: %w", err)
		}
		previousRenamed = true
	}
	rollback := func() {
		*record = previous
		if !previousRenamed {
			return
		}
		rollbackCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		if err := m.client.RenameContainer(rollbackCtx, previous.ContainerID, previous.ContainerName); err != nil {
			m.logger.Error("restore managed database container name after recreate failure", "id", previous.ID, "error", err)
			return
		}
		if err := m.startContainer(rollbackCtx, previous.ContainerID); err != nil {
			m.logger.Error("restart managed database after recreate failure", "id", previous.ID, "error", err)
			return
		}
		if migratingLegacyRedisACL {
			if err := m.runManagedDatabaseExec(
				rollbackCtx,
				previous.ContainerID,
				[]string{"sh", "-ec", redisACLFileRestoreCommand()},
				"",
				[]string{"REDISCLI_AUTH=" + input.OwnerPassword},
			); err != nil {
				m.logger.Error("restore legacy Redis ACLs after recreate failure", "id", previous.ID, "error", err)
			}
		}
	}
	// A disabled publication must not inherit the previous host binding from
	// the record; a port left to the node arrives here as the one it already
	// publishes (see keepAssignedHostPorts), or 0 when it has none.
	record.ContainerID = ""
	record.PublishedPort = input.PublishedPort
	record.PublishedNativePort = input.PublishedNativePort
	record.TLSEnabled = input.TLSEnabled
	record.TLSCertificateID = input.TLSCertificateID
	record.ClickhouseConfigHash = clickHouseConfigHash(input.ClickhouseConfig)
	record.RedisConfigHash = managedRedisConfigHash(input)
	record.PostgresMaxConnections = managedPostgresMaxConnections(input)
	record.PostgresPreloadLibraries = managedPostgresPreloadKey(input)
	if input.Type == "clickhouse" {
		record.ClickhouseRuntimeProfileVersion = clickHouseRuntimeProfileVersion
	}
	containerID, err := m.createContainer(ctx, record, input)
	if err != nil {
		rollback()
		return err
	}
	record.ContainerID = containerID
	record.DesiredRunning = true
	if previousRenamed {
		if err := m.client.RemoveContainer(ctx, previous.ContainerID, true); err != nil && !cerrdefs.IsNotFound(err) {
			m.logger.Warn("remove preserved managed database container after recreate", "id", previous.ID, "error", err)
		}
	}
	if record.Type == "redis" && previous.RedisConfigHash != "" && previous.RedisConfigHash != record.RedisConfigHash {
		previousConfigPath := filepath.Join(record.MountPath, "gateway-redis-"+previous.RedisConfigHash+".conf")
		if err := os.Remove(previousConfigPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			m.logger.Warn("remove superseded managed Redis config", "id", previous.ID, "error", err)
		}
	}
	return nil
}

func managedDatabaseRuntimeJSON(input managedDatabaseCommand) string {
	value, _ := json.Marshal(map[string]int64{
		"memoryLimit": input.MemoryBytes,
		"memorySwap":  input.MemorySwapBytes,
		"nanoCPUs":    input.NanoCPUs,
		"cpuShares":   input.CPUShares,
		"pidsLimit":   input.PidsLimit,
	})
	return string(value)
}

func (m *managedDatabaseManager) create(ctx context.Context, id string, input managedDatabaseCommand) (managedDatabaseRecord, error) {
	if err := validateManagedDatabaseInput(input); err != nil {
		return managedDatabaseRecord{}, err
	}
	if existing, err := m.loadRecord(id); err == nil {
		// A response can be lost after the record is written. Treat a repeated
		// create for the same managed-database ID as recovery, rather than
		// allocating a second volume or leaving the control plane in error.
		if existing.Type != input.Type {
			return managedDatabaseRecord{}, errors.New("managed database engine cannot be changed")
		}
		if existing.OperationID != input.OperationID {
			return managedDatabaseRecord{}, errors.New("managed database operation conflicts with an existing instance")
		}
		if err := m.ensureMounted(ctx, &existing); err != nil {
			return managedDatabaseRecord{}, err
		}
		if missing, err := m.restageRuntimeFiles(existing, &input); err != nil {
			return managedDatabaseRecord{}, err
		} else if len(missing) > 0 {
			return managedDatabaseRecord{}, runtimeFilesMissingError("managed database", missing)
		}
		if err := m.startContainer(ctx, existing.ContainerID); err != nil {
			return managedDatabaseRecord{}, err
		}
		if err := m.waitForDatabaseReady(ctx, existing.ContainerID, input); err != nil {
			return managedDatabaseRecord{}, err
		}
		existing.DesiredRunning = true
		if err := m.saveRecord(existing); err != nil {
			return managedDatabaseRecord{}, err
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return managedDatabaseRecord{}, err
	}
	record := m.newRecord(id, input)
	// The instance's container outlived its record: its image holds the data.
	if containerID, prefix, err := m.ownedDatabaseContainer(ctx, id); err != nil {
		return managedDatabaseRecord{}, err
	} else if containerID != "" {
		// The instance keeps the names it has.
		record.ContainerName, record.NetworkName = prefix+id, prefix+id+"-net"
		return m.adoptLostRecord(ctx, record, containerID, input)
	}
	release, err := m.reserveCapacity(input.StorageSizeBytes)
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	defer release()

	// No record and no container exist, so anything at these paths is left
	// from a create that failed before (or from an older release) and is not
	// an instance's data.
	if err := m.cleanupStorage(ctx, &record, true); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.createImage(ctx, record); err != nil {
		return managedDatabaseRecord{}, err
	}
	created := false
	defer func() {
		if !created {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			if err := m.cleanupStorage(cleanupCtx, &record, true); err != nil {
				m.logger.Warn("failed managed database create left storage behind; the repair pass releases it", "id", record.ID, "error", err)
			}
		}
	}()
	if err := m.ensureMounted(ctx, &record); err != nil {
		return managedDatabaseRecord{}, err
	}
	if _, err := m.client.EnsureThirdPartyImage(ctx, input.Image); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.createNetwork(ctx, record.NetworkName); err != nil {
		return managedDatabaseRecord{}, err
	}
	// A set member's runtime sees the container while the create waits for it.
	m.pending.set(record)
	defer m.pending.clear(record.ID)
	containerID, err := m.createContainer(ctx, &record, input)
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	record.ContainerID = containerID
	if err := m.saveRecord(record); err != nil {
		_ = m.client.RemoveContainer(ctx, containerID, true)
		return managedDatabaseRecord{}, err
	}
	created = true
	return record, nil
}

func validateManagedDatabaseInput(input managedDatabaseCommand) error {
	if input.Type != "postgres" && input.Type != "redis" && input.Type != "clickhouse" {
		return errors.New("unsupported managed database type")
	}
	if input.ClickhouseAvailability != nil && input.Type != "clickhouse" {
		return errors.New("availability members of this command are supported only for ClickHouse")
	}
	if input.Type == "redis" && input.OwnerUsername != "default" {
		return errors.New("Redis owner username must be default")
	}
	if !managedDatabaseIDPattern.MatchString(input.OperationID) {
		return errors.New("managed database operation id is invalid")
	}
	if !isCuratedDigestImage(input.Type, input.Image) {
		return errors.New("managed database image must be a curated sha256-pinned engine image")
	}
	if input.StorageSizeBytes < minimumDatabaseBytes {
		return fmt.Errorf("database storage must be at least %d bytes", minimumDatabaseBytes)
	}
	if input.MemoryBytes < 0 || input.NanoCPUs < 0 || input.CPUShares < 0 || input.PidsLimit < 0 {
		return errors.New("runtime limits cannot be negative")
	}
	if input.Type == "clickhouse" && input.MemoryBytes < minimumClickHouseBytes {
		return fmt.Errorf("ClickHouse requires at least %d bytes of memory", minimumClickHouseBytes)
	}
	if input.MemorySwapBytes != 0 && input.MemorySwapBytes != -1 && input.MemorySwapBytes < input.MemoryBytes {
		return errors.New("memory swap limit must be unlimited or at least the memory limit")
	}
	if !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("database and owner names must be safe SQL identifiers")
	}
	if len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("managed database password must be between 16 and 512 characters")
	}
	if !input.PublishTCP && input.PublishedPort != 0 {
		return errors.New("host port is not allowed unless TCP publishing is enabled")
	}
	if !input.PublishTCP && input.PublishedNativePort != 0 {
		return errors.New("native host port is not allowed unless TCP publishing is enabled")
	}
	if input.PublishNativeTCP && (!input.PublishTCP || input.Type != "clickhouse") {
		return errors.New("native TCP publishing is supported only for published ClickHouse databases")
	}
	if !input.PublishNativeTCP && input.PublishedNativePort != 0 {
		return errors.New("native host port is not allowed unless native TCP publishing is enabled")
	}
	if input.Type != "clickhouse" && input.PublishedNativePort != 0 {
		return errors.New("native host port is supported only for ClickHouse")
	}
	if input.TLSEnabled {
		if input.TLSCertificatePEM == "" || input.TLSPrivateKeyPEM == "" || input.TLSCACertificatePEM == "" {
			return errors.New("managed database TLS material is required when TLS is enabled")
		}
		if !managedDatabaseIDPattern.MatchString(input.TLSCertificateID) {
			return errors.New("managed database TLS certificate id is invalid")
		}
		if _, err := tls.X509KeyPair([]byte(input.TLSCertificatePEM), []byte(input.TLSPrivateKeyPEM)); err != nil {
			return errors.New("managed database TLS certificate and key are invalid")
		}
	}
	if input.Type != "clickhouse" && input.ClickhouseConfig != "" {
		return errors.New("ClickHouse XML is supported only for ClickHouse")
	}
	if input.Type != "redis" && input.RedisConfig != nil {
		return errors.New("Redis configuration is supported only for Redis")
	}
	if input.Type != "postgres" && input.PostgresConfig != nil {
		return errors.New("PostgreSQL configuration is supported only for PostgreSQL")
	}
	if err := validatePostgresExtensionConfig(input); err != nil {
		return err
	}
	if maxConnections := managedPostgresMaxConnections(input); maxConnections != 0 {
		if maxConnections < managedPostgresMinConnections || maxConnections > managedPostgresMaxConnectionsLimit {
			return fmt.Errorf("PostgreSQL max_connections must be between %d and %d", managedPostgresMinConnections, managedPostgresMaxConnectionsLimit)
		}
		if input.PidsLimit > 0 && input.PidsLimit < int64(maxConnections+managedPostgresProcessHeadroom) {
			return fmt.Errorf("the process limit must allow max_connections plus %d PostgreSQL background processes", managedPostgresProcessHeadroom)
		}
	}
	if input.Type == "redis" {
		config := normalizedManagedRedisConfig(input)
		policies := map[string]struct{}{
			"noeviction": {}, "allkeys-lru": {}, "allkeys-lfu": {}, "allkeys-random": {},
			"volatile-lru": {}, "volatile-lfu": {}, "volatile-random": {}, "volatile-ttl": {},
		}
		if config.MaxmemoryPercent < 10 || config.MaxmemoryPercent > 95 {
			return errors.New("Redis maxmemory percent must be between 10 and 95")
		}
		if _, ok := policies[config.MaxmemoryPolicy]; !ok {
			return errors.New("Redis maxmemory policy is invalid")
		}
		if config.AppendFsync != "always" && config.AppendFsync != "everysec" && config.AppendFsync != "no" {
			return errors.New("Redis append fsync policy is invalid")
		}
		if config.RDBSaveSeconds < 1 || config.RDBSaveSeconds > 31536000 || config.RDBSaveChanges < 1 || config.RDBSaveChanges > 1000000000 {
			return errors.New("Redis snapshot settings are invalid")
		}
		if config.AutoAOFRewritePercentage < 0 || config.AutoAOFRewritePercentage > 10000 || config.AutoAOFRewriteMinSizeMB < 1 || config.AutoAOFRewriteMinSizeMB > 1048576 {
			return errors.New("Redis AOF rewrite settings are invalid")
		}
		if config.MaxClients < 1 || config.MaxClients > 1000000 || config.TimeoutSeconds < 0 || config.TimeoutSeconds > 31536000 || config.TCPKeepaliveSeconds < 0 || config.TCPKeepaliveSeconds > 31536000 {
			return errors.New("Redis connection settings are invalid")
		}
		if config.SlowlogThresholdMicroseconds < -1 || config.SlowlogThresholdMicroseconds > 2147483647 || config.SlowlogMaxLen < 0 || config.SlowlogMaxLen > 1000000 {
			return errors.New("Redis slow log settings are invalid")
		}
	}
	return validateClickHouseFragment(input.ClickhouseConfig)
}

// Curated images are digest-pinned in the controller catalog.
var curatedManagedDatabaseImages = map[string]map[string]struct{}{
	// PostgreSQL's are every catalog version's official image and, once
	// pinned, Opfield's image of it (pgext/catalog/versions.json).
	"postgres": curatedPostgresImages(),
	"redis": {
		"docker.io/valkey/valkey-bundle@sha256:dd30c59c2b2a598e83308095220a31d6d93d64c40a839c702cb1e98c8e220660": {},
		"docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236":        {},
		"docker.io/library/redis@sha256:c88d347edef6249a6d2293f926f1eeb48bd40c57cbcd02c07f52e7f1fd2cb46b":        {},
		"docker.io/library/redis@sha256:aefcda4d4388a70e628ad5ebbf162ae65509b20ea3dd6eeac7dcbbb675d94dba":        {},
		"docker.io/library/redis@sha256:6159aff1adde991d8747d705fa1135ceda04b0414dc372b381a6af415ec3b374":        {},
		"docker.io/library/redis@sha256:616bb446d5db225ddf786052834279e7c7222c48694d4451e8af22b8f5953b28":        {},
		"docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b":        {},
		"docker.io/library/redis@sha256:16623900b6ddd58e8bac04ccb6b611b9a5d1aed165453e28bcaed251d549d62c":        {},
		"docker.io/library/redis@sha256:2a5e873bfae4bcc660b27f45c391d4a7a01799b65dea7286acc858e9c6c1e7d3":        {},
	},
	"clickhouse": {
		"docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5": {},
		"docker.io/clickhouse/clickhouse-server@sha256:fdc22372465a336fa47e9deab61fad8277b9e2f2473234a1294b33b53f01d377": {},
		"docker.io/clickhouse/clickhouse-server@sha256:0d16977194aca61e26631e616e0678c2a745344d7d9da5729d2356f413dd28e1": {},
		"docker.io/clickhouse/clickhouse-server@sha256:ab3f33278b99576ea2ff2b0fa316b5e078c8b25f8ba08956cdbbb67d85c8b30f": {},
		"docker.io/clickhouse/clickhouse-server@sha256:422be85ae7344058369cdd366ac0efea9daa8428b55c9cf50258e83a7d12fcb3": {},
		"docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf": {},
		"docker.io/clickhouse/clickhouse-server@sha256:0ab6e7c7597232b56c2883f67ef91154e7e3b54d1fda57606334aad65275e735": {},
		"docker.io/clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b": {},
		"docker.io/clickhouse/clickhouse-server@sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916": {},
	},
}

func isCuratedDigestImage(engine, image string) bool {
	if !digestImagePattern.MatchString(image) {
		return false
	}
	// The GHCR mirror of a curated image carries the same digest, so it is the
	// same trusted content under the Opfield-owned registry name.
	if upstream, ok := thirdPartyUpstreamReference(image); ok {
		image = upstream
	}
	_, ok := curatedManagedDatabaseImages[engine][image]
	return ok
}

func validateClickHouseFragment(fragment string) error {
	if fragment == "" {
		return nil
	}
	if len(fragment) > 64*1024 {
		return errors.New("ClickHouse XML fragment exceeds 64 KiB")
	}
	decoder := xml.NewDecoder(strings.NewReader(fragment))
	rootSeen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid ClickHouse XML: %w", err)
		}
		switch t := token.(type) {
		case xml.Directive:
			return errors.New("ClickHouse XML directives are not allowed")
		case xml.ProcInst:
			return errors.New("ClickHouse XML processing instructions are not allowed")
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			if !rootSeen {
				if name != "clickhouse" {
					return errors.New("ClickHouse XML fragment root must be <clickhouse>")
				}
				rootSeen = true
			}
			if forbiddenClickHouseElement(name) {
				return fmt.Errorf("ClickHouse XML element %q is managed by Opfield", name)
			}
			for _, attr := range t.Attr {
				attrName := strings.ToLower(attr.Name.Local)
				if attrName == "incl" || attrName == "from_env" || attrName == "replace" {
					return fmt.Errorf("ClickHouse XML attribute %q is not allowed", attrName)
				}
			}
		}
	}
	if !rootSeen {
		return errors.New("ClickHouse XML fragment is empty")
	}
	return nil
}

func forbiddenClickHouseElement(name string) bool {
	switch name {
	case "listen_host", "http_port", "tcp_port", "interserver_http_port", "path", "tmp_path", "user_directories", "users", "profiles", "quotas", "remote_servers", "zookeeper", "keeper_server", "macros", "open_ssl", "certificates":
		return true
	default:
		return false
	}
}
