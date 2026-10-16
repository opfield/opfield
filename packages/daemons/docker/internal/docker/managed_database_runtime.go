package docker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/docker-daemon/internal/chha"
)

// createContainer creates and starts the engine container and waits until it
// serves. A published port the controller leaves to the node is picked before
// the container is created (see pickManagedDatabaseHostPorts), so the engine
// starts once, already on the binding it keeps across restarts, and record
// gets the ports it publishes.
func (m *managedDatabaseManager) createContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) (string, error) {
	// The server never starts without the extension bundles it is configured
	// with (a new database, a recreate on another image).
	if err := m.ensurePostgresExtensionBundles(ctx, record, input); err != nil {
		return "", err
	}
	for attempt := 1; ; attempt++ {
		pinned, picked, err := pickManagedDatabaseHostPorts(input)
		if err != nil {
			return "", err
		}
		containerID, err := m.createPinnedContainer(ctx, record, pinned)
		if err != nil && picked && dockerHostPortTaken(err) && attempt < maxHostPortPicks {
			m.logger.Info("a picked managed database host port was taken before Docker bound it; picking again", "id", record.ID)
			continue
		}
		if err != nil {
			return "", err
		}
		record.PublishedPort = pinned.PublishedPort
		record.PublishedNativePort = pinned.PublishedNativePort
		return containerID, nil
	}
}

