package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/pgha"
)

// Managed-database actions of Postgres availability set members (the JSON
// bodies are the contract with Opfield, contracts.md "ha-pg"), and the gate
// that keeps every other action from starting, restarting or recreating a
// member outside the member runtime, or running principal SQL anywhere but on
// the serving primary.
//
// Order: Opfield configures the member (AvailabilityMemberCommand configure,
// engine "postgres") first, then sends availability_member_ensure; the member
// runtime keeps off the container while the daemon prepares it.

// pgSetHooks connect the database manager to the member runtime.
type pgSetHooks struct {
	members func() *memberha.Manager
	mesh    func() pgSetMesh
	engines sync.Map // set id -> *pgSetMemberEngine
	// lifted serve the published port of a lifted member until its next
	// recreate gives it a Docker binding.
	liftedMu sync.Mutex
	lifted   map[string]*memberha.Proxy
}

func (h *pgSetHooks) manager() *memberha.Manager {
	if h.members == nil {
		return nil
	}
	return h.members()
}

type pgEnsureCommand struct {
	OperationID string `json:"operationId"`
	SetID       string `json:"setId"`
	MemberID    string `json:"memberId"`
	// Role "origin": the running single-node database becomes the member;
	// "copy": a new member, seeded by the member runtime with a base backup.
	Role     string                 `json:"role"`
	Database managedDatabaseCommand `json:"database"`
	// ControlUsername is an existing LOGIN superuser of the origin (its
	// control account), used once through the unix socket to create the
	// node-local role.
	ControlUsername string `json:"controlUsername,omitempty"`
}

type pgMemberRef struct {
	OperationID string `json:"operationId"`
	SetID       string `json:"setId"`
	MemberID    string `json:"memberId"`
}

type pgRestartCommand struct {
	pgMemberRef
	AllowPrimary bool `json:"allowPrimary,omitempty"`
}

type pgDetachCommand struct {
	pgMemberRef
	Evidence struct {
		NeverHeld       bool     `json:"neverHeld"`
		SeededMemberIDs []string `json:"seededMemberIds"`
	} `json:"evidence"`
}

type pgBallot struct {
	Round       uint64 `json:"round"`
	Incarnation uint64 `json:"incarnation"`
	Proposer    string `json:"proposer"`
}

type pgForceCommand struct {
	pgMemberRef
	// OverBallot is the newest commit ballot the operator saw.
	OverBallot     pgBallot `json:"overBallot"`
	AcceptDataLoss bool     `json:"acceptDataLoss"`
}

func decodePGSet(configJSON string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(configJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("parse availability member command: %w", err)
	}
	return nil
}

func pgOK(fields map[string]any) (string, error) {
	if fields == nil {
		fields = map[string]any{}
	}
	if _, ok := fields["status"]; !ok {
		fields["status"] = "ok"
	}
	data, err := json.Marshal(fields)
	return string(data), err
}

// pgPrincipalActions run principal SQL: only the serving primary runs them.
var pgPrincipalActions = map[string]bool{
	"postgres_query_principal_apply_v1": true, "postgres_query_writer_apply_v1": true,
	"binding_principal_apply_v2": true, "binding_principal_probe_v2": true, "binding_principal_drop_v2": true,
	"owner_separation_prepare_v1": true, "owner_separation_finalize_v1": true,
	"binding_create": true, "binding_remove": true, "binding_remove_v2": true,
}

// pgSetHandle runs the availability_member_* actions and gates the other
// actions of a Postgres set member. handled is false for actions the normal
// path runs.
func (m *managedDatabaseManager) pgSetHandle(ctx context.Context, action, id, configJSON string) (bool, string, error) {
	if strings.HasPrefix(action, "availability_") {
		detail, err := m.pgSetAction(ctx, action, id, configJSON)
		return true, detail, err
	}
	record, err := m.loadRecord(id)
	if err != nil || record.AvailabilityMemberID == "" || record.Type != "postgres" {
		return false, "", nil
	}
	switch action {
	case "inspect", "stats", "reload_tls", "probe_tls", "logs", "logs_stop", "leftovers":
		return false, "", nil
	case "update":
		detail, err := m.pgMemberUpdate(ctx, id, configJSON)
		return true, detail, err
	case "create", "start", "stop", "restart", "pause", "unpause", "remove":
		return true, "", fmt.Errorf("%s is not available for a member of an availability set (use the availability operations)", action)
	}
	if action == postgresExtensionApplyAction {
		// Extension DDL runs on the serving primary; copies follow through WAL.
		members := m.pgSets.manager()
		if members == nil {
			return true, "", errors.New("the availability member runtime is not running on this node")
		}
		if serving, known := members.MemberServing(record.AvailabilitySetID, record.AvailabilityMemberID); !known || !serving {
			return true, "", extensionError(extensionNotPrimaryCode, "this member is not the serving primary of its availability set; extensions change on the primary")
		}
	}
	if pgPrincipalActions[action] {
		members := m.pgSets.manager()
		if members == nil {
			return true, "", errors.New("the availability member runtime is not running on this node")
		}
		if serving, known := members.MemberServing(record.AvailabilitySetID, record.AvailabilityMemberID); !known || !serving {
			return true, "", errors.New("this member is not the serving primary of its availability set; principals are applied on the primary")
		}
	}
	return false, "", nil
}

