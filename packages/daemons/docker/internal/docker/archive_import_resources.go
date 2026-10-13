package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/distribution/reference"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

type archiveImportPlanRequest struct {
	Manifest          gwcaContainerManifest `json:"manifest"`
	CanViewNetworks   bool                  `json:"canViewNetworks"`
	CanCreateNetworks bool                  `json:"canCreateNetworks"`
	CanViewVolumes    bool                  `json:"canViewVolumes"`
	CanCreateVolumes  bool                  `json:"canCreateVolumes"`
}

type archiveImportTargetNetwork struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver string `json:"driver"`
	Scope  string `json:"scope"`
}

type archiveImportTargetVolume struct {
	Name       string `json:"name"`
	Driver     string `json:"driver"`
	Mountpoint string `json:"mountpoint"`
	Scope      string `json:"scope"`
}

type archiveImportPlanResolution struct {
	Networks       map[string]string `json:"networks"`
	CreateNetworks []string          `json:"createNetworks"`
	Volumes        map[string]string `json:"volumes"`
	CreateVolumes  []string          `json:"createVolumes"`
	Ports          map[string]int    `json:"ports"`
}

type archiveImportPlanResult struct {
	Networks         []archiveImportTargetNetwork `json:"networks"`
	Volumes          []archiveImportTargetVolume  `json:"volumes"`
	Resolution       archiveImportPlanResolution  `json:"resolution"`
	ConflictingPorts []string                     `json:"conflictingPorts"`
}

func gwcaPortMappingKey(port gwcaPortMapping) string {
	return fmt.Sprintf("%d/%s:%d", port.ContainerPort, strings.ToLower(port.Protocol), port.HostPort)
}

func gwcaHostPortBindingKey(hostPort int, protocol string) string {
	return fmt.Sprintf("%d/%s", hostPort, strings.ToLower(protocol))
}

func gwcaPortConflicts(manifest gwcaContainerManifest, containers []ContainerInfo) []string {
	occupied := make(map[string]struct{})
	for _, target := range containers {
		for _, port := range target.Ports {
			if port.PublicPort > 0 {
				occupied[gwcaHostPortBindingKey(int(port.PublicPort), port.Type)] = struct{}{}
			}
		}
	}
	desiredCounts := make(map[string]int)
	for _, port := range manifest.Ports {
		if port.HostPort > 0 {
			desiredCounts[gwcaHostPortBindingKey(port.HostPort, port.Protocol)]++
		}
	}
	conflicts := make([]string, 0)
	for _, port := range manifest.Ports {
		if port.HostPort == 0 {
			continue
		}
		binding := gwcaHostPortBindingKey(port.HostPort, port.Protocol)
		if _, exists := occupied[binding]; exists || desiredCounts[binding] > 1 {
			conflicts = append(conflicts, gwcaPortMappingKey(port))
		}
	}
	sort.Strings(conflicts)
	return conflicts
}

func uniqueArchiveNetworkName(source string, used map[string]struct{}) string {
	if _, exists := used[source]; !exists {
		return source
	}
	for index := 2; index <= 9999; index++ {
		candidate := fmt.Sprintf("%s-gwca-%d", source, index)
		if _, exists := used[candidate]; !exists {
			return candidate
		}
	}
	return source + "-gwca"
}

