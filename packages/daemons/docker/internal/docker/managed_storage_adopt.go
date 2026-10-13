package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	mobyclient "github.com/moby/moby/client"
)

// newRecord is the record a create of one member writes once its container
// serves.
func (m *managedStorageManager) newRecord(id string, input managedStorageCommand, image string) managedStorageRecord {
	record := managedStorageRecord{
		ID: id, Engine: input.Engine, ContainerName: fmt.Sprintf("gateway-storage-%s-%d", id, input.MemberIndex), NetworkName: "gateway-storage-" + id,
		ImagePath: filepath.Join(m.root, "storage", "images", fmt.Sprintf("%s-%d.img", id, input.MemberIndex)), MountPath: filepath.Join(m.root, "storage", "mounts", fmt.Sprintf("%s-%d", id, input.MemberIndex)),
		StorageBytes: input.Resources.StorageBytes, NanoCPUs: input.Resources.NanoCPUs, MemoryBytes: input.Resources.MemoryBytes,
		MemorySwapBytes: input.Resources.MemorySwapBytes, Image: image, MemberIndex: input.MemberIndex, MemberCount: max(1, len(input.Members)), PublishS3: input.PublishS3,
		PublishedPort: input.PublishedPort, PeerBindAddress: input.PeerBindAddress, TLSEnabled: input.TLS != nil,
		DesiredRunning: true, OperationID: input.OperationID,
	}
	if input.TLS != nil {
		record.TLSServerName = input.TLS.ServerName
	}
	if input.FTP != nil {
		record.FTPPort = input.FTP.Port
		record.FTPPassiveStart = input.FTP.PassivePortStart
		record.FTPPassiveCount = input.FTP.PassivePortCount
	}
	if input.SFTP != nil {
		record.SFTPPort = input.SFTP.Port
	}
	return record
}

// ownedMemberContainer finds the container of one member of a managed
// storage id by its owner labels. Empty when the node has none.
func (m *managedStorageManager) ownedMemberContainer(ctx context.Context, id string, member int) (string, error) {
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All: true,
		Filters: mobyclient.Filters{}.
			Add("label", managedStorageLabel+"="+id).
			Add("label", managedStorageMemberLabel+"="+strconv.Itoa(member)),
	})
	if err != nil {
		return "", fmt.Errorf("list managed storage containers: %w", err)
	}
	if len(listed.Items) == 0 {
		return "", nil
	}
	if len(listed.Items) == 1 && slices.Contains(listed.Items[0].Names, fmt.Sprintf("/gateway-storage-%s-%d", id, member)) {
		return listed.Items[0].ID, nil
	}
	names := []string{}
	for _, item := range listed.Items {
		names = append(names, item.Names...)
	}
	return "", fmt.Errorf("the node has %d containers of this managed storage member (%v) and no record of it; keep the one that serves its data and remove the others", len(listed.Items), names)
}

// missingRecordDetail answers an inspect of an id the node holds no record
// of with what the node still has of it. Opfield retries a deployment from
// it: a create where nothing is left provisions anew, and one where a
// member's container is left adopts the member (see adoptLostRecord).
func (m *managedStorageManager) missingRecordDetail(ctx context.Context, id string) (string, error) {
	labelled, err := m.labelledStorageIDs(ctx)
	if err != nil {
		return jsonString(map[string]any{"status": "missing", "factsError": err.Error()})
	}
	images, err := filepath.Glob(filepath.Join(m.root, "storage", "images", id+"-*.img"))
	if err != nil {
		return jsonString(map[string]any{"status": "missing", "factsError": err.Error()})
	}
	return jsonString(map[string]any{"status": "missing", "container": labelled[id], "storageImage": len(images) > 0})
}

