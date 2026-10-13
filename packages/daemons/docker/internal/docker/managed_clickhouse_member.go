package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/chha"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// ClickHouse members of database availability sets (internal/chha). The
// member's container is the managed database's own container on the node,
// created by the managed database commands with clickhouseAvailability: it
// binds the member's availability files, publishes no Docker port (the member
// proxy serves the published ports, lease-gated) and starts with the client
// profile read-only. From then on the member runtime starts, stops and
// promotes it; the managed engine supervisor leaves it alone.

func init() {
	RegisterSetMemberEngine(chha.Engine, newClickHouseSetMember)
}

// clickHouseAvailabilityCommand is the managed database command's set member
// part (ClickHouse only): the member configuration the container's files are
// rendered from before the member runtime takes the member over.
type clickHouseAvailabilityCommand struct {
	// Standalone: a single node that keeps its Replicated databases and Keeper
	// after availability was turned off (it is the only voter); the managed
	// engine supervisor runs it like any database, writable, and it publishes
	// its ports itself.
	Standalone              bool            `json:"standalone,omitempty"`
	SetID                   string          `json:"setId"`
	MemberID                string          `json:"memberId"`
	Mode                    string          `json:"mode"`
	Durability              string          `json:"durability"`
	SyncDegradeAfterSeconds uint32          `json:"syncDegradeAfterSeconds"`
	Members                 []memberha.Peer `json:"members"`
	EngineConfig            json.RawMessage `json:"engineConfig"`
}

func (c *clickHouseAvailabilityCommand) memberConfig(databaseID string) memberha.Config {
	config := memberha.Config{
		SetID: c.SetID, MemberID: c.MemberID, Engine: chha.Engine, OwnerKind: "managed_database", OwnerID: databaseID,
		Mode: c.Mode, Durability: c.Durability, SyncDegradeAfterSeconds: c.SyncDegradeAfterSeconds, Members: c.Members,
		EngineConfig: c.EngineConfig,
	}
	if peer, ok := config.Peer(c.MemberID); ok {
		config.NodeID = peer.NodeID
	}
	return config
}

func validateClickHouseAvailability(input managedDatabaseCommand, databaseID string) error {
	availability := input.ClickhouseAvailability
	if availability == nil {
		return nil
	}
	if input.Type != "clickhouse" {
		return errors.New("availability members of this command are supported only for ClickHouse")
	}
	_, err := chha.ParseEngineConfig(availability.memberConfig(databaseID))
	return err
}

// clickHouseAvailabilityMember: the record is a ClickHouse availability set
// member (the member runtime starts and stops its engine).
func (r managedDatabaseRecord) clickHouseAvailabilityMember() bool {
	return r.Type == "clickhouse" && r.ClickhouseAvailabilitySetID != ""
}

// clickHouseAvailabilityChanged: the container must be recreated because the
// member's availability binds appear or disappear (convert, turn off).
func clickHouseAvailabilityChanged(record managedDatabaseRecord, input managedDatabaseCommand) bool {
	if record.Type != "clickhouse" {
		return false
	}
	return clickHouseAvailabilitySetID(input) != record.ClickhouseAvailabilitySetID ||
		(input.ClickhouseAvailability != nil) != record.ClickhouseAvailabilityFiles
}

// clickHouseAvailabilitySetID is the set a command makes the container a
// member of ("" for none and for a standalone node).
func clickHouseAvailabilitySetID(input managedDatabaseCommand) string {
	if input.ClickhouseAvailability == nil || input.ClickhouseAvailability.Standalone {
		return ""
	}
	return input.ClickhouseAvailability.SetID
}

func withoutEnv(env []string, name string) []string {
	out := env[:0:0]
	for _, entry := range env {
		if !strings.HasPrefix(entry, name+"=") {
			out = append(out, entry)
		}
	}
	return out
}

// clickHouseMemberOwnerOverrideConfig is Gateway's owner user on a set
// member: the client profile (read-only on a copy).
func clickHouseMemberOwnerOverrideConfig(username, password string) string {
	return strings.Replace(clickHouseOwnerOverrideConfig(username, password), "<profile>default</profile>",
		"<profile>"+chha.ClientProfile+"</profile>", 1)
}