// createPinnedContainer creates the container with the host ports in input,
// which are all chosen.
func (m *managedDatabaseManager) createPinnedContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) (string, error) {
	dataPath, port := engineDataPathAndPort(input.Type, input.TLSEnabled)
	dataSource, err := prepareManagedDatabaseDataSource(*record, input)
	if err != nil {
		return "", err
	}
	env := engineEnvironment(input)
	if input.Type == "clickhouse" && input.ClickhouseAvailability != nil && !input.ClickhouseAvailability.Standalone {
		// A set member joins the set's Replicated databases; the image must not
		// create the database as an Atomic one at its first start.
		env = withoutEnv(env, "CLICKHOUSE_DB")
	}
	// Resolve the reference actually present locally (GHCR mirror or the
	// upstream name) so a recreate never re-pulls or fails on the other name.
	image, err := m.client.EnsureThirdPartyImage(ctx, input.Image)
	if err != nil {
		return "", err
	}
	containerCfg := &container.Config{
		Image: image,
		Env:   env,
		Labels: map[string]string{
			managedDatabaseLabel:   record.ID,
			managedDatabaseTypeTag: input.Type,
		},
	}
	tlsDir := m.tlsDirectory(*record)
	if input.TLSEnabled {
		if err := writeManagedDatabaseTLS(tlsDir, input); err != nil {
			return "", err
		}
	}
	linkSocketDir := ""
	if linkSocketWanted(*record, input) {
		dir, err := m.prepareLinkSocketDir(*record)
		if err != nil {
			// Its links keep TLS over the bridge, as before.
			m.logger.Warn("managed PostgreSQL gets no link socket; its links use TLS over the bridge", "id", record.ID, "error", err)
		} else {
			linkSocketDir = dir
		}
	}
	if input.Type == "postgres" && input.TLSEnabled {
		postgresHBAPath := managedPostgresTLSHBAPath(*record)
		if err := writeManagedPostgresTLSHBA(postgresHBAPath, linkSocketDir != ""); err != nil {
			return "", fmt.Errorf("write PostgreSQL TLS authentication config: %w", err)
		}
	}
	if input.Type == "postgres" {
		containerCfg.Cmd = managedPostgresCommandWith(input, linkSocketDir != "")
	}
	if input.Type == "redis" {
		if err := ensureManagedRedisACLFile(dataSource, input.OwnerPassword); err != nil {
			return "", fmt.Errorf("prepare Redis ACL file: %w", err)
		}
		redisConfigPath := managedRedisConfigPath(*record, input)
		if err := writeManagedRedisConfig(redisConfigPath, managedRedisConfigText(input)); err != nil {
			return "", fmt.Errorf("write Redis managed config: %w", err)
		}
		containerCfg.Cmd = []string{managedRedisServerCommand(input.Image), "/run/gateway-config/redis.conf", "--dir", "/data"}
		if input.TLSEnabled {
			containerCfg.Cmd = append(containerCfg.Cmd, "--port", "6379", "--tls-port", "6380", "--tls-cert-file", "/run/gateway-tls/cert.pem", "--tls-key-file", "/run/gateway-tls/key.pem", "--tls-ca-cert-file", "/run/gateway-tls/ca.pem", "--tls-auth-clients", "no")
		}
	}
	if input.Type == "clickhouse" && input.ClickhouseConfig != "" {
		if err := writeClickHouseManagedConfig(filepath.Join(record.MountPath, "gateway-managed.xml"), input.ClickhouseConfig); err != nil {
			return "", fmt.Errorf("write ClickHouse managed config: %w", err)
		}
	}
	if input.Type == "clickhouse" {
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, "00-gateway-runtime.xml"), clickHouseRuntimeConfig); err != nil {
			return "", fmt.Errorf("write ClickHouse runtime config: %w", err)
		}
		ownerConfig := clickHouseOwnerOverrideConfig(input.OwnerUsername, input.OwnerPassword)
		if clickHouseAvailabilitySetID(input) != "" {
			ownerConfig = clickHouseMemberOwnerOverrideConfig(input.OwnerUsername, input.OwnerPassword)
		}
		if err := writeClickHouseOwnerOverride(clickHouseOwnerOverridePath(*record), ownerConfig); err != nil {
			return "", fmt.Errorf("write ClickHouse owner override: %w", err)
		}
	}
	if input.Type == "clickhouse" && input.TLSEnabled {
		config := `<clickhouse><https_port>8443</https_port><tcp_port_secure>9440</tcp_port_secure><openSSL><server><certificateFile>/run/gateway-tls/cert.pem</certificateFile><privateKeyFile>/run/gateway-tls/key.pem</privateKeyFile></server></openSSL></clickhouse>`
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, "gateway-tls.xml"), config); err != nil {
			return "", fmt.Errorf("write ClickHouse TLS config: %w", err)
		}
	}
	binds := []string{dataSource + ":" + dataPath}
	if input.Type == "redis" {
		binds = append(binds, managedRedisConfigPath(*record, input)+":/run/gateway-config/redis.conf:ro")
	}
	if input.Type == "postgres" && input.TLSEnabled {
		binds = append(binds, managedPostgresTLSHBAPath(*record)+":/run/gateway-config/pg_hba.conf:ro")
	}
	if linkSocketDir != "" {
		binds = append(binds, linkSocketDir+":"+pgLinkSocketContainerDir)
	}
	if input.TLSEnabled {
		binds = append(binds, tlsDir+":/run/gateway-tls:ro")
	}
	if input.Type == "clickhouse" && input.ClickhouseConfig != "" {
		binds = append(binds, filepath.Join(record.MountPath, "gateway-managed.xml")+":/etc/clickhouse-server/config.d/gateway-managed.xml:ro")
	}
	if input.Type == "clickhouse" {
		binds = append(binds, filepath.Join(record.MountPath, "00-gateway-runtime.xml")+":/etc/clickhouse-server/config.d/00-gateway-runtime.xml:ro")
		binds = append(binds, clickHouseOwnerOverridePath(*record)+":"+clickHouseOwnerOverrideContainerPath+":ro")
	}
	if input.Type == "clickhouse" && input.TLSEnabled {
		binds = append(binds, filepath.Join(record.MountPath, "gateway-tls.xml")+":/etc/clickhouse-server/config.d/gateway-tls.xml:ro")
	}
	availabilityMember := input.Type == "clickhouse" && clickHouseAvailabilitySetID(input) != ""
	if input.Type == "clickhouse" && input.ClickhouseAvailability != nil {
		availabilityBinds, err := stageClickHouseAvailability(record, input)
		if err != nil {
			return "", err
		}
		binds = append(binds, availabilityBinds...)
	} else if input.Type == "clickhouse" {
		record.ClickhouseAvailabilitySetID, record.ClickhouseAvailabilityMemberID, record.ClickhouseAvailabilityFiles = "", "", false
	}
	hostCfg := &container.HostConfig{
		Binds:         binds,
		RestartPolicy: engineRestartPolicy,
		LogConfig: container.LogConfig{
			Type: "json-file",
			Config: map[string]string{
				"max-size": "10m",
				"max-file": "3",
			},
		},
		Resources: container.Resources{
			Memory:     input.MemoryBytes,
			MemorySwap: input.MemorySwapBytes,
			NanoCPUs:   input.NanoCPUs,
			CPUShares:  input.CPUShares,
		},
	}
	if input.PidsLimit > 0 {
		pids := input.PidsLimit
		hostCfg.PidsLimit = &pids
	}
	// A set member publishes no Docker port: its member proxy serves the
	// published ports, admitting only while the member serves.
	if input.PublishTCP && !availabilityMember {
		containerPort, err := network.ParsePort(port)
		if err != nil {
			return "", fmt.Errorf("parse managed database port: %w", err)
		}
		containerCfg.ExposedPorts = network.PortSet{containerPort: {}}
		hostCfg.PortBindings = network.PortMap{containerPort: {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: fmt.Sprintf("%d", input.PublishedPort)}}}
		if input.Type == "clickhouse" && input.PublishNativeTCP {
			nativePort, parseErr := network.ParsePort(clickHouseNativePort(input.TLSEnabled))
			if parseErr != nil {
				return "", fmt.Errorf("parse ClickHouse native port: %w", parseErr)
			}
			containerCfg.ExposedPorts[nativePort] = struct{}{}
			hostCfg.PortBindings[nativePort] = []network.PortBinding{{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: fmt.Sprintf("%d", input.PublishedNativePort)}}
		}
	}
	// A key-value store member of an availability set (managed_database_kv_member.go).
	setNetwork, err := m.kvMemberContainer(*record, input, dataSource, containerCfg, hostCfg)
	if err != nil {
		return "", err
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     containerCfg,
		HostConfig: hostCfg,
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			record.NetworkName: {Aliases: []string{"database"}},
		}},
		Name: record.ContainerName,
	})
	if err != nil {
		return "", fmt.Errorf("create managed database container: %w", err)
	}
	if setNetwork != "" {
		if _, err := m.client.cli.NetworkConnect(ctx, setNetwork, mobyclient.NetworkConnectOptions{Container: created.ID, EndpointConfig: &network.EndpointSettings{}}); err != nil {
			_ = m.client.RemoveContainer(ctx, created.ID, true)
			return "", fmt.Errorf("attach the member to its availability set network: %w", err)
		}
	}
	if _, err := m.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", fmt.Errorf("start managed database container: %w", err)
	}
	if err := m.waitForDatabaseReady(ctx, created.ID, input); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", err
	}
	if input.Type == "clickhouse" && !availabilityMember {
		if err := m.cleanupClickHouseSystemLogs(ctx, created.ID, input); err != nil {
			m.logger.Warn("cleanup legacy ClickHouse system logs", "id", record.ID, "error", err)
		}
	}
	record.PostgresLinkSocket = linkSocketDir != ""
	return created.ID, nil
}

