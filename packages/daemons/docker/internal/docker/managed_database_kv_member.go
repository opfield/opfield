package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"golang.org/x/sys/unix"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/kvha"
	"github.com/opfield/opfield/docker-daemon/internal/lease"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Valkey availability set members (P2-T03): a key-value store on Valkey runs
// one member per node of its set, as its usual container with three
// additions: it is on the set's private network, it starts as a replica of
// primary-kv-repl with the set's replication user and announces its member
// id (kvMemberArgs), and its ACL file has the replication user. The
// member runtime drives it through the kvha engine; this file prepares,
// converts, updates, lifts and removes the containers (availability_member_*
// actions with a "redis" database, the same contract as Postgres members) and
// keeps the other lifecycle actions off members.

const (
	kvSetEngine         = "valkey"
	kvReplicationPrefix = "user " + kvha.ReplicationUser + " "
)

// kvReplicationRules are the replication user's permissions: replication,
// promotion, status, pausing writes for a switchover and the ACL mirror.
var kvReplicationRules = []string{
	"~*", "&*", "-@all", "+ping", "+info", "+role", "+replicaof", "+psync", "+sync", "+replconf",
	"+acl|list", "+acl|setuser", "+acl|deluser", "+acl|save", "+client|pause", "+client|unpause",
}

func init() {
	RegisterSetMemberEngine(kvSetEngine, newValkeySetMember)
}

// kvSetHooks connect the database manager to the member runtime.
type kvSetHooks struct {
	members func() *memberha.Manager
	mesh    func() *setMesh
	engines sync.Map // set id -> *kvha.Engine
	// pending: members being created (create runs before the record names its set).
	pendingMu sync.Mutex
	pending   map[string]kvEnsureCommand
}

func (h *kvSetHooks) manager() *memberha.Manager {
	if h.members == nil {
		return nil
	}
	return h.members()
}

func (h *kvSetHooks) pendingFor(id string) (kvEnsureCommand, bool) {
	h.pendingMu.Lock()
	defer h.pendingMu.Unlock()
	input, ok := h.pending[id]
	return input, ok
}

func (h *kvSetHooks) setPending(id string, input *kvEnsureCommand) {
	h.pendingMu.Lock()
	defer h.pendingMu.Unlock()
	if h.pending == nil {
		h.pending = map[string]kvEnsureCommand{}
	}
	if input == nil {
		delete(h.pending, id)
		return
	}
	h.pending[id] = *input
}

// wireKVSetHooks connects the database manager to the member runtime and the
// member mesh (storage-profile daemons).
func (p *DockerPlugin) wireKVSetHooks() {
	if p.databaseManager == nil {
		return
	}
	p.databaseManager.kvSets.members = func() *memberha.Manager { return p.setMembers }
	p.databaseManager.kvSets.mesh = p.setMesh
}

type kvEnsureCommand struct {
	OperationID string                 `json:"operationId"`
	SetID       string                 `json:"setId"`
	MemberID    string                 `json:"memberId"`
	Role        string                 `json:"role"`
	Database    managedDatabaseCommand `json:"database"`
}

type kvMemberRef struct {
	OperationID string `json:"operationId"`
	SetID       string `json:"setId"`
	MemberID    string `json:"memberId"`
}

// kvLiftCommand turns the kept member back into the single-node store; it
// carries the store's settings (the node keeps no credentials).
// kvForceCommand is a forced promotion of this node's Valkey member (AS10).
type kvForceCommand struct {
	kvMemberRef
	OverBallot     pgBallot `json:"overBallot"`
	AcceptDataLoss bool     `json:"acceptDataLoss"`
}

type kvLiftCommand struct {
	kvMemberRef
	Database managedDatabaseCommand `json:"database"`
}

// kvSetHandle runs the availability_member_* actions of Valkey members and
// gates the other actions of a Valkey member. handled is false for actions
// that are not about a Valkey member.
func (m *managedDatabaseManager) kvSetHandle(ctx context.Context, action, id, configJSON string) (bool, string, error) {
	if strings.HasPrefix(action, "availability_member_") || action == "availability_force_promote" {
		if !m.kvAction(action, id, configJSON) {
			return false, "", nil
		}
		detail, err := m.kvSetAction(ctx, action, id, configJSON)
		return true, detail, err
	}
	record, err := m.loadRecord(id)
	if err != nil || record.AvailabilityMemberID == "" || record.Type != "redis" {
		return false, "", nil
	}
	switch action {
	case "update":
		detail, err := m.kvMemberUpdate(ctx, id, configJSON)
		return true, detail, err
	case "create", "start", "stop", "restart", "pause", "unpause", "remove":
		return true, "", fmt.Errorf("%s is not available for a member of an availability set (use the availability operations)", action)
	}
	return false, "", nil
}