// recreateClickHouseAware recreates the container; converting a single node
// marks its MergeTree tables for conversion first (the engine must run), and
// a set member is held from the member runtime while its container changes.
func (m *managedDatabaseManager) recreateClickHouseAware(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if record.Type != "clickhouse" {
		return m.recreateContainer(ctx, record, input)
	}
	if input.ClickhouseAvailability != nil && !record.ClickhouseAvailabilityFiles {
		if err := m.placeClickHouseConvertFlags(ctx, *record, input); err != nil {
			return fmt.Errorf("prepare the conversion to a replicated database (the database must be running): %w", err)
		}
	}
	setID := record.ClickhouseAvailabilitySetID
	if setID == "" {
		setID = clickHouseAvailabilitySetID(input)
	}
	if m.plugin != nil && m.plugin.setMembers != nil && setID != "" {
		release, err := m.plugin.setMembers.Hold(ctx, setID)
		if err != nil {
			return err
		}
		defer release()
	}
	if record.ClickhouseAvailabilitySetID != "" && clickHouseAvailabilitySetID(input) == "" {
		// Leaving the set (a lift): the single-node container publishes the
		// ports the member proxy serves.
		restorePublished, err := m.plugin.releaseSetPublished(ctx, record.ClickhouseAvailabilitySetID)
		if err != nil {
			return err
		}
		if err := m.recreateContainer(ctx, record, input); err != nil {
			restorePublished()
			return err
		}
		return nil
	}
	return m.recreateContainer(ctx, record, input)
}

const clickHouseInternalSecretFile = "gateway-availability-internal.secret"

// stageClickHouseAvailability writes the member's availability files before
// its container is created (standby at rest: client profile read-only) and
// returns their binds.
func stageClickHouseAvailability(record *managedDatabaseRecord, input managedDatabaseCommand) ([]string, error) {
	availability := input.ClickhouseAvailability
	config := availability.memberConfig(record.ID)
	ec, err := chha.ParseEngineConfig(config)
	if err != nil {
		return nil, err
	}
	_, statErr := os.Stat(filepath.Join(record.MountPath, "coordination", "log"))
	hash, err := clickHouseInternalPasswordSHA256(record.MountPath)
	if err != nil {
		return nil, err
	}
	timeout := availability.SyncDegradeAfterSeconds
	if timeout == 0 {
		timeout = 10
	}
	files := chha.StageMemberFiles(config, ec, errors.Is(statErr, os.ErrNotExist), availability.Standalone, timeout*1000, hash)
	for name, data := range files {
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, name), string(data)); err != nil {
			return nil, fmt.Errorf("write ClickHouse availability file %s: %w", name, err)
		}
	}
	record.ClickhouseAvailabilityFiles = true
	record.ClickhouseAvailabilitySetID, record.ClickhouseAvailabilityMemberID = "", ""
	if !availability.Standalone {
		record.ClickhouseAvailabilitySetID = availability.SetID
		record.ClickhouseAvailabilityMemberID = availability.MemberID
	}
	return []string{
		filepath.Join(record.MountPath, chha.ServerConfigFile) + ":" + chha.ServerConfigTarget + ":ro",
		filepath.Join(record.MountPath, chha.UsersConfigFile) + ":" + chha.UsersConfigTarget + ":ro",
		filepath.Join(record.MountPath, chha.RoleConfigFile) + ":" + chha.RoleConfigTarget + ":ro",
	}, nil
}

// clickHouseInternalPasswordSHA256 is the hash of the member's internal user
// password, created once per data mount (root-only file, never leaves the
// node).
func clickHouseInternalPasswordSHA256(mountPath string) (string, error) {
	password, err := clickHouseInternalPassword(mountPath)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(password))
	return hex.EncodeToString(digest[:]), nil
}