// Redis cannot safely use the ext4 filesystem root as /data for new
// curated image drops privileges before opening the AOF directory.
//
// A key-value store on Valkey keeps its data in its own directory: a store
// moved from Redis is copied into it while the Redis data stays untouched in
// redis-data until the move is verified (managed_redis_move.go).
func prepareManagedDatabaseDataSource(record managedDatabaseRecord, input managedDatabaseCommand) (string, error) {
	engine := input.Type
	if engine != "redis" {
		return record.MountPath, nil
	}

	path := managedRedisDataPath(record, input.Image)
	if err := os.MkdirAll(path, 0750); err != nil {
		return "", fmt.Errorf("create Redis data directory: %w", err)
	}
	uid, gid, err := managedDatabaseTLSOwner(engine)
	if err != nil {
		return "", err
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return "", fmt.Errorf("set Redis data directory ownership: %w", err)
	}
	if err := os.Chmod(path, 0750); err != nil {
		return "", fmt.Errorf("set Redis data directory permissions: %w", err)
	}
	return path, nil
}

func ensureManagedRedisACLFile(dataPath, ownerPassword string) error {
	aclPath := filepath.Join(dataPath, "users.acl")
	if _, err := os.Stat(aclPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	digest := sha256.Sum256([]byte(ownerPassword))
	contents := fmt.Sprintf("user default on #%x ~* &* +@all\n", digest)
	if err := os.WriteFile(aclPath, []byte(contents), 0600); err != nil {
		return err
	}
	uid, gid, err := managedDatabaseTLSOwner("redis")
	if err != nil {
		return err
	}
	if err := os.Chown(aclPath, uid, gid); err != nil {
		return err
	}
	return os.Chmod(aclPath, 0600)
}

func (m *managedDatabaseManager) cleanupClickHouseSystemLogs(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	return m.runManagedDatabaseExec(
		ctx,
		containerID,
		[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", "system", "--multiquery"},
		clickHouseSystemLogCleanupSQL,
		[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
	)
}

func writeClickHouseConfig(path, contents string) error {
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		return err
	}
	// WriteFile preserves the mode of an existing file. Explicitly converge it
	// because ClickHouse reads config.d after dropping root privileges.
	return os.Chmod(path, 0644)
}

// managedPostgresCommand is the server command line of a managed PostgreSQL
// container, or nil to keep the image default when no setting needs a flag.
func managedPostgresCommand(input managedDatabaseCommand) []string {
	return managedPostgresCommandWith(input, false)
}

// managedPostgresCommandWith is managedPostgresCommand; linkSocket adds the
// link socket directory (managed_database_link_socket.go) to the engine's own.
func managedPostgresCommandWith(input managedDatabaseCommand, linkSocket bool) []string {
	var flags []string
	if maxConnections := managedPostgresMaxConnections(input); maxConnections > 0 {
		flags = append(flags, "-c", "max_connections="+strconv.Itoa(maxConnections))
	}
	flags = append(flags, managedPostgresExtensionFlags(input)...)
	if input.TLSEnabled {
		flags = append(flags,
			"-c", "ssl=on",
			"-c", "ssl_cert_file=/run/gateway-tls/cert.pem",
			"-c", "ssl_key_file=/run/gateway-tls/key.pem",
			"-c", "hba_file=/run/gateway-config/pg_hba.conf",
		)
		if linkSocket {
			flags = append(flags, "-c", "unix_socket_directories=/var/run/postgresql,"+pgLinkSocketContainerDir)
		}
	}
	if len(flags) == 0 {
		return nil
	}
	return append([]string{"postgres"}, flags...)
}

func writeManagedRedisConfig(path, contents string) error {
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		return err
	}
	return os.Chmod(path, 0644)
}

// waitForDatabaseReady keeps lifecycle completion aligned with actual engine
// availability. Docker reports ContainerStart before a database has finished
// initialization, which otherwise produces a false-ready/offline UI transition.
// An engine that answers it is still loading its data makes progress: each
// such answer gives it the readiness timeout again, within the operation's
// own deadline, so a large dataset can finish loading.
func (m *managedDatabaseManager) waitForDatabaseReady(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	deadline := time.Now().Add(managedDatabaseReadinessTimeout)
	for {
		probeCtx, cancel := context.WithDeadline(ctx, deadline)
		err := m.probeDatabaseReady(probeCtx, containerID, input)
		cancel()
		if err == nil {
			return nil
		}
		loading := errors.Is(err, errManagedDatabaseLoading)
		if loading {
			deadline = time.Now().Add(managedDatabaseReadinessTimeout)
		}

		timer := time.NewTimer(managedDatabaseReadinessInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if loading {
				return errors.New("managed database did not finish loading its data before timeout")
			}
			return errors.New("managed database did not become ready before timeout")
		case <-timer.C:
		}
		if !time.Now().Before(deadline) {
			return errors.New("managed database did not become ready before timeout")
		}
	}
}

// errManagedDatabaseLoading is the readiness answer of an engine that runs and
// is still loading its data into memory.
var errManagedDatabaseLoading = errors.New("managed database is loading its data")

func (m *managedDatabaseManager) probeDatabaseReady(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	command, env, err := managedDatabaseReadinessCommand(input)
	if err != nil {
		return err
	}
	if input.Type != "redis" {
		return m.runManagedDatabaseExec(ctx, containerID, command, "", env)
	}
	var reply bytes.Buffer
	err = m.runManagedDatabaseExecTo(ctx, containerID, command, "", env, &reply)
	return managedRedisPingResult(reply.String(), err)
}

// managedRedisPingResult reads the answer of redis-cli PING. Redis accepts
// connections while it loads its dataset and answers every command with a
// LOADING error until the data is in memory; redis-cli prints that error and
// can still exit 0, so only PONG means Redis serves.
func managedRedisPingResult(reply string, err error) error {
	reply = strings.TrimSpace(reply)
	switch {
	case strings.Contains(reply, "LOADING"):
		return errManagedDatabaseLoading
	case err != nil:
		return err
	case reply != "PONG":
		return errors.New("managed Redis did not answer PING")
	}
	return nil
}

// managedDatabaseReadinessCommand only returns fixed engine client commands.
// Passwords are passed through the exec environment, never as process args.
func managedDatabaseReadinessCommand(input managedDatabaseCommand) ([]string, []string, error) {
	switch input.Type {
	case "postgres":
		return []string{"pg_isready", "-q", "-h", "127.0.0.1", "-U", input.OwnerUsername, "-d", input.DatabaseName}, []string{"PGPASSWORD=" + input.OwnerPassword}, nil
	case "redis":
		return []string{"redis-cli", "--no-auth-warning", "--user", "default", "PING"}, []string{"REDISCLI_AUTH=" + input.OwnerPassword}, nil
	case "clickhouse":
		if clickHouseAvailabilitySetID(input) != "" {
			// A set member has its databases only once its Keeper joined the set
			// (chha.MemberReadinessQuery); the member runtime tracks them.
			return []string{"clickhouse-client", "--host", "127.0.0.1", "--user", input.OwnerUsername, "--query", chha.MemberReadinessQuery}, []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}, nil
		}
		return []string{"clickhouse-client", "--host", "127.0.0.1", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--query", "SELECT 1"}, []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}, nil
	default:
		return nil, nil, errors.New("unsupported managed database engine")
	}
}

func engineDataPathAndPort(engine string, tlsEnabled bool) (string, string) {
	switch engine {
	case "postgres":
		return "/var/lib/postgresql/data", "5432/tcp"
	case "redis":
		if tlsEnabled {
			return "/data", "6380/tcp"
		}
		return "/data", "6379/tcp"
	default:
		if tlsEnabled {
			return "/var/lib/clickhouse", "8443/tcp"
		}
		return "/var/lib/clickhouse", "8123/tcp"
	}
}

func clickHouseNativePort(tlsEnabled bool) string {
	if tlsEnabled {
		return "9440/tcp"
	}
	return "9000/tcp"
}

// managedDatabaseChown assigns TLS material to the engine account; tests
// running unprivileged replace it.
var managedDatabaseChown = os.Chown

func writeManagedDatabaseTLS(dir string, input managedDatabaseCommand) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create managed database TLS directory: %w", err)
	}
	uid, gid, err := managedDatabaseTLSOwner(input.Type)
	if err != nil {
		return err
	}
	if err := managedDatabaseChown(dir, uid, gid); err != nil {
		return fmt.Errorf("restrict managed database TLS directory: %w", err)
	}
	// Each file is replaced through a temporary file and a rename inside the
	// mounted directory, so a running engine rereading its certificate never
	// sees a truncated file. The key is owned by the engine account (0600, as
	// PostgreSQL requires) before it becomes visible.
	ownKey := func(path string) error { return managedDatabaseChown(path, uid, gid) }
	for _, file := range []struct {
		name, value string
		mode        os.FileMode
		chown       func(string) error
	}{
		{"ca.pem", input.TLSCACertificatePEM, 0644, nil},
		{"key.pem", input.TLSPrivateKeyPEM, 0600, ownKey},
		{"cert.pem", input.TLSCertificatePEM, 0644, nil},
	} {
		if err := writeFileAtomically(filepath.Join(dir, file.name), []byte(file.value), file.mode, file.chown); err != nil {
			return fmt.Errorf("write managed database TLS material %s: %w", file.name, err)
		}
	}
	return nil
}

