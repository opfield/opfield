package docker

import (
	"context"
	"errors"
	"fmt"

	mobyclient "github.com/moby/moby/client"
)

func storageBindingAlias(bindingID string) string {
	compact := ""
	for _, character := range bindingID {
		if character != '-' {
			compact += string(character)
		}
	}
	if len(compact) < 16 {
		return ""
	}
	return "storage-" + compact[:16]
}

func (p *DockerPlugin) createStorageBindingNetwork(ctx context.Context, name, driver, subnet, gateway string) (string, error) {
	if !storageBindingNetworkNamePattern.MatchString(name) || driver != "bridge" || subnet != "" || gateway != "" {
		return "", errors.New("invalid managed storage binding network")
	}
	created, err := p.client.cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
		Driver: "bridge", Internal: true,
		Labels: map[string]string{"net.opfield.managed": managedStorageConnectorWorkload},
	})
	if err != nil {
		return "", fmt.Errorf("create managed storage binding network: %w", err)
	}
	return created.ID, nil
}
