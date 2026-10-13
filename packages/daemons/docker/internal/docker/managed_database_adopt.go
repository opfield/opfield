package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	mobyclient "github.com/moby/moby/client"
)

// newRecord is the record a create of id writes once its container serves.
func (m *managedDatabaseManager) newRecord(id string, input managedDatabaseCommand) managedDatabaseRecord {
	prefix := managedDatabaseContainerPrefix()
	record := managedDatabaseRecord{
		ID:                     id,
		Type:                   input.Type,
		ContainerName:          prefix + id,
		NetworkName:            prefix + id + "-net",
		ImagePath:              filepath.Join(m.root, "images", id+".img"),
		MountPath:              filepath.Join(m.root, "mounts", id),
		StorageSize:            input.StorageSizeBytes,
		DesiredRunning:         true,
		PublishedPort:          input.PublishedPort,
		PublishedNativePort:    input.PublishedNativePort,
		TLSEnabled:             input.TLSEnabled,
		TLSCertificateID:       input.TLSCertificateID,
		ClickhouseConfigHash:   clickHouseConfigHash(input.ClickhouseConfig),
		RedisConfigHash:        managedRedisConfigHash(input),
		PostgresMaxConnections: managedPostgresMaxConnections(input),
		OperationID:            input.OperationID,
	}
	if input.Type == "clickhouse" {
		record.ClickhouseRuntimeProfileVersion = clickHouseRuntimeProfileVersion
	}
	return record
}

// ownedDatabaseContainer finds the container of a managed database by its
// owner label, which only a create of that id sets, so it is found without
// the record that names it, with the name prefix it carries (a container
// created before 2.12.1 keeps gwdb-). Empty when the node has none.
func (m *managedDatabaseManager) ownedDatabaseContainer(ctx context.Context, id string) (string, string, error) {
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedDatabaseLabel+"="+id),
	})
	if err != nil {
		return "", "", fmt.Errorf("list managed database containers: %w", err)
	}
	if len(listed.Items) == 0 {
		return "", "", nil
	}
	if len(listed.Items) == 1 {
		for _, name := range managedDatabaseContainerNames(id) {
			if slices.Contains(listed.Items[0].Names, "/"+name) {
				return listed.Items[0].ID, strings.TrimSuffix(name, id), nil
			}
		}
	}
	names := []string{}
	for _, item := range listed.Items {
		names = append(names, item.Names...)
	}
	return "", "", fmt.Errorf("the node has %d containers of this managed database (%v) and no record of it; keep the one that serves its data and remove the others", len(listed.Items), names)
}

// labelledDatabaseIDs are the managed database ids the node has containers
// of, with or without a record.
func (m *managedDatabaseManager) labelledDatabaseIDs(ctx context.Context) (map[string]bool, error) {
	ids := map[string]bool{}
	if m.client == nil {
		return ids, nil
	}
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedDatabaseLabel),
	})
	if err != nil {
		return nil, fmt.Errorf("list managed database containers: %w", err)
	}
	for _, item := range listed.Items {
		if id := item.Labels[managedDatabaseLabel]; id != "" {
			ids[id] = true
		}
	}
	return ids, nil
}

// removeLostRecord deletes what is left of a managed database the node holds
// no record of: every container with its owner label (the instance's, and one
// a replacement left), its network, then mount, loop device, image and TLS
// material by id. Only a delete runs it; the repair pass keeps the storage of
// such a container, since a retried create takes it over.
func (m *managedDatabaseManager) removeLostRecord(ctx context.Context, id string) error {
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedDatabaseLabel+"="+id),
	})
	if err != nil {
		return fmt.Errorf("list managed database containers: %w", err)
	}
	for _, item := range listed.Items {
		if err := m.client.RemoveContainer(ctx, item.ID, true); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove managed database container: %w", err)
		}
	}
	if len(listed.Items) > 0 {
		m.logger.Info("removing a managed database the node holds no record of", "id", id, "containers", len(listed.Items))
	}
	record := m.newRecord(id, managedDatabaseCommand{})
	for _, name := range managedDatabaseContainerNames(id) {
		_, _ = m.client.cli.NetworkRemove(ctx, name+"-net", mobyclient.NetworkRemoveOptions{})
	}
	return m.cleanupStorage(ctx, &record, true)
}

// missingRecordDetail answers an inspect of an id the node holds no record
// of with what the node still has of it. Opfield retries a deployment from
// it: a create where nothing is left provisions anew, and one where the
// container is left adopts the instance (see adoptLostRecord).
func (m *managedDatabaseManager) missingRecordDetail(ctx context.Context, id string) (string, error) {
	labelled, err := m.labelledDatabaseIDs(ctx)
	if err != nil {
		return jsonString(map[string]any{"status": "missing", "factsError": err.Error()})
	}
	_, statErr := os.Stat(filepath.Join(m.root, "images", id+".img"))
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return jsonString(map[string]any{"status": "missing", "factsError": statErr.Error()})
	}
	return jsonString(map[string]any{"status": "missing", "container": labelled[id], "storageImage": statErr == nil})
}

// adoptLostRecord takes over an instance whose record the node lost while
// its container and storage image stayed (a filesystem repair can do that).
// The image holds the data: it is mounted as it is and never formatted. The
// container is replaced by one made from Opfield's settings, with the
// previous one kept until the new one serves (see recreateContainer), and
// the record is written once it does. Without the image the data is gone,
// and the create is refused rather than starting the engine on an empty disk.
func (m *managedDatabaseManager) adoptLostRecord(ctx context.Context, record managedDatabaseRecord, containerID string, input managedDatabaseCommand) (managedDatabaseRecord, error) {
	info, err := os.Stat(record.ImagePath)
	if errors.Is(err, os.ErrNotExist) {
		return managedDatabaseRecord{}, errors.New("the node lost this managed database's record and storage image while its container remains; its data cannot be recovered on this node")
	}
	if err != nil {
		return managedDatabaseRecord{}, fmt.Errorf("stat managed database storage image: %w", err)
	}
	// The engine lets go of the image before it is mounted here, so the
	// filesystem is never mounted twice.
	if err := m.stopContainer(ctx, containerID); err != nil {
		return managedDatabaseRecord{}, err
	}
	record.ContainerID = containerID
	record.StorageSize = info.Size()
	if err := m.ensureStorageSize(ctx, &record, max(info.Size(), input.StorageSizeBytes)); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.createNetwork(ctx, record.NetworkName); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.recreateContainer(ctx, &record, input); err != nil {
		return managedDatabaseRecord{}, fmt.Errorf("take over the managed database left without its record: %w", err)
	}
	record.DesiredRunning = true
	if err := m.saveRecord(record); err != nil {
		return managedDatabaseRecord{}, err
	}
	m.logger.Warn("took over a managed database whose record was lost; its storage image was kept", "id", record.ID, "container", record.ContainerID)
	return record, nil
}
