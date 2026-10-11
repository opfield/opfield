package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

const managedVolumeLabel = "com.wiolett.gateway.managed-volume"
const managedVolumeOriginLabel = "com.wiolett.gateway.managed-volume-origin"

func (c *Client) collectVolumeUsers(ctx context.Context) map[string][]string {
	volumeUsers := make(map[string][]string)
	ctrResult, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return volumeUsers
	}

	for _, ctr := range ctrResult.Items {
		name := ""
		if len(ctr.Names) > 0 {
			name = strings.TrimPrefix(ctr.Names[0], "/")
		}
		if name == "" {
			name = ctr.ID
		}
		for _, m := range ctr.Mounts {
			if m.Type == "volume" && m.Name != "" {
				volumeUsers[m.Name] = append(volumeUsers[m.Name], name)
			}
		}
	}

	return volumeUsers
}

// ListVolumes returns the list of volumes as raw JSON, enriched with usage info.
func (c *Client) ListVolumes(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.VolumeList(ctx, client.VolumeListOptions{})
	if err != nil {
		return nil, fmt.Errorf("volume list: %w", err)
	}

	volumeUsers := c.collectVolumeUsers(ctx)

	type volumeWithUsage struct {
		volume.Volume
		UsedBy []string `json:"UsedBy"`
	}
	enriched := make([]volumeWithUsage, 0, len(result.Items))
	for _, v := range result.Items {
		vwu := volumeWithUsage{Volume: v}
		if users, ok := volumeUsers[v.Name]; ok {
			vwu.UsedBy = users
		}
		enriched = append(enriched, vwu)
	}

	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal volumes: %w", err)
	}
	return data, nil
}

// InspectVolume returns a single volume as raw JSON, enriched with usage info.
func (c *Client) InspectVolume(ctx context.Context, name string) (json.RawMessage, error) {
	result, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("volume inspect: %w", err)
	}
	type volumeWithUsage struct {
		volume.Volume
		UsedBy []string `json:"UsedBy"`
	}
	enriched := volumeWithUsage{Volume: result.Volume}
	if users, ok := c.collectVolumeUsers(ctx)[result.Volume.Name]; ok {
		enriched.UsedBy = users
	}
	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal volume: %w", err)
	}
	return data, nil
}

// RenameVolume emulates rename by creating a new volume, copying contents, then removing the old volume.
func (c *Client) RenameVolume(ctx context.Context, name string, newName string) error {
	if strings.TrimSpace(name) == "" || strings.TrimSpace(newName) == "" {
		return fmt.Errorf("source and target volume names are required")
	}
	if name == newName {
		return nil
	}
	if used, err := c.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot be renamed", name)
	}

	source, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("volume inspect: %w", err)
	}
	if _, err := c.cli.VolumeInspect(ctx, newName, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("target volume %q already exists", newName)
	}

	if err := c.CreateVolume(ctx, newName, source.Volume.Driver, source.Volume.Labels); err != nil {
		return err
	}
	cleanupTarget := true
	defer func() {
		if cleanupTarget {
			_, _ = c.cli.VolumeRemove(context.Background(), newName, client.VolumeRemoveOptions{Force: true})
		}
	}()

	if err := CopyVolumeContents(ctx, c, name, newName); err != nil {
		return err
	}
	if err := c.RemoveVolume(ctx, name, false); err != nil {
		return err
	}
	cleanupTarget = false
	return nil
}

// UpdateVolumeLabels recreates an unused volume with new labels while preserving its contents.
func (c *Client) UpdateVolumeLabels(ctx context.Context, name string, labels map[string]string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("volume name is required")
	}
	if used, err := c.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot update labels", name)
	}

	source, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("volume inspect: %w", err)
	}

	nextLabels := maps.Clone(labels)
	if nextLabels == nil {
		nextLabels = map[string]string{}
	}
	currentLabels := maps.Clone(source.Volume.Labels)
	if currentLabels == nil {
		currentLabels = map[string]string{}
	}
	for _, key := range []string{managedVolumeLabel, managedVolumeOriginLabel, managedVolumeStorageKindLabel, managedVolumeCapacityLabel} {
		if supplied, ok := nextLabels[key]; ok && supplied != currentLabels[key] {
			return fmt.Errorf("label %q is reserved for Opfield-managed volumes", key)
		}
		if current, ok := currentLabels[key]; ok {
			nextLabels[key] = current
		} else {
			delete(nextLabels, key)
		}
	}
	if maps.Equal(currentLabels, nextLabels) {
		return nil
	}

	tempName := fmt.Sprintf("gateway-labels-%d", time.Now().UnixNano())
	if err := c.CreateVolume(ctx, tempName, source.Volume.Driver, source.Volume.Labels); err != nil {
		return err
	}
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			_, _ = c.cli.VolumeRemove(context.Background(), tempName, client.VolumeRemoveOptions{Force: true})
		}
	}()

	if err := CopyVolumeContents(ctx, c, name, tempName); err != nil {
		return err
	}
	if err := c.RemoveVolume(ctx, name, false); err != nil {
		return err
	}
	if err := c.CreateVolume(ctx, name, source.Volume.Driver, nextLabels); err != nil {
		if restoreErr := c.restoreVolumeFromTemp(name, tempName, source.Volume.Driver, source.Volume.Labels); restoreErr != nil {
			cleanupTemp = false
			return fmt.Errorf("volume label update failed: %w; restore failed and original data is preserved in temporary volume %q: %v", err, tempName, restoreErr)
		}
		return err
	}
	if err := CopyVolumeContents(ctx, c, tempName, name); err != nil {
		cleanupTemp = false
		return fmt.Errorf("copy volume contents: %w; original data is preserved in temporary volume %q", err, tempName)
	}
	if err := c.RemoveVolume(ctx, tempName, false); err != nil {
		return err
	}
	cleanupTemp = false
	return nil
}

