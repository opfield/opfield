package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
)

func (p *DockerPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	if p.cfg.Docker.Mode == "builder" {
		switch payload := cmd.Payload.(type) {
		case *pb.GatewayCommand_DockerBuild:
			if p.builderManager == nil {
				result.Success = false
				result.Error = "builder execution is not initialized"
			} else if err := p.builderManager.Start(payload.DockerBuild); err != nil {
				result.Success = false
				result.Error = err.Error()
			}
		case *pb.GatewayCommand_DockerBuildCancel:
			if p.builderManager == nil || !p.builderManager.Cancel(payload.DockerBuildCancel.GetBuildId()) {
				result.Success = false
				result.Error = "build is not running"
			}
		case *pb.GatewayCommand_DockerBuildEventAck:
			if p.builderManager == nil {
				result.Success = false
				result.Error = "builder execution is not initialized"
			} else {
				p.builderManager.Acknowledge(
					payload.DockerBuildEventAck.GetBuildId(),
					payload.DockerBuildEventAck.GetAttempt(),
					payload.DockerBuildEventAck.GetDisposition(),
				)
			}
		case *pb.GatewayCommand_SyncDockerRegistryBindings:
			detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
			if err != nil {
				result.Success = false
				result.Error = err.Error()
			} else {
				result.Detail = detail
			}
		case *pb.GatewayCommand_SetDaemonLogStream:
			stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
		default:
			result.Success = false
			result.Error = "builder-profile daemon accepts only docker build, acknowledgement, cancellation, and registry binding commands"
		}
		return result
	}
	if p.cfg.Docker.IsStorageProfile() {
		switch payload := cmd.Payload.(type) {
		case *pb.GatewayCommand_DockerDatabase:
			p.handleManagedDatabaseCommand(payload.DockerDatabase, result)
		case *pb.GatewayCommand_DockerStorage:
			p.handleManagedStorageCommand(payload.DockerStorage, result)
		case *pb.GatewayCommand_DockerBackup:
			if p.backupHandler == nil {
				result.Success = false
				result.Error = "backup command handler is not registered"
			} else {
				p.backupHandler.handleBackupCommand(payload.DockerBackup, result)
			}
		default:
			result.Success = false
			result.Error = "storage-profile daemon accepts only docker_database, docker_storage and docker_backup commands"
		}
		return result
	}

	if err := p.leaseGate(cmd); err != nil {
		result.Success = false
		result.Error = err.Error()
		return result
	}

	switch payload := cmd.Payload.(type) {
	case *pb.GatewayCommand_DockerContainer:
		p.handleContainerCommand(payload.DockerContainer, result)

	case *pb.GatewayCommand_DockerImage:
		p.handleImageCommand(payload.DockerImage, result)

	case *pb.GatewayCommand_DockerVolume:
		p.handleVolumeCommand(payload.DockerVolume, result)

	case *pb.GatewayCommand_DockerNetwork:
		p.handleNetworkCommand(payload.DockerNetwork, result)

	case *pb.GatewayCommand_DockerDeployment:
		p.handleDeploymentCommand(payload.DockerDeployment, result)

	case *pb.GatewayCommand_DockerCompose:
		p.handleComposeCommand(payload.DockerCompose, result)

	case *pb.GatewayCommand_DockerRuntime:
		p.handleRuntimeCommand(payload.DockerRuntime, result)

	case *pb.GatewayCommand_DockerAvailability:
		p.handleAvailabilityCommand(payload.DockerAvailability, result)

	case *pb.GatewayCommand_SyncAvailabilityLease:
		p.handleAvailabilityLeaseSync(payload.SyncAvailabilityLease, result)

	case *pb.GatewayCommand_AvailabilityLeaseHandoff:
		p.handleAvailabilityLeaseHandoff(payload.AvailabilityLeaseHandoff, result)

	case *pb.GatewayCommand_ApplyWitnesses:
		p.handleApplyKeeperWitnesses(payload.ApplyWitnesses, result)

	case *pb.GatewayCommand_AvailabilityMember:
		if err := p.handleAvailabilityMember(payload.AvailabilityMember); err != nil {
			result.Success, result.Error = false, err.Error()
		}

	case *pb.GatewayCommand_DockerExec:
		p.handleExecCommand(payload.DockerExec, result)

	case *pb.GatewayCommand_DockerFile:
		p.handleFileCommand(payload.DockerFile, result)

	case *pb.GatewayCommand_ExecInput:
		p.handleExecInput(payload.ExecInput)

	case *pb.GatewayCommand_DockerLogs:
		p.handleLogsCommand(payload.DockerLogs, result)

	case *pb.GatewayCommand_DockerConfigPush:
		p.handleConfigPush(payload.DockerConfigPush, result)

	case *pb.GatewayCommand_DockerMigration:
		p.handleMigrationCommand(payload.DockerMigration, result)

	case *pb.GatewayCommand_SyncDockerRegistryBindings:
		detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}

	case *pb.GatewayCommand_DockerDatabase:
		result.Success = false
		result.Error = "managed database commands require the Storage profile"

	case *pb.GatewayCommand_DockerStorage:
		result.Success = false
		result.Error = "managed storage commands require docker.mode=storage"

	case *pb.GatewayCommand_DockerBackup:
		result.Success = false
		result.Error = "backup commands require docker.mode=storage"

	case *pb.GatewayCommand_SetDaemonLogStream:
		stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
		p.logger.Info("daemon log stream updated", "enabled", payload.SetDaemonLogStream.Enabled, "min_level", payload.SetDaemonLogStream.MinLevel)

	default:
		result.Success = false
		result.Error = "unsupported command for docker daemon"
	}

	return result
}