// kvAction reports an availability_member_* action about a Valkey member: an
// ensure of a redis database, or a member of a set whose engine here is Valkey.
func (m *managedDatabaseManager) kvAction(action, id, configJSON string) bool {
	if action == "availability_member_ensure" {
		var probe struct {
			Database struct {
				Type string `json:"type"`
			} `json:"database"`
		}
		return json.Unmarshal([]byte(configJSON), &probe) == nil && probe.Database.Type == "redis"
	}
	var ref kvMemberRef
	if json.Unmarshal([]byte(configJSON), &ref) != nil {
		return false
	}
	if _, ok := m.kvSets.engines.Load(ref.SetID); ok {
		return true
	}
	record, err := m.loadRecord(id)
	return err == nil && record.Type == "redis" && record.AvailabilitySetID == ref.SetID && ref.SetID != ""
}

func (m *managedDatabaseManager) kvSetAction(ctx context.Context, action, id, configJSON string) (string, error) {
	members := m.kvSets.manager()
	if members == nil {
		return "", errors.New("the availability member runtime is not running on this node (storage profile, lease watchdog)")
	}
	switch action {
	case "availability_member_ensure":
		var input kvEnsureCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.kvEnsure(ctx, members, id, input)
	case "availability_member_lift":
		var input kvLiftCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.kvLift(ctx, members, id, input)
	case "availability_member_remove":
		var input kvMemberRef
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.kvRemove(ctx, members, id, input)
	case "availability_force_promote":
		// AS10: no member can take over (another history, ACLs not
		// mirrored); the operator accepted the loss and names this one.
		var input kvForceCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		if !input.AcceptDataLoss {
			return "", errors.New("a forced promotion needs acceptDataLoss")
		}
		if config, ok := members.Config(input.SetID); !ok || config.MemberID != input.MemberID || config.OwnerID != id {
			return "", errors.New("the set has another member on this node")
		}
		result, err := members.ForcePromote(input.SetID, input.OperationID,
			memberha.Ballot{Round: input.OverBallot.Round, Incarnation: input.OverBallot.Incarnation, Proposer: input.OverBallot.Proposer})
		if err != nil {
			return "", err
		}
		data, err := json.Marshal(result)
		return string(data), err
	}
	return "", fmt.Errorf("%s is not available for Valkey members", action)
}

