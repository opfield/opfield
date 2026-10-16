package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

type nodeFileEntry struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Permissions string `json:"permissions"`
	IsDir       bool   `json:"isDir"`
	Modified    string `json:"modified"`
	IsSymlink   bool   `json:"isSymlink,omitempty"`
	LinkTarget  string `json:"linkTarget,omitempty"`
	IsSpecial   bool   `json:"isSpecial,omitempty"`
	IsWritable  bool   `json:"isWritable,omitempty"`
}

// handleNodeFile serves node filesystem commands. hostIdentityPath is the
// daemon's configured host identity file; empty means the shared default.
func handleNodeFile(_ context.Context, cmd *pb.OpfieldCommand, hostIdentityPath string) *pb.CommandResult {
	nodeFile := cmd.GetNodeFile()
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	sweepRememberedNodeUploadDirs(time.Now())

	switch nodeFile.GetAction() {
	case "ensure-host-identity":
		// Fixed canonical operation: callers cannot select a path or identity.
		// A daemon running as its own user answers from the copy of the host
		// identity in its state directory, the one it enrolled with.
		identity, err := loadOrCreateHostIdentity(hostIdentityPath)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}
		result.Data = []byte(identity)

	case "list":
		entries, err := listNodeDirectory(nodeFile.GetPath())
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}
		data, err := json.Marshal(entries)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal entries: %v", err)
			return result
		}
		result.Detail = string(data)

	case "read":
		content, err := readNodeFile(nodeFile.GetPath(), nodeFile.GetMaxBytes())
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}
		result.Data = content

	case "write":
		if err := writeNodeFile(nodeFile.GetPath(), nodeFile.GetContent(), false); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "create-file":
		if err := writeNodeFile(nodeFile.GetPath(), nodeFile.GetContent(), true); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "create-dir":
		if err := createNodeDirectory(nodeFile.GetPath()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "delete":
		if err := deleteNodePath(nodeFile.GetPath()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "move":
		if err := moveNodePath(nodeFile.GetPath(), nodeFile.GetTargetPath()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "upload-init":
		if err := initNodeFileUpload(nodeFile.GetPath(), nodeFile.GetTargetPath(), nodeFile.GetMaxBytes()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "upload-chunk":
		if err := writeNodeFileUploadChunk(nodeFile.GetPath(), nodeFile.GetTargetPath(), nodeFile.GetMaxBytes(), nodeFile.GetContent()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "upload-complete":
		if err := completeNodeFileUpload(nodeFile.GetPath(), nodeFile.GetTargetPath(), nodeFile.GetMaxBytes()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "upload-abort":
		if err := abortNodeFileUpload(nodeFile.GetPath(), nodeFile.GetTargetPath()); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	default:
		result.Success = false
		result.Error = "unknown node file action: " + nodeFile.GetAction()
	}

	return result
}

func listNodeDirectory(path string) ([]nodeFileEntry, error) {
	cleanPath, err := validateNodePath(path, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("inspect directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("not a directory: %s", cleanPath)
	}
	entries, err := os.ReadDir(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("list directory: %w", err)
	}
	result := make([]nodeFileEntry, 0, len(entries))
	for _, entry := range entries {
		item, err := nodeFileEntryFromDirEntry(cleanPath, entry)
		if err != nil {
			continue
		}
		result = append(result, item)
	}
	return result, nil
}

func nodeFileEntryFromDirEntry(parent string, entry os.DirEntry) (nodeFileEntry, error) {
	info, err := entry.Info()
	if err != nil {
		return nodeFileEntry{}, err
	}
	mode := info.Mode()
	fullPath := filepath.Join(parent, entry.Name())
	item := nodeFileEntry{
		Name:        entry.Name(),
		Size:        info.Size(),
		Permissions: mode.String(),
		IsDir:       entry.IsDir(),
		Modified:    info.ModTime().Format("Jan _2 15:04"),
		IsSymlink:   mode&os.ModeSymlink != 0,
		IsSpecial:   !mode.IsRegular() && !entry.IsDir() && mode&os.ModeSymlink == 0,
		IsWritable:  isNodePathWritable(fullPath, entry.IsDir()),
	}
	if item.IsSymlink {
		if target, err := os.Readlink(fullPath); err == nil {
			item.LinkTarget = target
		}
	}
	return item, nil
}

func readNodeFile(path string, maxBytes int64) ([]byte, error) {
	cleanPath, err := validateNodePath(path, false)
	if err != nil {
		return nil, err
	}
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	info, err := os.Stat(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("inspect file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular/readable file: %s", cleanPath)
	}
	file, err := os.Open(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxBytes))
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	return content, nil
}

func writeNodeFile(path string, content []byte, create bool) error {
	cleanPath, err := validateNodePath(path, true)
	if err != nil {
		return err
	}
	parent := filepath.Dir(cleanPath)
	if err := ensureNodeWritableDirectory(parent); err != nil {
		return err
	}
	if !create {
		info, err := os.Stat(cleanPath)
		if errors.Is(err, fs.ErrPermission) || errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("write file: %w", err)
		}
		if err != nil {
			return fmt.Errorf("file is not writable: %s", cleanPath)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("file is not writable: %s", cleanPath)
		}
	}
	if err := os.WriteFile(cleanPath, content, 0o644); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

func createNodeDirectory(path string) error {
	cleanPath, err := validateNodePath(path, true)
	if err != nil {
		return err
	}
	if err := ensureNodeWritableDirectory(filepath.Dir(cleanPath)); err != nil {
		return err
	}
	if err := os.Mkdir(cleanPath, 0o755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	return nil
}

func deleteNodePath(path string) error {
	cleanPath, err := validateNodePath(path, true)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(cleanPath); err != nil {
		return fmt.Errorf("delete path: %w", err)
	}
	return nil
}

func moveNodePath(fromPath string, toPath string) error {
	cleanFrom, cleanTo, err := validateNodeMovePaths(fromPath, toPath)
	if err != nil {
		return err
	}
	if err := ensureNodeWritableDirectory(filepath.Dir(cleanTo)); err != nil {
		return err
	}
	if _, err := os.Stat(cleanTo); err == nil {
		return fmt.Errorf("target path already exists: %s", cleanTo)
	}
	if err := os.Rename(cleanFrom, cleanTo); err != nil {
		return fmt.Errorf("move path: %w", err)
	}
	return nil
}

func initNodeFileUpload(uploadID string, targetPath string, totalBytes int64) error {
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}
	tempPath, cleanTarget, err := nodeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if err := ensureNodeWritableDirectory(filepath.Dir(cleanTarget)); err != nil {
		return err
	}
	if err := os.Remove(tempPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale upload temp file: %w", err)
	}
	rememberNodeUploadDir(filepath.Dir(cleanTarget), time.Now())
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create upload temp file: %w", err)
	}
	return file.Close()
}

func writeNodeFileUploadChunk(uploadID string, targetPath string, offset int64, content []byte) error {
	if offset < 0 {
		return fmt.Errorf("offset must not be negative")
	}
	tempPath, _, err := nodeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(tempPath, os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open upload temp file: %w", err)
	}
	defer file.Close()
	if _, err := file.WriteAt(content, offset); err != nil {
		return fmt.Errorf("write upload chunk: %w", err)
	}
	return nil
}

func completeNodeFileUpload(uploadID string, targetPath string, totalBytes int64) error {
	tempPath, cleanTarget, err := nodeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}
	info, err := os.Stat(tempPath)
	if err != nil {
		return fmt.Errorf("inspect upload temp file: %w", err)
	}
	if info.Size() != totalBytes {
		return fmt.Errorf("upload size mismatch: expected %d bytes, got %d bytes", totalBytes, info.Size())
	}
	if err := os.Rename(tempPath, cleanTarget); err != nil {
		return fmt.Errorf("complete upload: %w", err)
	}
	return nil
}

func abortNodeFileUpload(uploadID string, targetPath string) error {
	tempPath, _, err := nodeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if err := os.Remove(tempPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("abort upload: %w", err)
	}
	return nil
}

func validateNodePath(path string, mutable bool) (string, error) {
	if path == "" {
		path = "/"
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("path must be absolute: %s", path)
	}
	if hasParentTraversalSegment(path) {
		return "", fmt.Errorf("path must not contain '..': %s", path)
	}
	cleaned := filepath.Clean(path)
	if mutable && cleaned == "/" {
		return "", fmt.Errorf("cannot modify root directory")
	}
	return cleaned, nil
}

func validateNodeMovePaths(fromPath string, toPath string) (string, string, error) {
	cleanFrom, err := validateNodePath(fromPath, true)
	if err != nil {
		return "", "", err
	}
	cleanTo, err := validateNodePath(toPath, true)
	if err != nil {
		return "", "", err
	}
	if cleanFrom == cleanTo {
		return "", "", fmt.Errorf("source and target paths are the same")
	}
	if strings.HasPrefix(cleanTo+"/", cleanFrom+"/") {
		return "", "", fmt.Errorf("cannot move directory into itself")
	}
	return cleanFrom, cleanTo, nil
}

func hasParentTraversalSegment(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

func validateNodeUploadID(uploadID string) error {
	if strings.TrimSpace(uploadID) == "" {
		return fmt.Errorf("upload id is required")
	}
	if strings.Contains(uploadID, "/") || strings.Contains(uploadID, "\\") || strings.Contains(uploadID, "..") {
		return fmt.Errorf("invalid upload id")
	}
	return nil
}

func nodeUploadTempPath(uploadID string, targetPath string) (string, string, error) {
	if err := validateNodeUploadID(uploadID); err != nil {
		return "", "", err
	}
	cleanTarget, err := validateNodePath(targetPath, true)
	if err != nil {
		return "", "", err
	}
	parent := filepath.Dir(cleanTarget)
	return filepath.Join(parent, ".opfield-upload-"+uploadID+".tmp"), cleanTarget, nil
}

func ensureNodeWritableDirectory(path string) error {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrPermission) {
		// The daemon's user cannot enter a directory on the way: say so, so Opfield answers 403, not "does not exist".
		return fmt.Errorf("parent directory: %w", err)
	}
	if err != nil {
		return fmt.Errorf("parent directory does not exist: %s", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("parent path is not a directory: %s", path)
	}
	if !isNodePathWritable(path, true) {
		return fmt.Errorf("parent directory is not writable: %s", path)
	}
	return nil
}

func isNodePathWritable(path string, isDir bool) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	if info.IsDir() != isDir {
		return false
	}
	return info.Mode().Perm()&0222 != 0
}
