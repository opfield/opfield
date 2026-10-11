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
)

// A managed instance can leave things on its node that no record describes:
// a container a delete or an interrupted recreation left behind, or a record
// file that cannot be read (zeroed by a crash) with its image and mount point.
// The repair pass leaves both alone, since the node cannot tell a lost record
// of a live instance from one Gateway deleted. Gateway can: it lists them
// (leftovers) and, for ids it has no instance of, removes them with a remove
// command marked as such (leftoverRemove).

// managedLeftover is what the node keeps of one id it holds no readable
// record of.
type managedLeftover struct {
	ID string `json:"id"`
	// Record is "unreadable" (the file exists but cannot be read) or
	// "missing".
	Record     string   `json:"record"`
	ReadError  string   `json:"readError,omitempty"`
	Containers []string `json:"containers,omitempty"`
	// ImageBytes is the size of its images, AllocatedBytes what they occupy
	// on the node's disk.
	ImageBytes     int64 `json:"imageBytes"`
	AllocatedBytes int64 `json:"allocatedBytes"`
}

// leftoverCommand is the payload of a remove Gateway sends for a leftover:
// it confirms that it has no instance of the id.
type leftoverCommand struct {
	Leftover bool `json:"leftover"`
}

func isLeftoverRemove(configJSON string) bool {
	if configJSON == "" {
		return false
	}
	var command leftoverCommand
	return json.Unmarshal([]byte(configJSON), &command) == nil && command.Leftover
}

// errNotALeftover refuses a leftover remove of an id the node has a readable
// record of: an instance created since Gateway listed the leftovers.
var errNotALeftover = errors.New("the node has a record of this instance; it is not a leftover and was not removed")

func marshalLeftovers(byID map[string]*managedLeftover) (string, error) {
	items := make([]managedLeftover, 0, len(byID))
	for _, item := range byID {
		sort.Strings(item.Containers)
		items = append(items, *item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
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
	for id, leftover := range byID {
		images, _ := filepath.Glob(filepath.Join(m.root, "storage", "images", id+"-*.img"))
		for _, image := range images {
			if found, _, ok := cutStorageMemberName(strings.TrimSuffix(filepath.Base(image), ".img")); ok && found == id {
				leftover.addImage(image)
			}
		}
	}
	return marshalLeftovers(byID)
}

// removeLeftover removes everything of a storage id Gateway has no instance
// of: its containers, network, images, mount points, staged files and the
// record file that cannot be read. An id with a readable record is refused.
func (m *managedStorageManager) removeLeftover(ctx context.Context, id string) error {
	if _, err := m.loadRecord(id); err == nil {
		return errNotALeftover
	}
	if err := m.removeLostRecord(ctx, id, true); err != nil {
		return err
	}
	if err := os.Remove(m.recordPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove managed storage record: %w", err)
	}
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
	return marshalLeftovers(byID)
}

// removeLeftover removes everything of a database id Gateway has no instance
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
