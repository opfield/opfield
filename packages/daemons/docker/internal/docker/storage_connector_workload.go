package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

const (
	managedStorageConnectorWorkload = "managed-storage-connector"
	managedStorageConnectorLabel    = "net.opfield.internal-workload"
)

func (p *DockerPlugin) createManagedStorageConnector(ctx context.Context, raw string) (string, string, error) {
	var config ContainerCreateConfig
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return "", "", fmt.Errorf("parse internal workload config: %w", err)
	}
	if err := validateManagedStorageConnectorConfig(config, storageConnectorRelayDirectory(p.cfg.StateDir)); err != nil {
		return "", "", err
	}
	if config.Image != developmentSecureLinkImage {
		if err := p.client.EnsureImage(ctx, config.Image, ""); err != nil {
			return "", "", fmt.Errorf("ensure managed storage connector image: %w", err)
		}
	}
	inspected, err := p.client.cli.NetworkInspect(ctx, config.NetworkMode, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return "", "", fmt.Errorf("inspect storage connector network: %w", err)
	}
	if inspected.Network.Driver != "bridge" || !inspected.Network.Internal || inspected.Network.Ingress || inspected.Network.ConfigOnly {
		return "", "", errors.New("managed storage connector requires an internal bridge network")
	}
	containerConfig := &container.Config{Image: config.Image, Env: config.Env, User: "65532:65532", Labels: config.Labels}
	// A per-link storage connector carries one link: it keeps the limits connectors had before they were shared.
	pids := legacySecureLinkConnectorPidsLimit
	hostConfig := &container.HostConfig{
		LogConfig: internalContainerLogConfig(),
		Binds:     config.Binds, GroupAdd: connectorGroupAdd(), ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		Resources:     container.Resources{Memory: legacySecureLinkConnectorMemory, NanoCPUs: legacySecureLinkConnectorNanoCPUs, PidsLimit: &pids},
	}
	created, err := p.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: containerConfig, HostConfig: hostConfig,
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{config.NetworkMode: {Aliases: config.NetworkAliases}}},
		Name:             config.Name,
	})
	if err != nil {
		return "", "", fmt.Errorf("create managed storage connector: %w", err)
	}
	if _, err := p.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_ = p.client.RemoveContainer(ctx, created.ID, true)
		return "", "", fmt.Errorf("start managed storage connector: %w", err)
	}
	return created.ID, config.Name, nil
}

func validateManagedStorageConnectorConfig(config ContainerCreateConfig, socketDirectory string) error {
	if config.InternalWorkload != managedStorageConnectorWorkload || !allowedSecureLinkConnectorImage(config.Image) {
		return errors.New("invalid managed storage connector workload image")
	}
	bindingID := connectorEnvValue(config.Env, "BINDING_ID")
	if named, ok := storageConnectorBindingID(config.Name); bindingID == "" || !ok || named != bindingID {
		return errors.New("managed storage connector name must be derived from its binding id")
	}
	if len(config.NetworkAliases) != 1 || config.NetworkAliases[0] != storageBindingAlias(bindingID) {
		return errors.New("managed storage connector requires its derived network alias")
	}
	if config.User != "65532:65532" || config.NetworkMode == "" || config.NetworkMode == "host" || strings.HasPrefix(config.NetworkMode, "container:") ||
		config.Privileged || len(config.CapAdd) != 0 || len(config.CapDrop) != 0 || len(config.Cmd) != 0 || len(config.Entrypoint) != 0 ||
		len(config.PortBindings) != 0 || len(config.Ports) != 0 || len(config.ExtraHosts) != 0 || config.RuntimeProfile != "" ||
		config.Labels[managedStorageConnectorLabel] != managedStorageConnectorWorkload ||
		!validStorageConnectorInternalWorkload(config.Env, config.Binds, socketDirectory) {
		return errors.New("managed storage connector workload configuration is invalid")
	}
	return nil
}
