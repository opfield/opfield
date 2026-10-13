package docker

import (
	"context"

	mobyclient "github.com/moby/moby/client"
)

// A daemon update that pins a new SeaweedFS image leaves the storages it finds
// running the image the previous daemon pinned: nothing else recreates their
// containers until Opfield updates or restarts them. The new daemon process
// therefore moves each running one to the pinned image once, in the
// background after its start (data kept, see recreate). A node that cannot
// pull the pinned image (it falls back to the upstream one) moves nothing, so
// no storage is recreated onto the image it already runs; the next start tries
// again.

// moveStoragesToPinnedImage moves the SeaweedFS storages among ids whose
// container runs another image than the pinned one. Each move holds the
// storage's locks, so it never runs alongside an Opfield command for it.
func (m *managedStorageManager) moveStoragesToPinnedImage(ctx context.Context, ids []string) {
	pinned := seaweedfsImage
	due := false
	for _, id := range ids {
		m.mu.Lock()
		record, err := m.loadRecord(id)
		m.mu.Unlock()
		if err != nil {
			continue
		}
		if _, outdated := m.seaweedfsRunningImageOutdated(ctx, record, pinned); outdated {
			due = true
			break
		}
	}
	if !due {
		return
	}
	// Pulled before any storage lock is taken: a pull may take minutes.
	image, err := m.ensureEngineImage(ctx, managedStorageEngineSeaweedFS)
	if err != nil {
		m.logger.Info("managed storages keep their engine image: the pinned SeaweedFS image could not be pulled; the next daemon start tries again", "image", pinned, "error", err)
		return
	}
	if image != pinned {
		m.logger.Info("managed storages keep their engine image: the pinned SeaweedFS image is not available on this node; the next daemon start tries again", "image", pinned, "available", image)
		return
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		m.moveStorageToPinnedImage(ctx, id, pinned)
	}
}

// moveStorageToPinnedImage recreates one storage on the pinned image when it
// still runs another one. A failed recreation restores the previous container
// (see recreate), so the storage keeps serving from the old image.
func (m *managedStorageManager) moveStorageToPinnedImage(ctx context.Context, id, pinned string) {
	ctx, cancel := context.WithTimeout(ctx, managedStorageCommandTimeout)
	defer cancel()
	// The same order as a certificate reload: its lock, then the manager's.
	unlockResource := m.tlsReloads.lock(id)
	defer unlockResource()
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if err != nil || record.Removed || record.engine() != managedStorageEngineSeaweedFS {
		return
	}
	from, outdated := m.seaweedfsRunningImageOutdated(ctx, record, pinned)
	if !outdated {
		return
	}
	skip := ""
	switch {
	case !record.DesiredRunning:
		skip = "the storage is stopped"
	case m.repairs.running(id) || record.DiskRepair.blocksEngine():
		skip = "its disk is being repaired"
	case record.MemberCount > 1:
		skip = "distributed storage is recreated with its member list"
	case len(m.missingRuntimeFiles(record)) > 0:
		skip = "its runtime files are missing"
	}
	if skip != "" {
		m.logger.Info("managed storage keeps its engine image until its next update: "+skip, "id", id, "image", from, "pinned", pinned)
		return
	}
	// A certificate reload that staged its files before this move sees the
	// container changed and is retried by Opfield.
	m.generations.bump(id)
	previousContainer := record.ContainerID
	replacement := managedStorageCommand{
		Engine:          managedStorageEngineSeaweedFS,
		PublishS3:       record.PublishS3,
		PublishedPort:   record.PublishedPort,
		PeerBindAddress: record.PeerBindAddress,
	}
	if err := m.recreate(ctx, &record, replacement); err != nil {
		m.logger.Warn("managed storage could not be moved to the pinned engine image; it keeps running the previous one", "id", id, "from", from, "to", pinned, "error", err)
		return
	}
	m.forgetEngineRun(previousContainer)
	if err := m.saveRecord(record); err != nil {
		m.logger.Warn("managed storage moved to the pinned engine image but its record could not be saved", "id", id, "from", from, "to", record.Image, "error", err)
		return
	}
	m.logger.Info("managed storage moved to the pinned engine image", "id", id, "from", from, "to", record.Image)
}

// seaweedfsRunningImageOutdated returns the image the storage's container was
// created from and whether it differs from pinned. A container that cannot be
// inspected or names no image is left alone.
func (m *managedStorageManager) seaweedfsRunningImageOutdated(ctx context.Context, record managedStorageRecord, pinned string) (string, bool) {
	if record.Removed || record.engine() != managedStorageEngineSeaweedFS || record.Set != nil || record.ContainerID == "" {
		return "", false
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.Config == nil || inspect.Container.Config.Image == "" {
		return "", false
	}
	image := inspect.Container.Config.Image
	return image, !seaweedfsImageCurrent(image, pinned)
}
