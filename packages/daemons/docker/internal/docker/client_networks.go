package docker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func (c *Client) ListNetworks(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.NetworkList(ctx, client.NetworkListOptions{})
	if err != nil {
		return nil, fmt.Errorf("network list: %w", err)
	}
	// NetworkList doesn't populate Containers — inspect each to get them.
	type netWithContainers struct {
		network.Summary
		Containers map[string]network.EndpointResource `json:"Containers"`
	}
	// Build map of network ID/name → containers (including stopped) from container configs
	networkUsers := make(map[string]map[string]network.EndpointResource)
	ctrResult, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err == nil {
		for _, ctr := range ctrResult.Items {
			ctrName := ""
			if len(ctr.Names) > 0 {
				ctrName = strings.TrimPrefix(ctr.Names[0], "/")
			}
			for netName, netSettings := range ctr.NetworkSettings.Networks {
				if networkUsers[netName] == nil {
					networkUsers[netName] = make(map[string]network.EndpointResource)
				}
				networkUsers[netName][ctr.ID] = network.EndpointResource{
					Name: ctrName,
				}
				_ = netSettings
			}
		}
	}

	// Skip Docker built-in default networks
	hiddenNetworks := map[string]bool{"host": true, "none": true, "bridge": true}
	enriched := make([]netWithContainers, 0, len(result.Items))
	for _, n := range result.Items {
		if hiddenNetworks[n.Name] {
			continue
		}
		nwc := netWithContainers{Summary: n}
		// Merge: running containers from inspect + stopped containers from list
		inspected, inspErr := c.cli.NetworkInspect(ctx, n.ID, client.NetworkInspectOptions{})
		if inspErr == nil {
			nwc.Containers = inspected.Network.Containers
		} else {
			nwc.Containers = make(map[string]network.EndpointResource)
		}
		// Add stopped containers that aren't in the inspect result
		if users, ok := networkUsers[n.Name]; ok {
			for cid, ep := range users {
				if _, exists := nwc.Containers[cid]; !exists {
					nwc.Containers[cid] = ep
				}
			}
		}
		enriched = append(enriched, nwc)
	}
	data, err := json.Marshal(enriched)
	if err != nil {
		return nil, fmt.Errorf("marshal networks: %w", err)
	}
	return data, nil
}

// CreateNetwork creates a network with the given parameters. Returns the network ID.
func (c *Client) CreateNetwork(ctx context.Context, name string, driver string, subnet string, gatewayAddr string) (string, error) {
	opts := client.NetworkCreateOptions{
		Driver: driver,
	}

	if subnet != "" {
		ipamCfg := network.IPAMConfig{}
		prefix, err := netip.ParsePrefix(subnet)
		if err != nil {
			return "", fmt.Errorf("parse subnet %q: %w", subnet, err)
		}
		ipamCfg.Subnet = prefix

		if gatewayAddr != "" {
			gw, err := netip.ParseAddr(gatewayAddr)
			if err != nil {
				return "", fmt.Errorf("parse gateway %q: %w", gatewayAddr, err)
			}
			ipamCfg.Gateway = gw
		}

		opts.IPAM = &network.IPAM{
			Config: []network.IPAMConfig{ipamCfg},
		}
	}

	result, err := c.cli.NetworkCreate(ctx, name, opts)
	if err != nil {
		return "", fmt.Errorf("network create: %w", err)
	}
	return result.ID, nil
}

// CreateReservedNetwork creates a bridge network whose automatic allocation
// range excludes a stable address reserved for a managed database connector.
// When subnet is empty, Docker first selects a non-overlapping subnet and the
// temporary empty network is immediately recreated with the bounded IPAM
// configuration before any endpoint can attach to it.
func (c *Client) CreateReservedNetwork(
	ctx context.Context,
	name string,
	driver string,
	subnet string,
	gatewayAddr string,
) (string, string, error) {
	if subnet == "" {
		probe, err := c.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: driver})
		if err != nil {
			return "", "", fmt.Errorf("network address probe create: %w", err)
		}
		inspected, inspectErr := c.cli.NetworkInspect(ctx, probe.ID, client.NetworkInspectOptions{})
		removeErr := func() error {
			_, err := c.cli.NetworkRemove(ctx, probe.ID, client.NetworkRemoveOptions{})
			return err
		}()
		if inspectErr != nil {
			return "", "", fmt.Errorf("network address probe inspect: %w", inspectErr)
		}
		if removeErr != nil {
			return "", "", fmt.Errorf("network address probe remove: %w", removeErr)
		}
		for _, cfg := range inspected.Network.IPAM.Config {
			if cfg.Subnet.IsValid() && cfg.Subnet.Addr().Is4() {
				subnet = cfg.Subnet.String()
				if gatewayAddr == "" && cfg.Gateway.IsValid() && cfg.Gateway.Is4() {
					gatewayAddr = cfg.Gateway.String()
				}
				break
			}
		}
		if subnet == "" {
			return "", "", errors.New("Docker did not allocate an IPv4 subnet for the managed database network")
		}
	}

	ipamCfg, reservedAddress, err := managedConnectorIPAM(subnet, gatewayAddr)
	if err != nil {
		return "", "", err
	}
	result, err := c.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{
		Driver: driver,
		IPAM: &network.IPAM{
			Config: []network.IPAMConfig{ipamCfg},
		},
	})
	if err != nil {
		return "", "", fmt.Errorf("reserved network create: %w", err)
	}
	return result.ID, reservedAddress, nil
}

