package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// The update rule of availability set members (rolling engine updates, P3-T07):
//
//   - a change that applies live (limits, a grown disk, a renewed certificate,
//     the published ports a member proxy serves) applies on every member;
//   - a change that needs the container recreated (a new engine image, a
//     setting fixed at creation) recreates a copy's container on the same data
//     while the member runtime is held, and is refused on the primary with
//     AVAILABILITY_SWITCHOVER_REQUIRED: Gateway switches over first and
//     retries on the old primary, a copy by then;
//   - Postgres never changes its major version in place (POSTGRES_MAJOR_CHANGE,
//     members and single-node databases alike): a major upgrade is a backup
//     restored into a new database.

// managedDatabaseVersionUpdateCapability: an update naming another engine
// image recreates the container on it with the data kept (Postgres: same
// major only, else POSTGRES_MAJOR_CHANGE; set members: the copy rule above).
// Gateway changes a database's engine version only on nodes with it.
const managedDatabaseVersionUpdateCapability = "managed_database_version_update_v1"

// postgresMajorChangeCode starts the refusal of an update that would run a
// data directory on another PostgreSQL major version.
const postgresMajorChangeCode = "POSTGRES_MAJOR_CHANGE"

// managedDatabaseImageDigest is the content digest of a curated image
// reference (the GHCR mirror of a curated image carries the same digest), or
// the reference itself without one.
func managedDatabaseImageDigest(reference string) string {
	if _, digest, ok := strings.Cut(strings.TrimSpace(reference), "@"); ok {
		return digest
	}
	return strings.TrimSpace(reference)
}

