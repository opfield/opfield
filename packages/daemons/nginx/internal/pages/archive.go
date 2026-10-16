package pages

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	publicDirectoryMode  os.FileMode = 0o755
	privateDirectoryMode os.FileMode = 0o750
	publicFileMode       os.FileMode = 0o644
	privateFileMode      os.FileMode = 0o600
)

func extractArchive(archivePath, destination, deploymentID, digest string, size int64) (releaseManifest, error) {
	if _, err := lstatRegular(archivePath); err != nil {
		return releaseManifest{}, err
	}
	f, err := openNoFollow(archivePath, os.O_RDONLY, 0)
	if err != nil {
		return releaseManifest{}, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return releaseManifest{}, fmt.Errorf("open gzip archive: %w", err)
	}
	defer gz.Close()
	if err := ensureDirectory(destination, publicDirectoryMode); err != nil {
		return releaseManifest{}, err
	}
	// The expanded release must leave the node reserve free (nodeReserveBytes): a release far larger than its
	// archive must not fill the node.
	free, total, err := filesystemSpace(destination)
	if err != nil {
		return releaseManifest{}, err
	}
	budget := free - nodeReserveBytes(total)
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	regularFiles := map[string]bool{}
	files := 0
	entries := 0
	var expanded int64
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return releaseManifest{}, fmt.Errorf("read archive: %w", err)
		}
		if header.Typeflag == tar.TypeDir && isArchiveRootDirectory(header.Name) {
			if header.Size != 0 {
				return releaseManifest{}, errors.New("archive directory has payload")
			}
			continue
		}
		name, err := archiveName(header.Name)
		if err != nil {
			return releaseManifest{}, err
		}
		if seen[name] {
			return releaseManifest{}, errors.New("archive contains duplicate path")
		}
		seen[name] = true
		for ancestor := path.Dir(name); ancestor != "."; ancestor = path.Dir(ancestor) {
			if regularFiles[ancestor] {
				return releaseManifest{}, errors.New("archive path conflicts with file")
			}
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA && header.Typeflag != tar.TypeDir {
			return releaseManifest{}, errors.New("archive contains unsupported entry type")
		}
		if header.Size < 0 || header.Size > maxFileBytes {
			return releaseManifest{}, errors.New("archive file exceeds limit")
		}
		if header.Typeflag != tar.TypeDir {
			for existing := range seen {
				if existing != name && strings.HasPrefix(existing, name+"/") {
					return releaseManifest{}, errors.New("archive path conflicts with file")
				}
			}
			regularFiles[name] = true
			files++
		}
		entries++
		expanded += header.Size
		if entries > maxFileCount || expanded > maxExpandedBytes {
			return releaseManifest{}, errors.New("archive exceeds expanded limits")
		}
		if expanded > budget {
			return releaseManifest{}, errors.New("expanded release does not fit the node's free space reserve")
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if header.Typeflag == tar.TypeDir {
			if err := ensureDirectory(target, publicDirectoryMode); err != nil {
				return releaseManifest{}, err
			}
			continue
		}
		if err := ensureDirectory(filepath.Dir(target), publicDirectoryMode); err != nil {
			return releaseManifest{}, err
		}
		out, err := openNoFollow(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, publicFileMode)
		if err != nil {
			return releaseManifest{}, err
		}
		_, copyErr := io.Copy(out, io.LimitReader(tr, header.Size+1))
		chmodErr := out.Chmod(publicFileMode)
		syncErr := out.Sync()
		closeErr := out.Close()
		if copyErr != nil || chmodErr != nil || syncErr != nil || closeErr != nil {
			return releaseManifest{}, firstErr(copyErr, chmodErr, syncErr, closeErr)
		}
		if actual, err := lstatRegular(target); err != nil || actual.Size() != header.Size {
			return releaseManifest{}, errors.New("archive file size mismatch")
		}
	}
	if err := ensurePublicTree(destination); err != nil {
		return releaseManifest{}, err
	}
	return releaseManifest{DeploymentID: deploymentID, SHA256: digest, Size: size, FileCount: files}, nil
}

func isArchiveRootDirectory(raw string) bool {
	if raw == "." {
		return true
	}
	return strings.HasPrefix(raw, "./") && strings.Trim(raw[2:], "/") == ""
}

func archiveName(raw string) (string, error) {
	if raw == "" || strings.Contains(raw, "\\") || strings.ContainsRune(raw, 0) {
		return "", errors.New("invalid archive path")
	}
	cleaned := path.Clean(raw)
	if path.IsAbs(raw) || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("archive path escapes release")
	}
	return cleaned, nil
}

func fileSHA256(filePath string) (string, error) {
	return fileSHA256NoFollow(filePath)
}

func writeAtomic(filePath string, content []byte, mode os.FileMode) error {
	directoryMode := publicDirectoryMode
	if mode.Perm() == privateFileMode.Perm() {
		directoryMode = privateDirectoryMode
	}
	if err := ensureDirectory(filepath.Dir(filePath), directoryMode); err != nil {
		return err
	}
	if _, err := lstatRegular(filePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(filePath), ".tmp-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, filePath)
}

func ensurePublicTree(root string) error {
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if err := validateDirectoryInfo(root, info); err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink in public release tree at %s", errUnsafePagesPath, path)
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink in public release tree at %s", errUnsafePagesPath, path)
		}
		if entryInfo.IsDir() {
			return chmodNoFollowDirectory(path, publicDirectoryMode)
		}
		if entryInfo.Mode().IsRegular() {
			return chmodNoFollowRegular(path, publicFileMode)
		}
		return fmt.Errorf("%w: unsupported entry in public release tree at %s", errUnsafePagesPath, path)
	})
}

func (r *Runtime) ensurePublicRelease(deploymentID string) error {
	if err := ensureDirectory(r.root, publicDirectoryMode); err != nil {
		return err
	}
	if err := ensureDirectory(r.releasesDir(), publicDirectoryMode); err != nil {
		return err
	}
	contentInfo, err := os.Lstat(r.releaseContentDir(deploymentID))
	if err != nil {
		return err
	}
	if err := validateDirectoryInfo(r.releaseContentDir(deploymentID), contentInfo); err != nil {
		return err
	}
	return ensurePublicTree(r.releaseDir(deploymentID))
}

func validateID(id string) error {
	if !uuidPattern.MatchString(id) {
		return errors.New("must be a lowercase UUID")
	}
	return nil
}
func validHostname(hostname string) bool {
	if len(hostname) == 0 || len(hostname) > 253 || strings.Contains(hostname, "..") {
		return false
	}
	for _, label := range strings.Split(hostname, ".") {
		if !hostnameLabel.MatchString(label) {
			return false
		}
	}
	return true
}
func safeNginxPath(value string) bool {
	return filepath.IsAbs(value) && !strings.ContainsAny(value, "\r\n;{}#")
}
func firstErr(values ...error) error {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