const managedPostgresTLSHBA = `# Managed by Opfield. Direct TCP clients must negotiate TLS.
local all all trust
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::0/0 scram-sha-256
`

// managedPostgresLinkSocketHBA is the pg_hba of a container with the link
// socket: the daemon's link connections arrive on a unix socket, so a socket
// connection needs the role's password as a TCP one does (the engine's tools
// pass the owner password).
const managedPostgresLinkSocketHBA = `# Managed by Opfield. Direct TCP clients must negotiate TLS; socket connections (the daemon's links) need the password.
local all all scram-sha-256
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::0/0 scram-sha-256
`

func managedPostgresTLSHBAPath(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, "gateway-pg_hba.conf")
}

func writeManagedPostgresTLSHBA(path string, linkSocket bool) error {
	content := managedPostgresTLSHBA
	if linkSocket {
		content = managedPostgresLinkSocketHBA
	}
	return os.WriteFile(path, []byte(content), 0644)
}

// All accepted engine images are digest-pinned and use these service accounts.
// Keeping the private key outside the data volume and readable only by that
// account prevents it from being inherited by database backups or data mounts.
func managedDatabaseTLSOwner(engine string) (int, int, error) {
	switch engine {
	case "postgres", "redis":
		return 999, 999, nil
	case "clickhouse":
		return 101, 101, nil
	default:
		return 0, 0, errors.New("unsupported managed database engine")
	}
}