func (p *DockerPlugin) planGwcaArchiveImport(ctx context.Context, configJSON string) (archiveImportPlanResult, error) {
	var req archiveImportPlanRequest
	if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
		return archiveImportPlanResult{}, fmt.Errorf("parse archive import plan request: %w", err)
	}
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		return archiveImportPlanResult{}, err
	}

	targetNetworks := []archiveImportTargetNetwork{{ID: "bridge", Name: "bridge", Driver: "bridge", Scope: "local"}}
	if req.CanViewNetworks {
		listed, listErr := p.client.cli.NetworkList(ctx, mobyclient.NetworkListOptions{})
		if listErr != nil {
			return archiveImportPlanResult{}, fmt.Errorf("list archive target networks: %w", listErr)
		}
		targetNetworks = targetNetworks[:0]
		hasBridge := false
		for _, network := range listed.Items {
			if network.Name == "host" || network.Name == "none" {
				continue
			}
			if network.Name == "bridge" {
				hasBridge = true
			}
			targetNetworks = append(targetNetworks, archiveImportTargetNetwork{
				ID: network.ID, Name: network.Name, Driver: network.Driver, Scope: network.Scope,
			})
		}
		if !hasBridge {
			targetNetworks = append(targetNetworks, archiveImportTargetNetwork{
				ID: "bridge", Name: "bridge", Driver: "bridge", Scope: "local",
			})
		}
		sort.Slice(targetNetworks, func(i, j int) bool { return targetNetworks[i].Name < targetNetworks[j].Name })
	}

	targetVolumes := make([]archiveImportTargetVolume, 0)
	if req.CanViewVolumes {
		listed, listErr := p.client.cli.VolumeList(ctx, mobyclient.VolumeListOptions{})
		if listErr != nil {
			return archiveImportPlanResult{}, fmt.Errorf("list archive target volumes: %w", listErr)
		}
		for _, volume := range listed.Items {
			targetVolumes = append(targetVolumes, archiveImportTargetVolume{
				Name: volume.Name, Driver: volume.Driver, Mountpoint: volume.Mountpoint, Scope: volume.Scope,
			})
		}
		sort.Slice(targetVolumes, func(i, j int) bool { return targetVolumes[i].Name < targetVolumes[j].Name })
	}

	resolution := archiveImportPlanResolution{
		Networks: map[string]string{}, Volumes: map[string]string{}, Ports: map[string]int{},
		CreateNetworks: []string{}, CreateVolumes: []string{},
	}
	usedNetworks := make(map[string]struct{}, len(targetNetworks))
	for _, target := range targetNetworks {
		usedNetworks[target.Name] = struct{}{}
	}
	for _, source := range req.Manifest.Networks {
		matched := ""
		for _, target := range targetNetworks {
			if target.Name == source.Name && (source.Driver == "" || target.Driver == source.Driver) {
				matched = target.Name
				break
			}
		}
		if matched != "" {
			resolution.Networks[source.Name] = matched
			continue
		}
		if source.Createable && req.CanCreateNetworks {
			created := uniqueArchiveNetworkName(source.Name, usedNetworks)
			usedNetworks[created] = struct{}{}
			resolution.Networks[source.Name] = created
			resolution.CreateNetworks = append(resolution.CreateNetworks, source.Name)
			continue
		}
		resolution.Networks[source.Name] = "bridge"
	}

	for _, source := range req.Manifest.Mounts {
		if source.Type != "volume" || !source.RequiresMapping {
			continue
		}
		matched := ""
		for _, target := range targetVolumes {
			if target.Name == source.Source && (source.Driver == "" || target.Driver == source.Driver) {
				matched = target.Name
				break
			}
		}
		if matched == "" {
			for _, target := range targetVolumes {
				if source.Driver == "" || target.Driver == source.Driver {
					matched = target.Name
					break
				}
			}
		}
		if matched != "" {
			resolution.Volumes[source.Source] = matched
		} else if req.CanCreateVolumes {
			resolution.CreateVolumes = append(resolution.CreateVolumes, source.Source)
		}
	}

	conflictingPorts := gwcaPortConflicts(req.Manifest, containers)
	for _, key := range conflictingPorts {
		resolution.Ports[key] = 0
	}
	return archiveImportPlanResult{
		Networks: targetNetworks, Volumes: targetVolumes, Resolution: resolution, ConflictingPorts: conflictingPorts,
	}, nil
}

func (p *DockerPlugin) assertGwcaHostPortsAvailable(ctx context.Context, manifest gwcaContainerManifest) error {
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		return err
	}
	if conflicts := gwcaPortConflicts(manifest, containers); len(conflicts) > 0 {
		return fmt.Errorf("archive host ports are occupied; remap these bindings to port 0: %s", strings.Join(conflicts, ", "))
	}
	return nil
}

