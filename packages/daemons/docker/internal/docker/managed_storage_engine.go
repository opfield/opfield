package docker

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

const (
	managedStorageEngineMinIO     = "minio"
	managedStorageEngineSeaweedFS = "seaweedfs"
	managedStorageEngineLabel     = "net.opfield.managed-storage.engine"

	// Stable error codes carried at the start of a failed command's error text.
	// The backend maps them to typed API errors (see the SeaweedFS contract).
	managedStorageEngineImageUnavailableCode = "MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE"
	managedStorageImagePullFailedCode        = "MANAGED_STORAGE_IMAGE_PULL_FAILED"

	legacyMinioPullTimeout = 2 * time.Minute
)

// engine returns the record's engine; records written before engines existed
// are MinIO.
func (r managedStorageRecord) engine() string {
	if r.Engine == "" {
		return managedStorageEngineMinIO
	}
	return r.Engine
}

// managedStorageImageError is a typed runtime-image failure. Its text starts
// with the stable code so it survives the string-only command result.
type managedStorageImageError struct {
	Code    string
	Message string
	Cause   error
}

func (e *managedStorageImageError) Error() string {
	if e.Cause == nil {
		return e.Code + ": " + e.Message
	}
	return e.Code + ": " + e.Message + ": " + e.Cause.Error()
}

func (e *managedStorageImageError) Unwrap() error { return e.Cause }

// ensureEngineImage returns the local reference a storage container of the
// given engine must be created from, pulling it when needed.
//
// SeaweedFS is pulled by digest from the Gateway GHCR mirror first and Docker
// Hub second. The legacy MinIO image can no longer be pulled from its public
// registries: an existing node keeps using its cached copy, and anything that
// needs a pull fails with MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE before any
// running container or data is touched.
func (m *managedStorageManager) ensureEngineImage(ctx context.Context, engine string) (string, error) {
	switch engine {
	case managedStorageEngineSeaweedFS:
		reference, err := m.ensureSeaweedFSImage(ctx, seaweedfsImage)
		if err != nil {
			return "", &managedStorageImageError{Code: managedStorageImagePullFailedCode, Message: "the SeaweedFS runtime image could not be pulled from the Opfield mirror or Docker Hub", Cause: err}
		}
		return reference, nil
	case managedStorageEngineMinIO:
		present, err := m.client.localImagePresent(ctx, trustedMinioImage)
		if err != nil {
			return "", err
		}
		if present {
			return trustedMinioImage, nil
		}
		// One bounded attempt keeps a node behind a private pull-through cache
		// working; the public registries answer 401/denied.
		pullCtx, cancel := context.WithTimeout(ctx, legacyMinioPullTimeout)
		pullErr := m.client.PullImage(pullCtx, trustedMinioImage, "")
		cancel()
		if pullErr == nil {
			if present, err := m.client.localImagePresent(ctx, trustedMinioImage); err == nil && present {
				return trustedMinioImage, nil
			}
		}
		return "", &managedStorageImageError{Code: managedStorageEngineImageUnavailableCode, Message: "the legacy MinIO runtime image is not cached on this node and can no longer be pulled; migrate this storage to SeaweedFS", Cause: pullErr}
	default:
		return "", fmt.Errorf("managed storage engine %q is not supported", engine)
	}
}