// kvEnsure prepares this node's member: the origin's container is recreated
// as a member (it keeps its data and serves as the primary until the set's
// lease starts), a copy gets storage and a member container that syncs from
// the primary.
func (m *managedDatabaseManager) kvEnsure(ctx context.Context, members *memberha.Manager, id string, input kvEnsureCommand) (string, error) {
	db := input.Database
	if err := validateManagedDatabaseInput(db); err != nil {
		return "", err
	}
	if db.Type != "redis" || !managedRedisRunsValkey(db.Image) {
		return "", errors.New("availability needs a key-value store on Valkey (move the store to Valkey first)")
	}
	if input.Role != "origin" && input.Role != "copy" {
		return "", fmt.Errorf("unknown member role %q", input.Role)
	}
	config, ok := members.Config(input.SetID)
	if !ok || config.MemberID != input.MemberID || config.OwnerID != id || config.Engine != kvSetEngine {
		return "", errors.New("configure the member first (availability member command)")
	}
	release, err := members.Hold(ctx, input.SetID)
	if err != nil {
		return "", err
	}
	defer release()
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.kvSets.mesh().Ensure(ctx, input.SetID); err != nil {
		return "", err
	}
	m.kvSets.mesh().Expose(input.SetID, kvha.PrimaryHost, kvha.ServerPort, "primary-"+kvha.PortRepl)
	record, err := m.loadRecord(id)
	switch {
	case err == nil && record.AvailabilityMemberID == input.MemberID:
		// Already a member (a repeated command): make sure its container runs.
		if err := m.ensureMounted(ctx, &record); err != nil {
			return "", err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		return pgOK(map[string]any{"status": "ready", "memberId": input.MemberID})
	case err == nil && input.Role == "origin":
		if record.AvailabilityMemberID != "" {
			return "", errors.New("the database is a member of another availability set")
		}
		record.AvailabilitySetID, record.AvailabilityMemberID = input.SetID, input.MemberID
		if err := m.recreateContainer(ctx, &record, db); err != nil {
			return "", err
		}
		// The member container starts as a replica of a primary that does not
		// exist yet; the origin keeps serving as the primary at once.
		if err := m.kvPromoteLocal(ctx, record, config); err != nil {
			return "", err
		}
		record.OperationID = db.OperationID
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return pgOK(map[string]any{"status": "ready", "memberId": input.MemberID, "role": "origin"})
	case errors.Is(err, os.ErrNotExist) && input.Role == "copy":
		pending := input
		m.kvSets.setPending(id, &pending)
		defer m.kvSets.setPending(id, nil)
		created, err := m.create(ctx, id, db)
		if err != nil {
			return "", err
		}
		created.AvailabilitySetID, created.AvailabilityMemberID = input.SetID, input.MemberID
		if err := m.saveRecord(created); err != nil {
			return "", err
		}
		return pgOK(map[string]any{"status": "ready", "memberId": input.MemberID, "role": "copy"})
	case err != nil && !errors.Is(err, os.ErrNotExist):
		return "", err
	}
	return "", fmt.Errorf("a %s member cannot be prepared on this node's state", input.Role)
}

// kvMemberFor is the set member a container being created belongs to.
func (m *managedDatabaseManager) kvMemberFor(record managedDatabaseRecord) (setID, memberID string, ok bool) {
	if record.AvailabilitySetID != "" && record.AvailabilityMemberID != "" {
		return record.AvailabilitySetID, record.AvailabilityMemberID, true
	}
	if pending, found := m.kvSets.pendingFor(record.ID); found {
		return pending.SetID, pending.MemberID, true
	}
	return "", "", false
}

// kvMemberContainer turns a key-value store container being created into its
// member's (createPinnedContainer calls it before the create): the member's
// ha.conf and replication user, the set's network and the primary alias, and
// no Docker port binding (the member proxy publishes the port of the serving
// member only).
func (m *managedDatabaseManager) kvMemberContainer(record managedDatabaseRecord, input managedDatabaseCommand, dataSource string,
	containerCfg *container.Config, hostCfg *container.HostConfig) (setNetwork string, err error) {
	if input.Type != "redis" {
		return "", nil
	}
	setID, memberID, ok := m.kvMemberFor(record)
	if !ok {
		return "", nil
	}
	members := m.kvSets.manager()
	if members == nil {
		return "", errors.New("the availability member runtime is not running on this node")
	}
	config, found := members.Config(setID)
	if !found || config.MemberID != memberID {
		return "", errors.New("the availability member is not configured on this node")
	}
	args, err := kvMemberArgs(config)
	if err != nil {
		return "", err
	}
	if err := ensureKVReplicationUser(filepath.Join(dataSource, "users.acl"), config); err != nil {
		return "", err
	}
	mesh := m.kvSets.mesh()
	networkName, err := mesh.Ensure(context.Background(), setID)
	if err != nil {
		return "", err
	}
	mesh.Expose(setID, kvha.PrimaryHost, kvha.ServerPort, "primary-"+kvha.PortRepl)
	gateway, ok := mesh.Gateway(setID)
	if !ok {
		return "", errors.New("the availability set network has no gateway address")
	}
	containerCfg.Cmd = append(containerCfg.Cmd, args...)
	hostCfg.ExtraHosts = append(hostCfg.ExtraHosts, kvha.PrimaryHost+":"+gateway.String())
	containerCfg.ExposedPorts, hostCfg.PortBindings = nil, nil
	return networkName, nil
}

// kvMemberArgs are the member's server options: a replica of the primary with
// the set's replication user, announcing its member id (the primary lists its
// copies by member id). They are command-line options because the
// valkey-bundle entrypoint reads only the main config file for modules.
func kvMemberArgs(config memberha.Config) ([]string, error) {
	engine, err := kvha.ParseEngineConfig(config.EngineConfig)
	if err != nil {
		return nil, err
	}
	return []string{
		"--replicaof", kvha.PrimaryHost, strconv.Itoa(kvha.ServerPort),
		"--masteruser", kvha.ReplicationUser,
		"--masterauth", engine.ReplicationPassword,
		"--replica-read-only", "yes",
		"--replica-announce-ip", config.MemberID,
	}, nil
}

// ensureKVReplicationUser puts the set's replication user into the member's
// ACL file (Valkey loads it at start; ACL SAVE keeps users it knows).
func ensureKVReplicationUser(path string, config memberha.Config) error {
	engine, err := kvha.ParseEngineConfig(config.EngineConfig)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(engine.ReplicationPassword))
	line := kvReplicationPrefix + "on #" + hex.EncodeToString(digest[:]) + " " + strings.Join(kvReplicationRules, " ")
	current, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var lines []string
	for _, existing := range strings.Split(string(current), "\n") {
		if strings.TrimSpace(existing) == "" || strings.HasPrefix(existing, kvReplicationPrefix) {
			continue
		}
		lines = append(lines, existing)
	}
	lines = append(lines, line)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	uid, gid, err := managedDatabaseTLSOwner("redis")
	if err != nil {
		return err
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// kvPromoteLocal makes the member's server the primary (the origin while the
// set is being turned on).
func (m *managedDatabaseManager) kvPromoteLocal(ctx context.Context, record managedDatabaseRecord, config memberha.Config) error {
	engine, err := kvha.ParseEngineConfig(config.EngineConfig)
	if err != nil {
		return err
	}
	script := "redis-cli --no-auth-warning --user " + kvha.ReplicationUser + " REPLICAOF NO ONE"
	return m.runManagedDatabaseExec(ctx, record.ContainerID, []string{"sh", "-ec", script}, "",
		[]string{"REDISCLI_AUTH=" + engine.ReplicationPassword})
}

// kvMemberUpdate applies an update to a member (the member update rule,
// managed_database_member_update.go): limits, maxmemory, a grown disk and a
// renewed certificate apply live on any member; a change that needs the
// container recreated (a new Valkey image, settings fixed at creation)
// recreates a copy's container while the member runtime is held and is
// refused on the primary (AVAILABILITY_SWITCHOVER_REQUIRED).
func (m *managedDatabaseManager) kvMemberUpdate(ctx context.Context, id, configJSON string) (string, error) {
	var input managedDatabaseCommand
	if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
		return "", fmt.Errorf("parse managed database update: %w", err)
	}
	if err := validateManagedDatabaseInput(input); err != nil {
		return "", err
	}
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if input.Type != record.Type {
		return "", errors.New("managed database engine cannot be changed")
	}
	if input.StorageSizeBytes < record.StorageSize {
		return "", errors.New("managed database storage cannot be reduced")
	}
	if !managedRedisRunsValkey(input.Image) {
		return "", errors.New("a member of an availability set stays on Valkey")
	}
	members := m.kvSets.manager()
	if members == nil {
		return "", errors.New("the availability member runtime is not running on this node")
	}
	done := func() (string, error) {
		return pgOK(map[string]any{"status": "ready", "memberId": record.AvailabilityMemberID})
	}
	if record.OperationID == input.OperationID && !input.PreserveLifecycleOperationID {
		return done()
	}
	recreate, imageChanged, err := m.memberRecreateNeeded(ctx, record, input)
	if err != nil {
		return "", err
	}
	currentMaxmemory, liveMaxmemory := int64(0), false
	if recreate && !imageChanged && !managedDatabaseContainerSettingsChanged(record, withRecordPublication(record, input)) {
		// Only maxmemory differs in the config file: Valkey applies it live.
		currentMaxmemory, liveMaxmemory = m.redisMaxmemoryOnlyChange(record, input)
		recreate = !liveMaxmemory
	}
	if recreate {
		release, err := holdMemberCopy(ctx, members, record.AvailabilitySetID)
		if err != nil {
			return "", err
		}
		defer release()
		m.mu.Lock()
		defer m.mu.Unlock()
		m.generations.bump(id)
		if record, err = m.loadRecord(id); err != nil {
			return "", err
		}
		if input.StorageSizeBytes > record.StorageSize {
			if err := m.ensureStorageSize(ctx, &record, input.StorageSizeBytes); err != nil {
				return "", err
			}
			record.StorageSize = input.StorageSizeBytes
		}
		if err := m.recreateContainer(ctx, &record, input); err != nil {
			return "", err
		}
		if members.Stopped(record.AvailabilitySetID) {
			// The set is paused: the member runtime keeps the engine down.
			if err := m.stopContainer(ctx, record.ContainerID); err != nil {
				m.logger.Warn("could not stop the recreated member of a paused set", "id", id, "error", err)
			}
		}
		applyManagedDatabaseOperationID(&record, input)
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return done()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generations.bump(id)
	if record, err = m.loadRecord(id); err != nil {
		return "", err
	}
	if input.StorageSizeBytes > record.StorageSize {
		if err := m.ensureStorageSize(ctx, &record, input.StorageSizeBytes); err != nil {
			return "", err
		}
		record.StorageSize = input.StorageSizeBytes
	}
	// A lower maxmemory before the lower limit, a higher one after it.
	shrinking := liveMaxmemory && managedRedisMaxmemory(input) < currentMaxmemory
	if shrinking {
		if err := m.applyRedisMaxmemory(ctx, record, input); err != nil {
			return "", err
		}
	}
	if err := m.client.LiveUpdateContainer(ctx, record.ContainerID, managedDatabaseRuntimeJSON(input)); err != nil {
		return "", err
	}
	if liveMaxmemory && !shrinking {
		if err := m.applyRedisMaxmemory(ctx, record, input); err != nil {
			return "", err
		}
	}
	if input.TLSEnabled && record.TLSEnabled && input.TLSCertificateID != record.TLSCertificateID {
		leaf, err := leafCertificateFingerprint(input.TLSCertificatePEM, input.TLSPrivateKeyPEM)
		if err != nil {
			return "", err
		}
		// A member never restarts outside the member runtime (L1).
		if _, err := m.reloadTLS(ctx, &record, input, leaf, false); err != nil {
			return "", fmt.Errorf("apply renewed managed database certificate: %w", err)
		}
	}
	// The published port is the member proxy's (its member configuration).
	record.PublishedPort = input.PublishedPort
	if !input.PublishTCP {
		record.PublishedPort = 0
	}
	applyManagedDatabaseOperationID(&record, input)
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	return done()
}

// kvLift turns the kept member (availability turned off) back into the
// single-node store: its container is recreated without the member settings
// and serves as the primary of its own data.
func (m *managedDatabaseManager) kvLift(ctx context.Context, members *memberha.Manager, id string, command kvLiftCommand) (string, error) {
	ref := command.kvMemberRef
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if record.AvailabilityMemberID == "" && record.AvailabilitySetID == "" {
		// Already a single-node store (a set that never converted it, or a
		// repeated lift): the lift is done, the store is left untouched.
		return pgOK(map[string]any{"status": "lifted", "singleNode": true, "memberId": ref.MemberID})
	}
	if err := validateManagedDatabaseInput(command.Database); err != nil {
		return "", err
	}
	if record.AvailabilityMemberID != ref.MemberID || record.AvailabilitySetID != ref.SetID {
		return "", errors.New("the set has another member on this node")
	}
	release, err := members.Hold(ctx, ref.SetID)
	if err != nil {
		return "", err
	}
	defer release()
	input := command.Database
	// The single-node container publishes the port the member proxy serves.
	restorePublished, err := m.plugin.releaseSetPublished(ctx, ref.SetID)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record.AvailabilitySetID, record.AvailabilityMemberID = "", ""
	if err := m.recreateContainer(ctx, &record, input); err != nil {
		restorePublished()
		return "", err
	}
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	m.kvSets.engines.Delete(ref.SetID)
	if err := members.Forget(ref.SetID); err != nil {
		m.logger.Warn("the member runtime keeps the lifted Valkey member", "set_id", ref.SetID, "error", err)
	}
	m.kvSets.mesh().Release(ctx, ref.SetID)
	return pgOK(map[string]any{"status": "lifted", "memberId": ref.MemberID})
}

// kvRemove removes this node's member: container, storage and its runtime.
func (m *managedDatabaseManager) kvRemove(ctx context.Context, members *memberha.Manager, id string, ref kvMemberRef) (string, error) {
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		_ = members.Forget(ref.SetID)
		return pgOK(map[string]any{"status": "missing"})
	}
	if err != nil {
		return "", err
	}
	if record.AvailabilityMemberID != ref.MemberID {
		return "", errors.New("the set has another member on this node")
	}
	if config, ok := members.Config(ref.SetID); ok && config.MemberID == ref.MemberID {
		if serving, known := members.MemberServing(ref.SetID, ref.MemberID); known && serving {
			return "", errors.New("the primary cannot be removed; make another member primary first")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.remove(ctx, record); err != nil {
		return "", err
	}
	m.kvSets.engines.Delete(ref.SetID)
	if err := members.Forget(ref.SetID); err != nil {
		m.logger.Warn("the member runtime keeps the removed Valkey member", "set_id", ref.SetID, "error", err)
	}
	m.kvSets.mesh().Release(ctx, ref.SetID)
	return pgOK(map[string]any{"status": "removed", "memberId": ref.MemberID})
}

// newValkeySetMember opens the Valkey engine of one member.
func newValkeySetMember(p *DockerPlugin, config memberha.Config) (memberha.Engine, error) {
	if p.databaseManager == nil {
		return nil, errors.New("managed database storage is not initialized on this node")
	}
	host := &kvSetHost{plugin: p, m: p.databaseManager, id: config.OwnerID, initial: config,
		cgroups: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot}}
	engine, err := kvha.New(host)
	if err != nil {
		return nil, err
	}
	p.databaseManager.kvSets.engines.Store(config.SetID, engine)
	return engine, nil
}

// kvSetHost adapts the docker daemon to kvha.Host for one member.
type kvSetHost struct {
	plugin  *DockerPlugin
	m       *managedDatabaseManager
	id      string
	initial memberha.Config
	cgroups *leaseEngine
}

// aclMarkerPath remembers that this member mirrored its primary's ACL list
// (kvha.ACLMarker): it survives a daemon restart, as Valkey's ACL file does.
func (h *kvSetHost) aclMarkerPath() string {
	return filepath.Join(h.plugin.cfg.StateDir, "availability-valkey", h.initial.SetID+"-"+h.initial.MemberID+".acl-mirrored")
}

func (h *kvSetHost) ACLMirrored() bool {
	if h.plugin == nil || h.plugin.cfg == nil {
		return false
	}
	_, err := os.Stat(h.aclMarkerPath())
	return err == nil
}

func (h *kvSetHost) MarkACLMirrored() error {
	if h.plugin == nil || h.plugin.cfg == nil {
		return nil
	}
	path := h.aclMarkerPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, nil, 0o600)
}

func (h *kvSetHost) Config() memberha.Config {
	if h.plugin.setMembers != nil {
		if config, ok := h.plugin.setMembers.Config(h.initial.SetID); ok {
			return config
		}
	}
	return h.initial
}

func (h *kvSetHost) record() (managedDatabaseRecord, error) { return h.m.loadRecord(h.id) }

func (h *kvSetHost) Container(ctx context.Context) (kvha.ContainerInfo, error) {
	record, err := h.record()
	if errors.Is(err, os.ErrNotExist) {
		return kvha.ContainerInfo{}, nil
	}
	if err != nil || record.ContainerID == "" {
		return kvha.ContainerInfo{}, err
	}
	inspect, err := h.plugin.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		return kvha.ContainerInfo{}, nil
	}
	if err != nil {
		return kvha.ContainerInfo{}, err
	}
	c := h.cgroups.convert(ctx, inspect.Container)
	return kvha.ContainerInfo{Exists: true, Running: c.Running && !c.Restarting, ID: c.ID, CgroupPath: c.CgroupPath, StartedAt: c.StartedAt}, nil
}

