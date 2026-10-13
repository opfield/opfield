package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"golang.org/x/sys/unix"
)

// dockerMigrationCapability names the migration contract this daemon speaks.
// v2: the manifest's environment keys are the container's own environment
// (manifest schema 2). A Gateway that requires v1 refuses the migration in its
// preflight instead of sending the whole runtime environment.
const dockerMigrationCapability = "docker_migration_v2"

type migrationFilesystemCapacity struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
}

type dockerMigrationCapabilities struct {
	Protocol          string                      `json:"protocol"`
	EngineVersion     string                      `json:"engineVersion"`
	APIVersion        string                      `json:"apiVersion"`
	OSType            string                      `json:"osType"`
	Architecture      string                      `json:"architecture"`
	StorageDriver     string                      `json:"storageDriver"`
	DockerRootDir     migrationFilesystemCapacity `json:"dockerRootDir"`
	StateDir          migrationFilesystemCapacity `json:"stateDir"`
	Runtimes          []string                    `json:"runtimes"`
	VolumePlugins     []string                    `json:"volumePlugins"`
	NetworkPlugins    []string                    `json:"networkPlugins"`
	SecurityOptions   []string                    `json:"securityOptions"`
	MaxChunkBytes     int                         `json:"maxChunkBytes"`
	ArtifactMaxAgeSec int64                       `json:"artifactMaxAgeSeconds"`
	// ManifestValidation: the daemon answers validate_manifest, so Gateway's
	// preflight shows the manifest blockers before the migration starts.
	ManifestValidation bool `json:"manifestValidation"`
}

func (p *DockerPlugin) handleMigrationCommand(cmd *pb.DockerMigrationCommand, result *pb.CommandResult) {
	if p.migrationStore == nil {
		result.Success = false
		result.Error = "migration artifact store is unavailable"
		return
	}
	ctx := context.Background()
	var detail any
	var err error
	switch cmd.Action {
	case "capabilities":
		detail, err = p.migrationCapabilities(ctx)
	case "heartbeat":
		err = p.migrationStore.heartbeat(cmd.MigrationId)
	case "capture_manifest":
		detail, err = p.client.CaptureMigrationManifest(ctx, cmd.ResourceId)
	case "validate_manifest":
		detail, err = p.client.ValidateMigrationManifest(ctx, cmd.ResourceId)
	case "open_archive_export", "open_archive_export_v2":
		detail, err = p.openArchiveExport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId, cmd.ConfigJson)
	case "open_archive_import", "open_archive_import_v2":
		err = p.openArchiveImport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "plan_archive_import":
		detail, err = p.planGwcaArchiveImport(ctx, cmd.ConfigJson)
	case "finish_archive_import":
		detail, err = p.finishArchiveImport(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "cleanup_archive_import":
		err = p.cleanupGwcaImportResources(ctx, cmd.MigrationId)
	case "prepare_image":
		detail, err = p.prepareMigrationImage(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId)
	case "prepare_volume":
		detail, err = p.prepareMigrationVolume(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ResourceId)
	case "measure_volume":
		detail, err = p.measureMigrationVolume(ctx, cmd.ResourceId)
	case "import_image":
		detail, err = p.importMigrationImage(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "import_volume":
		detail, err = p.importMigrationVolume(ctx, cmd.MigrationId, cmd.ArtifactId, cmd.ConfigJson)
	case "query_artifact":
		detail, err = p.migrationStore.query(cmd.MigrationId, cmd.ArtifactId)
	case "create_container_stopped":
		var request createStoppedContainerRequest
		if err = json.Unmarshal([]byte(cmd.ConfigJson), &request); err == nil {
			var id string
			id, err = p.client.CreateContainerStopped(ctx, request)
			detail = map[string]string{"containerId": id}
		}
	case "create_deployment_stopped":
		var request deploymentCommandPayload
		if err = json.Unmarshal([]byte(cmd.ConfigJson), &request); err == nil {
			detail, err = p.client.CreateDeploymentStopped(ctx, request)
		}
	case "finalize", "abort":
		if p.archiveStreams != nil {
			p.archiveStreams.removeArchive(cmd.MigrationId)
		}
		err = p.migrationStore.remove(cmd.MigrationId)
	default:
		err = fmt.Errorf("unknown Docker migration action %q", cmd.Action)
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	if detail != nil {
		data, marshalErr := json.Marshal(detail)
		if marshalErr != nil {
			result.Success = false
			result.Error = marshalErr.Error()
			return
		}
		result.Detail = string(data)
	}
}

func (p *DockerPlugin) migrationCapabilities(ctx context.Context) (dockerMigrationCapabilities, error) {
	version, err := p.client.cli.ServerVersion(ctx, struct{}{})
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("get Docker version: %w", err)
	}
	infoResult, err := p.client.cli.Info(ctx, struct{}{})
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("get Docker capabilities: %w", err)
	}
	info := infoResult.Info
	dockerCapacity, err := filesystemCapacity(info.DockerRootDir)
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("inspect Docker RootDir capacity: %w", err)
	}
	stateCapacity, err := filesystemCapacity(p.cfg.StateDir)
	if err != nil {
		return dockerMigrationCapabilities{}, fmt.Errorf("inspect migration state capacity: %w", err)
	}
	runtimes := make([]string, 0, len(info.Runtimes))
	for runtime := range info.Runtimes {
		runtimes = append(runtimes, runtime)
	}
	sort.Strings(runtimes)
	return dockerMigrationCapabilities{
		Protocol: dockerMigrationCapability, EngineVersion: version.Version, APIVersion: version.APIVersion,
		OSType: info.OSType, Architecture: info.Architecture, StorageDriver: info.Driver,
		DockerRootDir: dockerCapacity, StateDir: stateCapacity, Runtimes: runtimes,
		VolumePlugins: append([]string(nil), info.Plugins.Volume...), NetworkPlugins: append([]string(nil), info.Plugins.Network...),
		SecurityOptions: append([]string(nil), info.SecurityOptions...), MaxChunkBytes: migrationChunkBytes,
		ArtifactMaxAgeSec: int64(migrationArtifactMaxAge.Seconds()), ManifestValidation: true,
	}, nil
}

func filesystemCapacity(path string) (migrationFilesystemCapacity, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return migrationFilesystemCapacity{}, err
	}
	return migrationFilesystemCapacity{Path: path, TotalBytes: stat.Blocks * uint64(stat.Bsize), FreeBytes: stat.Bavail * uint64(stat.Bsize)}, nil
}
