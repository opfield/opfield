package pages

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const maxRuntimeConfigBytes = 64 << 10

type RuntimeConfigBindingKind string

const (
	RuntimeConfigBindingRoute   RuntimeConfigBindingKind = "route"
	RuntimeConfigBindingPreview RuntimeConfigBindingKind = "preview"
)

type InventoryRuntimeConfig struct {
	BindingKind string `json:"bindingKind"`
	BindingID   string `json:"bindingId"`
	Generation  uint64 `json:"generation"`
}

type runtimeConfigBindingMetadata struct {
	BindingKind RuntimeConfigBindingKind `json:"bindingKind"`
	BindingID   string                   `json:"bindingId"`
}

// StageRuntimeConfig validates and stages an immutable JavaScript generation.
// It deliberately accepts JSON only: the daemon owns the browser assignment,
// escaping and all filesystem locations.
func (r *Runtime) StageRuntimeConfig(kind RuntimeConfigBindingKind, bindingID string, generation uint64, value []byte) error {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return err
	}
	if generation == 0 {
		return errors.New("runtime config generation must be positive")
	}
	if len(value) == 0 || len(value) > maxRuntimeConfigBytes {
		return errors.New("runtime config must be a JSON object up to 64 KiB")
	}
	canonical, err := canonicalRuntimeConfig(value)
	if err != nil {
		return err
	}
	content, err := runtimeConfigJavaScript(canonical)
	if err != nil {
		return err
	}
	path, err := r.runtimeConfigVersionPath(kind, bindingID, generation)
	if err != nil {
		return err
	}
	if err := r.ensureRuntimeConfigBindingMetadata(kind, bindingID); err != nil {
		return err
	}
	if existing, err := readFileNoFollow(path); err == nil {
		if string(existing) == string(content) {
			if err := chmodNoFollowRegular(path, publicFileMode); err != nil {
				return err
			}
			return nil
		}
		return errors.New("runtime config generation already contains a different value")
	} else if !os.IsNotExist(err) {
		return err
	}
	return writeAtomic(path, content, publicFileMode)
}

// ActivateRuntimeConfig atomically switches the stable current.js pointer.
// Activating an older staged generation is the rollback operation.
func (r *Runtime) ActivateRuntimeConfig(kind RuntimeConfigBindingKind, bindingID string, generation uint64) (string, error) {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return "", err
	}
	if generation == 0 {
		return "", errors.New("runtime config generation must be positive")
	}
	versionPath, err := r.runtimeConfigVersionPath(kind, bindingID, generation)
	if err != nil {
		return "", err
	}
	if _, err := lstatRegular(versionPath); err != nil {
		if os.IsNotExist(err) {
			return "", errors.New("runtime config generation is not staged")
		}
		return "", err
	}
	if err := r.ensureRuntimeConfigPublicDirs(kind, bindingID); err != nil {
		return "", err
	}
	if err := chmodNoFollowRegular(versionPath, publicFileMode); err != nil {
		return "", err
	}
	currentPath, err := r.RuntimeConfigPath(kind, bindingID)
	if err != nil {
		return "", err
	}
	expectedTarget := filepath.Join("versions", strconv.FormatUint(generation, 10)+".js")
	var previous uint64
	if info, err := os.Lstat(currentPath); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return "", fmt.Errorf("%w: runtime config current.js is not a symlink", errUnsafePagesPath)
		}
		target, err := os.Readlink(currentPath)
		if err != nil {
			return "", err
		}
		if err := validateRuntimeConfigCurrentTarget(currentPath, target); err != nil {
			return "", err
		}
		if target == expectedTarget {
			return currentPath, nil
		}
		previous, _ = strconv.ParseUint(strings.TrimSuffix(filepath.Base(target), ".js"), 10, 64)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := ensureDirectory(filepath.Dir(currentPath), publicDirectoryMode); err != nil {
		return "", err
	}
	temporary := currentPath + ".next"
	if info, err := os.Lstat(temporary); err == nil {
		if info.IsDir() {
			return "", fmt.Errorf("%w: runtime config temporary pointer is a directory", errUnsafePagesPath)
		}
		if err := os.Remove(temporary); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Symlink(filepath.Join("versions", strconv.FormatUint(generation, 10)+".js"), temporary); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, currentPath); err != nil {
		_ = os.Remove(temporary)
		return "", err
	}
	// Every activation used to leave its generation behind (one file per publication, tens of thousands on a busy
	// route). The generation just replaced stays as the rollback target; a failed prune is retried by Sweep.
	_, _ = pruneRuntimeConfigVersions(r.runtimeConfigBindingDir(kind, bindingID), previous, time.Now())
	return currentPath, nil
}

