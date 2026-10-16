package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func (c *Client) ensureDeploymentNetwork(ctx context.Context, name string, deploymentID string) error {
	if name == "" {
		return fmt.Errorf("network name is required")
	}
	_, err := c.cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
		Driver: "bridge",
		Labels: map[string]string{
			deploymentManagedLabel: "true",
			deploymentIDLabel:      deploymentID,
		},
	})
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return fmt.Errorf("create deployment network: %w", err)
	}
	return nil
}

func (c *Client) createDeploymentSlot(ctx context.Context, deploymentID, networkName, slot, name string, desired deploymentDesiredConfig, start bool, gpuSelection *gpuSelection) (string, error) {
	if name == "" {
		return "", fmt.Errorf("slot container name is required")
	}
	labels := map[string]string{}
	for k, v := range desired.Labels {
		labels[k] = v
	}
	labels[deploymentManagedLabel] = "true"
	labels[deploymentIDLabel] = deploymentID
	labels[deploymentRoleLabel] = "app"
	labels[deploymentSlotLabel] = slot

	cfg := &container.Config{
		Image:      desired.Image,
		Env:        envMapToList(desired.Env),
		Cmd:        desired.Command,
		Entrypoint: desired.Entrypoint,
		WorkingDir: desired.WorkingDir,
		User:       desired.User,
		Labels:     labels,
	}
	hostCfg := &container.HostConfig{
		Binds:       deploymentBinds(desired.Mounts),
		NetworkMode: container.NetworkMode(networkName),
	}
	managedDatabaseHosts, err := c.managedDatabaseHostEntries(ctx, desired.Networks)
	if err != nil {
		return "", err
	}
	hostCfg.ExtraHosts = mergeManagedDatabaseExtraHosts(hostCfg.ExtraHosts, managedDatabaseHosts)
	hostCfg.ExtraHosts = mergePreferredExtraHosts(hostCfg.ExtraHosts, desired.ExtraHosts)
	applyUserWorkloadBaseline(hostCfg)
	if err := c.applyRuntimeProfile(hostCfg, desired.RuntimeProfile, desired.GPU); err != nil {
		return "", err
	}
	if desired.RestartPolicy != "" {
		hostCfg.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(desired.RestartPolicy)}
	}
	applyDeploymentRuntime(hostCfg, desired)
	applyDefaultWorkloadLogConfig(hostCfg, c.defaultWorkloadLogDriver())
	c.applyResolvedGPUSelection(cfg, hostCfg, gpuSelection)
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     cfg,
		HostConfig: hostCfg,
		NetworkingConfig: &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				networkName: {Aliases: []string{slot}},
			},
		},
		Name: name,
	})
	if err != nil {
		return "", fmt.Errorf("create deployment slot: %w", err)
	}
	for _, additionalNetwork := range desired.Networks {
		if additionalNetwork == "" || additionalNetwork == networkName {
			continue
		}
		if _, err := c.cli.NetworkConnect(ctx, additionalNetwork, mobyclient.NetworkConnectOptions{Container: resp.ID}); err != nil {
			_ = c.RemoveContainerAndAnonymousVolumes(ctx, resp.ID, true)
			return "", fmt.Errorf("connect deployment slot to managed network: %w", err)
		}
	}
	if start {
		if err := c.gateStart(ctx, resp.ID); err != nil {
			return "", err
		}
		if _, err := c.cli.ContainerStart(ctx, resp.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return "", fmt.Errorf("start deployment slot: %w", err)
		}
	}
	return resp.ID, nil
}

func applyDeploymentRuntime(hostCfg *container.HostConfig, desired deploymentDesiredConfig) {
	runtime := desired.Runtime
	restartPolicy := desired.RestartPolicy
	if value, ok := runtimeString(runtime, "restartPolicy"); ok {
		restartPolicy = value
	}
	if restartPolicy != "" {
		policy := container.RestartPolicy{Name: container.RestartPolicyMode(restartPolicy)}
		if restartPolicy == "on-failure" {
			if maxRetries, ok := runtimeInt(runtime, "maxRetries"); ok {
				policy.MaximumRetryCount = maxRetries
			}
		}
		hostCfg.RestartPolicy = policy
	}

	if memoryLimit, ok := runtimeInt64(runtime, "memoryLimit"); ok {
		hostCfg.Memory = memoryLimit
	} else if memoryMB, ok := runtimeFloat(runtime, "memoryMB"); ok {
		hostCfg.Memory = int64(math.Round(memoryMB * 1048576))
	}

	if memorySwap, ok := runtimeInt64(runtime, "memorySwap"); ok {
		hostCfg.MemorySwap = memorySwap
	} else if memSwapMB, ok := runtimeFloat(runtime, "memSwapMB"); ok {
		if memSwapMB == -1 {
			hostCfg.MemorySwap = -1
		} else if hostCfg.Memory > 0 {
			hostCfg.MemorySwap = hostCfg.Memory + int64(math.Round(math.Max(0, memSwapMB)*1048576))
		} else {
			hostCfg.MemorySwap = 0
		}
	}

	if nanoCPUs, ok := runtimeInt64(runtime, "nanoCPUs"); ok {
		applyNanoCPULimit(&hostCfg.Resources, nanoCPUs)
	} else if cpuCount, ok := runtimeFloat(runtime, "cpuCount"); ok {
		applyNanoCPULimit(&hostCfg.Resources, int64(math.Round(cpuCount*1e9)))
	}

	if cpuShares, ok := runtimeInt64(runtime, "cpuShares"); ok {
		hostCfg.CPUShares = cpuShares
	}

	if pidsLimit, ok := runtimeInt64(runtime, "pidsLimit"); ok {
		hostCfg.PidsLimit = &pidsLimit
	}
}

func runtimeString(runtime map[string]any, key string) (string, bool) {
	if runtime == nil {
		return "", false
	}
	value, ok := runtime[key]
	if !ok || value == nil {
		return "", false
	}
	switch typed := value.(type) {
	case string:
		if typed == "" {
			return "", false
		}
		return typed, true
	default:
		return fmt.Sprint(typed), true
	}
}

func runtimeFloat(runtime map[string]any, key string) (float64, bool) {
	if runtime == nil {
		return 0, false
	}
	value, ok := runtime[key]
	if !ok || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		if strings.TrimSpace(typed) == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(typed, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func runtimeInt(runtime map[string]any, key string) (int, bool) {
	value, ok := runtimeFloat(runtime, key)
	if !ok {
		return 0, false
	}
	return int(math.Round(value)), true
}

func runtimeInt64(runtime map[string]any, key string) (int64, bool) {
	value, ok := runtimeFloat(runtime, key)
	if !ok {
		return 0, false
	}
	return int64(math.Round(value)), true
}
