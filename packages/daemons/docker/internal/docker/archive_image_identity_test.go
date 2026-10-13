package docker

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// docker save of alpine:3.20 by ID (stand, 2026-10-13): the config digest is the image ID of the classic store
// (Docker 26), the index entry the image ID of the containerd image store (Docker 29).
const (
	alpineConfigDigest   = "sha256:bf8527eb54c3680e728d5b4b383a8ba730d72dae7236fbc8dff97ed6b224a731"
	alpineDocker26Digest = "sha256:63f227048c13ddea8a12507cd21e61ad3a37da419a3fe0d1ffc318ccb9cd1fec"
	alpineDocker29Digest = "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
	alpineManifestJSON   = `[{"Config":"blobs/sha256/bf8527eb54c3680e728d5b4b383a8ba730d72dae7236fbc8dff97ed6b224a731","RepoTags":["alpine:3.20"],"Layers":["blobs/sha256/25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471"]}]`
	alpineDocker29Index  = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc","size":9226,"annotations":{"containerd.io/distribution.source.docker.io":"library/alpine","io.containerd.image.name":"docker.io/library/alpine:3.20","org.opencontainers.image.ref.name":"3.20"}}]}`
	alpineDocker26Index  = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:63f227048c13ddea8a12507cd21e61ad3a37da419a3fe0d1ffc318ccb9cd1fec","size":400}]}`
)

func archiveTar(t *testing.T, entries map[string]string, order ...string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, name := range order {
		content := entries[name]
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestArchiveImageIdentityAcrossImageStores(t *testing.T) {
	for _, tc := range []struct {
		name, index, expected, loaded string
	}{
		{"Docker 26 archive on Docker 29", alpineDocker26Index, alpineConfigDigest, alpineDocker26Digest},
		{"Docker 29 archive on Docker 26", alpineDocker29Index, alpineDocker29Digest, alpineConfigDigest},
		{"Docker 26 archive on Docker 26", alpineDocker26Index, alpineConfigDigest, alpineConfigDigest},
		{"Docker 29 archive on Docker 29", alpineDocker29Index, alpineDocker29Digest, alpineDocker29Digest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			names := archiveImageNames{}
			source := archiveTar(t, map[string]string{"blobs/sha256/x": "layer", "index.json": tc.index, "manifest.json": alpineManifestJSON}, "blobs/sha256/x", "index.json", "manifest.json")
			var sanitized bytes.Buffer
			if err := stripDockerArchiveRepoTags(bytes.NewReader(source), &sanitized, names); err != nil {
				t.Fatal(err)
			}
			imageID, err := names.loadedImage(tc.expected, []string{tc.loaded})
			if err != nil || imageID != tc.loaded {
				t.Fatalf("loaded image = %q, %v; want %s", imageID, err, tc.loaded)
			}
			// Neither manifest.json nor index.json names the image any more.
			reader := tar.NewReader(&sanitized)
			for {
				header, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				content, _ := io.ReadAll(reader)
				if strings.Contains(string(content), "alpine:3.20") || strings.Contains(string(content), "ref.name") {
					t.Fatalf("%s still names the image: %s", header.Name, content)
				}
				if header.Name == "index.json" && strings.Contains(tc.index, "distribution.source") && !strings.Contains(string(content), "containerd.io/distribution.source") {
					t.Fatalf("index.json lost its other annotations: %s", content)
				}
			}
		})
	}
}

func TestArchiveImageIdentityRefusesAnotherImage(t *testing.T) {
	names := archiveImageNames{}
	if err := names.addManifestConfigs([]byte(alpineManifestJSON)); err != nil {
		t.Fatal(err)
	}
	if _, err := names.sanitizeDockerArchiveIndex([]byte(alpineDocker26Index)); err != nil {
		t.Fatal(err)
	}
	other := "sha256:" + strings.Repeat("a", 64)
	if _, err := names.loadedImage(other, []string{alpineConfigDigest}); err == nil {
		t.Fatal("an archive of another image was accepted")
	}
	if _, err := names.loadedImage(alpineConfigDigest, []string{other}); err == nil {
		t.Fatal("a load that reported another image was accepted")
	}
	if _, err := names.loadedImage(alpineConfigDigest, []string{alpineConfigDigest, alpineDocker26Digest}); err == nil {
		t.Fatal("a load of two images was accepted")
	}
	if _, err := names.loadedImage(alpineConfigDigest, nil); err == nil {
		t.Fatal("a load that reported no image was accepted")
	}
	// A save of Docker 24 and earlier names its config "<hex>.json".
	legacy := archiveImageNames{}
	if err := legacy.addManifestConfigs([]byte(`[{"Config":"` + strings.TrimPrefix(alpineConfigDigest, "sha256:") + `.json"}]`)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.loadedImage(alpineConfigDigest, []string{alpineConfigDigest}); err != nil {
		t.Fatal(err)
	}
}

func TestReadDockerImageLoad(t *testing.T) {
	var response bytes.Buffer
	for _, message := range []map[string]any{
		{"status": "Loading layer", "progressDetail": map[string]any{"current": 1}},
		{"stream": "Loaded image ID: " + alpineDocker26Digest + "\n"},
	} {
		_ = json.NewEncoder(&response).Encode(message)
	}
	loaded, err := readDockerImageLoad(&response)
	if err != nil || len(loaded) != 1 || loaded[0] != alpineDocker26Digest {
		t.Fatalf("loaded = %v, %v", loaded, err)
	}
	if _, err := readDockerImageLoad(strings.NewReader(`{"errorDetail":{"message":"unexpected EOF"},"error":"unexpected EOF"}`)); err == nil || !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("load error = %v", err)
	}
}
