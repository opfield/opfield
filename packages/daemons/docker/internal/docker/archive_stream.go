package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/distribution/reference"
	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

type archiveExportRequest struct {
	IncludeWritableLayer bool              `json:"includeWritableLayer"`
	ImageMode            string            `json:"imageMode"`
	Environment          map[string]string `json:"environment"`
	Secrets              map[string]string `json:"secrets"`
	SecretKeys           []string          `json:"secretKeys"`
	IncludeEnvironment   *bool             `json:"includeEnvironment"`
	IncludeSecrets       bool              `json:"includeSecrets"`
}

type archiveImportRequest struct {
	ExpectedImageID        string   `json:"expectedImageId"`
	ImageEmbedded          *bool    `json:"imageEmbedded"`
	PullReference          string   `json:"pullReference"`
	RegistryAuthCandidates []string `json:"registryAuthCandidates"`
}

type archiveExportDetail struct {
	Manifest           gwcaContainerManifest `json:"manifest"`
	ImageID            string                `json:"imageId"`
	ImageTags          []string              `json:"imageTags"`
	CaptureMode        string                `json:"captureMode"`
	ImageEmbedded      bool                  `json:"imageEmbedded"`
	ImagePullReference string                `json:"imagePullReference,omitempty"`
}

type archiveImportResult struct {
	ImageID            string   `json:"imageId"`
	ArtifactDigest     string   `json:"artifactDigest"`
	SizeBytes          int64    `json:"sizeBytes"`
	UnexpectedImageIDs []string `json:"-"`
	Err                error    `json:"-"`
}

type archiveImportFinishRequest struct {
	Manifest               gwcaContainerManifest `json:"manifest"`
	Name                   string                `json:"name"`
	ExpectedArtifactDigest string                `json:"expectedArtifactDigest"`
}

const maxDockerArchiveManifestBytes int64 = 4 * 1024 * 1024

type archiveExportReader struct {
	io.ReadCloser
	cleanup func()
	once    sync.Once
}

func (r *archiveExportReader) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(r.cleanup)
	return err
}