// adoptLostRecord takes over a member whose record the node lost while its
// container and storage image stayed (a filesystem repair can do that). The
// image holds the data: it is mounted as it is and never formatted. The
// container is replaced by one made from Opfield's settings, with the
// previous one kept until the new one serves (see recreate), and the record
// is written once it does. Without the image the data is gone, and the create
// is refused rather than starting the engine on an empty disk.
func (m *managedStorageManager) adoptLostRecord(ctx context.Context, record managedStorageRecord, containerID string, input managedStorageCommand) (managedStorageRecord, error) {
	info, err := os.Stat(record.ImagePath)
	if errors.Is(err, os.ErrNotExist) {
		return managedStorageRecord{}, errors.New("the node lost this managed storage member's record and storage image while its container remains; its data cannot be recovered on this node")
	}
	if err != nil {
		return managedStorageRecord{}, fmt.Errorf("stat managed storage image: %w", err)
	}
	// The engine lets go of the image before it is mounted here, so the
	// filesystem is never mounted twice.
	if err := m.client.StopContainer(ctx, containerID, 20); err != nil && !isNotFoundErr(err) {
		return managedStorageRecord{}, err
	}
	record.ContainerID = containerID
	record.StorageBytes = info.Size()
	if err := m.ensureStorageSize(ctx, &record, max(info.Size(), input.Resources.StorageBytes)); err != nil {
		return managedStorageRecord{}, err
	}
	record.StorageBytes = max(info.Size(), input.Resources.StorageBytes)
	if err := m.prepareEngineDataRoot(record); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.createNetwork(ctx, record); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.recreate(ctx, &record, input); err != nil {
		return managedStorageRecord{}, fmt.Errorf("take over the managed storage member left without its record: %w", err)
	}
	record.DesiredRunning = true
	if err := m.saveRecord(record); err != nil {
		return managedStorageRecord{}, err
	}
	m.logger.Warn("took over a managed storage member whose record was lost; its storage image was kept", "id", record.ID, "member", record.MemberIndex, "container", record.ContainerID)
	return record, nil
}

// removeLostRecord removes what is left of a managed storage id the node holds
// no record of: every container with its owner label, its network, and for
// each member found (by container label or by its image or mount point) the
// mount and loop device. With deleteData the image and staged files go too;
// without it the image is kept under a removed record, like any removed
// member, so the repair pass does not take it for an orphan. Only a removal
// runs it; the repair pass keeps the storage of such a container, since a
// retried create takes it over.
func (m *managedStorageManager) removeLostRecord(ctx context.Context, id string, deleteData bool) error {
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedStorageLabel+"="+id),
	})
	if err != nil {
		return fmt.Errorf("list managed storage containers: %w", err)
	}
	members := map[int]bool{}
	for _, item := range listed.Items {
		if member, err := strconv.Atoi(item.Labels[managedStorageMemberLabel]); err == nil {
			members[member] = true
		}
		if err := m.client.RemoveContainer(ctx, item.ID, true); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove managed storage container: %w", err)
		}
	}
	if len(listed.Items) > 0 {
		m.logger.Info("removed the containers of a managed storage the node holds no record of", "id", id, "containers", len(listed.Items))
	}
	_, _ = m.client.cli.NetworkRemove(ctx, "gateway-storage-"+id, mobyclient.NetworkRemoveOptions{})
	for _, dir := range []string{"images", "mounts"} {
		names, err := filepath.Glob(filepath.Join(m.root, "storage", dir, id+"-*"))
		if err != nil {
			return err
		}
		for _, name := range names {
			if found, member, ok := cutStorageMemberName(strings.TrimSuffix(filepath.Base(name), ".img")); ok && found == id {
				members[int(member)] = true
			}
		}
	}
	for member := range members {
		record := m.newRecord(id, managedStorageCommand{MemberIndex: member}, "")
		record.DesiredRunning = false
		if err := m.removeSeaweedFSStaging(record); err != nil {
			return err
		}
		if deleteData {
			for _, directory := range []string{"tls", "sftp"} {
				_ = os.RemoveAll(filepath.Join(m.root, "storage", directory, fmt.Sprintf("%s-%d", id, member)))
			}
			if err := m.cleanupStorage(ctx, &record, true); err != nil {
				return err
			}
			continue
		}
		if err := m.cleanupStorage(ctx, &record, false); err != nil {
			return err
		}
		if err := m.loopHost().removeMountPoint(record.MountPath); err != nil {
			return err
		}
		if _, err := os.Stat(record.ImagePath); err == nil {
			record.Removed = true
			if err := m.saveRecord(record); err != nil {
				return err
			}
		}
	}
	return nil
}

// labelledStorageIDs are the managed storage ids the node has containers of,
// with or without a record.
func (m *managedStorageManager) labelledStorageIDs(ctx context.Context) (map[string]bool, error) {
	ids := map[string]bool{}
	if m.client == nil {
		return ids, nil
	}
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedStorageLabel),
	})
	if err != nil {
		return nil, fmt.Errorf("list managed storage containers: %w", err)
	}
	for _, item := range listed.Items {
		if id := item.Labels[managedStorageLabel]; id != "" {
			ids[id] = true
		}
	}
	return ids, nil
}