func (r *Runtime) RemoveRuntimeConfig(kind RuntimeConfigBindingKind, bindingID string) error {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return err
	}
	return os.RemoveAll(r.runtimeConfigBindingDir(kind, bindingID))
}

// DiscardRuntimeConfig removes one staged generation without touching the
// binding's active current.js pointer. It is used to recover a failed
// stage/activate transaction before retrying the same immutable generation.
func (r *Runtime) DiscardRuntimeConfig(kind RuntimeConfigBindingKind, bindingID string, generation uint64) error {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return err
	}
	if generation == 0 {
		return errors.New("runtime config generation must be positive")
	}

	versionPath, err := r.runtimeConfigVersionPath(kind, bindingID, generation)
	if err != nil {
		return err
	}
	currentPath, err := r.RuntimeConfigPath(kind, bindingID)
	if err != nil {
		return err
	}
	expectedTarget := filepath.Join("versions", strconv.FormatUint(generation, 10)+".js")
	if info, err := os.Lstat(currentPath); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("%w: runtime config current.js is not a symlink", errUnsafePagesPath)
		}
		target, err := os.Readlink(currentPath)
		if err != nil {
			return err
		}
		if err := validateRuntimeConfigCurrentTarget(currentPath, target); err != nil {
			return err
		}
		if target == expectedTarget {
			return errors.New("cannot discard the active runtime config generation")
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	if _, err := lstatRegular(versionPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.Remove(versionPath)
}

// RuntimeConfigPath returns the daemon-derived stable file path for a
// validated binding. Callers use it only as an internal nginx variable or
// alias target; no operator-supplied path can influence it.
func (r *Runtime) RuntimeConfigPath(kind RuntimeConfigBindingKind, bindingID string) (string, error) {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return "", err
	}
	return filepath.Join(r.runtimeConfigBindingDir(kind, bindingID), "current.js"), nil
}

func (r *Runtime) runtimeConfigVersionPath(kind RuntimeConfigBindingKind, bindingID string, generation uint64) (string, error) {
	if err := validateRuntimeConfigBinding(kind, bindingID); err != nil {
		return "", err
	}
	return filepath.Join(r.runtimeConfigBindingDir(kind, bindingID), "versions", strconv.FormatUint(generation, 10)+".js"), nil
}

func (r *Runtime) runtimeConfigBindingDir(kind RuntimeConfigBindingKind, bindingID string) string {
	if kind == RuntimeConfigBindingPreview {
		hash := sha256.Sum256([]byte(bindingID))
		return filepath.Join(r.root, "runtime-configs", "previews", hex.EncodeToString(hash[:12]))
	}
	return filepath.Join(r.root, "runtime-configs", "routes", bindingID)
}

