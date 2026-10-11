package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// dockerNetworkIsolationCapability advertises the network_isolate and network_restore container actions.
const dockerNetworkIsolationCapability = "docker_network_isolation_v1"

// hostNetworkIsolationPrefix starts the error of an isolate request for a container that shares the host's or another
// container's network stack, which cannot be detached from its networks.
const hostNetworkIsolationPrefix = "HOST_NETWORK:"

// IsolatedEndpoint is the user configuration of one network endpoint a container was disconnected from, enough to
// connect it again as it was. Dynamic addresses are not part of it.
type IsolatedEndpoint struct {
	NetworkID    string            `json:"networkId"`
	NetworkName  string            `json:"networkName"`
	Aliases      []string          `json:"aliases"`
	IPv4Address  string            `json:"ipv4Address"`
	IPv6Address  string            `json:"ipv6Address"`
	LinkLocalIPs []string          `json:"linkLocalIps"`
	Links        []string          `json:"links"`
	DriverOpts   map[string]string `json:"driverOpts"`
	// MacAddress stays empty: Docker reports the running endpoint's address, which a recreate does not carry either.
	MacAddress string `json:"macAddress"`
	GwPriority int    `json:"gwPriority"`
}

// NetworkIsolateResult lists what network_isolate removed.
type NetworkIsolateResult struct {
	NetworkMode string             `json:"networkMode"`
	Endpoints   []IsolatedEndpoint `json:"endpoints"`
}

// NetworkRestoreFailure is a network network_restore could not connect.
type NetworkRestoreFailure struct {
	NetworkName string `json:"networkName"`
	NetworkID   string `json:"networkId"`
	Error       string `json:"error"`
}

// NetworkRestoreResult reports network_restore per network.
type NetworkRestoreResult struct {
	Restored []string `json:"restored"`
	// Gone lists the networks that no longer exist (removed with their binding or link meanwhile): skipped, never
	// failed, since retrying cannot bring them back.
	Gone   []string                `json:"gone"`
	Failed []NetworkRestoreFailure `json:"failed"`
	// NetworkModeGone is the container's network mode when it names a network that no longer exists.
	NetworkModeGone string `json:"networkModeGone,omitempty"`
	// FallbackNetwork is the network the container was put on because its network mode is gone and no other network
	// was left to restore: Docker would otherwise refuse to start it.
	FallbackNetwork string `json:"fallbackNetwork,omitempty"`
}

// IsolateContainerNetworks disconnects a container from every network it is attached to, Gateway-managed ones
// included, and returns the endpoints it removed. A failed disconnect reconnects the endpoints already removed.
func (c *Client) IsolateContainerNetworks(ctx context.Context, containerRef string) (*NetworkIsolateResult, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerRef, client.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("container inspect: %w", err)
	}
	inspected := insp.Container
	mode := currentInspectNetworkMode(&inspected)
	networkMode := container.NetworkMode(mode)
	if networkMode.IsHost() || strings.HasPrefix(mode, "container:") {
		return nil, fmt.Errorf("%s container %s uses the %s network mode and cannot be isolated from its networks",
			hostNetworkIsolationPrefix, containerRef, mode)
	}
	result := &NetworkIsolateResult{NetworkMode: mode, Endpoints: isolatedEndpointsFromInspect(&inspected)}
	for index, endpoint := range result.Endpoints {
		if _, err := c.cli.NetworkDisconnect(ctx, endpointNetworkRef(endpoint), client.NetworkDisconnectOptions{
			Container: inspected.ID,
			Force:     true,
		}); err != nil && !isNotFoundErr(err) && !isNotConnectedErr(err) {
			disconnectErr := fmt.Errorf("disconnect network %q: %w", endpoint.NetworkName, err)
			rollbackCtx, cancel := recreateRollbackContext(ctx)
			defer cancel()
			for _, removed := range result.Endpoints[:index] {
				if rollbackErr := c.connectIsolatedEndpoint(rollbackCtx, inspected.ID, removed); rollbackErr != nil {
					disconnectErr = errors.Join(disconnectErr,
						fmt.Errorf("reconnect network %q: %w", removed.NetworkName, rollbackErr))
				}
			}
			return nil, disconnectErr
		}
	}
	return result, nil
}