func (p *DockerPlugin) handleAvailabilityCommand(cmd *pb.DockerAvailabilityCommand, result *pb.CommandResult) {
	if p.cfg == nil || p.cfg.Docker.Mode != "" {
		result.Success = false
		result.Error = "docker availability commands require generic docker mode"
		return
	}
	if p.availability == nil {
		result.Success = false
		result.Error = "docker availability state manager is not initialized"
		return
	}
	if cmd.GetAction() == availabilityActionHealth {
		p.handleAvailabilityHealth(cmd, result)
		return
	}
	detail, err := p.availability.apply(cmd)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}

func sanitizeAvailabilityConfig(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()

	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("availability config_json must be valid JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("trailing JSON value")
		}
		return nil, fmt.Errorf("availability config_json must contain one JSON value: %w", err)
	}
	if value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("availability config_json must be a JSON object")
	}

	sanitized := sanitizeAvailabilityObject(object, 0)
	if len(sanitized) == 0 {
		return nil, nil
	}
	return sanitized, nil
}

func sanitizeAvailabilityObject(object map[string]any, depth int) map[string]any {
	if depth > 3 {
		return nil
	}
	sanitized := make(map[string]any)
	for key, value := range object {
		if sensitiveAvailabilityMetadataKey(key) {
			continue
		}
		normalized := normalizeAvailabilityMetadataKey(key)
		if !availabilityMetadataKeyAllowed(normalized) {
			continue
		}
		cleanValue, ok := sanitizeAvailabilityValue(value, depth+1)
		if ok {
			sanitized[key] = cleanValue
		}
	}
	if len(sanitized) == 0 {
		return nil
	}
	return sanitized
}

func sanitizeAvailabilityValue(value any, depth int) (any, bool) {
	switch typed := value.(type) {
	case string, bool, json.Number:
		return typed, true
	case map[string]any:
		clean := sanitizeAvailabilityObject(typed, depth)
		return clean, len(clean) > 0
	default:
		return nil, false
	}
}

func cloneAvailabilityMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return nil
	}
	clone := make(map[string]any, len(metadata))
	for key, value := range metadata {
		clone[key] = cloneAvailabilityValue(value)
	}
	return clone
}

func cloneAvailabilityValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneAvailabilityMetadata(typed)
	default:
		return typed
	}
}

func normalizeAvailabilityMetadataKey(key string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			return character
		}
		return -1
	}, strings.ToLower(key))
}

func sensitiveAvailabilityMetadataKey(key string) bool {
	normalized := normalizeAvailabilityMetadataKey(key)
	for _, fragment := range []string{
		"credential", "password", "passwd", "secret", "token", "apikey", "accesskey", "privatekey", "certificate", "cookie", "authorization", "auth", "environment", "env", "mount", "volume", "bind", "header",
	} {
		if strings.Contains(normalized, fragment) {
			return true
		}
	}
	return false
}

func availabilityMetadataKeyAllowed(key string) bool {
	switch key {
	case "runtime", "identity", "runtimeidentity", "status", "health", "metadata", "config", "phase",
		"id", "runtimeid", "containerid", "containername", "deploymentid", "projectid", "projectname", "runtimeidentityid", "name", "runtimename", "image", "imageid", "digest", "imagedigest", "revision", "version", "state", "healthstatus", "ready", "serving", "draining", "restartcount", "exitcode", "architecture", "arch", "platform", "nodeid", "routername", "networkname", "slots", "blue", "green", "activeslot", "observedat", "startedat", "stoppedat", "createdat", "updatedat":
		return true
	default:
		return false
	}
}

func (p *DockerPlugin) emitBuildEvent(event *pb.DockerBuildEvent) error {
	if event == nil {
		return fmt.Errorf("docker build event is required")
	}
	p.buildEventMu.RLock()
	writer := p.buildEventWriter
	p.buildEventMu.RUnlock()
	if writer == nil {
		return fmt.Errorf("command stream is unavailable")
	}
	if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_DockerBuildEvent{DockerBuildEvent: event}}); err != nil {
		if p.logger != nil {
			p.logger.Warn("failed to report Docker build event", "build_id", event.GetBuildId(), "attempt", event.GetAttempt(), "error", err)
		}
		return err
	}
	return nil
}

func (p *DockerPlugin) handleRuntimeCommand(cmd *pb.DockerRuntimeCommand, result *pb.CommandResult) {
	if p.runtimeManager == nil || cmd.Runtime != "runsc" {
		result.Success = false
		result.Error = "unsupported Docker runtime"
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	var status runtimemanager.Status
	var err error
	switch cmd.Action {
	case "preflight":
		status = p.runtimeManager.Preflight(ctx)
	case "install":
		p.setRuntimeStatus(runtimemanager.Status{
			State:         runtimemanager.StateInstalling,
			TargetVersion: runtimemanager.RunscVersion,
			CheckedAt:     time.Now().UTC(),
		})
		status, err = p.runtimeManager.Install(ctx)
	default:
		result.Success = false
		result.Error = "unknown runtime action"
		return
	}
	p.setRuntimeStatus(status)
	data, marshalErr := json.Marshal(status)
	if marshalErr != nil {
		result.Success = false
		result.Error = marshalErr.Error()
		return
	}
	result.Detail = string(data)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
	}
}

// handleContainerCommand dispatches container actions.