func managedConnectorIPAM(subnet string, gatewayAddr string) (network.IPAMConfig, string, error) {
	prefix, err := netip.ParsePrefix(subnet)
	if err != nil || !prefix.Addr().Is4() {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q is not valid IPv4", subnet)
	}
	prefix = prefix.Masked()
	if prefix.Bits() > 28 {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q is too small", subnet)
	}

	baseBytes := prefix.Addr().As4()
	base := binary.BigEndian.Uint32(baseBytes[:])
	gateway := base + 1
	if gatewayAddr != "" {
		parsedGateway, parseErr := netip.ParseAddr(gatewayAddr)
		if parseErr != nil || !parsedGateway.Is4() || !prefix.Contains(parsedGateway) {
			return network.IPAMConfig{}, "", fmt.Errorf("managed database network gateway %q is invalid", gatewayAddr)
		}
		gatewayBytes := parsedGateway.As4()
		gateway = binary.BigEndian.Uint32(gatewayBytes[:])
	}

	reserved := base + 2
	if reserved == gateway {
		reserved++
	}
	var reservedBytes [4]byte
	binary.BigEndian.PutUint32(reservedBytes[:], reserved)
	reservedAddress := netip.AddrFrom4(reservedBytes)
	if !prefix.Contains(reservedAddress) {
		return network.IPAMConfig{}, "", fmt.Errorf("managed database network subnet %q has no connector address", subnet)
	}

	dynamicBits := prefix.Bits() + 1
	halfSize := uint32(1) << uint32(32-dynamicBits)
	dynamicBase := base
	firstHalf := netip.PrefixFrom(prefix.Addr(), dynamicBits)
	if firstHalf.Contains(reservedAddress) {
		dynamicBase += halfSize
	}
	var dynamicBytes [4]byte
	binary.BigEndian.PutUint32(dynamicBytes[:], dynamicBase)
	dynamicRange := netip.PrefixFrom(netip.AddrFrom4(dynamicBytes), dynamicBits)

	var gatewayBytes [4]byte
	binary.BigEndian.PutUint32(gatewayBytes[:], gateway)
	return network.IPAMConfig{
		Subnet:  prefix,
		Gateway: netip.AddrFrom4(gatewayBytes),
		IPRange: dynamicRange,
	}, reservedAddress.String(), nil
}

// RemoveNetwork removes a network by ID. Endpoints left behind by containers that no longer exist are deleted
// first, and the Secure Link connector leaves a network it is the last container on; a network another container
// still uses is not removed.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	c.removeOrphanedEndpoints(ctx, id)
	c.releaseSecureLinkConnector(ctx, id, false)
	_, err := c.cli.NetworkRemove(ctx, id, client.NetworkRemoveOptions{})
	if err != nil {
		return fmt.Errorf("network remove: %w", err)
	}
	return nil
}

// removeStaleEndpoints deletes the endpoints named after a container from the given networks. Docker can keep the
// endpoint of a container removed while it restarted, and with it the host ports the endpoint published: a
// container created under that name could then neither join the network nor publish its ports. Call it only while
// no container has the name: the endpoint is deleted by name, and a forced disconnect addresses a container of that
// name first.
func (c *Client) removeStaleEndpoints(ctx context.Context, name string, networkNames []string) {
	for _, networkName := range networkNames {
		inspected, err := c.cli.NetworkInspect(ctx, networkName, client.NetworkInspectOptions{})
		if err != nil {
			continue
		}
		for _, endpoint := range inspected.Network.Containers {
			if strings.TrimPrefix(endpoint.Name, "/") == name {
				c.deleteEndpoint(ctx, networkName, name)
				break
			}
		}
	}
}

// withLinkNetworks adds the managed database, storage and container link networks of the node to a list of network
// names.
func (c *Client) withLinkNetworks(ctx context.Context, networkNames []string) []string {
	listed, err := c.cli.NetworkList(ctx, client.NetworkListOptions{
		Filters: make(client.Filters).Add("name", databaseLinkNetworkPrefix).Add("name", storageLinkNetworkPrefix).
			Add("name", containerLinkNetworkPrefix).
			// legacy-name: link networks created before 2.12.1 (see legacyDatabaseLinkNetworkPrefix) — remove once every node reports none
			Add("name", legacyDatabaseLinkNetworkPrefix).Add("name", legacyStorageLinkNetworkPrefix).Add("name", legacyContainerLinkNetworkPrefix),
	})
	if err != nil {
		return networkNames
	}
	names := slices.Clone(networkNames)
	for _, item := range listed.Items {
		linkNetwork := isDatabaseLinkNetworkName(item.Name) || isStorageNetworkName(item.Name) ||
			isContainerLinkNetworkName(item.Name)
		if linkNetwork && !slices.Contains(names, item.Name) {
			names = append(names, item.Name)
		}
	}
	return names
}