func (r *Runtime) runtimeConfigInventory() ([]InventoryRuntimeConfig, error) {
	result := []InventoryRuntimeConfig{}
	for _, kind := range []RuntimeConfigBindingKind{RuntimeConfigBindingRoute, RuntimeConfigBindingPreview} {
		base := filepath.Join(r.root, "runtime-configs", string(kind)+"s")
		if info, err := os.Lstat(base); err == nil {
			if err := validateDirectoryInfo(base, info); err != nil {
				return nil, err
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		entries, err := os.ReadDir(base)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		for _, entry := range entries {
			bindingDir := filepath.Join(base, entry.Name())
			bindingInfo, err := os.Lstat(bindingDir)
			if err != nil {
				return nil, err
			}
			if err := validateDirectoryInfo(bindingDir, bindingInfo); err != nil {
				return nil, err
			}
			if !bindingInfo.IsDir() {
				continue
			}
			current := filepath.Join(bindingDir, "current.js")
			target, err := os.Readlink(current)
			if err != nil {
				continue
			}
			var generation uint64
			if _, err := fmt.Sscanf(filepath.Base(target), "%d.js", &generation); err != nil || generation == 0 {
				continue
			}
			if err := validateRuntimeConfigCurrentTarget(current, target); err != nil {
				return nil, err
			}
			metadata, err := r.readRuntimeConfigBindingMetadata(filepath.Join(bindingDir, "binding.json"))
			if err != nil || metadata.BindingKind != kind {
				continue
			}
			if err := validateRuntimeConfigBinding(metadata.BindingKind, metadata.BindingID); err != nil {
				continue
			}
			result = append(result, InventoryRuntimeConfig{BindingKind: string(kind), BindingID: metadata.BindingID, Generation: generation})
		}
	}
	return result, nil
}

func (r *Runtime) ensureRuntimeConfigBindingMetadata(kind RuntimeConfigBindingKind, bindingID string) error {
	if err := r.ensureRuntimeConfigPublicDirs(kind, bindingID); err != nil {
		return err
	}
	path := filepath.Join(r.runtimeConfigBindingDir(kind, bindingID), "binding.json")
	metadata := runtimeConfigBindingMetadata{BindingKind: kind, BindingID: bindingID}
	if existing, err := r.readRuntimeConfigBindingMetadata(path); err == nil {
		if existing == metadata {
			return chmodNoFollowRegular(path, publicFileMode)
		}
		return errors.New("runtime config binding metadata conflict")
	} else if !os.IsNotExist(err) {
		return err
	}
	content, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	return writeAtomic(path, content, publicFileMode)
}

func (r *Runtime) ensureRuntimeConfigPublicDirs(kind RuntimeConfigBindingKind, bindingID string) error {
	return r.ensureRuntimeConfigPublicDirsAtPath(kind, r.runtimeConfigBindingDir(kind, bindingID))
}

func (r *Runtime) ensureRuntimeConfigPublicDirsAtPath(kind RuntimeConfigBindingKind, bindingDir string) error {
	baseDir := filepath.Join(r.root, "runtime-configs", string(kind)+"s")
	for _, path := range []string{
		r.root,
		filepath.Join(r.root, "runtime-configs"),
		baseDir,
		bindingDir,
		filepath.Join(bindingDir, "versions"),
	} {
		if err := ensureDirectory(path, publicDirectoryMode); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) readRuntimeConfigBindingMetadata(path string) (runtimeConfigBindingMetadata, error) {
	var metadata runtimeConfigBindingMetadata
	content, err := readFileNoFollow(path)
	if err != nil {
		return metadata, err
	}
	if err := json.Unmarshal(content, &metadata); err != nil {
		return metadata, err
	}
	return metadata, nil
}

func validateRuntimeConfigCurrentTarget(currentPath, target string) error {
	if filepath.IsAbs(target) || filepath.Clean(target) != target || filepath.Dir(target) != "versions" || !validRuntimeConfigVersionName(filepath.Base(target)) {
		return fmt.Errorf("%w: unsafe runtime config current target at %s", errUnsafePagesPath, currentPath)
	}
	targetPath := filepath.Join(filepath.Dir(currentPath), target)
	if _, err := lstatRegular(targetPath); err != nil {
		return fmt.Errorf("%w: unsafe runtime config current target at %s: %v", errUnsafePagesPath, targetPath, err)
	}
	return nil
}

func validateRuntimeConfigBinding(kind RuntimeConfigBindingKind, bindingID string) error {
	switch kind {
	case RuntimeConfigBindingRoute:
		if err := validateID(bindingID); err != nil {
			return fmt.Errorf("runtime route binding id: %w", err)
		}
	case RuntimeConfigBindingPreview:
		if !validHostname(bindingID) {
			return errors.New("invalid runtime preview binding hostname")
		}
	default:
		return errors.New("invalid runtime config binding kind")
	}
	return nil
}

func canonicalRuntimeConfig(value []byte) ([]byte, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(value, &object); err != nil || object == nil {
		return nil, errors.New("runtime config must be a JSON object")
	}
	canonical, err := json.Marshal(object)
	if err != nil {
		return nil, err
	}
	if len(canonical) > maxRuntimeConfigBytes {
		return nil, errors.New("runtime config must be a JSON object up to 64 KiB")
	}
	return canonical, nil
}

func runtimeConfigJavaScript(canonical []byte) ([]byte, error) {
	escaped, err := json.Marshal(string(canonical))
	if err != nil {
		return nil, err
	}
	return []byte("window.runtime = window.runtime && typeof window.runtime === 'object' && !Array.isArray(window.runtime) ? window.runtime : {};\nwindow.runtime.config = JSON.parse(" + string(escaped) + ");\n"), nil
}