func (p *DockerPlugin) availableArchiveContainerName(ctx context.Context, requested string) (string, error) {
	base := strings.TrimSpace(requested)
	if base == "" {
		base = "imported-container"
	}
	if _, err := p.client.cli.ContainerInspect(ctx, base, mobyclient.ContainerInspectOptions{}); isNotFoundErr(err) {
		return base, nil
	} else if err != nil {
		return "", fmt.Errorf("inspect target container name: %w", err)
	}
	for index := 2; index <= 9999; index++ {
		candidate := fmt.Sprintf("%s-%d", base, index)
		if len(candidate) > 255 {
			candidate = fmt.Sprintf("%s-%d", base[:max(1, 255-len(strconv.Itoa(index))-1)], index)
		}
		if _, err := p.client.cli.ContainerInspect(ctx, candidate, mobyclient.ContainerInspectOptions{}); isNotFoundErr(err) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("inspect target container name: %w", err)
		}
	}
	return "", fmt.Errorf("could not allocate an available container name")
}

func (p *DockerPlugin) prepareGwcaNetworks(
	ctx context.Context,
	archiveID string,
	manifest *gwcaContainerManifest,
) ([]string, error) {
	created := make([]string, 0)
	if err := validateGwcaNetworks(manifest.Networks); err != nil {
		return created, err
	}
	for index := range manifest.Networks {
		entry := &manifest.Networks[index]
		if entry.Name == "" {
			continue
		}
		if entry.CreateNew {
			name, err := p.availableArchiveNetworkName(ctx, entry.Name)
			if err != nil {
				return created, err
			}
			entry.Name = name
		} else {
			if _, err := p.client.cli.NetworkInspect(ctx, entry.Name, mobyclient.NetworkInspectOptions{}); err == nil {
				continue
			} else if !isNotFoundErr(err) {
				return created, fmt.Errorf("inspect target network %q: %w", entry.Name, err)
			}
		}
		if entry.Createable {
			options := mobyclient.NetworkCreateOptions{
				Driver: entry.Driver,
				Labels: map[string]string{"net.opfield.archive.id": archiveID},
			}
			if entry.Subnet != "" || entry.Gateway != "" {
				ipamConfig := network.IPAMConfig{}
				if entry.Subnet != "" {
					prefix, parseErr := netip.ParsePrefix(entry.Subnet)
					if parseErr != nil {
						return created, fmt.Errorf("parse archive network subnet %q: %w", entry.Subnet, parseErr)
					}
					ipamConfig.Subnet = prefix
				}
				if entry.Gateway != "" && entry.Gateway != "invalid IP" {
					gateway, parseErr := netip.ParseAddr(entry.Gateway)
					if parseErr != nil {
						return created, fmt.Errorf("parse archive network gateway %q: %w", entry.Gateway, parseErr)
					}
					ipamConfig.Gateway = gateway
				}
				options.IPAM = &network.IPAM{Config: []network.IPAMConfig{ipamConfig}}
			}
			if _, createErr := p.client.cli.NetworkCreate(ctx, entry.Name, options); createErr == nil {
				created = append(created, entry.Name)
				continue
			} else if entry.CreateNew {
				return created, fmt.Errorf("create archive network %q: %w", entry.Name, createErr)
			}
		}
		entry.Name = "bridge"
	}
	seen := make(map[string]bool)
	filtered := manifest.Networks[:0]
	for _, entry := range manifest.Networks {
		if entry.Name == "" || seen[entry.Name] {
			continue
		}
		seen[entry.Name] = true
		filtered = append(filtered, entry)
	}
	manifest.Networks = filtered
	return created, nil
}

func (p *DockerPlugin) availableArchiveNetworkName(ctx context.Context, requested string) (string, error) {
	if _, err := p.client.cli.NetworkInspect(ctx, requested, mobyclient.NetworkInspectOptions{}); isNotFoundErr(err) {
		return requested, nil
	} else if err != nil {
		return "", fmt.Errorf("inspect target network name: %w", err)
	}
	for index := 2; index <= 9999; index++ {
		candidate := fmt.Sprintf("%s-gwca-%d", requested, index)
		if _, err := p.client.cli.NetworkInspect(ctx, candidate, mobyclient.NetworkInspectOptions{}); isNotFoundErr(err) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("inspect target network name: %w", err)
		}
	}
	return "", fmt.Errorf("could not allocate an available network name")
}