func (m *managedDatabaseManager) pgSetAction(ctx context.Context, action, id, configJSON string) (string, error) {
	members := m.pgSets.manager()
	if members == nil {
		return "", errors.New("the availability member runtime is not running on this node (storage profile, lease watchdog)")
	}
	switch action {
	case "availability_member_ensure":
		var input pgEnsureCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.pgEnsure(ctx, members, id, input)
	case "availability_member_lift":
		var input pgMemberRef
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.pgLift(ctx, members, id, input, nil)
	case "availability_member_detach":
		var input pgDetachCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		evidence := memberha.DetachEvidence{NeverHeld: input.Evidence.NeverHeld, SeededMemberIDs: input.Evidence.SeededMemberIDs}
		return m.pgLift(ctx, members, id, input.pgMemberRef, &evidence)
	case "availability_member_remove":
		var input pgMemberRef
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		return m.pgRemove(ctx, members, id, input)
	case "availability_member_rebuild":
		var input pgMemberRef
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		engine, err := m.pgMemberEngine(id, input)
		if err != nil {
			return "", err
		}
		if err := engine.RequestRebuild(); err != nil {
			return "", err
		}
		return pgOK(map[string]any{"status": "accepted", "operationId": input.OperationID})
	case "availability_member_restart":
		var input pgRestartCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		if _, err := m.pgMemberEngine(id, input.pgMemberRef); err != nil {
			return "", err
		}
		if err := members.RestartMember(input.SetID, input.OperationID, input.AllowPrimary); err != nil {
			return "", err
		}
		return pgOK(map[string]any{"status": "accepted", "operationId": input.OperationID})
	case "availability_force_promote":
		var input pgForceCommand
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		if !input.AcceptDataLoss {
			return "", errors.New("a forced promotion needs acceptDataLoss")
		}
		if _, err := m.pgMemberEngine(id, input.pgMemberRef); err != nil {
			return "", err
		}
		result, err := members.ForcePromote(input.SetID, input.OperationID,
			memberha.Ballot{Round: input.OverBallot.Round, Incarnation: input.OverBallot.Incarnation, Proposer: input.OverBallot.Proposer})
		if err != nil {
			return "", err
		}
		data, err := json.Marshal(result)
		return string(data), err
	case "availability_force_status":
		var input pgMemberRef
		if err := decodePGSet(configJSON, &input); err != nil {
			return "", err
		}
		result, err := members.ForceStatusOf(input.SetID)
		if err != nil {
			return "", err
		}
		data, err := json.Marshal(result)
		return string(data), err
	}
	return "", fmt.Errorf("unsupported managed database action: %s", action)
}

// pgMemberEngine is the Postgres engine of the named member on this node.
func (m *managedDatabaseManager) pgMemberEngine(id string, ref pgMemberRef) (*pgSetMemberEngine, error) {
	value, ok := m.pgSets.engines.Load(ref.SetID)
	if !ok {
		return nil, errors.New("the set has no Postgres member on this node")
	}
	engine := value.(*pgSetMemberEngine)
	config := engine.Config()
	if config.MemberID != ref.MemberID || config.DatabaseID != id {
		return nil, errors.New("the set has another member on this node")
	}
	return engine, nil
}

// pgEnsure prepares this node's member: the origin keeps serving as the
// primary in a member container; a copy gets storage and a stopped member
// container that the runtime seeds.
func (m *managedDatabaseManager) pgEnsure(ctx context.Context, members *memberha.Manager, id string, input pgEnsureCommand) (string, error) {
	db := input.Database
	if err := validateManagedDatabaseInput(db); err != nil {
		return "", err
	}
	if db.Type != "postgres" || !db.TLSEnabled {
		return "", errors.New("availability needs a TLS-enabled PostgreSQL database")
	}
	if db.PublishTCP && db.PublishedPort == 0 {
		return "", errors.New("a member publishes an explicit port")
	}
	if input.Role != "origin" && input.Role != "copy" {
		return "", fmt.Errorf("unknown member role %q", input.Role)
	}
	engine, err := m.pgMemberEngine(id, pgMemberRef{SetID: input.SetID, MemberID: input.MemberID})
	if err != nil {
		return "", fmt.Errorf("configure the member first: %w", err)
	}
	release, err := members.Hold(ctx, input.SetID)
	if err != nil {
		return "", err
	}
	defer release()
	m.mu.Lock()
	defer m.mu.Unlock()
	networkName, err := m.pgSets.mesh().Ensure(ctx, input.SetID)
	if err != nil {
		return "", err
	}
	config := engine.Config()
	if input.Role == "origin" {
		return m.pgEnsureOrigin(ctx, members, id, input, engine, config, networkName)
	}
	return m.pgEnsureCopy(ctx, members, id, input, config, networkName)
}