func (h *kvSetHost) PrepareStandby(context.Context) error {
	record, err := h.record()
	if err != nil {
		return err
	}
	config := h.Config()
	inspect, err := h.plugin.client.cli.ContainerInspect(context.Background(), record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return err
	}
	image := ""
	if inspect.Container.Config != nil {
		image = inspect.Container.Config.Image
	}
	return ensureKVReplicationUser(filepath.Join(managedRedisDataPath(record, image), "users.acl"), config)
}

func (h *kvSetHost) Start(ctx context.Context) error {
	record, err := h.record()
	if err != nil {
		return err
	}
	if err := h.m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	return h.m.startContainer(ctx, record.ContainerID)
}

func (h *kvSetHost) Stop(ctx context.Context, _ time.Duration) error {
	record, err := h.record()
	if err != nil {
		return err
	}
	err = h.m.stopContainer(ctx, record.ContainerID)
	if isNotFoundErr(err) {
		return nil
	}
	return err
}

func (h *kvSetHost) Kill(ctx context.Context) error {
	record, err := h.record()
	if err != nil {
		return err
	}
	err = h.plugin.client.KillContainer(ctx, record.ContainerID, "KILL")
	if err != nil && (isNotFoundErr(err) || strings.Contains(strings.ToLower(err.Error()), "not running")) {
		return nil
	}
	return err
}