func (p *DockerPlugin) openArchiveExport(ctx context.Context, archiveID, artifactID, containerID, configJSON string) (archiveExportDetail, error) {
	if archiveID == "" || artifactID == "" {
		return archiveExportDetail{}, fmt.Errorf("archive and artifact IDs are required")
	}
	var req archiveExportRequest
	if configJSON != "" {
		if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
			return archiveExportDetail{}, fmt.Errorf("parse archive export request: %w", err)
		}
	}
	includeEnvironment := req.IncludeEnvironment == nil || *req.IncludeEnvironment
	manifest, err := buildGwcaContainerManifest(ctx, p, containerID, req.Environment, req.Secrets)
	if err != nil {
		return archiveExportDetail{}, err
	}
	if req.ImageMode == "" {
		req.ImageMode = "portable"
	}
	if req.ImageMode != "portable" && req.ImageMode != "registry" {
		return archiveExportDetail{}, fmt.Errorf("unsupported archive image mode %q", req.ImageMode)
	}
	if req.ImageMode == "registry" && req.IncludeWritableLayer {
		return archiveExportDetail{}, fmt.Errorf("registry-backed archives cannot include a writable layer")
	}
	imageID := ""
	containerInspect, err := p.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return archiveExportDetail{}, fmt.Errorf("inspect archive image identity: %w", err)
	}
	imageID = containerInspect.Container.Image
	captureMode := "image"
	cleanup := func() {}
	if req.IncludeWritableLayer {
		commitConfig := *containerInspect.Container.Config
		baseImageEnv := []string(nil)
		if !includeEnvironment {
			sourceImage, err := p.client.cli.ImageInspect(ctx, imageID)
			if err != nil {
				return archiveExportDetail{}, fmt.Errorf("inspect archive source image environment: %w", err)
			}
			if sourceImage.Config != nil {
				baseImageEnv = sourceImage.Config.Env
			}
		}
		commitConfig.Env = archiveCommitEnvironment(
			includeEnvironment,
			req.IncludeSecrets,
			commitConfig.Env,
			baseImageEnv,
			req.SecretKeys,
		)
		committed, err := p.client.cli.ContainerCommit(ctx, containerID, mobyclient.ContainerCommitOptions{
			NoPause: true,
			Comment: "Opfield portable container archive",
			Config:  &commitConfig,
		})
		if err != nil {
			return archiveExportDetail{}, fmt.Errorf("capture writable layer without pausing: %w", err)
		}
		imageID = committed.ID
		captureMode = "container-commit-no-pause"
		cleanup = func() {
			_, removeErr := p.client.cli.ImageRemove(context.Background(), imageID, mobyclient.ImageRemoveOptions{Force: true})
			if removeErr != nil {
				p.logger.Warn("remove temporary archive image", "image_id", imageID, "error", removeErr)
			}
		}
		manifest.Warnings = append(manifest.Warnings, "Writable layer was captured without pausing; concurrent writes may not be transactionally consistent")
	}
	inspected, err := p.client.cli.ImageInspect(ctx, imageID)
	if err != nil {
		cleanup()
		return archiveExportDetail{}, fmt.Errorf("inspect archive image: %w", err)
	}
	if req.ImageMode == "registry" {
		pullReference := selectArchivePullReference(manifest.ImageReference, inspected.RepoDigests)
		if pullReference == "" {
			return archiveExportDetail{}, fmt.Errorf("image has no immutable registry digest available for a registry-backed archive")
		}
		return archiveExportDetail{
			Manifest: manifest, ImageID: inspected.ID, ImageTags: append([]string(nil), inspected.RepoTags...),
			CaptureMode: "registry-reference", ImageEmbedded: false, ImagePullReference: pullReference,
		}, nil
	}
	reader, err := p.client.cli.ImageSave(ctx, []string{imageID})
	if err != nil {
		cleanup()
		return archiveExportDetail{}, fmt.Errorf("stream archive image: %w", err)
	}
	wrapped := &archiveExportReader{ReadCloser: reader, cleanup: cleanup}
	if err := p.archiveStreams.put(archiveID, artifactID, &archiveLiveSession{reader: wrapped}); err != nil {
		_ = wrapped.Close()
		return archiveExportDetail{}, err
	}
	return archiveExportDetail{
		Manifest: manifest, ImageID: inspected.ID, ImageTags: append([]string(nil), inspected.RepoTags...),
		CaptureMode: captureMode, ImageEmbedded: true,
	}, nil
}

func archiveCommitEnvironment(
	includeEnvironment bool,
	includeSecrets bool,
	containerEnvironment []string,
	baseImageEnvironment []string,
	secretKeys []string,
) []string {
	if !includeEnvironment {
		return append([]string(nil), baseImageEnvironment...)
	}
	if !includeSecrets {
		return stripArchiveSecretEnv(containerEnvironment, secretKeys)
	}
	return append([]string(nil), containerEnvironment...)
}