func clickHouseInternalPassword(mountPath string) (string, error) {
	path := filepath.Join(mountPath, clickHouseInternalSecretFile)
	if data, err := os.ReadFile(path); err == nil && len(bytes.TrimSpace(data)) >= 32 {
		return string(bytes.TrimSpace(data)), nil
	}
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	password := hex.EncodeToString(buffer)
	if err := os.WriteFile(path, []byte(password+"\n"), 0o600); err != nil {
		return "", err
	}
	return password, nil
}

// placeClickHouseConvertFlags marks every MergeTree-family table of the
// running single-node engine for in-place conversion to its Replicated
// variant at the next start (convert_to_replicated, P0-T02 item 5).
func (m *managedDatabaseManager) placeClickHouseConvertFlags(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) error {
	var output bytes.Buffer
	query := "SELECT arrayStringConcat(data_paths, '\\n') FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') " +
		"AND engine LIKE '%MergeTree' AND engine NOT LIKE 'Replicated%' AND NOT is_temporary FORMAT TabSeparatedRaw"
	if err := m.runManagedDatabaseExecTo(ctx, record.ContainerID,
		[]string{"clickhouse-client", "--user", input.OwnerUsername, "--query", query}, "",
		[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}, &output); err != nil {
		return fmt.Errorf("list the tables to convert: %w", err)
	}
	for _, path := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if !strings.HasPrefix(path, "/var/lib/clickhouse/") || strings.Contains(path, "..") {
			return fmt.Errorf("unexpected table data path %q", path)
		}
		host := filepath.Join(record.MountPath, strings.TrimPrefix(path, "/var/lib/clickhouse/"), "convert_to_replicated")
		if err := os.WriteFile(host, nil, 0o644); err != nil {
			return fmt.Errorf("mark a table for conversion: %w", err)
		}
		if err := os.Chown(host, clickHouseUID, clickHouseUID); err != nil {
			return fmt.Errorf("mark a table for conversion: %w", err)
		}
	}
	return nil
}

// clickHouseUID is the clickhouse user of the official image.
const clickHouseUID = 101

// newClickHouseSetMember opens the ClickHouse engine of this node's member.
func newClickHouseSetMember(p *DockerPlugin, config memberha.Config) (memberha.Engine, error) {
	if p.databaseManager == nil {
		return nil, errors.New("this daemon runs no managed databases")
	}
	if config.OwnerKind != "managed_database" || !managedDatabaseIDPattern.MatchString(config.OwnerID) {
		return nil, errors.New("a ClickHouse member belongs to a managed database")
	}
	rt := &clickHouseMemberRuntime{plugin: p, setID: config.SetID, databaseID: config.OwnerID,
		cgroups: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot}, cgroupPaths: map[string]string{}}
	return chha.New(config, rt)
}

// clickHouseMemberRuntime is chha.Runtime over the managed database record.
type clickHouseMemberRuntime struct {
	plugin     *DockerPlugin
	setID      string
	databaseID string
	cgroups    *leaseEngine

	mu          sync.Mutex
	cgroupPaths map[string]string
	proxies     map[string]string
}

func (r *clickHouseMemberRuntime) record() (managedDatabaseRecord, error) {
	record, err := r.plugin.databaseManager.loadRecord(r.databaseID)
	if errors.Is(err, os.ErrNotExist) {
		// The create command waits for this member's container (pendingCreates).
		if pending, ok := r.plugin.databaseManager.pending.get(r.databaseID); ok {
			record, err = pending, nil
		}
	}
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	if record.Type != "clickhouse" {
		return managedDatabaseRecord{}, errors.New("the managed database is not a ClickHouse database")
	}
	return record, nil
}

func (r *clickHouseMemberRuntime) Logger() *slog.Logger { return r.plugin.logger }