func (h *kvSetHost) CgroupEmpty(ctx context.Context) (bool, error) {
	info, err := h.Container(ctx)
	if err != nil {
		return false, err
	}
	if !info.Exists {
		return true, nil
	}
	return h.cgroups.CgroupEmpty(ctx, lease.Container{ID: info.ID, CgroupPath: info.CgroupPath, Running: info.Running})
}

func (h *kvSetHost) DialServer(ctx context.Context) (net.Conn, error) {
	record, err := h.record()
	if err != nil {
		return nil, err
	}
	inspect, err := h.plugin.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, err
	}
	if inspect.Container.NetworkSettings == nil {
		return nil, errors.New("the Valkey member has no network")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[setMeshNetworkName(h.initial.SetID)]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return nil, errors.New("the Valkey member is not on its set's network")
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), strconv.Itoa(kvha.ServerPort)))
}

func (h *kvSetHost) DialAlias(ctx context.Context, alias string) (net.Conn, error) {
	local, remote := net.Pipe()
	go func() {
		if err := h.plugin.BridgeSetPeer(remote, h.initial.SetID, alias); err != nil {
			_ = local.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		_ = local.SetDeadline(deadline)
	}
	return local, nil
}

func (h *kvSetHost) Expose(exposures []kvha.Exposure) {
	mesh := h.plugin.setMesh()
	for _, exposure := range exposures {
		mesh.Expose(h.initial.SetID, exposure.Host, exposure.Port, exposure.Alias)
	}
}

func (h *kvSetHost) SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool)) {
	h.plugin.setMesh().SetLocalPrimary(h.initial.SetID, dial)
}

