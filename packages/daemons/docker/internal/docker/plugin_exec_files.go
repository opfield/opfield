package docker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"time"
)

func (p *DockerPlugin) handleConfigPush(cmd *pb.DockerConfigPushCommand, result *pb.CommandResult) {
	// Update allowlist if provided
	if len(cmd.Allowlist) > 0 {
		p.allowlist.Update(cmd.Allowlist)
		p.logger.Info("allowlist updated", "count", len(cmd.Allowlist))
	}

	// Store registry credentials
	if len(cmd.Registries) > 0 {
		p.registryMu.Lock()
		for _, reg := range cmd.Registries {
			if reg.Username == "" && reg.Password == "" {
				delete(p.registryCreds, reg.Url)
			} else {
				// Encode as base64 JSON (Docker registry auth format)
				authJSON, _ := json.Marshal(map[string]string{
					"username":      reg.Username,
					"password":      reg.Password,
					"serveraddress": reg.Url,
				})
				p.registryCreds[reg.Url] = encodeBase64(authJSON)
			}
		}
		p.registryMu.Unlock()
		p.logger.Info("registry credentials updated", "count", len(cmd.Registries))
	}
}

// handleExecCommand dispatches exec session actions (create, resize, detach).
func (p *DockerPlugin) handleExecCommand(cmd *pb.DockerExecCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "run":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for exec run"
			return
		}
		if len(cmd.Command) == 0 {
			result.Success = false
			result.Error = "command is required for exec run"
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		stdout, err := execInContainerBytesAsUser(runCtx, p.client, cmd.ContainerId, cmd.Command, cmd.User, 128*1024)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec run: %v", err)
			return
		}
		resp := map[string]interface{}{
			"stdout":   string(stdout),
			"exitCode": 0,
		}
		data, _ := json.Marshal(resp)
		result.Detail = string(data)

	case "create":
		if p.execMgr == nil {
			result.Success = false
			result.Error = "exec manager not initialized (no active session)"
			return
		}
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for exec create"
			return
		}
		execID, isNew, err := p.execMgr.CreateOrReuse(
			ctx,
			cmd.ContainerId,
			cmd.SessionKey,
			cmd.Command,
			cmd.Tty,
			int(cmd.Rows),
			int(cmd.Cols),
			cmd.User,
		)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec create: %v", err)
			return
		}

		resp := map[string]interface{}{
			"exec_id": execID,
			"is_new":  isNew,
			"buffer":  p.execMgr.GetBuffer(cmd.ContainerId, cmd.SessionKey),
		}
		data, _ := json.Marshal(resp)
		result.Detail = string(data)

	case "resize":
		if p.execMgr == nil {
			result.Success = false
			result.Error = "exec manager not initialized (no active session)"
			return
		}
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id (exec_id) is required for resize"
			return
		}
		if err := p.execMgr.HandleResize(ctx, cmd.ContainerId, int(cmd.Rows), int(cmd.Cols)); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec resize: %v", err)
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown exec action: %s", cmd.Action)
	}
}

// handleExecInput routes stdin data to the appropriate exec session.
func (p *DockerPlugin) handleExecInput(input *pb.ExecInput) {
	if p.execMgr == nil || input == nil {
		return
	}
	p.execMgr.HandleInput(input.ExecId, input.Data)
}

// handleFileCommand dispatches file browser actions (list, read).
func (p *DockerPlugin) handleFileCommand(cmd *pb.DockerFileCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required"
			return
		}
		path := cmd.Path
		if path == "" {
			path = "/"
		}
		entries, err := ListDir(ctx, p.client, cmd.ContainerId, path)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, err := json.Marshal(entries)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal entries: %v", err)
			return
		}
		result.Detail = string(data)

	case "read":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		content, err := ReadFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "write":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := WriteFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-file":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := CreateFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-init":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := InitChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-chunk":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := WriteChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-complete":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := CompleteChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-abort":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := AbortChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-dir":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := CreateDirectory(ctx, p.client, cmd.ContainerId, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "delete":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := DeletePath(ctx, p.client, cmd.ContainerId, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "move":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, path, and target_path are required"
			return
		}
		if err := MovePath(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown file action: %s", cmd.Action)
	}
}

// encodeBase64 encodes bytes as standard base64.
func encodeBase64(data []byte) string {
	return base64.URLEncoding.EncodeToString(data)
}

// CollectHealth enriches the base health report with Docker-specific metrics.