func engineEnvironment(input managedDatabaseCommand) []string {
	switch input.Type {
	case "postgres":
		// An ext4 image has a lost+found directory at its mount root. PostgreSQL
		// correctly refuses to initialize a cluster in that non-empty directory,
		// so keep the bind mount at its conventional parent and put PGDATA in an
		// engine-managed child directory.
		return []string{
			"POSTGRES_USER=" + input.OwnerUsername,
			"POSTGRES_PASSWORD=" + input.OwnerPassword,
			"POSTGRES_DB=" + input.DatabaseName,
			"PGDATA=/var/lib/postgresql/data/pgdata",
		}
	case "clickhouse":
		return []string{
			"CLICKHOUSE_USER=" + input.OwnerUsername,
			"CLICKHOUSE_PASSWORD=" + input.OwnerPassword,
			"CLICKHOUSE_DB=" + input.DatabaseName,
			// Opfield's internal owner creates and revokes the isolated users used
			// by direct publication and secure bindings. The official image keeps
			// SQL access management disabled unless this flag is explicit.
			"CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
		}
	default:
		return nil
	}
}

func (m *managedDatabaseManager) startContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		return nil
	}
	if _, err := m.client.cli.ContainerStart(ctx, id, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) stopContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return nil
	}
	timeout := 30
	if _, err := m.client.cli.ContainerStop(ctx, id, mobyclient.ContainerStopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("stop managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) pauseContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed database container is not running")
	}
	if inspect.Container.State.Paused {
		return nil
	}
	if _, err := m.client.cli.ContainerPause(ctx, id, mobyclient.ContainerPauseOptions{}); err != nil {
		return fmt.Errorf("pause managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) unpauseContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed database container is not running")
	}
	if !inspect.Container.State.Paused {
		return nil
	}
	if _, err := m.client.cli.ContainerUnpause(ctx, id, mobyclient.ContainerUnpauseOptions{}); err != nil {
		return fmt.Errorf("unpause managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) runtimeStats(ctx context.Context, record managedDatabaseRecord) (string, error) {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "missing"})
	}
	if err != nil {
		return "", fmt.Errorf("inspect managed database container for stats: %w", err)
	}
	if managedDatabaseContainerStatus(inspect.Container.State) == "paused" {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "paused"})
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "stopped"})
	}
	result, err := m.client.cli.ContainerStats(ctx, record.ContainerID, mobyclient.ContainerStatsOptions{
		Stream:                false,
		IncludePreviousSample: true,
	})
	if err != nil {
		return "", fmt.Errorf("collect managed database stats: %w", err)
	}
	defer result.Body.Close()
	data, err := io.ReadAll(result.Body)
	if err != nil {
		return "", fmt.Errorf("read managed database stats: %w", err)
	}
	var stats container.StatsResponse
	if err := json.Unmarshal(data, &stats); err != nil {
		return "", fmt.Errorf("parse managed database stats: %w", err)
	}
	normalized := statsResponseToProto(&stats, &inspect.Container)
	swapLimit := managedDatabaseSwapLimit(inspect.Container.HostConfig)
	swapUsage := int64(stats.MemoryStats.Stats["swap"])
	diskUsed, diskTotal, _ := managedDatabaseDiskUsage(record.MountPath)
	return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{
		Status:           "ready",
		CPUPercent:       normalized.CpuPercent,
		MemoryUsageBytes: normalized.MemoryUsageBytes,
		MemoryLimitBytes: normalized.MemoryLimitBytes,
		SwapUsageBytes:   swapUsage,
		SwapLimitBytes:   swapLimit,
		Pids:             normalized.Pids,
		DiskUsedBytes:    diskUsed,
		DiskTotalBytes:   diskTotal,
	})
}

