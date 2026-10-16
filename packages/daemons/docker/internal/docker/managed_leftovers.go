package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// A managed instance can leave things on its node that no record describes:
// a container a delete or an interrupted recreation left behind, or a record
// file that cannot be read (zeroed by a crash) with its image and mount point.
// The repair pass leaves both alone, since the node cannot tell a lost record
// of a live instance from one Opfield deleted. Opfield can: it lists them
// (leftovers) and, for ids it has no instance of, removes them with a remove
// command marked as such (leftoverRemove).

// managedLeftover is what the node keeps of one id it holds no readable
// record of.
type managedLeftover struct {
	ID string `json:"id"`
	// Record is "unreadable" (the file exists but cannot be read),
	// "missing", or "member": a readable record of an availability set
	// member (Opfield removes it when it has no instance of the id or no
	// such member on this node any more: a set deleted or a member removed
	// while its node could not be reached).
	Record     string   `json:"record"`
	SetID      string   `json:"setId,omitempty"`
	MemberID   string   `json:"memberId,omitempty"`
	ReadError  string   `json:"readError,omitempty"`
	Containers []string `json:"containers,omitempty"`
	// ImageBytes is the size of its images, AllocatedBytes what they occupy
	// on the node's disk.
	ImageBytes     int64 `json:"imageBytes"`
	AllocatedBytes int64 `json:"allocatedBytes"`
}

// leftoverCommand is the payload of a remove Opfield sends for a leftover:
// it confirms that it has no instance of the id.
type leftoverCommand struct {
	Leftover bool `json:"leftover"`
	// MemberID names the member a "member" leftover was listed with; the
	// node refuses when its record names another one by now.
	MemberID string `json:"memberId,omitempty"`
}

func leftoverMemberID(configJSON string) string {
	var command leftoverCommand
	if json.Unmarshal([]byte(configJSON), &command) != nil {
		return ""
	}
	return command.MemberID
}

func isLeftoverRemove(configJSON string) bool {
	if configJSON == "" {
		return false
	}
	var command leftoverCommand
	return json.Unmarshal([]byte(configJSON), &command) == nil && command.Leftover
}

// errNotALeftover refuses a leftover remove of an id the node has a readable
// record of: an instance created since Opfield listed the leftovers.
var errNotALeftover = errors.New("the node has a record of this instance; it is not a leftover and was not removed")

func marshalLeftovers(byID map[string]*managedLeftover) (string, error) {
	return marshalLeftoversWithMembers(byID, nil)
}

// marshalLeftoversWithMembers lists the leftovers and the availability set
// members the node runs (Opfield decides which members are left over).
func marshalLeftoversWithMembers(byID map[string]*managedLeftover, members []managedLeftover) (string, error) {
	items := make([]managedLeftover, 0, len(byID)+len(members))
	items = append(items, members...)
	for _, item := range byID {
		sort.Strings(item.Containers)
		items = append(items, *item)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return jsonString(map[string]any{"items": items})
}

// addImage counts an image file of a leftover.
func (l *managedLeftover) addImage(path string) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	l.ImageBytes += info.Size()
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		l.AllocatedBytes += int64(stat.Blocks) * 512
	}
}

// listLeftoverContainers adds the containers labelled with label whose id has
// no readable record.
func listLeftoverContainers(ctx context.Context, client *Client, label string, readable map[string]bool, byID map[string]*managedLeftover) error {
	if client == nil {
		return nil
	}
	listed, err := client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", label),
	})
	if err != nil {
		return fmt.Errorf("list managed containers: %w", err)
	}
	for _, item := range listed.Items {
		id := item.Labels[label]
		if id == "" || readable[id] {
			continue
		}
		leftover := byID[id]
		if leftover == nil {
			leftover = &managedLeftover{ID: id, Record: "missing"}
			byID[id] = leftover
		}
		name := item.ID
		if len(item.Names) > 0 {
			name = strings.TrimPrefix(item.Names[0], "/")
		}
		leftover.Containers = append(leftover.Containers, name)
	}
	return nil
}

