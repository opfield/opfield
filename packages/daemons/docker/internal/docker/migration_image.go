package docker

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	mobyclient "github.com/moby/moby/client"
	"github.com/zeebo/blake3"
)

var dockerSHA256Digest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func restorableMigrationImageTags(tags []string) []string {
	result := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" || tag == "<none>:<none>" || strings.Contains(tag, "@") {
			continue
		}
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		result = append(result, tag)
	}
	return result
}

type migrationImageImportRequest struct {
	ExpectedImageID      string   `json:"expectedImageId"`
	ExpectedArtifactHash string   `json:"expectedArtifactDigest"`
	SourceTags           []string `json:"sourceTags"`
}

func (p *DockerPlugin) prepareMigrationImage(ctx context.Context, migrationID, artifactID, imageRef string) (migrationArtifactMetadata, error) {
	image, err := p.client.cli.ImageInspect(ctx, imageRef)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("inspect migration image: %w", err)
	}
	path, err := p.migrationStore.artifactPath(migrationID, artifactID, true)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("create image artifact: %w", err)
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(tmp)
		}
	}()

	reader, err := p.client.cli.ImageSave(ctx, []string{image.ID})
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("save Docker image: %w", err)
	}
	defer reader.Close()
	hasher := blake3.New()
	size, err := io.Copy(io.MultiWriter(file, hasher), reader)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("spool Docker image: %w", err)
	}
	if err := file.Sync(); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("fsync Docker image artifact: %w", err)
	}
	if err := file.Close(); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("close Docker image artifact: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("commit Docker image artifact: %w", err)
	}
	committed = true
	meta := migrationArtifactMetadata{
		ArtifactID: artifactID, ArtifactType: "image", SizeBytes: size,
		ArtifactDigest: hex.EncodeToString(hasher.Sum(nil)), ImageID: image.ID,
		ImageTags: restorableMigrationImageTags(image.RepoTags), Complete: true,
	}
	if err := p.migrationStore.saveMetadata(migrationID, meta); err != nil {
		return migrationArtifactMetadata{}, err
	}
	return meta, nil
}

func (p *DockerPlugin) importMigrationImage(ctx context.Context, migrationID, artifactID, configJSON string) (migrationArtifactMetadata, error) {
	var req migrationImageImportRequest
	if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("parse image import request: %w", err)
	}
	if !dockerSHA256Digest.MatchString(req.ExpectedImageID) || req.ExpectedArtifactHash == "" {
		return migrationArtifactMetadata{}, fmt.Errorf("expected image and artifact digests are required")
	}
	if meta, err := p.migrationStore.query(migrationID, artifactID); err == nil && meta.Complete &&
		meta.ImageID == req.ExpectedImageID && meta.ArtifactDigest == req.ExpectedArtifactHash {
		return meta, nil
	}
	sourceTags := restorableMigrationImageTags(req.SourceTags)
	for _, tag := range sourceTags {
		existing, err := p.client.cli.ImageInspect(ctx, tag)
		if err == nil && existing.ID != req.ExpectedImageID {
			return migrationArtifactMetadata{}, fmt.Errorf("target image tag %q points to a different digest", tag)
		}
		if err != nil && !isNotFoundErr(err) {
			return migrationArtifactMetadata{}, fmt.Errorf("inspect target image tag %q: %w", tag, err)
		}
	}

	path, err := p.migrationStore.artifactPath(migrationID, artifactID, false)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("open image artifact: %w", err)
	}
	defer file.Close()
	hasher := blake3.New()
	loadResult, err := p.client.cli.ImageLoad(ctx, io.TeeReader(file, hasher))
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("load Docker image: %w", err)
	}
	_, copyErr := io.Copy(io.Discard, loadResult)
	closeErr := loadResult.Close()
	if copyErr != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("read Docker image load response: %w", copyErr)
	}
	if closeErr != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("close Docker image load response: %w", closeErr)
	}
	artifactDigest := hex.EncodeToString(hasher.Sum(nil))
	if artifactDigest != req.ExpectedArtifactHash {
		return migrationArtifactMetadata{}, fmt.Errorf("image artifact digest mismatch")
	}
	loaded, err := p.client.cli.ImageInspect(ctx, req.ExpectedImageID)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("inspect loaded Docker image: %w", err)
	}
	if loaded.ID != req.ExpectedImageID {
		return migrationArtifactMetadata{}, fmt.Errorf("loaded Docker image digest mismatch")
	}
	if len(sourceTags) == 0 {
		internalTag := "opfield-migration:" + strings.TrimPrefix(req.ExpectedImageID, "sha256:")[:12]
		if _, err := p.client.cli.ImageTag(ctx, mobyclient.ImageTagOptions{Source: loaded.ID, Target: internalTag}); err != nil {
			return migrationArtifactMetadata{}, fmt.Errorf("tag untagged migration image: %w", err)
		}
	} else {
		for _, tag := range sourceTags {
			if _, err := p.client.cli.ImageTag(ctx, mobyclient.ImageTagOptions{Source: loaded.ID, Target: tag}); err != nil {
				return migrationArtifactMetadata{}, fmt.Errorf("restore migration image tag %q: %w", tag, err)
			}
		}
	}
	info, err := file.Stat()
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("stat image artifact: %w", err)
	}
	meta := migrationArtifactMetadata{
		ArtifactID: artifactID, ArtifactType: "image", SizeBytes: info.Size(),
		ArtifactDigest: artifactDigest, ImageID: loaded.ID, Complete: true,
	}
	if err := p.migrationStore.saveMetadata(migrationID, meta); err != nil {
		return migrationArtifactMetadata{}, err
	}
	return meta, nil
}