func stripArchiveSecretEnv(environment, secretKeys []string) []string {
	if len(environment) == 0 || len(secretKeys) == 0 {
		return append([]string(nil), environment...)
	}
	blocked := make(map[string]struct{}, len(secretKeys))
	for _, key := range secretKeys {
		blocked[key] = struct{}{}
	}
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		if _, secret := blocked[key]; !secret {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

func selectArchivePullReference(imageReference string, repoDigests []string) string {
	wanted, wantedErr := reference.ParseNormalizedNamed(strings.TrimSpace(imageReference))
	for _, candidate := range repoDigests {
		parsed, err := reference.ParseNormalizedNamed(candidate)
		if err != nil {
			continue
		}
		if _, ok := parsed.(reference.Digested); !ok {
			continue
		}
		if wantedErr == nil && reference.Domain(parsed) == reference.Domain(wanted) && reference.Path(parsed) == reference.Path(wanted) {
			return parsed.String()
		}
	}
	for _, candidate := range repoDigests {
		parsed, err := reference.ParseNormalizedNamed(candidate)
		if err == nil {
			if _, ok := parsed.(reference.Digested); ok {
				return parsed.String()
			}
		}
	}
	return ""
}

func (p *DockerPlugin) openArchiveImport(ctx context.Context, archiveID, artifactID, configJSON string) error {
	if archiveID == "" || artifactID == "" {
		return fmt.Errorf("archive and artifact IDs are required")
	}
	var req archiveImportRequest
	if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
		return fmt.Errorf("parse archive import request: %w", err)
	}
	if !dockerSHA256Digest.MatchString(req.ExpectedImageID) {
		return fmt.Errorf("expected archive image ID is required")
	}
	imagesBefore, err := p.archiveImageIDs(ctx)
	if err != nil {
		return fmt.Errorf("list images before archive import: %w", err)
	}
	_, imageAlreadyPresent := imagesBefore[req.ExpectedImageID]
	if imageAlreadyPresent {
		if _, err := p.client.cli.ImageInspect(ctx, req.ExpectedImageID); err != nil {
			return fmt.Errorf("inspect archive image before import: %w", err)
		}
	}
	imageEmbedded := req.ImageEmbedded == nil || *req.ImageEmbedded
	if !imageEmbedded {
		imageID, introduced, err := p.prepareRegistryBackedArchiveImage(ctx, req, imagesBefore)
		if err != nil {
			return err
		}
		done := make(chan archiveImportResult, 1)
		emptyDigest := sha256.Sum256(nil)
		done <- archiveImportResult{
			ImageID: imageID, ArtifactDigest: hex.EncodeToString(emptyDigest[:]), SizeBytes: 0,
		}
		close(done)
		cleanup := func() { p.removeArchiveImages(introduced) }
		return p.archiveStreams.put(archiveID, artifactID, &archiveLiveSession{done: done, cleanup: cleanup})
	}
	reader, writer := io.Pipe()
	done := make(chan archiveImportResult, 1)
	introduced := []string(nil)
	cleanup := func() {
		go func() {
			select {
			case <-done:
			case <-time.After(30 * time.Second):
				p.logger.Warn("timed out waiting for incomplete archive image load", "image_id", req.ExpectedImageID)
			}
			p.removeArchiveImages(introduced)
		}()
	}
	if err := p.archiveStreams.put(archiveID, artifactID, &archiveLiveSession{writer: writer, done: done, cleanup: cleanup}); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return err
	}
	go func() {
		hasher := sha256.New()
		counter := &countingWriter{}
		loadReader, loadWriter := io.Pipe()
		sanitizeDone := make(chan error, 1)
		names := archiveImageNames{}
		go func() {
			err := stripDockerArchiveRepoTags(
				io.TeeReader(reader, io.MultiWriter(hasher, counter)),
				loadWriter,
				names,
			)
			_ = loadWriter.CloseWithError(err)
			sanitizeDone <- err
		}()
		var loadedIDs []string
		loadResult, err := p.client.cli.ImageLoad(context.Background(), loadReader)
		if err == nil {
			loadedIDs, err = readDockerImageLoad(loadResult)
			closeErr := loadResult.Close()
			if err == nil {
				err = closeErr
			}
		}
		_ = loadReader.Close()
		if sanitizeErr := <-sanitizeDone; sanitizeErr != nil && err == nil {
			err = fmt.Errorf("strip archive image tags: %w", sanitizeErr)
		}
		_ = reader.Close()
		imageID := ""
		if err == nil {
			imageID, err = names.loadedImage(req.ExpectedImageID, loadedIDs)
		}
		if imagesAfter, listErr := p.archiveImageIDs(context.Background()); listErr != nil && err == nil {
			err = fmt.Errorf("list images after archive import: %w", listErr)
		} else if listErr == nil {
			introduced = introducedArchiveImageIDs(imagesBefore, imagesAfter)
		}
		unexpected := make([]string, 0)
		for _, introducedID := range introduced {
			if introducedID != imageID {
				unexpected = append(unexpected, introducedID)
			}
		}
		done <- archiveImportResult{
			ImageID: imageID, ArtifactDigest: hex.EncodeToString(hasher.Sum(nil)), SizeBytes: counter.n,
			UnexpectedImageIDs: unexpected, Err: err,
		}
		close(done)
	}()
	return nil
}

