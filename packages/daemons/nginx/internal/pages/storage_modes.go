package pages

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (r *Runtime) StoragePreflight(required int64) (StoragePreflight, error) {
	if required < 0 {
		return StoragePreflight{}, errors.New("invalid required bytes")
	}
	if err := ensureDirectory(r.root, publicDirectoryMode); err != nil {
		return StoragePreflight{}, err
	}
	// Capacity checks must not walk every stored release for each binding.
	if err := ensureDirectory(r.releasesDir(), publicDirectoryMode); err != nil {
		return StoragePreflight{}, err
	}
	if err := ensureDirectory(r.uploadsDir(), privateDirectoryMode); err != nil {
		return StoragePreflight{}, err
	}
	free, total, err := filesystemSpace(r.root)
	if err != nil {
		return StoragePreflight{}, err
	}
	// The node reserve stays free after the release is stored (nodeReserveBytes).
	return StoragePreflight{RequiredBytes: required, FreeBytes: free, Available: free-nodeReserveBytes(total) >= required}, nil
}

// RepairStorage migrates legacy permissions at startup, independently of
// capacity checks. Normal publication/inspection repairs only its own release.
func (r *Runtime) RepairStorage() error {
	if err := ensureDirectory(r.root, publicDirectoryMode); err != nil {
		return err
	}
	if err := ensureDirectory(r.releasesDir(), publicDirectoryMode); err != nil {
		return err
	}
	if err := ensureDirectory(r.uploadsDir(), privateDirectoryMode); err != nil {
		return err
	}
	if err := ensurePrivateTree(r.uploadsDir()); err != nil {
		return err
	}
	if err := r.repairPublicReleases(); err != nil {
		return err
	}
	return r.repairRuntimeConfigBindings()
}

func ensurePrivateTree(root string) error {
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
			return fmt.Errorf("%w: symlink in private Pages tree at %s", errUnsafePagesPath, path)
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink in private Pages tree at %s", errUnsafePagesPath, path)
		}
		if entryInfo.IsDir() {
			return chmodNoFollowDirectory(path, privateDirectoryMode)
		}
		if entryInfo.Mode().IsRegular() {
			return chmodNoFollowRegular(path, privateFileMode)
		}
		return fmt.Errorf("%w: unsupported entry in private Pages tree at %s", errUnsafePagesPath, path)
	})
}

func (r *Runtime) repairPublicReleases() error {
	if err := ensureDirectory(r.releasesDir(), publicDirectoryMode); err != nil {
		return err
	}
	// A single walk covers every release, including legacy/unreferenced trees.
	return ensurePublicTree(r.releasesDir())
}

func (r *Runtime) repairRuntimeConfigBindings() error {
	if err := ensureDirectory(filepath.Join(r.root, "runtime-configs"), publicDirectoryMode); err != nil {
		return err
	}
	for _, kind := range []RuntimeConfigBindingKind{RuntimeConfigBindingRoute, RuntimeConfigBindingPreview} {
		baseDir := filepath.Join(r.root, "runtime-configs", string(kind)+"s")
		if err := ensureDirectory(baseDir, publicDirectoryMode); err != nil {
			return err
		}
		entries, err := os.ReadDir(baseDir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			entryPath := filepath.Join(baseDir, entry.Name())
			entryInfo, err := os.Lstat(entryPath)
			if err != nil {
				return err
			}
			if entryInfo.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: symlink in runtime config bindings at %s", errUnsafePagesPath, entryPath)
			}
			if !entryInfo.IsDir() {
				return fmt.Errorf("%w: non-directory runtime config binding at %s", errUnsafePagesPath, entryPath)
			}
			bindingDir := entryPath
			if err := ensureRuntimeConfigBindingFilesPublic(bindingDir); err != nil {
				return err
			}
			bindingID, valid := r.runtimeConfigBindingStorageID(kind, entry.Name(), bindingDir)
			if !valid {
				continue
			}
			if bindingID != "" {
				if err := r.ensureRuntimeConfigPublicDirs(kind, bindingID); err != nil {
					return err
				}
			} else if err := r.ensureRuntimeConfigPublicDirsAtPath(kind, bindingDir); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *Runtime) runtimeConfigBindingStorageID(kind RuntimeConfigBindingKind, entryName, bindingDir string) (string, bool) {
	switch kind {
	case RuntimeConfigBindingRoute:
		if err := validateRuntimeConfigBinding(kind, entryName); err != nil {
			return "", false
		}
		metadata, err := r.readRuntimeConfigBindingMetadata(filepath.Join(bindingDir, "binding.json"))
		if err == nil {
			if metadata.BindingKind != kind || metadata.BindingID != entryName || validateRuntimeConfigBinding(kind, metadata.BindingID) != nil {
				return "", false
			}
		} else if !os.IsNotExist(err) {
			return "", false
		}
		return entryName, true
	case RuntimeConfigBindingPreview:
		metadata, err := r.readRuntimeConfigBindingMetadata(filepath.Join(bindingDir, "binding.json"))
		if err == nil {
			if metadata.BindingKind != kind || validateRuntimeConfigBinding(kind, metadata.BindingID) != nil || r.runtimeConfigBindingDir(kind, metadata.BindingID) != bindingDir {
				return "", false
			}
			return metadata.BindingID, true
		}
		if !os.IsNotExist(err) || !validRuntimeConfigPreviewHash(entryName) {
			return "", false
		}
		return "", true
	default:
		return "", false
	}
}

func validRuntimeConfigPreviewHash(value string) bool {
	if len(value) != 24 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func ensureRuntimeConfigBindingFilesPublic(bindingDir string) error {
	metadataPath := filepath.Join(bindingDir, "binding.json")
	if info, err := os.Lstat(metadataPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("%w: unsafe runtime config metadata at %s", errUnsafePagesPath, metadataPath)
		}
		if err := chmodNoFollowRegular(metadataPath, publicFileMode); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	versionsDir := filepath.Join(bindingDir, "versions")
	versionsInfo, err := os.Lstat(versionsDir)
	if err == nil {
		if err := validateDirectoryInfo(versionsDir, versionsInfo); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	entries, err := os.ReadDir(versionsDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(versionsDir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !validRuntimeConfigVersionName(entry.Name()) || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("%w: unsafe runtime config generation at %s", errUnsafePagesPath, path)
		}
		if err := chmodNoFollowRegular(path, publicFileMode); err != nil {
			return err
		}
	}

	currentPath := filepath.Join(bindingDir, "current.js")
	target, err := os.Readlink(currentPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || filepath.Clean(target) != target || filepath.Dir(target) != "versions" || !validRuntimeConfigVersionName(filepath.Base(target)) {
		return fmt.Errorf("%w: unsafe runtime config current target at %s", errUnsafePagesPath, currentPath)
	}
	targetPath := filepath.Join(bindingDir, target)
	info, err := os.Lstat(targetPath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("%w: unsafe runtime config current target at %s", errUnsafePagesPath, targetPath)
	}
	return chmodNoFollowRegular(targetPath, publicFileMode)
}

func validRuntimeConfigVersionName(name string) bool {
	if !strings.HasSuffix(name, ".js") {
		return false
	}
	generation, err := strconv.ParseUint(strings.TrimSuffix(name, ".js"), 10, 64)
	return err == nil && generation > 0 && strconv.FormatUint(generation, 10)+".js" == name
}
