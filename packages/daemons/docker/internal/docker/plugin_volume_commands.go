package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/moby/moby/api/types/volume"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func (p *DockerPlugin) handleVolumeCommand(cmd *pb.DockerVolumeCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListVolumes(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "inspect":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume inspect"
			return
		}
		data, err := p.client.InspectVolume(ctx, cmd.Name)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		var inspected struct {
			volume.Volume
			UsedBy           []string `json:"UsedBy"`
			ManagedDiskImage bool     `json:"ManagedDiskImage"`
		}
		if err := json.Unmarshal(data, &inspected); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse volume inspection: %v", err)
			return
		}
		inspected.ManagedDiskImage = p.volumeImages.matchesVolumeRecord(inspected.Volume)
		data, err = json.Marshal(inspected)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal volume inspection: %v", err)
			return
		}
		result.Detail = string(data)

	case "list-files":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume file list"
			return
		}
		path := cmd.Path
		if path == "" {
			path = "/"
		}
		entries, err := ListVolumeDir(ctx, p.client, cmd.Name, path)
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

	case "export":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume export"
			return
		}
		content, err := ExportVolume(ctx, p.client, cmd.Name, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "read-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file read"
			return
		}
		content, err := ReadVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "write-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file write"
			return
		}
		if err := WriteVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file create"
			return
		}
		if err := CreateVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-init":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload init"
			return
		}
		if err := InitVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-chunk":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload chunk"
			return
		}
		if err := WriteVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-complete":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload complete"
			return
		}
		if err := CompleteVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-abort":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload abort"
			return
		}
		if err := AbortVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-dir":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume directory create"
			return
		}
		if err := CreateVolumeDirectory(ctx, p.client, cmd.Name, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "delete":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file delete"
			return
		}
		if err := DeleteVolumePath(ctx, p.client, cmd.Name, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "move":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, path, and target_path are required for volume file move"
			return
		}
		if err := MoveVolumePath(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume create"
			return
		}
		var err error
		if cmd.StorageKind == volumeStorageKindDiskImage {
			if p.volumeImages == nil {
				err = errors.New("disk-image volume storage is not initialized")
			} else {
				err = p.volumeImages.create(ctx, cmd.Name, cmd.CapacityBytes)
			}
		} else {
			err = p.client.CreateManagedVolume(ctx, cmd.Name)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "metrics":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume metrics"
			return
		}
		if p.volumeImages == nil {
			result.Success = false
			result.Error = "volume metrics are not initialized"
			return
		}
		metrics, err := p.volumeImages.metrics(ctx, cmd.Name)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, err := json.Marshal(metrics)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "resize":
		if cmd.Name == "" || cmd.CapacityBytes <= 0 {
			result.Success = false
			result.Error = "name and capacity_bytes are required for volume resize"
			return
		}
		if p.volumeImages == nil {
			result.Success = false
			result.Error = "disk-image volume storage is not initialized"
			return
		}
		if err := p.volumeImages.resize(ctx, cmd.Name, cmd.CapacityBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "remove":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume remove"
			return
		}
		var err error
		if p.volumeImages != nil {
			if _, recordErr := p.volumeImages.loadRecord(cmd.Name); recordErr == nil {
				err = p.volumeImages.remove(ctx, cmd.Name, cmd.Force)
			} else {
				err = p.client.RemoveVolume(ctx, cmd.Name, cmd.Force)
			}
		} else {
			err = p.client.RemoveVolume(ctx, cmd.Name, cmd.Force)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "rename":
		if cmd.Name == "" || cmd.NewName == "" {
			result.Success = false
			result.Error = "name and new_name are required for volume rename"
			return
		}
		var err error
		if p.volumeImages != nil {
			if _, recordErr := p.volumeImages.loadRecord(cmd.Name); recordErr == nil {
				err = p.volumeImages.rename(ctx, cmd.Name, cmd.NewName)
			} else {
				err = p.client.RenameVolume(ctx, cmd.Name, cmd.NewName)
			}
		} else {
			err = p.client.RenameVolume(ctx, cmd.Name, cmd.NewName)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "update-labels":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume label update"
			return
		}
		var err error
		if p.volumeImages != nil {
			if _, recordErr := p.volumeImages.loadRecord(cmd.Name); recordErr == nil {
				err = p.volumeImages.updateLabels(ctx, cmd.Name, cmd.Labels)
			} else {
				err = p.client.UpdateVolumeLabels(ctx, cmd.Name, cmd.Labels)
			}
		} else {
			err = p.client.UpdateVolumeLabels(ctx, cmd.Name, cmd.Labels)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown volume action: %s", cmd.Action)
	}
}

// handleNetworkCommand dispatches network actions.