func managedDatabaseSwapLimit(hostConfig *container.HostConfig) int64 {
	if hostConfig == nil || hostConfig.MemorySwap == 0 {
		return 0
	}
	if hostConfig.MemorySwap < 0 {
		return -1
	}
	if hostConfig.MemorySwap <= hostConfig.Memory {
		return 0
	}
	return hostConfig.MemorySwap - hostConfig.Memory
}

func marshalManagedDatabaseRuntimeStats(stats managedDatabaseRuntimeStats) (string, error) {
	data, err := json.Marshal(stats)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// remove deletes a managed database in a fixed order and answers only once
// the storage is really gone: container, then mount, then loop device (waiting
// until the kernel has released it), then image and record. A step that fails
// is reported and leaves the record marked Deleting, so a repeated delete or
// the repair pass completes it instead of Opfield losing track of a mount
// or loop device that is still held.
func (m *managedDatabaseManager) remove(ctx context.Context, record managedDatabaseRecord) error {
	if !record.Deleting {
		record.Deleting = true
		record.DesiredRunning = false
		if err := m.saveRecord(record); err != nil {
			return err
		}
	}
	if record.ContainerID != "" {
		if err := m.client.RemoveContainer(ctx, record.ContainerID, true); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove managed database container: %w", err)
		}
	}
	if record.NetworkName != "" {
		_, _ = m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{})
	}
	return m.cleanupStorage(ctx, &record, true)
}

func (m *managedDatabaseManager) cleanupStorage(ctx context.Context, record *managedDatabaseRecord, removeImage bool) error {
	if err := m.loopHost().release(ctx, record.ImagePath, record.MountPath); err != nil {
		return fmt.Errorf("release database storage image: %w", err)
	}
	record.LoopDevice = ""
	if removeImage {
		if err := os.RemoveAll(m.tlsDirectory(*record)); err != nil {
			return fmt.Errorf("remove managed database TLS material: %w", err)
		}
		m.removeLinkSocketDir(*record)
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove database storage image: %w", err)
		}
		if err := m.loopHost().removeMountPoint(record.MountPath); err != nil {
			return err
		}
		if err := os.Remove(m.recordPath(record.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove managed database record: %w", err)
		}
	}
	return nil
}

// records reads every managed database record and lists the record files
// that cannot be read.
func (m *managedDatabaseManager) records() (records []managedDatabaseRecord, unreadable []unreadableRecord, err error) {
	dir := filepath.Join(m.root, "records")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, fmt.Errorf("read managed database records: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		record, err := m.loadRecord(id)
		if err != nil {
			unreadable = append(unreadable, unreadableRecord{ID: id, Path: filepath.Join(dir, entry.Name()), Err: err})
			continue
		}
		records = append(records, record)
	}
	return records, unreadable, nil
}