// leftovers lists the storage ids the node keeps something of without a
// readable record. Called under the manager lock.
func (m *managedStorageManager) leftovers(ctx context.Context) (string, error) {
	records, unreadable, err := m.records()
	if err != nil {
		return "", err
	}
	readable := map[string]bool{}
	for _, record := range records {
		readable[record.ID] = true
	}
	byID := map[string]*managedLeftover{}
	for _, bad := range unreadable {
		byID[bad.ID] = &managedLeftover{ID: bad.ID, Record: "unreadable", ReadError: bad.Err.Error()}
	}
	if err := listLeftoverContainers(ctx, m.client, managedStorageLabel, readable, byID); err != nil {
		return "", err
	}
	members := []managedLeftover{}
	for _, record := range records {
		if record.Set != nil && !record.Removed {
			members = append(members, managedLeftover{ID: record.ID, Record: "member", SetID: record.Set.SetID, MemberID: record.Set.MemberID})
		}
	}
	members = append(members, runtimeLeftoverMembers(m.plugin, "managed_storage", readable)...)
	for id, leftover := range byID {
		images, _ := filepath.Glob(filepath.Join(m.root, "storage", "images", id+"-*.img"))
		for _, image := range images {
			if found, _, ok := cutStorageMemberName(strings.TrimSuffix(filepath.Base(image), ".img")); ok && found == id {
				leftover.addImage(image)
			}
		}
	}
	return marshalLeftoversWithMembers(byID, members)
}

// removeLeftover removes everything of a storage id Opfield has no instance
// of: its containers, network, images, mount points, staged files and the
// record file that cannot be read. An id with a readable record is refused.
func (m *managedStorageManager) removeLeftover(ctx context.Context, id, configJSON string) error {
	if record, err := m.loadRecord(id); err == nil {
		memberID := leftoverMemberID(configJSON)
		if record.Set == nil || record.Removed || memberID == "" || record.Set.MemberID != memberID {
			return errNotALeftover
		}
		// A member of a set Opfield no longer has (or a member it removed
		// while this node could not be reached): containers, member runtime,
		// mesh, disk and record go.
		if err := m.removeSetMember(ctx, record); err != nil {
			return err
		}
		if err := m.remove(ctx, &record, true); err != nil {
			return err
		}
		m.logger.Info("removed an availability member of a storage Opfield no longer has it of", "id", id, "set_id", record.Set.SetID, "member_id", memberID)
		return nil
	}
	if err := m.removeLostRecord(ctx, id, true); err != nil {
		return err
	}
	if err := os.Remove(m.recordPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove managed storage record: %w", err)
	}
	forgetRuntimeMember(ctx, m.plugin, id, leftoverMemberID(configJSON))
	m.logger.Info("removed what was left of a managed storage Opfield has no instance of", "id", id)
	return nil
}

// leftovers lists the database ids the node keeps something of without a
// readable record. Called under the manager lock.
func (m *managedDatabaseManager) leftovers(ctx context.Context) (string, error) {
	records, unreadable, err := m.records()
	if err != nil {
		return "", err
	}
	readable := map[string]bool{}
	for _, record := range records {
		readable[record.ID] = true
	}
	byID := map[string]*managedLeftover{}
	for _, bad := range unreadable {
		byID[bad.ID] = &managedLeftover{ID: bad.ID, Record: "unreadable", ReadError: bad.Err.Error()}
	}
	if err := listLeftoverContainers(ctx, m.client, managedDatabaseLabel, readable, byID); err != nil {
		return "", err
	}
	for id, leftover := range byID {
		leftover.addImage(filepath.Join(m.root, "images", id+".img"))
	}
	members := []managedLeftover{}
	for _, record := range records {
		if setID, memberID := record.setMember(); setID != "" && !record.Deleting {
			members = append(members, managedLeftover{ID: record.ID, Record: "member", SetID: setID, MemberID: memberID})
		}
	}
	members = append(members, runtimeLeftoverMembers(m.plugin, "managed_database", readable)...)
	return marshalLeftoversWithMembers(byID, members)
}