func (p *DockerPlugin) prepareGwcaMounts(
	ctx context.Context,
	archiveID string,
	containerName string,
	manifest *gwcaContainerManifest,
) ([]string, error) {
	created := make([]string, 0)
	shortID := strings.ReplaceAll(archiveID, "-", "")
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	for index := range manifest.Mounts {
		entry := &manifest.Mounts[index]
		if entry.Type != "volume" {
			continue
		}
		if !entry.CreateNew {
			if inspected, err := p.client.cli.VolumeInspect(ctx, entry.Source, mobyclient.VolumeInspectOptions{}); err != nil {
				return created, fmt.Errorf("target volume %q is unavailable; remap this volume before import: %w", entry.Source, err)
			} else if entry.Driver != "" && inspected.Volume.Driver != entry.Driver {
				return created, fmt.Errorf("target volume %q uses driver %q instead of %q", entry.Source, inspected.Volume.Driver, entry.Driver)
			}
			continue
		}
		base := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
				return r
			}
			return '-'
		}, containerName)
		name := fmt.Sprintf("%s-gwca-%s-%d", base, shortID, index+1)
		createdVolume, err := p.client.cli.VolumeCreate(ctx, mobyclient.VolumeCreateOptions{
			Name: name, Driver: "local", Labels: mergeArchiveLabels(entry.Labels, archiveID),
		})
		if err != nil {
			return created, fmt.Errorf("create empty archive volume: %w", err)
		}
		entry.Source = createdVolume.Volume.Name
		entry.CreateNew = false
		created = append(created, createdVolume.Volume.Name)
	}
	return created, nil
}

func mergeArchiveLabels(labels map[string]string, archiveID string) map[string]string {
	result := sanitizeGwcaLabels(labels)
	if result == nil {
		result = map[string]string{}
	}
	result["net.opfield.archive.id"] = archiveID
	result[managedVolumeLabel] = "true"
	result[managedVolumeOriginLabel] = "created"
	return result
}

func (p *DockerPlugin) cleanupGwcaImportResources(ctx context.Context, archiveID string) error {
	if strings.TrimSpace(archiveID) == "" {
		return fmt.Errorf("archive ID is required")
	}
	label := "net.opfield.archive.id=" + archiveID
	volumes, err := p.client.cli.VolumeList(ctx, mobyclient.VolumeListOptions{
		Filters: mobyclient.Filters{}.Add("label", label),
	})
	if err != nil {
		return fmt.Errorf("list archive import volumes: %w", err)
	}
	for _, volume := range volumes.Items {
		if _, removeErr := p.client.cli.VolumeRemove(ctx, volume.Name, mobyclient.VolumeRemoveOptions{Force: true}); removeErr != nil && !isNotFoundErr(removeErr) {
			return fmt.Errorf("remove archive import volume %q: %w", volume.Name, removeErr)
		}
	}
	networks, err := p.client.cli.NetworkList(ctx, mobyclient.NetworkListOptions{
		Filters: mobyclient.Filters{}.Add("label", label),
	})
	if err != nil {
		return fmt.Errorf("list archive import networks: %w", err)
	}
	for _, target := range networks.Items {
		if _, removeErr := p.client.cli.NetworkRemove(ctx, target.ID, mobyclient.NetworkRemoveOptions{}); removeErr != nil && !isNotFoundErr(removeErr) {
			return fmt.Errorf("remove archive import network %q: %w", target.Name, removeErr)
		}
	}
	return nil
}

func (p *DockerPlugin) prepareArchiveCreateImageReference(imageID, sourceReference string) (string, string) {
	sourceReference = strings.TrimSpace(sourceReference)
	if sourceReference == "" || dockerSHA256Digest.MatchString(sourceReference) {
		return imageID, ""
	}
	named, err := reference.ParseNormalizedNamed(sourceReference)
	if err != nil {
		p.logger.Warn("ignore invalid archive image reference", "image_reference", sourceReference, "error", err)
		return imageID, ""
	}
	if _, digested := named.(reference.Digested); digested {
		return imageID, named.String()
	}
	return imageID, reference.TagNameOnly(named).String()
}