// RestoreContainerNetworks connects a container to the endpoints network_isolate removed. A network the container is
// already on counts as restored; a network that no longer exists is reported gone and a failed connect failed, and
// the rest still connect. A container whose network mode names a network that is gone keeps the networks restored;
// with none left it joins Docker's default bridge network, so it can still start.
func (c *Client) RestoreContainerNetworks(ctx context.Context, containerRef string, endpoints []IsolatedEndpoint) (*NetworkRestoreResult, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerRef, client.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("container inspect: %w", err)
	}
	inspected := insp.Container
	attachedNames := map[string]bool{}
	attachedIDs := map[string]bool{}
	if inspected.NetworkSettings != nil {
		for name, settings := range inspected.NetworkSettings.Networks {
			attachedNames[name] = true
			if settings != nil && settings.NetworkID != "" {
				attachedIDs[settings.NetworkID] = true
			}
		}
	}
	result := &NetworkRestoreResult{Restored: []string{}, Gone: []string{}, Failed: []NetworkRestoreFailure{}}
	for _, endpoint := range orderRestoreEndpoints(endpoints, currentInspectNetworkMode(&inspected)) {
		label := endpoint.NetworkName
		if label == "" {
			label = endpoint.NetworkID
		}
		if (endpoint.NetworkName != "" && attachedNames[endpoint.NetworkName]) ||
			(endpoint.NetworkID != "" && attachedIDs[endpoint.NetworkID]) {
			result.Restored = append(result.Restored, label)
			continue
		}
		if err := c.connectIsolatedEndpoint(ctx, inspected.ID, endpoint); err != nil {
			if isAlreadyConnectedErr(err) {
				result.Restored = append(result.Restored, label)
				continue
			}
			if isNetworkNotFoundErr(err) {
				result.Gone = append(result.Gone, label)
				continue
			}
			result.Failed = append(result.Failed, NetworkRestoreFailure{
				NetworkName: endpoint.NetworkName,
				NetworkID:   endpoint.NetworkID,
				Error:       err.Error(),
			})
			continue
		}
		result.Restored = append(result.Restored, label)
	}
	if err := c.restoreStartableNetworkMode(ctx, &inspected, len(attachedNames) > 0 || len(result.Restored) > 0, result); err != nil {
		return nil, err
	}
	return result, nil
}

// restoreStartableNetworkMode checks the container's network mode after a restore. Docker attaches the network a
// user-defined network mode names whenever the container starts on no network, and refuses the start when that
// network is gone: the gone network mode is reported, and a container left on no network joins the default bridge.
func (c *Client) restoreStartableNetworkMode(
	ctx context.Context,
	inspected *container.InspectResponse,
	onNetwork bool,
	result *NetworkRestoreResult,
) error {
	mode := container.NetworkMode(currentInspectNetworkMode(inspected))
	if mode == "" || !mode.IsUserDefined() {
		return nil
	}
	existing, err := c.existingNetworkNames(ctx, []string{string(mode)})
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		return nil
	}
	result.NetworkModeGone = string(mode)
	if onNetwork {
		return nil
	}
	if _, err := c.cli.NetworkConnect(ctx, network.NetworkBridge, client.NetworkConnectOptions{
		Container:      inspected.ID,
		EndpointConfig: &network.EndpointSettings{},
	}); err != nil && !isAlreadyConnectedErr(err) {
		result.Failed = append(result.Failed, NetworkRestoreFailure{
			NetworkName: network.NetworkBridge,
			Error:       err.Error(),
		})
		return nil
	}
	result.FallbackNetwork = network.NetworkBridge
	return nil
}