// runtimeLeftoverMembers lists the member runtime's members of ownerKind whose
// owner has no readable record on this node (a set deleted while the node was
// unreachable: the runtime keeps the member and warns that its container does
// not exist on every start). Opfield removes those it has no such member of.
func runtimeLeftoverMembers(p *DockerPlugin, ownerKind string, readable map[string]bool) []managedLeftover {
	if p == nil || p.setMembers == nil {
		return nil
	}
	out := []managedLeftover{}
	for _, setID := range p.setMembers.ConfiguredSets() {
		config, ok := p.setMembers.Config(setID)
		if !ok || config.OwnerKind != ownerKind || config.OwnerID == "" || readable[config.OwnerID] {
			continue
		}
		out = append(out, managedLeftover{ID: config.OwnerID, Record: "member", SetID: setID, MemberID: config.MemberID})
	}
	return out
}

// forgetRuntimeMember drops the member runtime's member of ownerID named
// memberID (its record and containers are gone) and the set's mesh.
func forgetRuntimeMember(ctx context.Context, p *DockerPlugin, ownerID, memberID string) {
	if p == nil || p.setMembers == nil || memberID == "" {
		return
	}
	for _, setID := range p.setMembers.ConfiguredSets() {
		config, ok := p.setMembers.Config(setID)
		if !ok || config.OwnerID != ownerID || config.MemberID != memberID {
			continue
		}
		if err := p.setMembers.Forget(setID); err != nil {
			p.logger.Warn("the member runtime keeps a member Opfield no longer has", "set_id", setID, "error", err)
			continue
		}
		p.setMesh().Release(ctx, setID)
		p.logger.Info("forgot an availability member Opfield no longer has", "set_id", setID, "member_id", memberID)
	}
}

// forgetLiftedSetMember drops the member runtime's member of setID (named
// memberID, of ownerID) once the owner's record no longer names the set: it
// was taken back to a single node (a lift or detach, availability turned
// off, a create on several servers that failed and was kept on one server).
// Such a member used to wait for the leftover sweep, and turning
// availability on again meanwhile warned that its container does not exist.
// Its mesh and state files go with it (the runtime's Forgotten hook).
func (p *DockerPlugin) forgetLiftedSetMember(setID, memberID, ownerID string) {
	if p == nil || p.setMembers == nil || setID == "" || ownerID == "" {
		return
	}
	config, ok := p.setMembers.Config(setID)
	if !ok || config.OwnerID != ownerID || (memberID != "" && config.MemberID != memberID) {
		return
	}
	if err := p.setMembers.Forget(setID); err != nil {
		p.logger.Warn("the member runtime keeps the member of a set its owner left", "set_id", setID, "owner_id", ownerID, "error", err)
		return
	}
	p.logger.Info("forgot the availability member of a set its owner left", "set_id", setID, "member_id", config.MemberID, "owner_id", ownerID)
}

// forgetLoneSetMembersOf drops the member runtime's members of ownerID whose
// set lists no other member (availability was turned off around it) while
// the owner's record names no set. A member of a set with other members is
// kept: it may be one Opfield configured for a make available that has not
// reached the owner's record yet.
func (p *DockerPlugin) forgetLoneSetMembersOf(ownerKind, ownerID string) {
	if p == nil || p.setMembers == nil || ownerID == "" {
		return
	}
	for _, setID := range p.setMembers.ConfiguredSets() {
		config, ok := p.setMembers.Config(setID)
		if !ok || config.OwnerKind != ownerKind || config.OwnerID != ownerID {
			continue
		}
		alone := true
		for _, peer := range config.Members {
			if peer.MemberID != config.MemberID {
				alone = false
			}
		}
		if alone {
			p.forgetLiftedSetMember(setID, config.MemberID, ownerID)
		}
	}
}