func (r *clickHouseMemberRuntime) Container(ctx context.Context) (memberha.ContainerState, int, error) {
	record, err := r.record()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return memberha.ContainerState{}, 0, nil
		}
		return memberha.ContainerState{}, 0, err
	}
	r.ensureProxies(record)
	ref := r.containerRef(record)
	if ref == "" {
		return memberha.ContainerState{}, 0, nil
	}
	result, err := r.plugin.client.cli.ContainerInspect(ctx, ref, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return memberha.ContainerState{}, 0, nil
		}
		return memberha.ContainerState{}, 0, err
	}
	inspect := result.Container
	state := memberha.ContainerState{Exists: true, ID: inspect.ID}
	pid := 0
	if inspect.State != nil {
		state.Running, pid = inspect.State.Running, inspect.State.Pid
		if started, err := time.Parse(time.RFC3339Nano, inspect.State.StartedAt); err == nil && started.Year() > 1 {
			state.StartedAt = started
		}
	}
	state.CgroupPath = r.cgroups.cgroupPath(ctx, inspect, pid)
	r.mu.Lock()
	if state.Running {
		r.cgroupPaths[inspect.ID] = state.CgroupPath
	} else if known := r.cgroupPaths[inspect.ID]; known != "" {
		state.CgroupPath = known
	}
	r.mu.Unlock()
	return state, pid, nil
}

// containerRef is the member's container: its recorded id, or its name while
// the create command that makes it waits for it (pendingCreates).
func (r *clickHouseMemberRuntime) containerRef(record managedDatabaseRecord) string {
	if record.ContainerID != "" {
		return record.ContainerID
	}
	if _, creating := r.plugin.databaseManager.pending.get(r.databaseID); creating {
		return record.ContainerName
	}
	return ""
}

func (r *clickHouseMemberRuntime) Address(ctx context.Context) (string, error) {
	record, err := r.record()
	if err != nil {
		return "", err
	}
	ref := r.containerRef(record)
	if ref == "" {
		return "", errors.New("the ClickHouse member has no container")
	}
	result, err := r.plugin.client.cli.ContainerInspect(ctx, ref, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	inspect := result.Container
	if inspect.State == nil || !inspect.State.Running || inspect.NetworkSettings == nil {
		return "", errors.New("the ClickHouse member's container is not running")
	}
	endpoint := inspect.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return "", errors.New("the ClickHouse member has no private bridge address")
	}
	return endpoint.IPAddress.String(), nil
}

// Start mounts the member's storage and starts its container.
func (r *clickHouseMemberRuntime) Start(ctx context.Context) error {
	m := r.plugin.databaseManager
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(r.databaseID)
	if err != nil {
		return err
	}
	if record.Deleting || record.ContainerID == "" {
		return errors.New("the ClickHouse member has no container to start")
	}
	if m.repairs.running(record.ID) || record.DiskRepair.blocksEngine() {
		return errors.New("the ClickHouse member's disk is being repaired")
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	return m.startContainer(ctx, record.ContainerID)
}

func (r *clickHouseMemberRuntime) StopClean(ctx context.Context, timeout time.Duration) error {
	record, err := r.record()
	if err != nil || record.ContainerID == "" {
		return err
	}
	err = r.plugin.client.StopContainer(ctx, record.ContainerID, int(timeout.Seconds()))
	if err != nil && isNotFoundErr(err) {
		return nil
	}
	return err
}

func (r *clickHouseMemberRuntime) Kill(ctx context.Context) error {
	record, err := r.record()
	if err != nil || record.ContainerID == "" {
		return err
	}
	err = r.plugin.client.KillContainer(ctx, record.ContainerID, "KILL")
	if err != nil && (isNotFoundErr(err) || strings.Contains(err.Error(), "is not running")) {
		return nil
	}
	return err
}

func (r *clickHouseMemberRuntime) CgroupEmpty(ctx context.Context) (bool, error) {
	state, _, err := r.Container(ctx)
	if err != nil {
		return false, err
	}
	if !state.Exists {
		return true, nil
	}
	if state.Running {
		return false, nil
	}
	return leasefence.ContainerCgroupEmpty(leasefence.DefaultCgroupRoot, state.ID, state.CgroupPath)
}

var clickHouseHTTPClient = &http.Client{Transport: &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second}}