func (m *managedDatabaseManager) pgEnsureOrigin(ctx context.Context, members *memberha.Manager, id string, input pgEnsureCommand, engine *pgSetMemberEngine, config pgha.Config, networkName string) (string, error) {
	record, err := m.loadRecord(id)
	if err != nil {
		return "", fmt.Errorf("the origin database has no record on this node: %w", err)
	}
	if record.Type != "postgres" || !record.TLSEnabled {
		return "", errors.New("availability needs a TLS-enabled PostgreSQL database")
	}
	if record.AvailabilityLiftedFrom != "" && record.AvailabilityMemberID == "" && record.AvailabilityLiftedFrom == input.MemberID {
		return "", errors.New("this member was lifted to a single-node database; a new availability period uses a new member")
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return "", err
	}
	member := engine.member
	if !m.isPGMemberContainer(ctx, record, input.MemberID) {
		if !managedDatabaseName.MatchString(input.ControlUsername) {
			return "", errors.New("the control account name is required to prepare the origin")
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		if err := m.waitForDatabaseReady(ctx, record.ContainerID, input.Database); err != nil {
			return "", err
		}
		if err := m.ensurePGLocalRole(ctx, record, input.ControlUsername, input.Database.OwnerPassword); err != nil {
			return "", err
		}
		if identities := config.Engine.Identities; identities != nil {
			// Still the single-node container: its pg_hba asks every socket connection for a password (the link
			// socket shares it), and the node-local role has none, so the principals are made as the control account.
			if err := m.ensurePGOriginIdentities(ctx, record, input.ControlUsername, input.Database.OwnerPassword, *identities); err != nil {
				return "", fmt.Errorf("create the set's principals: %w", err)
			}
		}
		if err := writePGMemberFiles(record, config); err != nil {
			return "", err
		}
		if err := m.stopContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		// The origin keeps running as the primary: the member settings, but
		// no standby.signal before this start (nothing else holds data yet).
		standby := config.StandbyConfig()
		if err := pgUpdateAutoConf(filepath.Join(record.MountPath, pgdataDirName), pgMemberAutoConfKeys, pgMemberAutoConf(standby, record.StorageSize)); err != nil {
			return "", err
		}
		if err := m.replaceWithPGMemberContainer(ctx, &record, input.Database, input.SetID, input.MemberID, networkName); err != nil {
			return "", err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		if err := m.waitForDatabaseReady(ctx, record.ContainerID, input.Database); err != nil {
			return "", err
		}
	} else {
		if err := writePGMemberFiles(record, config); err != nil {
			return "", err
		}
		if err := member.reloadConfig(ctx); err != nil {
			m.logger.Warn("could not reload the origin's configuration", "id", id, "error", err)
		}
		if identities := config.Engine.Identities; identities != nil {
			if err := member.EnsureIdentities(ctx, *identities); err != nil {
				return "", fmt.Errorf("converge the set's principals: %w", err)
			}
		}
	}
	// Standby at rest from now on: any restart comes up read-only.
	if err := member.MarkStandbyAtRest(ctx); err != nil {
		return "", err
	}
	m.applyPGMemberRecord(&record, input)
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	if err := m.attachPGMemberProxy(members, record, input.Database); err != nil {
		return "", err
	}
	return pgMemberDetail(record, "ready", input.MemberID)
}

func (m *managedDatabaseManager) pgEnsureCopy(ctx context.Context, members *memberha.Manager, id string, input pgEnsureCommand, config pgha.Config, networkName string) (string, error) {
	db := input.Database
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		record, err = m.createPGMemberStorage(ctx, id, db, networkName)
	}
	if err != nil {
		return "", err
	}
	if record.AvailabilityMemberID != "" && record.AvailabilityMemberID != input.MemberID {
		return "", errors.New("this node holds another member of the database")
	}
	if record.AvailabilityMemberID == "" && record.ContainerID != "" && !m.isPGMemberContainer(ctx, record, input.MemberID) && record.AvailabilitySetID == "" {
		// A plain database of the same id on this node is never replaced by a
		// copy (its data would be discarded by the seed).
		if running, _ := (&pgMember{m: m, id: id}).running(ctx, record); running || record.DesiredRunning {
			return "", errors.New("this node runs the database as a single-node database; a copy goes to another node")
		}
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return "", err
	}
	if err := writePGMemberFiles(record, config); err != nil {
		return "", err
	}
	if !m.isPGMemberContainer(ctx, record, input.MemberID) {
		if record.ContainerID != "" {
			if err := m.stopContainer(ctx, record.ContainerID); err != nil {
				return "", err
			}
			if err := m.removePGContainerWithVolumes(ctx, record.ContainerID); err != nil {
				return "", err
			}
		}
		record.NetworkName = networkName
		containerID, err := m.createPGMemberContainer(ctx, &record, db, input.SetID, input.MemberID, networkName)
		if err != nil {
			return "", err
		}
		record.ContainerID = containerID
	}
	m.applyPGMemberRecord(&record, input)
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	if err := m.attachPGMemberProxy(members, record, db); err != nil {
		return "", err
	}
	status := "ready"
	if _, statErr := os.Stat(filepath.Join(record.MountPath, pgdataDirName, "PG_VERSION")); errors.Is(statErr, os.ErrNotExist) {
		status = "seeding"
	}
	return pgMemberDetail(record, status, input.MemberID)
}

func (m *managedDatabaseManager) applyPGMemberRecord(record *managedDatabaseRecord, input pgEnsureCommand) {
	record.AvailabilitySetID, record.AvailabilityMemberID, record.AvailabilityLiftedFrom = input.SetID, input.MemberID, ""
	record.PublishedPort = input.Database.PublishedPort
	if !input.Database.PublishTCP {
		record.PublishedPort = 0
	}
	record.TLSCertificateID = input.Database.TLSCertificateID
	record.DesiredRunning = true
	record.OperationID = input.OperationID
	record.PostgresMaxConnections = managedPostgresMaxConnections(input.Database)
	record.PostgresPreloadLibraries = managedPostgresPreloadKey(input.Database)
}

// ensurePGLocalRole creates the node-local superuser through the unix socket
// as the control account (pg_hba rejects it on TCP).
// password is the control account's (the owner's): a single-node database with
// the link socket asks for it on the socket too.
func (m *managedDatabaseManager) ensurePGLocalRole(ctx context.Context, record managedDatabaseRecord, controlUsername, password string) error {
	statement := fmt.Sprintf("DO $gw$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN CREATE ROLE %s LOGIN SUPERUSER; END IF; END $gw$",
		pgLiteral(pgLocalRole), pgIdentifier(pgLocalRole))
	var env []string
	if password != "" {
		env = []string{"PGPASSWORD=" + password}
	}
	_, err := m.pgExecOutputEnv(ctx, record.ContainerID, []string{"psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-U", controlUsername, "-d", "postgres", "-c", statement}, "", env)
	if err != nil {
		return fmt.Errorf("create the node-local role: %w", err)
	}
	return nil
}

// ensurePGOriginIdentities converges the set principals on an origin that still
// runs its single-node container, through the unix socket as the control
// account with its password (the node-local role can log in without one only
// once the member pg_hba is in place).
func (m *managedDatabaseManager) ensurePGOriginIdentities(ctx context.Context, record managedDatabaseRecord, controlUsername, password string, identities pgha.Identities) error {
	var env []string
	if password != "" {
		env = []string{"PGPASSWORD=" + password}
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := m.pgExecOutputEnv(callCtx, record.ContainerID,
		[]string{"psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-U", controlUsername, "-d", "postgres"},
		pgIdentitiesSQL(identities), env)
	return err
}

// createPGMemberStorage allocates the data image of a new member (the
// container follows once its files exist).
func (m *managedDatabaseManager) createPGMemberStorage(ctx context.Context, id string, input managedDatabaseCommand, networkName string) (managedDatabaseRecord, error) {
	releaseReservation, err := m.reserveCapacity(input.StorageSizeBytes)
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	defer releaseReservation()
	record := m.newRecord(id, input)
	record.NetworkName = networkName
	record.DesiredRunning = true
	if err := m.createImage(ctx, record); err != nil {
		return managedDatabaseRecord{}, err
	}
	created := false
	defer func() {
		if !created {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			_ = m.cleanupStorage(cleanupCtx, &record, true)
		}
	}()
	if err := m.ensureMounted(ctx, &record); err != nil {
		return managedDatabaseRecord{}, err
	}
	if _, err := m.client.EnsureThirdPartyImage(ctx, input.Image); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.saveRecord(record); err != nil {
		return managedDatabaseRecord{}, err
	}
	created = true
	return record, nil
}

// createPGMemberContainer creates (does not start) the Postgres container of
// a set member. Unlike a single-node database it publishes no host port (the
// member proxy serves it, AS3), trusts the database CA for the set roles'
// client certificates, reaches the primary through the member mesh, keeps its
// pg_hba in the data volume and never restarts on its own.
func (m *managedDatabaseManager) createPGMemberContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand, setID, memberID, networkName string) (string, error) {
	image, err := m.client.EnsureThirdPartyImage(ctx, input.Image)
	if err != nil {
		return "", err
	}
	if err := writeManagedDatabaseTLS(m.tlsDirectory(*record), input); err != nil {
		return "", err
	}
	command := []string{
		"postgres",
		"-c", "ssl=on",
		"-c", "ssl_cert_file=" + pgContainerTLSDir + "/cert.pem",
		"-c", "ssl_key_file=" + pgContainerTLSDir + "/key.pem",
		"-c", "ssl_ca_file=" + pgContainerTLSDir + "/ca.pem",
		"-c", "hba_file=" + pgContainerHBAPath,
	}
	// Preload libraries and their settings are the same on every member.
	command = append(command, managedPostgresExtensionFlags(input)...)
	if err := m.ensurePostgresExtensionBundles(ctx, record, input); err != nil {
		return "", err
	}
	config := &container.Config{
		Image: image,
		Env:   engineEnvironment(input),
		Labels: map[string]string{
			managedDatabaseLabel:           record.ID,
			managedDatabaseTypeTag:         input.Type,
			pgMemberLabel:                  memberID,
			"net.opfield.availability.set": setID,
		},
		Cmd: command,
	}
	hostConfig := &container.HostConfig{
		Binds: []string{
			record.MountPath + ":" + pgContainerDataDir,
			m.tlsDirectory(*record) + ":" + pgContainerTLSDir + ":ro",
		},
		ExtraHosts:    m.pgSets.mesh().ExtraHosts(setID),
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		LogConfig:     container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		Resources: container.Resources{
			Memory: input.MemoryBytes, MemorySwap: input.MemorySwapBytes, NanoCPUs: input.NanoCPUs, CPUShares: input.CPUShares,
		},
	}
	if input.PidsLimit > 0 {
		pids := input.PidsLimit
		hostConfig.PidsLimit = &pids
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: config, HostConfig: hostConfig, Name: record.ContainerName,
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			networkName: {Aliases: []string{"database"}},
		}},
	})
	if err != nil {
		return "", fmt.Errorf("create the member container: %w", err)
	}
	return created.ID, nil
}