// ensureSeaweedFSImage returns the SeaweedFS image a container is created
// from. Gateway's own build (pinned) is used when it is present or pulls; a
// node that cannot reach it keeps the upstream image, mirror first and Docker
// Hub second, so storage never stops for want of the patched build.
func (m *managedStorageManager) ensureSeaweedFSImage(ctx context.Context, pinned string) (string, error) {
	if pinned == seaweedfsUpstreamImage {
		return m.client.EnsureThirdPartyImage(ctx, seaweedfsUpstreamImage)
	}
	present, err := m.client.localImagePresent(ctx, pinned)
	if err != nil {
		return "", err
	}
	if present {
		return pinned, nil
	}
	pullErr := m.client.PullImage(ctx, pinned, "")
	if pullErr == nil {
		if present, err := m.client.localImagePresent(ctx, pinned); err == nil && present {
			return pinned, nil
		}
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if m.logger != nil {
		m.logger.Warn("Opfield's SeaweedFS image could not be pulled; using the upstream image", "image", pinned, "error", pullErr)
	}
	return m.client.EnsureThirdPartyImage(ctx, seaweedfsUpstreamImage)
}

// prepareEngineDataRoot hands the mounted data root to the engine's runtime
// user. MinIO runs as root and needs nothing.
func (m *managedStorageManager) prepareEngineDataRoot(record managedStorageRecord) error {
	if record.engine() != managedStorageEngineSeaweedFS {
		return nil
	}
	if err := m.chownRuntime(record.MountPath); err != nil {
		return fmt.Errorf("assign managed storage data root: %w", err)
	}
	return nil
}

// recreate replaces the storage container while keeping its data, so settings
// fixed at container creation (published port, network isolation, SeaweedFS
// volume sizing) can change. The previous container is renamed rather than
// removed until the replacement is ready; on any failure it is restored.
func (m *managedStorageManager) recreate(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	if record.MemberCount > 1 && input.PublishedPort == 0 {
		return errors.New("distributed managed storage requires a published peer port")
	}
	if input.PublishS3 && input.PublishedPort == 0 {
		return errors.New("public managed storage requires a published port")
	}
	if record.MemberCount <= 1 && !input.PublishS3 && input.PublishedPort != 0 {
		return errors.New("private single-node storage cannot publish a host port")
	}
	// Fail before touching the running container when the engine image or the
	// secrets needed to start a replacement are unavailable.
	image, err := m.ensureEngineImage(ctx, record.engine())
	if err != nil {
		return err
	}
	replacement, err := m.recreateInput(*record, input)
	if err != nil {
		return err
	}
	previous := *record
	rollbackName := previous.ContainerName + "-replaced"
	if previous.ContainerID != "" {
		if err := m.verifyOwnedContainer(ctx, previous); err != nil {
			return err
		}
		if err := m.client.StopContainer(ctx, previous.ContainerID, 20); err != nil && !isNotFoundErr(err) {
			return err
		}
		if err := m.client.RenameContainer(ctx, previous.ContainerID, rollbackName); err != nil {
			_ = m.startContainer(ctx, previous.ContainerID)
			return fmt.Errorf("preserve managed storage container for recreation: %w", err)
		}
	}
	record.Image = image
	record.PublishS3 = input.PublishS3
	record.PublishedPort = input.PublishedPort
	if input.PeerBindAddress != "" {
		record.PeerBindAddress = input.PeerBindAddress
	}
	record.ContainerID = ""
	restore := func(cause error) error {
		failed := record.ContainerID
		*record = previous
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if failed != "" {
			_ = m.client.RemoveContainer(cleanupCtx, failed, true)
		}
		if err := m.ensureNetworkIsolation(cleanupCtx, previous, previous.ContainerID); err != nil {
			m.logger.Error("restore managed storage network after recreate failure", "id", previous.ID, "error", err)
		}
		if previous.ContainerID != "" {
			if err := m.client.RenameContainer(cleanupCtx, previous.ContainerID, previous.ContainerName); err != nil {
				m.logger.Error("restore managed storage container name after recreate failure", "id", previous.ID, "error", err)
				return cause
			}
			if err := m.startContainer(cleanupCtx, previous.ContainerID); err != nil {
				m.logger.Error("restart managed storage after recreate failure", "id", previous.ID, "error", err)
			}
		}
		return cause
	}
	if err := m.ensureNetworkIsolation(ctx, *record, ""); err != nil {
		return restore(err)
	}
	containerID, err := m.createEngineContainer(ctx, record, replacement)
	if err != nil {
		return restore(err)
	}
	record.ContainerID = containerID
	if record.MemberCount <= 1 {
		if err := m.waitForReady(ctx, *record); err != nil {
			return restore(fmt.Errorf("recreated managed storage did not become ready: %w", err))
		}
	}
	if previous.ContainerID != "" {
		if err := m.client.RemoveContainer(ctx, previous.ContainerID, true); err != nil && !isNotFoundErr(err) {
			m.logger.Warn("remove replaced managed storage container", "id", record.ID, "error", err)
		}
	}
	return nil
}

// recreateInput is the create payload for a replacement container. Secrets a
// replacement needs must come from the update payload (MinIO environment,
// TLS/SFTP material) or, for SeaweedFS, may be reused from the staged files.
func (m *managedStorageManager) recreateInput(record managedStorageRecord, input managedStorageCommand) (managedStorageCommand, error) {
	replacement := input
	replacement.Engine = record.engine()
	if record.engine() == managedStorageEngineSeaweedFS {
		if replacement.RootCredentials.AccessKey == "" || replacement.RootCredentials.SecretKey == "" {
			accessKey, secretKey, err := m.readSeaweedFSRootCredentials(record)
			if err != nil {
				return replacement, fmt.Errorf("managed storage root credentials are required to recreate: %w", err)
			}
			replacement.RootCredentials = managedStorageRootCreds{AccessKey: accessKey, SecretKey: secretKey}
		}
		if record.TLSEnabled && replacement.TLS == nil {
			if _, err := m.stagedSeaweedFSTLS(record); err != nil {
				return replacement, errors.New("managed storage TLS material is required to recreate")
			}
		}
		return replacement, nil
	}
	if replacement.RootCredentials.AccessKey == "" || replacement.RootCredentials.SecretKey == "" {
		return replacement, errors.New("managed storage root credentials are required to recreate")
	}
	if record.TLSEnabled && replacement.TLS == nil {
		return replacement, errors.New("managed storage TLS material is required to recreate")
	}
	if record.SFTPPort != 0 && replacement.SFTP == nil {
		return replacement, errors.New("managed storage SFTP host key is required to recreate")
	}
	if record.FTPPort != 0 && replacement.FTP == nil {
		replacement.FTP = &managedStorageFTP{Port: record.FTPPort, PassivePortStart: record.FTPPassiveStart, PassivePortCount: record.FTPPassiveCount}
	}
	if len(replacement.Members) == 0 && record.MemberCount > 1 {
		return replacement, errors.New("distributed managed storage recreation requires the member list")
	}
	return replacement, nil
}

func (m *managedStorageManager) verifyOwnedContainer(ctx context.Context, record managedStorageRecord) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed storage container: %w", err)
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedStorageLabel] != record.ID ||
		inspect.Container.Config.Labels[managedStorageMemberLabel] != strconv.Itoa(record.MemberIndex) {
		return errors.New("managed storage container identity is invalid")
	}
	return nil
}