// Query runs SQL as the internal user over the engine's HTTP interface on the
// private bridge.
func (r *clickHouseMemberRuntime) Query(ctx context.Context, query string) (string, error) {
	record, err := r.record()
	if err != nil {
		return "", err
	}
	password, err := clickHouseInternalPassword(record.MountPath)
	if err != nil {
		return "", err
	}
	address, err := r.Address(ctx)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://"+net.JoinHostPort(address, strconv.Itoa(chha.HTTPPort))+"/", strings.NewReader(query))
	if err != nil {
		return "", err
	}
	request.Header.Set("X-ClickHouse-User", chha.InternalUser)
	request.Header.Set("X-ClickHouse-Key", password)
	response, err := clickHouseHTTPClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		message := strings.TrimSpace(string(body))
		if len(message) > 500 {
			message = message[:500]
		}
		return "", fmt.Errorf("ClickHouse answered %d: %s", response.StatusCode, message)
	}
	return string(body), nil
}

// KeeperClient runs one keeper-client command against the member's own Keeper.
func (r *clickHouseMemberRuntime) KeeperClient(ctx context.Context, command string) (string, error) {
	record, err := r.record()
	if err != nil {
		return "", err
	}
	var output bytes.Buffer
	ref := r.containerRef(record)
	if ref == "" {
		return "", errors.New("the ClickHouse member has no container")
	}
	err = r.plugin.databaseManager.runManagedDatabaseExecTo(ctx, ref,
		chha.KeeperClientCommand(command), "", nil, &output)
	text := output.String()
	if err == nil && chha.KeeperClientFailed(text) {
		err = errors.New(strings.TrimSpace(text))
	}
	return text, err
}

func (r *clickHouseMemberRuntime) mountFile(name string) (string, error) {
	if name == "" || name != filepath.Base(name) {
		return "", errors.New("invalid member file name")
	}
	record, err := r.record()
	if err != nil {
		return "", err
	}
	return filepath.Join(record.MountPath, name), nil
}

func (r *clickHouseMemberRuntime) ReadFile(name string) ([]byte, error) {
	path, err := r.mountFile(name)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

// WriteFile rewrites a mount file in place (truncate and write keep the inode
// a file bind mount of the container refers to).
func (r *clickHouseMemberRuntime) WriteFile(name string, data []byte) error {
	path, err := r.mountFile(name)
	if err != nil {
		return err
	}
	return writeClickHouseConfig(path, string(data))
}

func (r *clickHouseMemberRuntime) Exists(relative string) bool {
	if strings.Contains(relative, "..") {
		return false
	}
	record, err := r.record()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(record.MountPath, relative))
	return err == nil
}

func (r *clickHouseMemberRuntime) InternalPasswordSHA256() (string, error) {
	record, err := r.record()
	if err != nil {
		return "", err
	}
	return clickHouseInternalPasswordSHA256(record.MountPath)
}

func (r *clickHouseMemberRuntime) Listen(pid int, address string) (net.Listener, error) {
	return chha.ListenInNetns(pid, address)
}

func (r *clickHouseMemberRuntime) Bridge(connection net.Conn, alias string) error {
	return r.plugin.BridgeSetPeer(connection, r.setID, alias)
}