// replaceWithPGMemberContainer swaps the origin's container for a member one:
// the old one is stopped and renamed, and put back if the new one cannot be
// created.
func (m *managedDatabaseManager) replaceWithPGMemberContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand, setID, memberID, networkName string) error {
	previous := *record
	rollbackName := previous.ContainerName + "-rollback"
	renamed := false
	if previous.ContainerID != "" {
		if err := m.stopContainer(ctx, previous.ContainerID); err != nil {
			return err
		}
		if err := m.client.RenameContainer(ctx, previous.ContainerID, rollbackName); err != nil && !cerrdefs.IsNotFound(err) {
			return fmt.Errorf("preserve the database container: %w", err)
		}
		renamed = true
	}
	id, err := m.createPGMemberContainer(ctx, record, input, setID, memberID, networkName)
	if err != nil {
		if renamed {
			restoreCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			_ = m.client.RenameContainer(restoreCtx, previous.ContainerID, previous.ContainerName)
			_ = m.startContainer(restoreCtx, previous.ContainerID)
		}
		return err
	}
	record.ContainerID = id
	record.NetworkName = networkName
	if renamed {
		if err := m.removePGContainerWithVolumes(ctx, previous.ContainerID); err != nil {
			m.logger.Warn("remove the replaced database container", "id", record.ID, "error", err)
		}
	}
	return nil
}