// connectIsolatedEndpoint connects the container by network name, falling back to the network ID when no network of
// that name exists (a network recreated under the same name keeps working; a renamed one is still found).
func (c *Client) connectIsolatedEndpoint(ctx context.Context, containerID string, endpoint IsolatedEndpoint) error {
	settings, err := endpoint.endpointSettings()
	if err != nil {
		return err
	}
	refs := make([]string, 0, 2)
	if endpoint.NetworkName != "" {
		refs = append(refs, endpoint.NetworkName)
	}
	if endpoint.NetworkID != "" && endpoint.NetworkID != endpoint.NetworkName {
		refs = append(refs, endpoint.NetworkID)
	}
	if len(refs) == 0 {
		return errors.New("endpoint has no network name or id")
	}
	var connectErr error
	for _, ref := range refs {
		_, connectErr = c.cli.NetworkConnect(ctx, ref, client.NetworkConnectOptions{
			Container:      containerID,
			EndpointConfig: settings.Copy(),
		})
		if connectErr == nil {
			return nil
		}
		if !isNetworkNotFoundErr(connectErr) {
			return connectErr
		}
	}
	return connectErr
}

func isolatedEndpointsFromInspect(insp *container.InspectResponse) []IsolatedEndpoint {
	endpoints := []IsolatedEndpoint{}
	if insp == nil || insp.NetworkSettings == nil {
		return endpoints
	}
	autoAliases := map[string]bool{}
	if id := insp.ID; id != "" {
		autoAliases[id] = true
		if len(id) > 12 {
			autoAliases[id[:12]] = true
		}
	}
	if name := strings.TrimPrefix(insp.Name, "/"); name != "" {
		autoAliases[name] = true
	}
	for name, source := range insp.NetworkSettings.Networks {
		if strings.TrimSpace(name) == "" || name == network.NetworkNone {
			continue
		}
		endpoint := IsolatedEndpoint{
			NetworkName:  name,
			Aliases:      []string{},
			LinkLocalIPs: []string{},
			Links:        []string{},
			DriverOpts:   map[string]string{},
		}
		if config := endpointConfigForRecreate(source); config != nil {
			endpoint.NetworkID = source.NetworkID
			for _, alias := range config.Aliases {
				if alias != "" && !autoAliases[alias] {
					endpoint.Aliases = append(endpoint.Aliases, alias)
				}
			}
			if config.IPAMConfig != nil {
				if config.IPAMConfig.IPv4Address.IsValid() {
					endpoint.IPv4Address = config.IPAMConfig.IPv4Address.String()
				}
				if config.IPAMConfig.IPv6Address.IsValid() {
					endpoint.IPv6Address = config.IPAMConfig.IPv6Address.String()
				}
				for _, address := range config.IPAMConfig.LinkLocalIPs {
					if address.IsValid() {
						endpoint.LinkLocalIPs = append(endpoint.LinkLocalIPs, address.String())
					}
				}
			}
			endpoint.Links = append(endpoint.Links, config.Links...)
			for key, value := range config.DriverOpts {
				endpoint.DriverOpts[key] = value
			}
			endpoint.GwPriority = config.GwPriority
		}
		endpoints = append(endpoints, endpoint)
	}
	sort.Slice(endpoints, func(i, j int) bool { return endpoints[i].NetworkName < endpoints[j].NetworkName })
	return endpoints
}

// orderRestoreEndpoints sorts endpoints by network name and moves the network of the container's network mode first,
// so the restored container gets the default route it had.
func orderRestoreEndpoints(endpoints []IsolatedEndpoint, mode string) []IsolatedEndpoint {
	ordered := append([]IsolatedEndpoint(nil), endpoints...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].NetworkName < ordered[j].NetworkName })
	primary := mode
	if primary == "" || primary == network.NetworkDefault {
		primary = network.NetworkBridge
	}
	for index, endpoint := range ordered {
		if endpoint.NetworkName == primary || (endpoint.NetworkID != "" && endpoint.NetworkID == primary) {
			if index > 0 {
				copy(ordered[1:index+1], ordered[0:index])
				ordered[0] = endpoint
			}
			break
		}
	}
	return ordered
}