func (c *Client) restoreVolumeFromTemp(name string, tempName string, driver string, labels map[string]string) error {
	ctx := context.Background()
	if err := c.CreateVolume(ctx, name, driver, labels); err != nil {
		return err
	}
	if err := CopyVolumeContents(ctx, c, tempName, name); err != nil {
		return err
	}
	return nil
}

func (c *Client) volumeInUse(ctx context.Context, name string) (bool, error) {
	containers, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return false, fmt.Errorf("container list: %w", err)
	}
	for _, ctr := range containers.Items {
		for _, m := range ctr.Mounts {
			if m.Type == "volume" && m.Name == name {
				return true, nil
			}
		}
	}
	return false, nil
}

// CreateVolume creates a named volume with the given driver and labels.
func (c *Client) CreateVolume(ctx context.Context, name string, driver string, labels map[string]string) error {
	opts := client.VolumeCreateOptions{
		Name:   name,
		Labels: labels,
	}
	if driver != "" {
		opts.Driver = driver
	}
	_, err := c.cli.VolumeCreate(ctx, opts)
	if err != nil {
		return fmt.Errorf("volume create: %w", err)
	}
	return nil
}

// CreateManagedVolume creates a new Gateway-owned volume without adopting an
// existing Docker volume with the same name. Docker's volume-create API is
// idempotent by name, so the explicit inspection and serialized create prevent
// a create request from silently claiming pre-existing data.
func (c *Client) CreateManagedVolume(ctx context.Context, name string) error {
	c.managedVolumeCreateMutex.Lock()
	defer c.managedVolumeCreateMutex.Unlock()

	if _, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("volume %q already exists", name)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check existing volume %q: %w", name, err)
	}

	labels := map[string]string{
		managedVolumeLabel:            "true",
		managedVolumeOriginLabel:      "created",
		managedVolumeStorageKindLabel: volumeStorageKindRegular,
	}
	result, err := c.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name:   name,
		Driver: "local",
		Labels: labels,
	})
	if err != nil {
		return fmt.Errorf("volume create: %w", err)
	}
	if result.Volume.Labels[managedVolumeLabel] != labels[managedVolumeLabel] ||
		result.Volume.Labels[managedVolumeOriginLabel] != labels[managedVolumeOriginLabel] {
		return fmt.Errorf("volume %q appeared concurrently and was left unchanged", name)
	}
	return nil
}

func (c *Client) volumeDiskUsage(ctx context.Context, name string) (int64, error) {
	usage, err := c.cli.DiskUsage(ctx, client.DiskUsageOptions{Volumes: true, Verbose: true})
	if err != nil {
		return -1, fmt.Errorf("volume disk usage: %w", err)
	}
	for _, item := range usage.Volumes.Items {
		if item.Name == name && item.UsageData != nil {
			return item.UsageData.Size, nil
		}
	}
	return -1, nil
}

func (c *Client) runningVolumeAttachments(ctx context.Context, name string) (int64, error) {
	containers, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: false})
	if err != nil {
		return 0, fmt.Errorf("list running containers: %w", err)
	}
	var count int64
	for _, ctr := range containers.Items {
		for _, mount := range ctr.Mounts {
			if mount.Type == "volume" && mount.Name == name {
				count++
				break
			}
		}
	}
	return count, nil
}

// RemoveVolume removes a volume by name.
func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	_, err := c.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: force})
	if err != nil {
		return fmt.Errorf("volume remove: %w", err)
	}
	return nil
}

// ── Network Operations ────────────────────────────────────────────

// ListNetworks returns the list of networks as raw JSON, with Containers populated.