// Probe opens and closes one tunnel to alias (one attempt per route, a short
// budget: the holder loop must not wait on a dead witness).
func (r *clickHouseMemberRuntime) Probe(ctx context.Context, alias string) error {
	routes := r.plugin.setPeerRoutes(r.setID, alias)
	if len(routes) == 0 {
		return errRelayLaneUnavailable
	}
	deadline := time.Now().Add(3 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	var lastErr error = errRelayLaneUnavailable
	for _, route := range routes {
		tunnel, err := r.plugin.openRelaySourceOnce(route, deadline)
		if err == nil {
			tunnel.close()
			return nil
		}
		lastErr = err
	}
	return lastErr
}

func (r *clickHouseMemberRuntime) Config() (memberha.Config, bool) {
	if r.plugin.setMembers == nil {
		return memberha.Config{}, false
	}
	config, ok := r.plugin.setMembers.Config(r.setID)
	if !ok {
		r.detachProxies()
	}
	return config, ok
}

func (r *clickHouseMemberRuntime) OpfieldConnected() bool { return r.plugin.sessionLive.Load() }

func (r *clickHouseMemberRuntime) Sign(domain string, payload []byte) ([]byte, error) {
	if r.plugin.lease == nil || r.plugin.lease.keys == nil {
		return nil, errors.New("the node identity key is unavailable")
	}
	return availabilitylease.SignHolderStatement(r.plugin.lease.keys.SigningSigner(), domain, payload)
}

// ensureProxies serves the member's published ports through the member proxy
// (direct publication, lease-gated): HTTP and, when published, native TCP.
func (r *clickHouseMemberRuntime) ensureProxies(record managedDatabaseRecord) {
	if r.plugin.setMembers == nil {
		return
	}
	desired := map[string]string{}
	httpPort, nativePort := "8123", "9000"
	if record.TLSEnabled {
		httpPort, nativePort = "8443", "9440"
	}
	if !record.clickHouseAvailabilityMember() {
		return
	}
	if record.PublishedPort != 0 {
		desired["http"] = fmt.Sprintf("0.0.0.0:%d|%s", record.PublishedPort, httpPort)
	}
	if record.PublishedNativePort != 0 {
		desired["native"] = fmt.Sprintf("0.0.0.0:%d|%s", record.PublishedNativePort, nativePort)
	}
	r.mu.Lock()
	if r.proxies == nil {
		r.proxies = map[string]string{}
	}
	changes := map[string]string{}
	for name, spec := range desired {
		if r.proxies[name] != spec {
			changes[name] = spec
		}
	}
	for name := range r.proxies {
		if _, ok := desired[name]; !ok {
			changes[name] = ""
		}
	}
	r.mu.Unlock()
	for name, spec := range changes {
		if spec == "" {
			r.plugin.setMembers.DetachProxyPort(r.setID, name)
			r.mu.Lock()
			delete(r.proxies, name)
			r.mu.Unlock()
			continue
		}
		address, port, _ := strings.Cut(spec, "|")
		dial := func(ctx context.Context) (net.Conn, error) {
			target, err := r.Address(ctx)
			if err != nil {
				return nil, err
			}
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(target, port))
		}
		if err := r.plugin.setMembers.AttachProxyPort(r.setID, name, address, dial); err != nil {
			r.plugin.logger.Warn("ClickHouse member's published port could not be served", "set_id", r.setID, "port", name, "error", err)
			continue
		}
		r.mu.Lock()
		r.proxies[name] = spec
		r.mu.Unlock()
	}
}

func (r *clickHouseMemberRuntime) detachProxies() {
	r.mu.Lock()
	names := make([]string, 0, len(r.proxies))
	for name := range r.proxies {
		names = append(names, name)
	}
	r.proxies = map[string]string{}
	r.mu.Unlock()
	if r.plugin.setMembers == nil {
		return
	}
	for _, name := range names {
		r.plugin.setMembers.DetachProxyPort(r.setID, name)
	}
}

// MoveAside renames a path of the data mount to <path>.wiped-<unix> (a wiped
// Keeper state is kept for inspection), keeping the two newest such copies.
func (r *clickHouseMemberRuntime) MoveAside(relative string) error {
	if relative == "" || strings.Contains(relative, "..") || strings.Contains(relative, "/") {
		return errors.New("invalid member path")
	}
	record, err := r.record()
	if err != nil {
		return err
	}
	source := filepath.Join(record.MountPath, relative)
	if err := os.Rename(source, fmt.Sprintf("%s.wiped-%d", source, time.Now().Unix())); err != nil {
		return err
	}
	old, _ := filepath.Glob(source + ".wiped-*")
	sort.Strings(old)
	for len(old) > 2 {
		_ = os.RemoveAll(old[0])
		old = old[1:]
	}
	return nil
}

// PeerEngineState asks another member's member-control port for its engine facts.
func (r *clickHouseMemberRuntime) PeerEngineState(ctx context.Context, memberID string) (map[string]string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	state, ok := r.plugin.setPeerState(ctx, r.setID, memberID)
	if !ok {
		return nil, false
	}
	return state.Engine, true
}