// repairLoopImages finishes deletes that could not complete and releases
// mounts, loop devices and image files that belong to no managed database,
// plus loop devices left bound to deleted backup workspaces. It runs at start
// and periodically; see loopHost.repair for what is never touched. A record
// that cannot be read keeps everything named after its id (image, mount point,
// loop device, container) and is reported; so does an id that has a container
// but no record. When the containers cannot be listed, no database storage is
// released. The rest is repaired as usual.
func (m *managedDatabaseManager) repairLoopImages(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	records, unreadable, err := m.records()
	if err != nil {
		m.logger.Warn("managed database storage repair skipped", "error", err)
		return
	}
	for _, record := range records {
		if !record.Deleting {
			continue
		}
		if err := m.remove(ctx, record); err != nil {
			m.logger.Warn("managed database deletion could not be finished yet", "id", record.ID, "error", err)
			continue
		}
		m.logger.Info("finished interrupted managed database deletion", "id", record.ID)
	}
	for _, bad := range unreadable {
		m.logger.Warn("managed database record cannot be read; its storage and container are left alone until it is repaired or removed by hand",
			"id", bad.ID, "path", bad.Path, "error", bad.Err)
	}
	if records, unreadable, err = m.records(); err == nil {
		// An id whose container outlived its record keeps its image: the image
		// holds the data a retried create takes over.
		labelled, listErr := m.labelledDatabaseIDs(ctx)
		if listErr != nil {
			m.logger.Warn("managed database storage repair skipped: its containers could not be listed", "error", listErr)
		} else {
			ids := make(map[string]bool, len(records)+len(unreadable)+len(labelled))
			for id := range labelled {
				ids[id] = true
			}
			for _, record := range records {
				ids[record.ID] = true
			}
			for _, bad := range unreadable {
				ids[bad.ID] = true
			}
			imageOwned := func(name string) bool {
				id, ok := strings.CutSuffix(name, ".img")
				return ok && ids[id]
			}
			m.loopHost().repair(ctx, loopImageDomain{
				label:      "managed database",
				imageDir:   filepath.Join(m.root, "images"),
				mountDir:   filepath.Join(m.root, "mounts"),
				mountRoot:  filepath.Join(m.root, "mounts"),
				imageInUse: func(name string, _ bool) bool { return imageOwned(name) },
				imageKept:  imageOwned,
				mountInUse: func(name string) bool { return ids[name] },
				orphanImage: func(name string) bool {
					id, ok := strings.CutSuffix(name, ".img")
					return ok && managedDatabaseIDPattern.MatchString(id)
				},
			}, m.logger)
		}
	}
	// Backup runs own their live workspace images and remove them themselves;
	// only a loop device bound to a deleted workspace image is released here.
	m.loopHost().repair(ctx, loopImageDomain{
		label:      "backup workspace",
		imageDir:   filepath.Join(m.root, "backups", "images"),
		mountRoot:  filepath.Join(m.cfg.StateDir, backupStateDirectory),
		imageInUse: func(_ string, deleted bool) bool { return !deleted },
		imageKept:  func(string) bool { return true },
	}, m.logger)
}

func (m *managedDatabaseManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if err != nil {
		return fmt.Errorf("read managed database records: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		// One broken database (container removed, volume missing, unreadable record) must not keep the whole node
		// offline: the node comes up with the others, and Opfield sees this one as not running and can repair it.
		record, err := m.loadRecord(id)
		if err != nil {
			m.logger.Warn("managed database record could not be read at startup", "id", id, "path", m.recordPath(id), "error", err)
			continue
		}
		if record.ContainerID != "" {
			if err := ensureEngineRestartPolicy(ctx, m.client, record.ContainerID); err != nil {
				m.logger.Warn("managed database engine keeps Docker's restart policy", "id", id, "error", err)
			}
		}
		if !record.DesiredRunning {
			continue
		}
		if record.AvailabilityMemberID != "" {
			// A set member is never started here: the member runtime starts it
			// through standby at rest. Its storage is mounted for it.
			if err := m.ensureStorageSize(ctx, &record, record.StorageSize); err != nil {
				m.logger.Warn("availability member storage could not be restored at startup", "id", id, "error", err)
				continue
			}
			m.healClickHouseConfig(record)
			continue
		}
		if err := m.ensureStorageSize(ctx, &record, record.StorageSize); err != nil {
			m.logger.Warn("managed database storage could not be restored at startup", "id", id, "error", err)
			continue
		}
		m.healClickHouseConfig(record)
		if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
			m.logger.Warn("managed database is not started at startup", "id", id, "error", runtimeFilesMissingError("managed database", missing))
			if err := m.saveRecord(record); err != nil {
				return err
			}
			continue
		}
		if record.clickHouseAvailabilityMember() {
			// The availability member runtime starts it (standby at rest first).
			if err := m.saveRecord(record); err != nil {
				return err
			}
			continue
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			m.logger.Warn("managed database could not be started at startup", "id", id, "error", err)
			continue
		}
		if err := m.saveRecord(record); err != nil {
			return err
		}
	}
	return nil
}

