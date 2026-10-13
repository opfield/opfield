package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/docker-daemon/internal/swha"
)

// SeaweedFS set members on a newly pinned image (P3-T07). A daemon update that
// pins a new SeaweedFS image leaves set members on the image they run (the
// background mover of single-node storages skips them): the primary must not
// be recreated before Opfield switched over. Each member reports
// imageMove=pending while any of its containers runs another image; Opfield
// rolls the set like an engine update: a storage update whose set part carries
// imageMove recreates a copy's containers on the pinned image (same data,
// staging, hosts file and networks) under the member runtime's hold, and is
// refused on the primary with AVAILABILITY_SWITCHOVER_REQUIRED.

// managedAvailabilitySeaweedFSImageMoveCapability: SeaweedFS members report
// imageMove and take the imageMove update.
const managedAvailabilitySeaweedFSImageMoveCapability = "managed_availability_seaweedfs_image_move_v1"

// setImageMovePosition is the member report's position key (value "pending").
const setImageMovePosition = "imageMove"

var seaweedfsSetRoles = []swha.Role{swha.RoleVolume, swha.RoleFiler, swha.RoleMaster}

// seaweedfsSetImages remembers the image each member container runs, as the
// member runtime's samples see it (by set id), for the member report.
type seaweedfsSetImages struct {
	mu   sync.Mutex
	sets map[string]map[swha.Role]string
}

func (s *seaweedfsSetImages) observe(setID string, role swha.Role, image string, exists bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sets == nil {
		s.sets = map[string]map[swha.Role]string{}
	}
	roles := s.sets[setID]
	if roles == nil {
		roles = map[swha.Role]string{}
		s.sets[setID] = roles
	}
	if !exists || image == "" {
		delete(roles, role)
		return
	}
	roles[role] = image
}

// pending reports whether a container of the set's member here runs another
// image than the pinned one.
func (s *seaweedfsSetImages) pending(setID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, image := range s.sets[setID] {
		if !seaweedfsImageCurrent(image, seaweedfsImage) {
			return true
		}
	}
	return false
}

// seaweedfsSetImageOutdated inspects the member's containers: whether any
// runs another image than the pinned one, and which roles exist.
func (m *managedStorageManager) seaweedfsSetImageOutdated(ctx context.Context, record managedStorageRecord) (bool, map[swha.Role]bool, error) {
	outdated, existing := false, map[swha.Role]bool{}
	for _, role := range seaweedfsSetRoles {
		name := seaweedfsSetContainerName(record.namePrefix(), record.ID, record.Set.MemberIndex, role)
		inspect, err := m.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
		if isNotFoundErr(err) {
			continue
		}
		if err != nil {
			return false, nil, fmt.Errorf("inspect %s: %w", name, err)
		}
		if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedStorageLabel] != record.ID {
			return false, nil, fmt.Errorf("container %s exists and is not this storage member's", name)
		}
		existing[role] = true
		if !seaweedfsImageCurrent(inspect.Container.Config.Image, seaweedfsImage) {
			outdated = true
		}
	}
	return outdated, existing, nil
}

// moveSetMemberImage recreates a copy's containers on the pinned image
// (imageMove update). The containers are created, not started: the member
// runtime starts the copy again (volume server and filer; the master only on
// a promotion), or keeps it down while the set is paused. A member already on
// the pinned image answers ready without a recreate.
func (m *managedStorageManager) moveSetMemberImage(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	outdated, _, err := m.seaweedfsSetImageOutdated(ctx, *record)
	if err != nil {
		return err
	}
	if !outdated {
		if input.OperationID != "" {
			record.OperationID = input.OperationID
		}
		return nil
	}
	// Pulled before the hold: a pull may take minutes.
	image, err := m.ensureEngineImage(ctx, managedStorageEngineSeaweedFS)
	if err != nil {
		return err
	}
	if !seaweedfsImageCurrent(image, seaweedfsImage) {
		return fmt.Errorf("the pinned SeaweedFS image %s is not available on this node (it has %s)", seaweedfsImage, image)
	}
	if m.plugin == nil {
		return errors.New("the availability member runtime is not running on this node")
	}
	release, err := holdMemberCopy(ctx, m.plugin.setMembers, record.Set.SetID)
	if err != nil {
		return err
	}
	defer release()
	_, existing, err := m.seaweedfsSetImageOutdated(ctx, *record)
	if err != nil {
		return err
	}
	staging := m.seaweedfsStagingDir(*record)
	hostsPath := filepath.Join(m.seaweedfsSetDir(record.ID, record.Set.MemberIndex), seaweedfsSetHostsFile)
	for _, path := range []string{staging, hostsPath} {
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("the member's runtime files are missing (%s); an update with its settings restages them: %w", path, err)
		}
	}
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	if err := m.replaceSetContainers(ctx, record, existing, image, m.setNetworkOf(ctx, *record), staging, hostsPath); err != nil {
		return err
	}
	if input.OperationID != "" {
		record.OperationID = input.OperationID
	}
	return nil
}