// removePGContainerWithVolumes removes a database container together with the
// anonymous volume its image declares (the data itself is a bind mount).
func (m *managedDatabaseManager) removePGContainerWithVolumes(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	if _, err := m.client.cli.ContainerRemove(ctx, id, mobyclient.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !cerrdefs.IsNotFound(err) {
		return err
	}
	return nil
}

// isPGMemberContainer reports whether the recorded container is the named
// member's.
func (m *managedDatabaseManager) isPGMemberContainer(ctx context.Context, record managedDatabaseRecord, memberID string) bool {
	if record.ContainerID == "" {
		return false
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.Config == nil {
		return false
	}
	return inspect.Container.Config.Labels[pgMemberLabel] == memberID
}

// attachPGMemberProxy serves a member's published port (AS3): admitted only
// while the member serves with a fresh gate view. The member's configuration
// names the port (AvailabilityMemberConfig.published_port, 0 suspends the
// publication: the app kill switch); the database command's port is used only
// for a member the runtime does not know.
func (m *managedDatabaseManager) attachPGMemberProxy(members *memberha.Manager, record managedDatabaseRecord, input managedDatabaseCommand) error {
	port := 0
	if config, ok := members.Config(record.AvailabilitySetID); ok && config.MemberID == record.AvailabilityMemberID {
		port = int(config.PublishedPort)
	} else if input.PublishTCP {
		port = int(record.PublishedPort)
	}
	if port == 0 {
		members.DetachProxy(record.AvailabilitySetID)
		return nil
	}
	id := record.ID
	return members.AttachProxy(record.AvailabilitySetID, net.JoinHostPort("0.0.0.0", strconv.Itoa(port)),
		func(ctx context.Context) (net.Conn, error) {
			connection, _, err := m.dialRecord(ctx, id)
			return connection, err
		})
}

// restorePGMemberProxies serves the published ports of members and lifted
// members after a daemon start.
func (m *managedDatabaseManager) restorePGMemberProxies(members *memberha.Manager) {
	records, _, err := m.records()
	if err != nil {
		return
	}
	for _, record := range records {
		if record.Type != "postgres" || (record.PublishedPort == 0 && record.AvailabilityMemberID == "") {
			continue
		}
		switch {
		case record.AvailabilityMemberID != "" && members != nil:
			if err := m.attachPGMemberProxy(members, record, managedDatabaseCommand{PublishTCP: true}); err != nil {
				m.logger.Warn("could not serve the published port of a set member", "id", record.ID, "error", err)
			}
		case record.AvailabilityLiftedFrom != "" && !m.pgPublishedByDocker(record):
			if err := m.attachPGLiftedProxy(record); err != nil {
				m.logger.Warn("could not serve the published port of a lifted member", "id", record.ID, "error", err)
			}
		}
	}
}

// syncPGMemberProxy applies a member configuration's published port to the
// member proxy (a configure that moves it, e.g. to 0 and back).
func (m *managedDatabaseManager) syncPGMemberProxy(members *memberha.Manager, config memberha.Config) {
	record, err := m.loadRecord(config.OwnerID)
	if err != nil || record.Type != "postgres" || record.AvailabilitySetID != config.SetID || record.AvailabilityMemberID != config.MemberID {
		// Not prepared yet: availability_member_ensure attaches it.
		return
	}
	if err := m.attachPGMemberProxy(members, record, managedDatabaseCommand{PublishTCP: true}); err != nil {
		m.logger.Warn("could not serve the published port of a set member", "id", record.ID, "error", err)
	}
}

func (m *managedDatabaseManager) pgPublishedByDocker(record managedDatabaseRecord) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.HostConfig == nil {
		return false
	}
	return len(inspect.Container.HostConfig.PortBindings) > 0
}

// attachPGLiftedProxy serves the published port of a lifted member (now a
// single-node database) until a recreate gives it a Docker binding.
func (m *managedDatabaseManager) attachPGLiftedProxy(record managedDatabaseRecord) error {
	h := &m.pgSets
	h.liftedMu.Lock()
	defer h.liftedMu.Unlock()
	if h.lifted == nil {
		h.lifted = map[string]*memberha.Proxy{}
	}
	if h.lifted[record.ID] != nil || record.PublishedPort == 0 {
		return nil
	}
	id := record.ID
	proxy := memberha.NewProxy(net.JoinHostPort("0.0.0.0", strconv.Itoa(int(record.PublishedPort))), func() bool { return true },
		func(ctx context.Context) (net.Conn, error) {
			connection, _, err := m.dialRecord(ctx, id)
			return connection, err
		}, m.logger)
	if err := proxy.Start(); err != nil {
		return err
	}
	h.lifted[id] = proxy
	return nil
}

func (m *managedDatabaseManager) detachPGLiftedProxy(id string) {
	h := &m.pgSets
	h.liftedMu.Lock()
	proxy := h.lifted[id]
	delete(h.lifted, id)
	h.liftedMu.Unlock()
	if proxy != nil {
		proxy.Close()
	}
}

// pgLift returns this node's member to a single-node database: the retained
// primary of a closed set (a majority confirmed the close), a manual pair's
// remaining primary, or, with evidence, an origin detached before the first
// holder (H2). Standby at rest is lifted (the retained copy is promoted when
// it came back read-only), the set settings and the member pg_hba go, the
// record becomes single-node and the runtime forgets the member. Repeats
// answer ready, and so does a database that is no member (never touched).
func (m *managedDatabaseManager) pgLift(ctx context.Context, members *memberha.Manager, id string, ref pgMemberRef, detach *memberha.DetachEvidence) (string, error) {
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if record.AvailabilityMemberID == "" {
		if record.AvailabilityLiftedFrom == ref.MemberID {
			return pgOK(map[string]any{"status": "ready", "retained": true, "memberId": ref.MemberID})
		}
		// A plain database (a set that never converted it, e.g. a convert
		// that failed before the origin became a member) already runs as a
		// single node: the lift is done, and the database is left untouched.
		return pgOK(map[string]any{"status": "ready", "retained": true, "singleNode": true, "memberId": ref.MemberID})
	}
	if record.AvailabilityMemberID != ref.MemberID || record.AvailabilitySetID != ref.SetID {
		return "", errors.New("this node holds another member of the database")
	}
	value, ok := m.pgSets.engines.Load(ref.SetID)
	if !ok {
		return "", errors.New("the member runtime does not run this member")
	}
	engine := value.(*pgSetMemberEngine)
	if detach != nil {
		if err := members.Detach(ref.SetID, ref.OperationID, *detach); err != nil {
			return "", err
		}
	}
	release, err := members.Hold(ctx, ref.SetID)
	if err != nil {
		return "", err
	}
	defer release()
	primaryRunning, err := members.LiftCheck(ref.SetID, ref.MemberID)
	if err != nil {
		return "", err
	}
	member := engine.member
	if err := member.ClearStandbySignal(ctx); err != nil {
		return "", err
	}
	if !primaryRunning {
		running, err := member.running(ctx, record)
		if err != nil {
			return "", err
		}
		if !running {
			// Without standby.signal it comes up as the primary.
			if err := member.Start(ctx); err != nil {
				return "", err
			}
			if err := m.waitForPGAnswer(ctx, member); err != nil {
				return "", err
			}
		}
		status, err := member.Status(ctx)
		if err != nil {
			return "", err
		}
		if status.Answering && status.InRecovery {
			if err := member.Promote(ctx); err != nil {
				return "", fmt.Errorf("promote the retained member: %w", err)
			}
		}
	}
	if err := pgUpdateAutoConf(filepath.Join(record.MountPath, pgdataDirName), pgMemberOnlyAutoConfKeys, nil); err != nil {
		return "", err
	}
	if err := writeFileAtomically(pgMemberHBAPath(record), []byte(managedPostgresTLSHBA), 0o644, nil); err != nil {
		return "", err
	}
	if _, err := member.psql(ctx, "ALTER SYSTEM RESET synchronous_standby_names", "ALTER SYSTEM RESET restart_after_crash", "SELECT pg_reload_conf()"); err != nil {
		return "", fmt.Errorf("restore single-node settings: %w", err)
	}
	if err := member.SyncSlots(ctx, nil); err != nil {
		m.logger.Warn("could not drop the member slots of a lifted member", "id", id, "error", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err = m.loadRecord(id)
	if err != nil {
		return "", err
	}
	record.AvailabilityLiftedFrom, record.AvailabilitySetID, record.AvailabilityMemberID = ref.MemberID, "", ""
	record.DesiredRunning = true
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	members.DetachProxy(ref.SetID)
	m.pgSets.engines.Delete(ref.SetID)
	if err := members.Forget(ref.SetID); err != nil {
		return "", err
	}
	if record.PublishedPort != 0 {
		if err := m.attachPGLiftedProxy(record); err != nil {
			return "", fmt.Errorf("serve the published port: %w", err)
		}
	}
	return pgOK(map[string]any{"status": "ready", "retained": true, "detached": detach != nil, "memberId": ref.MemberID})
}

func (m *managedDatabaseManager) waitForPGAnswer(ctx context.Context, member *pgMember) error {
	for attempt := 0; attempt < 120; attempt++ {
		status, err := member.Status(ctx)
		if err == nil && status.Answering {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return errors.New("the database did not answer after its start")
}

// pgRemove removes a member that is not the primary (the runtime refuses the
// holder, a retained primary and a manual pair's assigned primary, B2): the
// runtime stops it for good, then its container, storage and record go and
// the runtime forgets it. A plain database is never removed this way.
func (m *managedDatabaseManager) pgRemove(ctx context.Context, members *memberha.Manager, id string, ref pgMemberRef) (string, error) {
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		_ = members.Forget(ref.SetID)
		return `{"status":"deleted"}`, nil
	}
	if err != nil {
		return "", err
	}
	if record.AvailabilityMemberID == "" {
		return "", errors.New("this database is not a member of an availability set on this node (it is a single-node database); a member removal never deletes it")
	}
	if record.AvailabilityMemberID != ref.MemberID || record.AvailabilitySetID != ref.SetID {
		return "", errors.New("this node holds another member of the database")
	}
	if config, ok := members.Config(ref.SetID); ok {
		if config.MemberID != ref.MemberID {
			return "", errors.New("the set has another member on this node")
		}
		if err := members.Remove(ref.SetID); err != nil {
			return "", err
		}
	}
	release, err := members.Hold(ctx, ref.SetID)
	if err != nil {
		return "", err
	}
	defer release()
	members.DetachProxy(ref.SetID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.removePGContainerWithVolumes(ctx, record.ContainerID); err != nil {
		return "", err
	}
	if mesh := m.pgSets.mesh; mesh != nil {
		mesh().Release(ref.SetID)
	}
	if err := m.remove(ctx, record); err != nil {
		return "", err
	}
	m.pgSets.engines.Delete(ref.SetID)
	if err := members.Forget(ref.SetID); err != nil {
		return "", err
	}
	return `{"status":"deleted"}`, nil
}

// pgMemberUpdate is update for a set member (H1): live changes on any
// member: limits are applied to the running container, the data image grows,
// a renewed certificate is reloaded in place, the published port is the
// member proxy's. A change that needs the container recreated (a new image of
// the same major, a setting fixed at creation) recreates a copy's container
// (pgMemberRecreate) and is refused on the primary
// (AVAILABILITY_SWITCHOVER_REQUIRED). The member pg_hba is never rewritten.
func (m *managedDatabaseManager) pgMemberUpdate(ctx context.Context, id, configJSON string) (string, error) {
	var input managedDatabaseCommand
	if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
		return "", fmt.Errorf("parse managed database config: %w", err)
	}
	current, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if err := pgMemberUpdateAllowed(current, input); err != nil {
		return "", err
	}
	if current.OperationID != input.OperationID || input.PreserveLifecycleOperationID {
		recreate, imageChanged, err := m.memberRecreateNeeded(ctx, current, input)
		if err != nil {
			return "", err
		}
		if recreate {
			return m.pgMemberRecreate(ctx, id, input, imageChanged)
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generations.bump(id)
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if err := pgMemberUpdateAllowed(record, input); err != nil {
		return "", err
	}
	if record.OperationID == input.OperationID && !input.PreserveLifecycleOperationID {
		return marshalManagedDatabaseDetail(record, "ready")
	}
	if input.StorageSizeBytes > record.StorageSize {
		if err := m.ensureStorageSize(ctx, &record, input.StorageSizeBytes); err != nil {
			return "", err
		}
	}
	if err := m.client.LiveUpdateContainer(ctx, record.ContainerID, managedDatabaseRuntimeJSON(input)); err != nil {
		return "", err
	}
	if input.TLSEnabled && record.TLSEnabled && input.TLSCertificateID != record.TLSCertificateID {
		leaf, err := leafCertificateFingerprint(input.TLSCertificatePEM, input.TLSPrivateKeyPEM)
		if err != nil {
			return "", err
		}
		// No restart fallback for a member (L1).
		if _, err := m.reloadTLS(ctx, &record, input, leaf, false); err != nil {
			return "", fmt.Errorf("apply renewed managed database certificate: %w", err)
		}
	}
	// Extension bundles apply to every member without a restart.
	if err := m.settlePostgresExtensionBundles(ctx, &record, input); err != nil {
		return "", err
	}
	// The published port is the member proxy's (its member configuration
	// names it); the record keeps what the command says.
	record.PublishedPort = input.PublishedPort
	if !input.PublishTCP {
		record.PublishedPort = 0
	}
	applyManagedDatabaseOperationID(&record, input)
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	return marshalManagedDatabaseDetail(record, "ready")
}

// pgMemberUpdateAllowed refuses an update no member takes: another engine,
// a smaller disk, a member without TLS.
func pgMemberUpdateAllowed(record managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := validateManagedDatabaseInput(input); err != nil {
		return err
	}
	if input.Type != record.Type {
		return errors.New("managed database engine cannot be changed")
	}
	if input.StorageSizeBytes < record.StorageSize {
		return errors.New("managed database storage cannot be reduced")
	}
	if !input.TLSEnabled {
		return errors.New("a member of an availability set keeps TLS")
	}
	return nil
}

func pgMemberDetail(record managedDatabaseRecord, status, memberID string) (string, error) {
	value, err := json.Marshal(map[string]any{
		"id": record.ID, "containerId": record.ContainerID, "status": status, "memberId": memberID,
		"publishedPort": record.PublishedPort, "tlsEnabled": record.TLSEnabled,
	})
	return string(value), err
}