func endpointNetworkRef(endpoint IsolatedEndpoint) string {
	if endpoint.NetworkID != "" {
		return endpoint.NetworkID
	}
	return endpoint.NetworkName
}

func (endpoint IsolatedEndpoint) endpointSettings() (*network.EndpointSettings, error) {
	settings := &network.EndpointSettings{
		Aliases:    append([]string(nil), endpoint.Aliases...),
		Links:      append([]string(nil), endpoint.Links...),
		GwPriority: endpoint.GwPriority,
	}
	if len(endpoint.DriverOpts) > 0 {
		settings.DriverOpts = make(map[string]string, len(endpoint.DriverOpts))
		for key, value := range endpoint.DriverOpts {
			settings.DriverOpts[key] = value
		}
	}
	ipam := &network.EndpointIPAMConfig{}
	if endpoint.IPv4Address != "" {
		address, err := netip.ParseAddr(endpoint.IPv4Address)
		if err != nil {
			return nil, fmt.Errorf("parse ipv4Address %q: %w", endpoint.IPv4Address, err)
		}
		ipam.IPv4Address = address
	}
	if endpoint.IPv6Address != "" {
		address, err := netip.ParseAddr(endpoint.IPv6Address)
		if err != nil {
			return nil, fmt.Errorf("parse ipv6Address %q: %w", endpoint.IPv6Address, err)
		}
		ipam.IPv6Address = address
	}
	for _, value := range endpoint.LinkLocalIPs {
		address, err := netip.ParseAddr(value)
		if err != nil {
			return nil, fmt.Errorf("parse linkLocalIps entry %q: %w", value, err)
		}
		ipam.LinkLocalIPs = append(ipam.LinkLocalIPs, address)
	}
	if ipam.IPv4Address.IsValid() || ipam.IPv6Address.IsValid() || len(ipam.LinkLocalIPs) > 0 {
		settings.IPAMConfig = ipam
	}
	if endpoint.MacAddress != "" {
		var mac network.HardwareAddr
		if err := mac.UnmarshalText([]byte(endpoint.MacAddress)); err != nil {
			return nil, fmt.Errorf("parse macAddress %q: %w", endpoint.MacAddress, err)
		}
		settings.MacAddress = mac
	}
	return settings, nil
}

func isNetworkNotFoundErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no such network") ||
		(strings.Contains(msg, "network") && strings.Contains(msg, "not found"))
}

func isNotConnectedErr(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "is not connected to")
}

func isAlreadyConnectedErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already attached") ||
		(strings.Contains(msg, "endpoint with name") && strings.Contains(msg, "already exists"))
}

// decodeNetworkRestoreEndpoints parses the network_restore payload.
func decodeNetworkRestoreEndpoints(configJSON string) ([]IsolatedEndpoint, error) {
	if strings.TrimSpace(configJSON) == "" {
		return nil, errors.New("config_json is required for network_restore")
	}
	var payload struct {
		Endpoints *[]IsolatedEndpoint `json:"endpoints"`
	}
	if err := json.Unmarshal([]byte(configJSON), &payload); err != nil {
		return nil, fmt.Errorf("parse network restore payload: %w", err)
	}
	if payload.Endpoints == nil {
		return nil, errors.New("network restore payload has no endpoints")
	}
	for index, endpoint := range *payload.Endpoints {
		if endpoint.NetworkName == "" && endpoint.NetworkID == "" {
			return nil, fmt.Errorf("network restore endpoint %d has no networkName or networkId", index)
		}
		if _, err := endpoint.endpointSettings(); err != nil {
			return nil, fmt.Errorf("network restore endpoint %q: %w", endpoint.NetworkName, err)
		}
	}
	return *payload.Endpoints, nil
}