func managedStorageNetworkInternal(record managedStorageRecord) bool {
	return !record.PublishS3 && record.PeerBindAddress == ""
}

// ensureNetworkIsolation makes the cluster network's internal flag match the
// record. An internal network cannot carry a published port, so a publication
// change replaces the network (detaching every endpoint first). attach, when
// set, is a container that must end up connected to the resulting network.
func (m *managedStorageManager) ensureNetworkIsolation(ctx context.Context, record managedStorageRecord, attach string) error {
	internal := managedStorageNetworkInternal(record)
	inspected, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	switch {
	case err == nil && inspected.Network.Internal == internal:
		if attach == "" {
			return nil
		}
		if _, attached := inspected.Network.Containers[attach]; attached {
			return nil
		}
	case err == nil:
		if inspected.Network.Labels[managedStorageLabel] != record.ID {
			return errors.New("managed storage network identity is invalid")
		}
		for endpoint := range inspected.Network.Containers {
			if _, err := m.client.cli.NetworkDisconnect(ctx, record.NetworkName, mobyclient.NetworkDisconnectOptions{Container: endpoint, Force: true}); err != nil && !isNotFoundErr(err) {
				return fmt.Errorf("detach managed storage network: %w", err)
			}
		}
		if _, err := m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("replace managed storage network: %w", err)
		}
		if err := m.createNetwork(ctx, record); err != nil {
			return err
		}
	case isNotFoundErr(err):
		if err := m.createNetwork(ctx, record); err != nil {
			return err
		}
	default:
		return fmt.Errorf("inspect managed storage network: %w", err)
	}
	if attach == "" {
		return nil
	}
	if _, err := m.client.cli.NetworkConnect(ctx, record.NetworkName, mobyclient.NetworkConnectOptions{Container: attach, EndpointConfig: &network.EndpointSettings{}}); err != nil {
		return fmt.Errorf("reattach managed storage container: %w", err)
	}
	return nil
}
