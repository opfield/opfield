package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func (p *DockerPlugin) handleNetworkCommand(cmd *pb.DockerNetworkCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListNetworks(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "reserved_ipam_supported":
		// Capability probe used before an existing binding network is replaced.
		// Older daemons reject the action before the backend disconnects targets.

	case "create":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id (name) is required for network create"
			return
		}
		id, err := p.client.CreateNetwork(ctx, cmd.NetworkId, cmd.Driver, cmd.Subnet, cmd.GatewayAddr)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id})
		result.Detail = string(data)

	case "create_storage_binding":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id (name) is required for managed storage binding network"
			return
		}
		id, err := p.createStorageBindingNetwork(ctx, cmd.NetworkId, cmd.Driver, cmd.Subnet, cmd.GatewayAddr)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id})
		result.Detail = string(data)

	case "create_link_network":
		// A link network with a /28 of the secure-link pool and the connector's reserved address (C5).
		linkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		created, err := p.createLinkNetwork(linkCtx, cmd.NetworkId)
		cancel()
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(created)
		result.Detail = string(data)

	case "create_reserved":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id (name) is required for reserved network create"
			return
		}
		id, reservedAddress, err := p.client.CreateReservedNetwork(
			ctx,
			cmd.NetworkId,
			cmd.Driver,
			cmd.Subnet,
			cmd.GatewayAddr,
		)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id, "reservedAddress": reservedAddress})
		result.Detail = string(data)

	case "remove":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id is required for network remove"
			return
		}
		if err := p.client.RemoveNetwork(ctx, cmd.NetworkId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "connect":
		if cmd.NetworkId == "" || cmd.ContainerId == "" {
			result.Success = false
			result.Error = "network_id and container_id are required for connect"
			return
		}
		if err := p.client.ConnectContainerToNetwork(ctx, cmd.NetworkId, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "disconnect":
		if cmd.NetworkId == "" || cmd.ContainerId == "" {
			result.Success = false
			result.Error = "network_id and container_id are required for disconnect"
			return
		}
		if err := p.client.DisconnectContainerFromNetwork(ctx, cmd.NetworkId, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown network action: %s", cmd.Action)
	}
}

// handleLogsCommand retrieves container logs and returns them as JSON.
// When follow is true, starts a background goroutine that streams log chunks.