// setMember is the availability set member the record is ("" when none).
func (record managedDatabaseRecord) setMember() (string, string) {
	if record.AvailabilitySetID != "" {
		return record.AvailabilitySetID, record.AvailabilityMemberID
	}
	return record.ClickhouseAvailabilitySetID, record.ClickhouseAvailabilityMemberID
}

// removeLeftoverMember removes a database's availability set member Opfield
// no longer has (its database was deleted, or the member was removed while
// this node could not be reached): the member runtime lets go of it first
// (held, published ports released, forgotten), then its container, network,
// disk and record go. The member runtime is held before the manager lock, as
// every member action does.
func (m *managedDatabaseManager) removeLeftoverMember(ctx context.Context, id, configJSON string) (bool, error) {
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		if wanted := leftoverMemberID(configJSON); wanted != "" {
			// The member runtime keeps a member of a database this node has no
			// record of: whatever is left of the id goes, then the member.
			m.mu.Lock()
			removeErr := m.removeLeftover(ctx, id)
			m.mu.Unlock()
			if removeErr != nil {
				return true, removeErr
			}
			forgetRuntimeMember(ctx, m.plugin, id, wanted)
			return true, nil
		}
		return false, nil
	}
	if err != nil {
		return false, nil
	}
	setID, memberID := record.setMember()
	if setID == "" {
		return false, nil
	}
	if want := leftoverMemberID(configJSON); want == "" || want != memberID {
		return true, errNotALeftover
	}
	var members *memberha.Manager
	if m.plugin != nil {
		members = m.plugin.setMembers
	}
	if members != nil {
		release, err := members.Hold(ctx, setID)
		if err != nil {
			return true, err
		}
		defer release()
		waitCtx, cancel := context.WithTimeout(ctx, setPublishedReleaseWait)
		_ = members.ReleasePublished(waitCtx, setID)
		cancel()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err = m.loadRecord(id)
	if err != nil {
		return true, err
	}
	if currentSet, currentMember := record.setMember(); currentSet != setID || currentMember != memberID {
		return true, errNotALeftover
	}
	if record.Type == "postgres" && record.ContainerID != "" {
		if err := m.removePGContainerWithVolumes(ctx, record.ContainerID); err != nil {
			return true, err
		}
	}
	if err := m.remove(ctx, record); err != nil {
		return true, err
	}
	m.kvSets.engines.Delete(setID)
	m.pgSets.engines.Delete(setID)
	if members != nil {
		if config, ok := members.Config(setID); ok && config.MemberID == memberID {
			if err := members.Forget(setID); err != nil {
				m.logger.Warn("the member runtime keeps the removed availability member", "set_id", setID, "error", err)
			}
		}
	}
	if m.plugin != nil {
		m.plugin.setMesh().Release(ctx, setID)
	}
	if record.Type == "postgres" && m.pgSets.mesh != nil {
		if mesh := m.pgSets.mesh(); mesh != nil {
			mesh.Release(setID)
		}
	}
	m.logger.Info("removed an availability member of a database Opfield no longer has it of", "id", id, "set_id", setID, "member_id", memberID)
	return true, nil
}

// removeLeftover removes everything of a database id Opfield has no instance
// of (see the storage variant).
func (m *managedDatabaseManager) removeLeftover(ctx context.Context, id string) error {
	if _, err := m.loadRecord(id); err == nil {
		return errNotALeftover
	}
	if err := m.removeLostRecord(ctx, id); err != nil {
		return err
	}
	if err := os.Remove(m.recordPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove managed database record: %w", err)
	}
	m.logger.Info("removed what was left of a managed database Opfield has no instance of", "id", id)
	return nil
}