func (p *DockerPlugin) prepareRegistryBackedArchiveImage(
	ctx context.Context,
	req archiveImportRequest,
	imagesBefore map[string]struct{},
) (string, []string, error) {
	if _, present := imagesBefore[req.ExpectedImageID]; present {
		return req.ExpectedImageID, nil, nil
	}
	pullReference, err := reference.ParseNormalizedNamed(strings.TrimSpace(req.PullReference))
	if err != nil {
		return "", nil, fmt.Errorf("parse registry-backed archive image reference: %w", err)
	}
	digested, ok := pullReference.(reference.Digested)
	if !ok {
		return "", nil, fmt.Errorf("registry-backed archive image reference must use an immutable digest")
	}
	authCandidates := req.RegistryAuthCandidates
	if len(authCandidates) == 0 {
		authCandidates = []string{""}
	}
	var lastErr error
	for _, registryAuth := range authCandidates {
		if err := p.client.PullImage(ctx, pullReference.String(), registryAuth); err != nil {
			lastErr = err
			continue
		}
		// The classic image store names an image by its config digest, the containerd image store by the digest it
		// was pulled by (P-6). The pulled image is the expected one when either store's name matches: a source on
		// the classic store reported the config digest, one on the containerd image store the pinned digest itself.
		pinned := digested.Digest().String()
		pulled, err := p.client.cli.ImageInspect(ctx, pullReference.String())
		if err == nil && (pulled.ID == req.ExpectedImageID || pulled.ID == pinned || req.ExpectedImageID == pinned) {
			after, listErr := p.archiveImageIDs(ctx)
			if listErr != nil {
				_, _ = p.client.cli.ImageRemove(ctx, pulled.ID, mobyclient.ImageRemoveOptions{Force: true})
				return "", nil, fmt.Errorf("list pulled archive images: %w", listErr)
			}
			return pulled.ID, introducedArchiveImageIDs(imagesBefore, after), nil
		}
		if err == nil {
			err = fmt.Errorf("pulled image ID is %s", pulled.ID)
		}
		lastErr = fmt.Errorf("pulled image does not provide expected image ID %s: %w", req.ExpectedImageID, err)
		after, listErr := p.archiveImageIDs(ctx)
		if listErr == nil {
			p.removeArchiveImages(introducedArchiveImageIDs(imagesBefore, after))
		}
	}
	return "", nil, fmt.Errorf("pull registry-backed archive image %q: %w", pullReference.String(), lastErr)
}

func (p *DockerPlugin) archiveImageIDs(ctx context.Context) (map[string]struct{}, error) {
	listed, err := p.client.cli.ImageList(ctx, mobyclient.ImageListOptions{All: true})
	if err != nil {
		return nil, err
	}
	result := make(map[string]struct{}, len(listed.Items))
	for _, image := range listed.Items {
		result[image.ID] = struct{}{}
	}
	return result, nil
}

func introducedArchiveImageIDs(before, after map[string]struct{}) []string {
	result := make([]string, 0)
	for imageID := range after {
		if _, existed := before[imageID]; !existed {
			result = append(result, imageID)
		}
	}
	sort.Strings(result)
	return result
}

func (p *DockerPlugin) removeArchiveImages(imageIDs []string) {
	for _, imageID := range imageIDs {
		_, err := p.client.cli.ImageRemove(context.Background(), imageID, mobyclient.ImageRemoveOptions{Force: true})
		if err != nil && !isNotFoundErr(err) {
			p.logger.Warn("remove archive import image", "image_id", imageID, "error", err)
		}
	}
}

type countingWriter struct{ n int64 }

func (w *countingWriter) Write(p []byte) (int, error) { w.n += int64(len(p)); return len(p), nil }