// healClickHouseConfig gives a ClickHouse database's user config the system
// log TTLs it was written without (managed_clickhouse_system_logs.go).
func (m *managedDatabaseManager) healClickHouseConfig(record managedDatabaseRecord) {
	if record.Type != "clickhouse" || record.ClickhouseConfigHash == "" {
		return
	}
	healed, err := healClickHouseManagedConfig(record.MountPath)
	if err != nil {
		m.logger.Warn("ClickHouse user config keeps system logs without a TTL", "id", record.ID, "error", err)
		return
	}
	if healed {
		m.logger.Info("ClickHouse user config: system logs it enables expire after "+clickHouseUserSystemLogDays+" days from the next start", "id", record.ID)
	}
}

func (m *managedDatabaseManager) tlsDirectory(record managedDatabaseRecord) string {
	return filepath.Join(m.root, "tls", record.ID)
}

func (m *managedDatabaseManager) recordPath(id string) string {
	return filepath.Join(m.root, "records", id+".json")
}

func (m *managedDatabaseManager) loadRecord(id string) (managedDatabaseRecord, error) {
	data, err := os.ReadFile(m.recordPath(id))
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	var record managedDatabaseRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return managedDatabaseRecord{}, fmt.Errorf("parse managed database record: %w", err)
	}
	if record.ID != id || record.ImagePath != filepath.Join(m.root, "images", id+".img") || record.MountPath != filepath.Join(m.root, "mounts", id) {
		return managedDatabaseRecord{}, errors.New("managed database record has invalid storage paths")
	}
	return record, nil
}

func (m *managedDatabaseManager) saveRecord(record managedDatabaseRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal managed database record: %w", err)
	}
	if err := atomicfile.WriteFile(m.recordPath(record.ID), data, 0600); err != nil {
		return fmt.Errorf("write managed database record: %w", err)
	}
	return nil
}

func marshalManagedDatabaseDetail(record managedDatabaseRecord, status string) (string, error) {
	return marshalManagedDatabaseInspect(record, status, nil)
}

// inspectDetail answers inspect. An engine whose disk is being repaired (or
// failed its repair) is stopped; so is one that keeps failing, even in the
// seconds it runs between two restarts by the supervisor (engineExited).
// The detail carries the disk repair, the engine's unrequested stops of the
// last day (out-of-memory kills among them) and an oversubscribed node disk.
func (m *managedDatabaseManager) inspectDetail(ctx context.Context, record managedDatabaseRecord) (string, error) {
	inspect, inspectErr := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	status := "stopped"
	var startedAt time.Time
	if inspectErr == nil {
		state := inspect.Container.State
		status = managedDatabaseContainerStatus(state)
		if state != nil && state.Running {
			startedAt, _ = time.Parse(time.RFC3339Nano, state.StartedAt)
		}
	}
	extras := map[string]any{}
	repairing := m.repairs.running(record.ID)
	if repair := diskRepairDetail(record.DiskRepair, repairing); repair != nil {
		extras["diskRepair"] = repair
	}
	switch {
	case repairing || record.DiskRepair.blocksEngine():
		if status != "paused" {
			status = "stopped"
		}
	case status != "paused" && record.DesiredRunning && m.incidents.crashLooping(record.ID, startedAt):
		status = "stopped"
		extras["engineExited"] = true
	}
	if incidents := m.incidents.detail(record.ID); incidents != nil {
		extras["engineIncidents"] = incidents
	}
	if oversubscribed := managedDiskOversubscription(m.root, m.reserve, m.statFilesystem); oversubscribed != nil {
		extras["nodeDiskOversubscribed"] = oversubscribed
	}
	return marshalManagedDatabaseInspect(record, status, m.missingRuntimeFiles(record), extras)
}

// marshalManagedDatabaseInspect is the inspect detail; runtimeMissing names the
// runtime files the node lost (see managed_runtime_files.go).
func marshalManagedDatabaseInspect(record managedDatabaseRecord, status string, runtimeMissing []string, extras ...map[string]any) (string, error) {
	detail := map[string]any{
		"id": record.ID, "containerId": record.ContainerID, "status": status, "publishedPort": record.PublishedPort, "publishedNativePort": record.PublishedNativePort, "tlsEnabled": record.TLSEnabled, "operationId": record.OperationID,
	}
	if len(runtimeMissing) > 0 {
		detail["runtimeMissing"] = runtimeMissing
	}
	for _, extra := range extras {
		maps.Copy(detail, extra)
	}
	value, err := json.Marshal(detail)
	if err != nil {
		return "", err
	}
	return string(value), nil
}