// replaceSetContainers stops the member's containers cleanly and keeps them
// under a rollback name, creates the new ones on image (volume server and
// filer always, the master only where it existed), then removes the old ones.
// On a failure the new ones go and the old ones get their names back.
func (m *managedStorageManager) replaceSetContainers(ctx context.Context, record *managedStorageRecord, existing map[swha.Role]bool,
	image, setNetwork, staging, hostsPath string) error {
	previous := *record
	index := record.Set.MemberIndex
	kept := []swha.Role{}
	restore := func(created []string) {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		for _, id := range created {
			_ = m.client.RemoveContainer(cleanupCtx, id, true)
		}
		for _, role := range kept {
			name := seaweedfsSetContainerName(record.namePrefix(), record.ID, index, role)
			if err := m.client.RenameContainer(cleanupCtx, name+"-rollback", name); err != nil {
				m.logger.Error("restore a SeaweedFS member container after a failed image move", "id", record.ID, "role", role, "error", err)
			}
		}
		*record = previous
	}
	// The filer first: S3 clients go before the volume server they write to.
	for _, role := range []swha.Role{swha.RoleFiler, swha.RoleMaster, swha.RoleVolume} {
		if !existing[role] {
			continue
		}
		name := seaweedfsSetContainerName(record.namePrefix(), record.ID, index, role)
		if err := m.client.StopContainer(ctx, name, 30); err != nil && !isNotFoundErr(err) {
			restore(nil)
			return fmt.Errorf("stop the SeaweedFS %s: %w", role, err)
		}
		if err := m.client.RenameContainer(ctx, name, name+"-rollback"); err != nil {
			restore(nil)
			return fmt.Errorf("keep the SeaweedFS %s for a rollback: %w", role, err)
		}
		kept = append(kept, role)
	}
	record.Image = image
	created := []string{}
	for _, role := range seaweedfsSetRoles {
		if role == swha.RoleMaster && !existing[role] {
			continue
		}
		id, err := m.createSetContainer(ctx, *record, role, setNetwork, staging, hostsPath)
		if err != nil {
			restore(created)
			return err
		}
		created = append(created, id)
		if role == swha.RoleFiler {
			record.ContainerID = id
		}
	}
	for _, role := range kept {
		name := seaweedfsSetContainerName(record.namePrefix(), record.ID, index, role) + "-rollback"
		if err := m.client.RemoveContainer(ctx, name, true); err != nil && !isNotFoundErr(err) {
			m.logger.Warn("remove a replaced SeaweedFS member container", "id", record.ID, "role", role, "error", err)
		}
	}
	m.forgetEngineRun(previous.ContainerID)
	return nil
}

// setNetworkOf is the set network the member's filer is on: the name it has on this node (a set that joined the node
// before 2.12.1 keeps its earlier name), or the name a new one gets.
func (m *managedStorageManager) setNetworkOf(ctx context.Context, record managedStorageRecord) string {
	filer := seaweedfsSetContainerName(record.namePrefix(), record.ID, record.Set.MemberIndex, swha.RoleFiler)
	if inspect, err := m.client.cli.ContainerInspect(ctx, filer, mobyclient.ContainerInspectOptions{}); err == nil &&
		inspect.Container.NetworkSettings != nil {
		for _, name := range setMeshNetworkNames(record.Set.SetID) {
			if inspect.Container.NetworkSettings.Networks[name] != nil {
				return name
			}
		}
	}
	return setMeshNetworkName(record.Set.SetID)
}