func stripDockerArchiveRepoTags(source io.Reader, destination io.Writer, names archiveImageNames) (err error) {
	input := tar.NewReader(source)
	output := tar.NewWriter(destination)
	seenMetadata := make(map[string]struct{}, 2)
	defer func() {
		if closeErr := output.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("finish archive image stream: %w", closeErr)
		}
	}()

	for {
		header, nextErr := input.Next()
		if nextErr == io.EOF {
			return nil
		}
		if nextErr != nil {
			return fmt.Errorf("read archive image stream: %w", nextErr)
		}

		metadataName, metadataErr := dockerArchiveTagMetadataEntryName(header)
		if metadataErr != nil {
			return metadataErr
		}
		if metadataName != "" {
			if _, seen := seenMetadata[metadataName]; seen {
				return fmt.Errorf("archive image contains duplicate %s entry", metadataName)
			}
			seenMetadata[metadataName] = struct{}{}
		}

		switch metadataName {
		case "manifest.json":
			manifest, readErr := readDockerArchiveManifest(input, header.Size)
			if readErr != nil {
				return readErr
			}
			if namesErr := names.addManifestConfigs(manifest); namesErr != nil {
				return namesErr
			}
			sanitized, sanitizeErr := sanitizeDockerArchiveManifest(manifest)
			if sanitizeErr != nil {
				return sanitizeErr
			}
			if writeErr := writeDockerArchiveEntry(output, header, sanitized); writeErr != nil {
				return writeErr
			}
		case "index.json":
			index, readErr := readDockerArchiveManifest(input, header.Size)
			if readErr != nil {
				return readErr
			}
			sanitized, sanitizeErr := names.sanitizeDockerArchiveIndex(index)
			if sanitizeErr != nil {
				return sanitizeErr
			}
			if writeErr := writeDockerArchiveEntry(output, header, sanitized); writeErr != nil {
				return writeErr
			}
		case "repositories":
			if _, copyErr := io.Copy(io.Discard, input); copyErr != nil {
				return fmt.Errorf("read archive repositories: %w", copyErr)
			}
			if writeErr := writeDockerArchiveEntry(output, header, []byte("{}")); writeErr != nil {
				return writeErr
			}
		default:
			copyHeader := *header
			if writeErr := output.WriteHeader(&copyHeader); writeErr != nil {
				return fmt.Errorf("write archive image header: %w", writeErr)
			}
			if _, copyErr := io.Copy(output, input); copyErr != nil {
				return fmt.Errorf("copy archive image entry %q: %w", header.Name, copyErr)
			}
		}
	}
}

// dockerArchiveTagMetadataEntryName identifies the root metadata entries
// Docker consumes for image tags (index.json: the containerd image store). Reject aliases instead of copying them: the
// Docker loader normalizes tar paths during extraction, so an absolute or
// otherwise non-canonical name could become root metadata after this stream
// has already decided it was an ordinary file.
func dockerArchiveTagMetadataEntryName(header *tar.Header) (string, error) {
	// Normalize against an extraction root. This catches aliases such as
	// "/../manifest.json" and "../../repositories" as well as leading slashes.
	cleanName := strings.TrimPrefix(path.Clean("/"+header.Name), "/")
	if cleanName != "manifest.json" && cleanName != "repositories" && cleanName != "index.json" {
		return "", nil
	}
	if header.Name != cleanName {
		return "", fmt.Errorf("archive image metadata entry %q has a non-canonical path", header.Name)
	}
	if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
		return "", fmt.Errorf("archive image metadata entry %q must be a regular file", header.Name)
	}
	return cleanName, nil
}