func (h *kvSetHost) DiskFree() (uint64, bool, bool) {
	record, err := h.record()
	if err != nil {
		return 0, false, false
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(record.MountPath, &stat); err != nil {
		return 0, false, false
	}
	free := stat.Bavail * uint64(stat.Bsize)
	return free, free < 64*1024*1024, true
}

// Serve attaches the member proxy of the store's published port: the serving
// member's TLS port (or plain port without TLS).
func (h *kvSetHost) Serve() {
	config := h.Config()
	if h.plugin.setMembers == nil {
		return
	}
	if config.PublishedPort == 0 {
		h.plugin.setMembers.DetachProxy(config.SetID)
		return
	}
	address := ":" + strconv.Itoa(int(config.PublishedPort))
	if err := h.plugin.setMembers.AttachProxy(config.SetID, address, func(ctx context.Context) (net.Conn, error) {
		record, err := h.record()
		if err != nil {
			return nil, err
		}
		port := kvha.ServerPort
		if record.TLSEnabled {
			port = 6380
		}
		inspect, err := h.plugin.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
		if err != nil || inspect.Container.NetworkSettings == nil {
			return nil, errors.New("the Valkey member container is unavailable")
		}
		endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
		if endpoint == nil || !endpoint.IPAddress.IsValid() {
			return nil, errors.New("the Valkey member is not on its network")
		}
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), strconv.Itoa(port)))
	}); err != nil {
		h.plugin.logger.Warn("key-value store member proxy could not listen", "id", h.id, "address", address, "error", err)
	}
}

func (h *kvSetHost) Logger() *slog.Logger { return h.plugin.logger }
