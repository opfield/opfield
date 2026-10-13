package docker

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	mobyclient "github.com/moby/moby/client"
)

var storageBindingNetworkNamePattern = regexp.MustCompile(`^gateway-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

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
