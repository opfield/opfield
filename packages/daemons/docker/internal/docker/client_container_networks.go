package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"slices"
	"sort"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// managedDatabaseHostEntries returns the ExtraHosts entry of each database link network: the link alias at the
// network's gateway, where the daemon's host listener serves the link. A network where the shared connector serves
// the link gets none (C6): its consumers resolve the alias through Docker's DNS to the connector.
func (c *Client) managedDatabaseHostEntries(ctx context.Context, networkNames []string) ([]string, error) {
	entries := make([]string, 0)
	for _, networkName := range networkNames {
		if !strings.HasPrefix(networkName, "gateway-db-") {
			continue
		}
		if c.databaseLinkOnConnector != nil && c.databaseLinkOnConnector(networkName) {
			continue
		}
		inspected, err := c.cli.NetworkInspect(ctx, networkName, client.NetworkInspectOptions{})
		if err != nil {
			return nil, fmt.Errorf("inspect managed database network %q: %w", networkName, err)
		}
		entry, err := managedDatabaseHostEntry(networkName, inspected.Network)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func managedDatabaseHostEntry(networkName string, inspected network.Inspect) (string, error) {
	suffix, managed := strings.CutPrefix(networkName, "gateway-db-")
	if !managed || suffix == "" {
		return "", fmt.Errorf("managed database network name %q is invalid", networkName)
	}
	gateway, err := managedDatabaseNetworkGatewayAddress(inspected)
	if err != nil {
		return "", fmt.Errorf("resolve managed database listener address for %q: %w", networkName, err)
	}
	return fmt.Sprintf("db-%s:%s", suffix, gateway), nil
}

func mergeManagedDatabaseExtraHosts(existing []string, managed []string) []string {
	merged := make([]string, 0, len(existing)+len(managed))
	for _, entry := range existing {
		host, _, found := strings.Cut(entry, ":")
		if found && isManagedDatabaseAlias(host) {
			continue
		}
		merged = append(merged, entry)
	}
	return append(merged, managed...)
}

func mergePreferredExtraHosts(existing []string, preferred []string) []string {
	preferredHosts := make(map[string]struct{}, len(preferred))
	for _, entry := range preferred {
		host, _, found := strings.Cut(entry, ":")
		if found && host != "" {
			preferredHosts[host] = struct{}{}
		}
	}
	merged := make([]string, 0, len(existing)+len(preferred))
	for _, entry := range existing {
		host, _, found := strings.Cut(entry, ":")
		if found {
			if _, replaced := preferredHosts[host]; replaced {
				continue
			}
		}
		merged = append(merged, entry)
	}
	return append(merged, preferred...)
}

func isManagedDatabaseAlias(host string) bool {
	suffix, ok := strings.CutPrefix(host, "db-")
	if !ok || len(suffix) != 16 {
		return false
	}
	for _, char := range suffix {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

func (c *Client) existingNetworkNames(ctx context.Context, names []string) ([]string, error) {
	existing := make([]string, 0, len(names))
	for _, name := range names {
		if _, err := c.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{}); err != nil {
			if isNotFoundErr(err) {
				continue
			}
			return nil, fmt.Errorf("inspect network %q: %w", name, err)
		}
		existing = append(existing, name)
	}
	return existing, nil
}

func inspectNetworkNames(insp *container.InspectResponse) []string {
	if insp == nil || insp.NetworkSettings == nil || len(insp.NetworkSettings.Networks) == 0 {
		return nil
	}

	netNames := make([]string, 0, len(insp.NetworkSettings.Networks))
	for netName := range insp.NetworkSettings.Networks {
		if strings.TrimSpace(netName) != "" {
			netNames = append(netNames, netName)
		}
	}
	sort.Strings(netNames)
	return prioritizeNetworkNames(netNames, currentInspectNetworkMode(insp))
}

func currentInspectNetworkMode(insp *container.InspectResponse) string {
	if insp == nil || insp.HostConfig == nil {
		return ""
	}
	return strings.TrimSpace(string(insp.HostConfig.NetworkMode))
}

// prioritizeNetworkNames moves the network that becomes the container's network mode first: its current network mode
// when the container is on it, otherwise the first user-defined network, otherwise the default bridge. A link network
// (managed database binding, storage link, container link) is chosen only when the container is on nothing else:
// Gateway removes a link network with its link, and a network mode that names a removed network keeps the container
// from starting once it is on no other network.
func prioritizeNetworkNames(netNames []string, currentMode string) []string {
	preferred := ""
	if currentMode != network.NetworkDefault && currentMode != network.NetworkBridge && !isLinkNetwork(currentMode) &&
		slices.Contains(netNames, currentMode) {
		preferred = currentMode
	}
	if preferred == "" {
		for _, name := range netNames {
			if name != network.NetworkBridge && name != network.NetworkDefault && !isLinkNetwork(name) {
				preferred = name
				break
			}
		}
	}
	if preferred == "" && slices.Contains(netNames, network.NetworkBridge) {
		preferred = network.NetworkBridge
	}
	if preferred == "" && slices.Contains(netNames, currentMode) {
		preferred = currentMode
	}
	for index, name := range netNames {
		if name == preferred && index > 0 {
			copy(netNames[1:index+1], netNames[0:index])
			netNames[0] = name
			break
		}
	}
	return netNames
}

func networkingConfigForInspectNetwork(
	insp *container.InspectResponse,
	netNames []string,
) *network.NetworkingConfig {
	if len(netNames) == 0 || insp == nil || insp.NetworkSettings == nil {
		return nil
	}

	ep := endpointConfigForRecreate(insp.NetworkSettings.Networks[netNames[0]])
	return &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{netNames[0]: ep},
	}
}

func endpointConfigForRecreate(source *network.EndpointSettings) *network.EndpointSettings {
	if source == nil {
		return nil
	}

	endpoint := source.Copy()
	endpoint.NetworkID = ""
	endpoint.EndpointID = ""
	endpoint.Gateway = netip.Addr{}
	endpoint.IPAddress = netip.Addr{}
	endpoint.MacAddress = nil
	endpoint.IPPrefixLen = 0
	endpoint.IPv6Gateway = netip.Addr{}
	endpoint.GlobalIPv6Address = netip.Addr{}
	endpoint.GlobalIPv6PrefixLen = 0
	endpoint.DNSNames = nil
	return endpoint
}

func (c *Client) connectContainerToAdditionalNetworks(
	ctx context.Context,
	containerID string,
	insp *container.InspectResponse,
	netNames []string,
) error {
	if insp == nil || insp.NetworkSettings == nil || len(netNames) < 2 {
		return nil
	}

	for _, netName := range netNames[1:] {
		ep := endpointConfigForRecreate(insp.NetworkSettings.Networks[netName])
		if _, err := c.cli.NetworkConnect(ctx, netName, client.NetworkConnectOptions{
			Container:      containerID,
			EndpointConfig: ep,
		}); err != nil {
			return fmt.Errorf("connect network %q: %w", netName, err)
		}
	}
	return nil
}

func cloneInspectResponse(src *container.InspectResponse) (*container.InspectResponse, error) {
	data, err := json.Marshal(src)
	if err != nil {
		return nil, err
	}

	var cloned container.InspectResponse
	if err := json.Unmarshal(data, &cloned); err != nil {
		return nil, err
	}

	return &cloned, nil
}

// applyEnvChanges builds the final env slice by:
//  1. Stripping keys listed in removals
//  2. Applying overrides on top (overrides win on conflict; new keys are appended)
func applyEnvChanges(containerEnv []string, overrides map[string]string, removals []string) []string {
	removeSet := make(map[string]bool, len(removals))
	for _, k := range removals {
		removeSet[k] = true
	}
	seen := make(map[string]bool, len(containerEnv))
	filtered := make([]string, 0, len(containerEnv))
	for _, kv := range containerEnv {
		key := kv
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			key = kv[:idx]
		}
		if removeSet[key] {
			continue
		}
		seen[key] = true
		if val, ok := overrides[key]; ok {
			filtered = append(filtered, key+"="+val)
		} else {
			filtered = append(filtered, kv)
		}
	}
	for k, v := range overrides {
		if !seen[k] {
			filtered = append(filtered, k+"="+v)
		}
	}
	return filtered
}

// ── Image Operations ──────────────────────────────────────────────

// ListImages returns the list of images as raw JSON.