// deleteEndpoint deletes a network endpoint by name with a forced disconnect, which Docker turns into an endpoint
// deletion when no container has the name.
func (c *Client) deleteEndpoint(ctx context.Context, networkName string, name string) {
	_, err := c.cli.NetworkDisconnect(ctx, networkName, client.NetworkDisconnectOptions{Container: name, Force: true})
	if err != nil && !isDetachedErr(err) && c.logger != nil {
		c.logger.Warn("cannot delete a stale network endpoint", "network", networkName, "endpoint", name, "error", err)
	}
}

// removeOrphanedEndpoints deletes the endpoints of a network whose container no longer exists. An endpoint of a
// name another container now has is kept: that container is not on this network (Docker refuses a second endpoint
// of a name), and deleting by name would address it.
func (c *Client) removeOrphanedEndpoints(ctx context.Context, networkID string) {
	inspected, err := c.cli.NetworkInspect(ctx, networkID, client.NetworkInspectOptions{})
	if err != nil {
		return
	}
	for key, endpoint := range inspected.Network.Containers {
		name := strings.TrimPrefix(endpoint.Name, "/")
		if name == "" {
			continue
		}
		// An endpoint without a sandbox is listed as "ep-<endpoint id>"; any other key is its container's ID.
		if !strings.HasPrefix(key, "ep-") {
			if _, err := c.cli.ContainerInspect(ctx, key, client.ContainerInspectOptions{}); !isNotFoundErr(err) {
				continue
			}
		}
		if _, err := c.cli.ContainerInspect(ctx, name, client.ContainerInspectOptions{}); !isNotFoundErr(err) {
			continue
		}
		c.deleteEndpoint(ctx, networkID, name)
	}
}

// ConnectContainerToNetwork connects a container to a network.
func (c *Client) ConnectContainerToNetwork(ctx context.Context, networkID, containerID string) error {
	_, err := c.cli.NetworkConnect(ctx, networkID, client.NetworkConnectOptions{
		Container: containerID,
	})
	if err != nil {
		return fmt.Errorf("network connect: %w", err)
	}
	return nil
}

// DisconnectContainerFromNetwork disconnects a container from a network.
func (c *Client) DisconnectContainerFromNetwork(ctx context.Context, networkID, containerID string) error {
	_, err := c.cli.NetworkDisconnect(ctx, networkID, client.NetworkDisconnectOptions{
		Container: containerID,
	})
	if err != nil {
		return fmt.Errorf("network disconnect: %w", err)
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────

// ContainerName returns the canonical name of a container (without leading "/").

// releaseSecureLinkConnector disconnects the Secure Link connector from a network Opfield removes. The connector
// joins the networks of the link targets it serves; with them gone it serves nothing there, and its endpoint alone
// kept the network (an Availability placement's deployment network: its replacement standby could never be prepared).
// Unless always is set it leaves only a network it is the last container on. The connector's next link sync attaches
// it to a network of the same name created again.
func (c *Client) releaseSecureLinkConnector(ctx context.Context, network string, always bool) {
	inspected, err := c.cli.NetworkInspect(ctx, network, client.NetworkInspectOptions{})
	if err != nil {
		return
	}
	// Both connector slots: a replaced connector stays attached while it retires.
	var attached []string
	for _, endpoint := range inspected.Network.Containers {
		if name := strings.TrimPrefix(endpoint.Name, "/"); isSecureLinkConnectorName(name) {
			attached = append(attached, name)
		} else if !always {
			return
		}
	}
	for _, name := range attached {
		_, err = c.cli.NetworkDisconnect(ctx, network, client.NetworkDisconnectOptions{Container: name, Force: true})
		if err != nil && !isDetachedErr(err) && c.logger != nil {
			c.logger.Warn("cannot detach the secure-link connector from a network being removed", "network", network, "error", err)
		}
	}
}

// isSecureLinkConnectorName reports the connector's containers: its slots and the anchor holding its endpoints.
func isSecureLinkConnectorName(name string) bool {
	if isSecureLinkAnchorName(name) {
		return true
	}
	for _, family := range secureLinkNameFamilies {
		if slices.Contains(secureLinkConnectorSlotNames(family), name) {
			return true
		}
	}
	return false
}

// releaseSecureLinkConnectorFromProject disconnects the Secure Link connector from the networks of a Compose project
// that is taken down: compose removes them with the project, and the connector's endpoint would keep them.
func (c *Client) releaseSecureLinkConnectorFromProject(ctx context.Context, projectName string) {
	listed, err := c.cli.NetworkList(ctx, client.NetworkListOptions{
		Filters: make(client.Filters).Add("label", "com.docker.compose.project="+projectName),
	})
	if err != nil {
		return
	}
	for _, item := range listed.Items {
		c.releaseSecureLinkConnector(ctx, item.ID, true)
	}
}
