package docker

import (
	"context"
	"encoding/json"
	"fmt"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"time"
)

func (p *DockerPlugin) handleContainerCommand(cmd *pb.DockerContainerCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		containers, err := p.client.ListContainers(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		// Filter by allowlist
		containers = p.allowlist.Filter(containers)
		p.client.AttachListeningPorts(ctx, containers)
		data, err := json.Marshal(containers)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal containers: %v", err)
			return
		}
		result.Detail = string(data)

	case "inspect":
		data, err := p.client.InspectContainer(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "start":
		if err := p.client.StartContainer(ctx, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "stop":
		timeout := int(cmd.TimeoutSeconds)
		timeoutProvided := dockerTimeoutProvided(cmd.ConfigJson)
		if timeout < 0 || (timeout == 0 && !timeoutProvided) {
			timeout = defaultContainerStopTimeoutSeconds
		}
		// Run async to avoid blocking the command handler
		containerID := cmd.ContainerId
		go func() {
			if err := p.client.StopContainer(context.Background(), containerID, timeout); err != nil {
				p.logger.Warn("container stop failed", "container", containerID, "error", err)
			}
		}()

	case "restart":
		timeout := int(cmd.TimeoutSeconds)
		timeoutProvided := dockerTimeoutProvided(cmd.ConfigJson)
		if timeout < 0 || (timeout == 0 && !timeoutProvided) {
			timeout = defaultContainerStopTimeoutSeconds
		}
		containerID := cmd.ContainerId
		go func() {
			if err := p.client.RestartContainer(context.Background(), containerID, timeout); err != nil {
				p.logger.Warn("container restart failed", "container", containerID, "error", err)
			}
		}()

	case "kill":
		var params struct {
			ContainerName string `json:"containerName"`
		}
		if cmd.ConfigJson != "" {
			if err := json.Unmarshal([]byte(cmd.ConfigJson), &params); err != nil {
				result.Success = false
				result.Error = fmt.Sprintf("parse emergency kill params: %v", err)
				return
			}
		}
		signal := cmd.Signal
		if signal == "" {
			signal = "SIGKILL"
		}
		target := cmd.ContainerId
		if params.ContainerName != "" {
			target = params.ContainerName
		}
		if !p.taskMgr.CancelAndWait(target, emergencyKillCancellationTimeout) {
			result.Success = false
			result.Error = "timed out cancelling the active container operation"
			return
		}
		if err := p.client.KillContainer(ctx, target, signal); err != nil && !isNotFoundErr(err) {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "remove":
		if err := p.client.RemoveContainer(ctx, cmd.ContainerId, cmd.Force); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "rename":
		if cmd.NewName == "" {
			result.Success = false
			result.Error = "new_name is required for rename"
			return
		}
		if err := p.client.RenameContainer(ctx, cmd.ContainerId, cmd.NewName); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create":
		if cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "config_json is required for create"
			return
		}
		var internal struct {
			Workload string `json:"internal_workload"`
		}
		if err := json.Unmarshal([]byte(cmd.ConfigJson), &internal); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse container config: %v", err)
			return
		}
		var id, name string
		var err error
		if internal.Workload == "" {
			id, name, err = p.client.CreateContainer(ctx, p.leaseCreateConfig(cmd.ConfigJson))
		} else if internal.Workload == managedStorageConnectorWorkload {
			id, name, err = p.createManagedStorageConnector(ctx, cmd.ConfigJson)
		} else {
			err = fmt.Errorf("unsupported internal workload %q", internal.Workload)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id, "name": name})
		result.Detail = string(data)

	case "duplicate":
		if cmd.NewName == "" {
			result.Success = false
			result.Error = "new_name is required for duplicate"
			return
		}
		// The backend names the variables a duplicate must not inherit: the source's database and storage link
		// variables carry the link's credentials.
		var params struct {
			RemoveEnv []string `json:"removeEnv"`
		}
		if cmd.ConfigJson != "" {
			if err := json.Unmarshal([]byte(cmd.ConfigJson), &params); err != nil {
				result.Success = false
				result.Error = fmt.Sprintf("parse duplicate params: %v", err)
				return
			}
		}
		id, err := p.client.DuplicateContainer(ctx, cmd.ContainerId, cmd.NewName, params.RemoveEnv)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id})
		result.Detail = string(data)

	case "update":
		// Container update is a long-running operation, use task manager.
		// Parse update params from config_json.
		var params struct {
			Tag           string            `json:"tag"`
			Env           map[string]string `json:"env"`
			EnvRemovals   []string          `json:"env_removals"`
			RemoveEnv     []string          `json:"removeEnv"`
			ExpectedState string            `json:"expectedState"`
		}
		if cmd.ConfigJson != "" {
			if err := json.Unmarshal([]byte(cmd.ConfigJson), &params); err != nil {
				result.Success = false
				result.Error = fmt.Sprintf("parse update params: %v", err)
				return
			}
		}

		containerID := cmd.ContainerId

		// Determine registry auth for the container's image
		p.registryMu.RLock()
		regCreds := make(map[string]string, len(p.registryCreds))
		for k, v := range p.registryCreds {
			regCreds[k] = v
		}
		p.registryMu.RUnlock()

		// Resolve container name for envstore
		containerName, _ := p.client.ContainerName(ctx, containerID)

		taskKey := containerID
		if containerName != "" {
			taskKey = containerName
		}
		task, err := p.taskMgr.SubmitForCommand(result.CommandId, taskKey, "update", 10*time.Minute, func(taskCtx context.Context) error {
			// Compute env changes via envstore
			var envOverrides map[string]string
			var envRemovals []string

			explicitRemovals := append([]string{}, params.EnvRemovals...)
			explicitRemovals = append(explicitRemovals, params.RemoveEnv...)

			if len(params.Env) > 0 || len(explicitRemovals) > 0 {
				if containerName != "" {
					// Apply env changes through envstore
					_, applyErr := p.envStore.Apply(containerName, params.Env, explicitRemovals)
					if applyErr != nil {
						p.logger.Warn("envstore apply failed", "error", applyErr)
					}
					envRemovals = append(envRemovals, explicitRemovals...)
				}
				envOverrides = params.Env
			}

			// Resolve registry auth for the image
			inspData, inspErr := p.client.InspectContainer(taskCtx, containerID)
			registryAuth := ""
			if inspErr == nil {
				var inspJSON struct {
					Config struct {
						Image  string            `json:"Image"`
						Labels map[string]string `json:"Labels"`
					} `json:"Config"`
				}
				if json.Unmarshal(inspData, &inspJSON) == nil {
					imageReference := configuredArchiveImageReference(inspJSON.Config.Image, inspJSON.Config.Labels)
					if imageReference != "" {
						registryAuth = resolveRegistryAuth(imageReference, regCreds)
					}
				}
			}

			if err := p.client.UpdateContainer(taskCtx, containerID, params.Tag, envOverrides, envRemovals, registryAuth, params.ExpectedState); err != nil {
				return err
			}

			// Save applied env
			if containerName != "" && len(params.Env) > 0 {
				_ = p.envStore.SaveApplied(containerName, params.Env)
			}

			return nil
		})
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

		data, _ := json.Marshal(task)
		result.Detail = string(data)

	case "stats":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for stats"
			return
		}
		// Return cached stats from the background collector (updated every 10s)
		// Falls back to a live fetch if no cached data available
		if p.statsCollector != nil {
			for _, s := range p.statsCollector.GetStats() {
				if s.ContainerId == cmd.ContainerId {
					data, _ := json.Marshal(s)
					result.Detail = string(data)
					return
				}
			}
		}
		// Fallback: live fetch (slower, ~1s)
		data, err := p.client.ContainerStatsOnce(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "top":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for top"
			return
		}
		data, err := p.client.ContainerTop(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "http_probe":
		if cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "config_json is required for http_probe"
			return
		}
		data, err := p.client.HTTPProbe(ctx, cmd.ConfigJson)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		detail, _ := json.Marshal(data)
		result.Detail = string(detail)

	case "live_update":
		if cmd.ContainerId == "" || cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "container_id and config_json are required for live_update"
			return
		}
		if err := p.client.LiveUpdateContainer(ctx, cmd.ContainerId, cmd.ConfigJson); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "recreate":
		if cmd.ContainerId == "" || cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "container_id and config_json are required for recreate"
			return
		}
		containerID := cmd.ContainerId
		containerName, _ := p.client.ContainerName(ctx, containerID)
		taskKey := containerID
		if containerName != "" {
			taskKey = containerName
		}
		task, err := p.taskMgr.SubmitForCommand(result.CommandId, taskKey, "recreate", 10*time.Minute, func(taskCtx context.Context) error {
			return p.client.RecreateWithConfig(taskCtx, containerID, cmd.ConfigJson)
		})
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(task)
		result.Detail = string(data)

	case "task_status":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for task_status"
			return
		}
		// The ID is the task's, or that of the Gateway command that started it (TaskCommandLookupCapability).
		task, ok := p.taskMgr.Get(cmd.ContainerId)
		if !ok {
			result.Success = false
			result.Error = "docker task not found"
			return
		}
		data, _ := json.Marshal(task)
		result.Detail = string(data)

	case "network_isolate":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for network_isolate"
			return
		}
		isolated, err := p.client.IsolateContainerNetworks(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(isolated)
		result.Detail = string(data)

	case "network_restore":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for network_restore"
			return
		}
		endpoints, err := decodeNetworkRestoreEndpoints(cmd.ConfigJson)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		restored, err := p.client.RestoreContainerNetworks(ctx, cmd.ContainerId, endpoints)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(restored)
		result.Detail = string(data)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown container action: %s", cmd.Action)
	}
}

// handleImageCommand dispatches image actions.
