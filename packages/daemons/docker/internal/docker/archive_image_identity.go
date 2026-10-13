package docker

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// P-6: Docker names the same image differently per image store. The classic store's image ID is the digest of the
// image config; the containerd image store's is the digest of the manifest or index. A docker save names both (the
// config in manifest.json, the manifests in index.json), so an archive made on either store is matched by them, and
// the image it loaded is identified by the ID Docker reports for the load.

var hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// archiveImageNames are the digests an image save names for its image.
type archiveImageNames map[string]struct{}

func (names archiveImageNames) add(digest string) {
	if dockerSHA256Digest.MatchString(digest) {
		names[digest] = struct{}{}
	}
}

// addManifestConfigs records the config digest of each manifest.json entry: "blobs/sha256/<hex>" (Docker 25 and
// later) or "<hex>.json".
func (names archiveImageNames) addManifestConfigs(manifest []byte) error {
	var entries []struct {
		Config string `json:"Config"`
	}
	if err := json.Unmarshal(manifest, &entries); err != nil {
		return fmt.Errorf("parse archive image manifest: %w", err)
	}
	for _, entry := range entries {
		hex := strings.TrimSuffix(strings.TrimPrefix(entry.Config, "blobs/sha256/"), ".json")
		if hexSHA256.MatchString(hex) {
			names.add("sha256:" + hex)
		}
	}
	return nil
}

// sanitizeDockerArchiveIndex records the manifest digests of index.json and drops the image names its entries carry
// (the containerd image store tags a loaded image after them, as Docker does after manifest.json RepoTags).
func (names archiveImageNames) sanitizeDockerArchiveIndex(index []byte) ([]byte, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(index, &document); err != nil {
		return nil, fmt.Errorf("parse archive image index: %w", err)
	}
	var manifests []map[string]json.RawMessage
	if raw, ok := document["manifests"]; ok {
		if err := json.Unmarshal(raw, &manifests); err != nil {
			return nil, fmt.Errorf("parse archive image index manifests: %w", err)
		}
	}
	for index, manifest := range manifests {
		if manifest == nil {
			return nil, fmt.Errorf("archive image index entry %d is invalid", index)
		}
		var digest string
		if err := json.Unmarshal(manifest["digest"], &digest); err == nil {
			names.add(digest)
		}
		if raw, ok := manifest["annotations"]; ok {
			var annotations map[string]string
			if err := json.Unmarshal(raw, &annotations); err != nil {
				return nil, fmt.Errorf("parse archive image index annotations: %w", err)
			}
			delete(annotations, "io.containerd.image.name")
			delete(annotations, "org.opencontainers.image.ref.name")
			encoded, err := json.Marshal(annotations)
			if err != nil {
				return nil, err
			}
			manifest["annotations"] = encoded
		}
	}
	if manifests != nil {
		encoded, err := json.Marshal(manifests)
		if err != nil {
			return nil, err
		}
		document["manifests"] = encoded
	}
	return json.Marshal(document)
}

// loadedImage returns the image a load of this save made: the one ID Docker reported, which the save must name, as
// it must name the expected image.
func (names archiveImageNames) loadedImage(expectedImageID string, loadedIDs []string) (string, error) {
	if _, named := names[expectedImageID]; !named {
		return "", fmt.Errorf("archive image does not hold the expected image %s", expectedImageID)
	}
	if len(loadedIDs) != 1 {
		return "", fmt.Errorf("archive image load reported %d images, want 1", len(loadedIDs))
	}
	if _, named := names[loadedIDs[0]]; !named {
		return "", fmt.Errorf("archive image load reported image %s, which the archive does not name", loadedIDs[0])
	}
	return loadedIDs[0], nil
}

// readDockerImageLoad reads a load response: the IDs of the untagged images it loaded ("Loaded image ID: <id>"),
// or the error it reported.
func readDockerImageLoad(response io.Reader) ([]string, error) {
	decoder := json.NewDecoder(response)
	var loaded []string
	for {
		var message struct {
			Stream      string `json:"stream"`
			Error       string `json:"error"`
			ErrorDetail *struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := decoder.Decode(&message); err == io.EOF {
			return loaded, nil
		} else if err != nil {
			return nil, fmt.Errorf("read Docker image load response: %w", err)
		}
		if message.ErrorDetail != nil && message.ErrorDetail.Message != "" {
			return nil, fmt.Errorf("load Docker image: %s", message.ErrorDetail.Message)
		}
		if message.Error != "" {
			return nil, fmt.Errorf("load Docker image: %s", message.Error)
		}
		for _, line := range strings.Split(message.Stream, "\n") {
			if id, found := strings.CutPrefix(strings.TrimSpace(line), "Loaded image ID: "); found {
				loaded = append(loaded, strings.TrimSpace(id))
			}
		}
	}
}