func readDockerArchiveManifest(reader io.Reader, size int64) ([]byte, error) {
	if size < 0 || size > maxDockerArchiveManifestBytes {
		return nil, fmt.Errorf("archive image manifest exceeds the allowed size")
	}
	manifest, err := io.ReadAll(io.LimitReader(reader, maxDockerArchiveManifestBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read archive image manifest: %w", err)
	}
	if int64(len(manifest)) > maxDockerArchiveManifestBytes {
		return nil, fmt.Errorf("archive image manifest exceeds the allowed size")
	}
	return manifest, nil
}

func sanitizeDockerArchiveManifest(manifest []byte) ([]byte, error) {
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(manifest, &entries); err != nil {
		return nil, fmt.Errorf("parse archive image manifest: %w", err)
	}
	for index, entry := range entries {
		if entry == nil {
			return nil, fmt.Errorf("archive image manifest entry %d is invalid", index)
		}
		entry["RepoTags"] = json.RawMessage("[]")
	}
	sanitized, err := json.Marshal(entries)
	if err != nil {
		return nil, fmt.Errorf("encode archive image manifest: %w", err)
	}
	return sanitized, nil
}

func writeDockerArchiveEntry(writer *tar.Writer, header *tar.Header, content []byte) error {
	copyHeader := *header
	copyHeader.Size = int64(len(content))
	if err := writer.WriteHeader(&copyHeader); err != nil {
		return fmt.Errorf("write archive image header: %w", err)
	}
	if _, err := writer.Write(content); err != nil {
		return fmt.Errorf("write archive image entry %q: %w", header.Name, err)
	}
	return nil
}

func (p *DockerPlugin) finishArchiveImport(ctx context.Context, archiveID, artifactID, configJSON string) (map[string]any, error) {
	var req archiveImportFinishRequest
	if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
		return nil, fmt.Errorf("parse archive import request: %w", err)
	}
	session, ok := p.archiveStreams.get(archiveID, artifactID)
	if !ok || session.done == nil {
		return nil, fmt.Errorf("archive import stream is unavailable")
	}
	completed := false
	defer func() {
		if completed {
			p.archiveStreams.release(archiveID, artifactID)
		} else {
			p.archiveStreams.remove(archiveID, artifactID)
		}
	}()
	var imported archiveImportResult
	select {
	case imported = <-session.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if imported.Err != nil {
		return nil, fmt.Errorf("load archive image: %w", imported.Err)
	}
	if len(imported.UnexpectedImageIDs) > 0 {
		return nil, fmt.Errorf("archive contains unexpected images")
	}
	if imported.ArtifactDigest != req.ExpectedArtifactDigest {
		return nil, fmt.Errorf("archive image digest mismatch")
	}
	loaded, err := p.client.cli.ImageInspect(ctx, imported.ImageID)
	if err != nil {
		return nil, fmt.Errorf("inspect imported archive image: %w", err)
	}
	name, err := p.availableArchiveContainerName(ctx, req.Name)
	if err != nil {
		return nil, err
	}
	if err := p.assertGwcaHostPortsAvailable(ctx, req.Manifest); err != nil {
		return nil, err
	}
	imageReference, preservedReference := p.prepareArchiveCreateImageReference(loaded.ID, req.Manifest.ImageReference)
	createdNetworks, err := p.prepareGwcaNetworks(ctx, archiveID, &req.Manifest)
	if err != nil {
		p.cleanupGwcaCreatedNetworks(createdNetworks)
		return nil, err
	}
	createdVolumes, err := p.prepareGwcaMounts(ctx, archiveID, name, &req.Manifest)
	if err != nil {
		p.cleanupGwcaCreatedVolumes(createdVolumes)
		p.cleanupGwcaCreatedNetworks(createdNetworks)
		return nil, err
	}
	createRequest, err := gwcaManifestToMigration(req.Manifest, loaded.ID, imageReference, name, archiveID)
	if err != nil {
		p.cleanupGwcaCreatedVolumes(createdVolumes)
		p.cleanupGwcaCreatedNetworks(createdNetworks)
		return nil, err
	}
	setArchiveImageReferenceLabel(createRequest.Manifest.Config, preservedReference)
	containerID, err := p.client.CreateContainerStopped(ctx, createRequest)
	if err != nil {
		p.cleanupGwcaCreatedVolumes(createdVolumes)
		p.cleanupGwcaCreatedNetworks(createdNetworks)
		return nil, err
	}
	completed = true
	return map[string]any{
		"containerId":    containerID,
		"containerName":  name,
		"imageId":        loaded.ID,
		"createdVolumes": createdVolumes,
	}, nil
}

// setArchiveImageReferenceLabel adds the update source only after the archive
// manifest labels have been sanitized. The source reference is trusted only
// after prepareArchiveCreateImageReference has normalized it.
func setArchiveImageReferenceLabel(config *container.Config, sourceReference string) {
	if config == nil || sourceReference == "" {
		return
	}
	if config.Labels == nil {
		config.Labels = map[string]string{}
	}
	config.Labels[archiveImageReferenceLabel] = sourceReference
}

func (p *DockerPlugin) cleanupGwcaCreatedNetworks(networks []string) {
	for _, networkName := range networks {
		if _, err := p.client.cli.NetworkRemove(
			context.Background(),
			networkName,
			mobyclient.NetworkRemoveOptions{},
		); err != nil && !isNotFoundErr(err) {
			p.logger.Warn("remove archive import network", "network", networkName, "error", err)
		}
	}
}

func (p *DockerPlugin) cleanupGwcaCreatedVolumes(volumes []string) {
	for _, volumeName := range volumes {
		if _, err := p.client.cli.VolumeRemove(
			context.Background(),
			volumeName,
			mobyclient.VolumeRemoveOptions{Force: true},
		); err != nil && !isNotFoundErr(err) {
			p.logger.Warn("remove archive import volume", "volume", volumeName, "error", err)
		}
	}
}
