package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/docker-daemon/internal/pgext"
)

// The files of a downloadable extension bundle image and their verification:
// opfield-bundle.json lists every file under files/ with its size and sha256
// (links with their target); the daemon accepts exactly that, under usr/lib
// and usr/share only.

// pgBundleManifest is opfield-bundle.json of a bundle image.
type pgBundleManifest struct {
	SchemaVersion int             `json:"schemaVersion"`
	ID            string          `json:"id"`
	Version       string          `json:"version"`
	Major         string          `json:"major"`
	Debian        string          `json:"debian"`
	Arch          string          `json:"arch"`
	Provides      []string        `json:"provides"`
	Requires      []string        `json:"requires"`
	Files         []pgBundleEntry `json:"files"`
	SizeBytes     int64           `json:"sizeBytes"`
}

type pgBundleEntry struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Target string `json:"target,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Mode   string `json:"mode,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

func (m *managedDatabaseManager) readPostgresBundleManifest(ctx context.Context, containerID string) (pgBundleManifest, error) {
	var manifest pgBundleManifest
	archive, err := m.client.cli.CopyFromContainer(ctx, containerID, mobyclient.CopyFromContainerOptions{SourcePath: "/" + pgBundleManifestName})
	if err != nil {
		return manifest, err
	}
	defer archive.Content.Close()
	reader := tar.NewReader(archive.Content)
	for {
		header, err := reader.Next()
		if err != nil {
			return manifest, fmt.Errorf("%s is missing: %w", pgBundleManifestName, err)
		}
		if path.Base(header.Name) != pgBundleManifestName || header.Typeflag != tar.TypeReg {
			continue
		}
		if header.Size > pgBundleMaxManifestBytes {
			return manifest, errors.New("the manifest is too large")
		}
		data, err := io.ReadAll(io.LimitReader(reader, pgBundleMaxManifestBytes))
		if err != nil {
			return manifest, err
		}
		return manifest, json.Unmarshal(data, &manifest)
	}
}

// checkPostgresBundleManifest matches a bundle's manifest with its pin.
func checkPostgresBundleManifest(manifest pgBundleManifest, bundle pgext.Bundle, arch string) error {
	switch {
	case manifest.SchemaVersion != 1:
		return errors.New("the bundle manifest has an unknown schema version")
	case manifest.ID != bundle.ID || manifest.Version != bundle.Version || manifest.Major != bundle.Major ||
		manifest.Debian != bundle.Debian || manifest.Arch != arch:
		return fmt.Errorf("the bundle is %s %s for PostgreSQL %s on %s/%s, the pin is %s %s for PostgreSQL %s on %s/%s",
			manifest.ID, manifest.Version, manifest.Major, manifest.Debian, manifest.Arch,
			bundle.ID, bundle.Version, bundle.Major, bundle.Debian, arch)
	case manifest.SizeBytes != bundle.SizeBytes[arch]:
		return fmt.Errorf("the %s bundle holds %d bytes, the pin says %d", bundle.ID, manifest.SizeBytes, bundle.SizeBytes[arch])
	case len(manifest.Files) == 0 || len(manifest.Files) > pgBundleMaxFiles:
		return fmt.Errorf("the %s bundle lists %d files", bundle.ID, len(manifest.Files))
	}
	return nil
}

// pgBundlePathAllowed: bundle files live under usr/lib and usr/share only
// (the paths opfield-extensions links); directories leading there are fine.
func pgBundlePathAllowed(rel string, dir bool) bool {
	if rel == "" || strings.HasPrefix(rel, "/") || path.Clean(rel) != rel || rel == ".." || strings.HasPrefix(rel, "../") {
		return false
	}
	if dir && (rel == "usr" || rel == "usr/lib" || rel == "usr/share") {
		return true
	}
	return strings.HasPrefix(rel, "usr/lib/") || strings.HasPrefix(rel, "usr/share/")
}

// extractPostgresBundleFiles writes the archive of a bundle's files/ into
// dest, accepting exactly the manifest's entries: regular files with their
// size and sha256 (no setuid, setgid or write bits for others), links whose
// relative target stays inside the bundle, and the directories between.
func extractPostgresBundleFiles(archive io.Reader, dest string, manifest pgBundleManifest) error {
	expected := make(map[string]pgBundleEntry, len(manifest.Files))
	for _, entry := range manifest.Files {
		if !pgBundlePathAllowed(entry.Path, false) {
			return fmt.Errorf("the manifest lists %q outside usr/lib and usr/share", entry.Path)
		}
		expected[entry.Path] = entry
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	seen := map[string]bool{}
	written := int64(0)
	reader := tar.NewReader(archive)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(strings.TrimPrefix(header.Name, "./"), "/")
		name = strings.TrimSuffix(name, "/")
		if name == "files" {
			continue
		}
		rel, ok := strings.CutPrefix(name, "files/")
		if !ok {
			return fmt.Errorf("unexpected archive entry %q", header.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(rel))
		switch header.Typeflag {
		case tar.TypeDir:
			if !pgBundlePathAllowed(rel, true) {
				return fmt.Errorf("directory %q is outside usr/lib and usr/share", rel)
			}
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			entry, listed := expected[rel]
			if !listed || entry.Type != "file" || seen[rel] {
				return fmt.Errorf("file %q is not in the manifest", rel)
			}
			if header.Size != entry.Size {
				return fmt.Errorf("file %q has %d bytes, the manifest says %d", rel, header.Size, entry.Size)
			}
			written += header.Size
			if written > manifest.SizeBytes {
				return errors.New("the bundle holds more than its manifest says")
			}
			mode, err := strconv.ParseUint(entry.Mode, 8, 32)
			if err != nil {
				return fmt.Errorf("file %q has an invalid mode", rel)
			}
			if err := writePostgresBundleFile(target, reader, entry, os.FileMode(mode)&0o755|0o644); err != nil {
				return err
			}
			seen[rel] = true
		case tar.TypeSymlink:
			entry, listed := expected[rel]
			if !listed || entry.Type != "symlink" || entry.Target != header.Linkname || seen[rel] {
				return fmt.Errorf("link %q is not in the manifest", rel)
			}
			resolved := path.Clean(path.Join(path.Dir(rel), header.Linkname))
			if path.IsAbs(header.Linkname) || !pgBundlePathAllowed(resolved, true) {
				return fmt.Errorf("link %q points outside the bundle", rel)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
			seen[rel] = true
		default:
			return fmt.Errorf("entry %q has an unsupported type", rel)
		}
	}
	for rel := range expected {
		if !seen[rel] {
			return fmt.Errorf("file %q is missing", rel)
		}
	}
	return nil
}

func writePostgresBundleFile(target string, content io.Reader, entry pgBundleEntry, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(content, entry.Size))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if sum := hex.EncodeToString(hash.Sum(nil)); sum != entry.SHA256 {
		return fmt.Errorf("file %q has sha256 %s, the manifest says %s", entry.Path, sum, entry.SHA256)
	}
	return os.Chmod(target, mode)
}