// containerImageChanged reports whether the database's container runs another
// image than the command names.
func (m *managedDatabaseManager) containerImageChanged(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) (bool, error) {
	if record.ContainerID == "" || strings.TrimSpace(input.Image) == "" {
		return false, nil
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Image == "" {
		return false, nil
	}
	return managedDatabaseImageDigest(inspect.Container.Config.Image) != managedDatabaseImageDigest(input.Image), nil
}

// withRecordPublication is input with the publication the record has: a set
// member's published ports are its member proxy's, so they never need a
// recreate.
func withRecordPublication(record managedDatabaseRecord, input managedDatabaseCommand) managedDatabaseCommand {
	input.PublishTCP, input.PublishedPort = record.PublishedPort != 0, record.PublishedPort
	input.PublishNativeTCP, input.PublishedNativePort = record.PublishedNativePort != 0, record.PublishedNativePort
	return input
}

// memberRecreateNeeded reports whether an update of a set member needs its
// container recreated (publication excluded), and whether the image changes.
func (m *managedDatabaseManager) memberRecreateNeeded(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) (recreate, imageChanged bool, err error) {
	imageChanged, err = m.containerImageChanged(ctx, record, input)
	if err != nil {
		return false, false, err
	}
	return imageChanged || managedDatabaseRequiresRecreate(record, withRecordPublication(record, input)), imageChanged, nil
}

// postgresMajorChange refuses running a data directory of major dataMajor on
// an image of major imageMajor.
func postgresMajorChange(dataMajor, imageMajor string) error {
	dataMajor, imageMajor = strings.TrimSpace(dataMajor), strings.TrimSpace(imageMajor)
	if dataMajor == "" || dataMajor == imageMajor {
		return nil
	}
	return fmt.Errorf("%s: the data directory is PostgreSQL %s and the image is PostgreSQL %s; a major upgrade is a backup restored into a new database",
		postgresMajorChangeCode, dataMajor, firstNonEmpty(imageMajor, "of an unknown version"))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// postgresDataMajor is the major version of the database's data directory
// ("" before the first start, or for a copy that is not seeded yet).
func postgresDataMajor(record managedDatabaseRecord) (string, error) {
	data, err := os.ReadFile(filepath.Join(record.MountPath, pgdataDirName, "PG_VERSION"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read the data directory's PostgreSQL version: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}

// postgresImageMajor is the PostgreSQL major version an image runs (PG_MAJOR of
// the official image); the image is pulled when missing.
func (m *managedDatabaseManager) postgresImageMajor(ctx context.Context, image string) (string, error) {
	local, err := m.client.EnsureThirdPartyImage(ctx, image)
	if err != nil {
		return "", err
	}
	inspected, err := m.client.cli.ImageInspect(ctx, local)
	if err != nil {
		return "", fmt.Errorf("inspect the PostgreSQL image: %w", err)
	}
	if inspected.Config != nil {
		for _, entry := range inspected.Config.Env {
			if value, ok := strings.CutPrefix(entry, "PG_MAJOR="); ok {
				return strings.TrimSpace(value), nil
			}
		}
	}
	return "", nil
}

// checkPostgresMajor refuses an image whose PostgreSQL major differs from the
// data directory's (members and single-node databases).
func (m *managedDatabaseManager) checkPostgresMajor(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) error {
	if record.Type != "postgres" {
		return nil
	}
	dataMajor, err := postgresDataMajor(record)
	if err != nil || dataMajor == "" {
		return err
	}
	imageMajor, err := m.postgresImageMajor(ctx, input.Image)
	if err != nil {
		return err
	}
	return postgresMajorChange(dataMajor, imageMajor)
}

// holdMemberCopy holds a set member whose container is about to be recreated,
// refusing the primary (memberha.ErrSwitchoverRequired).
func holdMemberCopy(ctx context.Context, members *memberha.Manager, setID string) (func(), error) {
	if members == nil {
		return nil, errors.New("the availability member runtime is not running on this node")
	}
	return members.HoldCopy(ctx, setID)
}

// recreatePGMemberContainer replaces a held Postgres copy's container on the
// same data (the member's labels, set network, mesh hosts and TLS): the old
// one stops cleanly and is renamed, then removed once the new one exists; on
// failure it gets its name back. The new container is not started: the member
// runtime starts it as a copy (standby at rest) unless the set is paused.
func (m *managedDatabaseManager) recreatePGMemberContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	previous := *record
	rollbackName := previous.ContainerName + "-rollback"
	renamed := false
	if previous.ContainerID != "" {
		if err := m.stopContainer(ctx, previous.ContainerID); err != nil {
			return err
		}
		if err := m.client.RenameContainer(ctx, previous.ContainerID, rollbackName); err != nil && !cerrdefs.IsNotFound(err) {
			return fmt.Errorf("preserve the member container: %w", err)
		}
		renamed = true
	}
	id, err := m.createPGMemberContainer(ctx, record, input, record.AvailabilitySetID, record.AvailabilityMemberID, record.NetworkName)
	if err != nil {
		if renamed {
			restoreCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			if restoreErr := m.client.RenameContainer(restoreCtx, previous.ContainerID, previous.ContainerName); restoreErr != nil {
				m.logger.Error("restore the member container's name after a failed recreate", "id", record.ID, "error", restoreErr)
			}
		}
		return err
	}
	record.ContainerID = id
	if renamed {
		if err := m.removePGContainerWithVolumes(ctx, previous.ContainerID); err != nil {
			m.logger.Warn("remove the replaced member container", "id", record.ID, "error", err)
		}
	}
	return nil
}

// pgMemberRecreate applies an update that needs a Postgres copy's container
// recreated (H1 extended by P3-T07): a new image of the same major, or a
// setting fixed at creation. The primary is refused.
func (m *managedDatabaseManager) pgMemberRecreate(ctx context.Context, id string, input managedDatabaseCommand, imageChanged bool) (string, error) {
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if imageChanged {
		if err := m.checkPostgresMajor(ctx, record, input); err != nil {
			return "", err
		}
	}
	members := m.pgSets.manager()
	release, err := holdMemberCopy(ctx, members, record.AvailabilitySetID)
	if err != nil {
		return "", err
	}
	defer release()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generations.bump(id)
	record, err = m.loadRecord(id)
	if err != nil {
		return "", err
	}
	if record.OperationID == input.OperationID && !input.PreserveLifecycleOperationID {
		return marshalManagedDatabaseDetail(record, "ready")
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return "", err
	}
	if input.StorageSizeBytes > record.StorageSize {
		if err := m.ensureStorageSize(ctx, &record, input.StorageSizeBytes); err != nil {
			return "", err
		}
	}
	if err := m.recreatePGMemberContainer(ctx, &record, input); err != nil {
		return "", err
	}
	record.TLSEnabled = input.TLSEnabled
	record.TLSCertificateID = input.TLSCertificateID
	record.PostgresMaxConnections = managedPostgresMaxConnections(input)
	record.PublishedPort = input.PublishedPort
	if !input.PublishTCP {
		record.PublishedPort = 0
	}
	applyManagedDatabaseOperationID(&record, input)
	if err := m.saveRecord(record); err != nil {
		return "", err
	}
	if err := m.attachPGMemberProxy(members, record, input); err != nil {
		m.logger.Warn("could not serve the published port of a recreated member", "id", id, "error", err)
	}
	return marshalManagedDatabaseDetail(record, "ready")
}

// updateClickHouseMember applies an update to a ClickHouse set member that
// stays one: live changes (limits, certificate, the published ports its
// member proxies serve) on any member; a recreate only on a copy.
func (m *managedDatabaseManager) updateClickHouseMember(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	recreate, _, err := m.memberRecreateNeeded(ctx, *record, input)
	if err != nil {
		return err
	}
	var members *memberha.Manager
	if m.plugin != nil {
		members = m.plugin.setMembers
	}
	if recreate {
		setID := record.ClickhouseAvailabilitySetID
		release, err := holdMemberCopy(ctx, members, setID)
		if err != nil {
			return err
		}
		defer release()
		if err := m.recreateContainer(ctx, record, input); err != nil {
			return err
		}
		if members.Stopped(setID) {
			// The set is paused: the member runtime keeps the engine down.
			if err := m.stopContainer(ctx, record.ContainerID); err != nil {
				m.logger.Warn("could not stop the recreated member of a paused set", "id", record.ID, "error", err)
			}
		}
		applyManagedDatabaseOperationID(record, input)
		return nil
	}
	if err := m.client.LiveUpdateContainer(ctx, record.ContainerID, managedDatabaseRuntimeJSON(input)); err != nil {
		return err
	}
	if input.TLSEnabled && record.TLSEnabled && input.TLSCertificateID != record.TLSCertificateID {
		leaf, err := leafCertificateFingerprint(input.TLSCertificatePEM, input.TLSPrivateKeyPEM)
		if err != nil {
			return err
		}
		// A member never restarts outside the member runtime (L1).
		if _, err := m.reloadTLS(ctx, record, input, leaf, false); err != nil {
			return fmt.Errorf("apply renewed managed database certificate: %w", err)
		}
	}
	// The member proxies follow the record's ports on the runtime's next
	// sample (ensureProxies): a dropped publication detaches, a restored one
	// attaches, without touching the container.
	pinned, _, err := pickManagedDatabaseHostPorts(input)
	if err != nil {
		return err
	}
	record.PublishedPort, record.PublishedNativePort = 0, 0
	if input.PublishTCP {
		record.PublishedPort = pinned.PublishedPort
		if input.PublishNativeTCP {
			record.PublishedNativePort = pinned.PublishedNativePort
		}
	}
	applyManagedDatabaseOperationID(record, input)
	return nil
}
