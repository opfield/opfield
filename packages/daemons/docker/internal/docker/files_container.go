package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
)

func readContainerLogs(ctx context.Context, c *Client, containerID string, maxBytes int64) ([]byte, string, error) {
	logs, err := c.cli.ContainerLogs(ctx, containerID, client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	})
	if err != nil {
		return nil, "", fmt.Errorf("read helper logs: %w", err)
	}
	defer logs.Close()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	reader := io.Reader(logs)
	if maxBytes > 0 {
		reader = io.LimitReader(logs, maxBytes)
	}
	if _, err := stdcopy.StdCopy(&stdout, &stderr, reader); err != nil {
		return nil, "", fmt.Errorf("copy helper logs: %w", err)
	}
	return stdout.Bytes(), stderr.String(), nil
}

// ReadFile reads up to maxBytes of a regular file from inside a container.
// Rejects special files (devices, sockets, pipes, symlinks) that could hang or crash.
func ReadFile(ctx context.Context, c *Client, containerID string, path string, maxBytes int64) ([]byte, error) {
	if err := validatePath(path); err != nil {
		return nil, err
	}

	if maxBytes <= 0 {
		maxBytes = 1024 * 1024 // 1MB default
	}

	// Check that the target is a regular, readable file (not a device, socket, pipe, etc.)
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-f", path}); err != nil {
		return nil, fmt.Errorf("not a regular/readable file: %s", path)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-r", path}); err != nil {
		return nil, fmt.Errorf("not a regular/readable file: %s", path)
	}

	// Read with a timeout to prevent hangs on special files that slip through
	readCtx, readCancel := context.WithTimeout(ctx, 10*time.Second)
	defer readCancel()
	stdout, err := execInContainerBytes(readCtx, c, containerID, []string{"head", "-c", strconv.FormatInt(maxBytes, 10), path}, maxBytes+1024*1024)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}

	return stdout, nil
}

// WriteFile writes content to a regular, writable file inside a container.
// Content is sent on stdin and the target path is passed as argv so it is never interpreted by a shell.
func WriteFile(ctx context.Context, c *Client, containerID string, path string, content []byte) error {
	if err := validatePath(path); err != nil {
		return err
	}

	// Check that the target is a regular, writable file
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-f", path}); err != nil {
		return fmt.Errorf("file is not writable: %s", path)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-w", path}); err != nil {
		return fmt.Errorf("file is not writable: %s", path)
	}

	writeCtx, writeCancel := context.WithTimeout(ctx, 30*time.Second)
	defer writeCancel()

	if _, err := execInContainerWithInput(writeCtx, c, containerID, dockerWriteFileCommand(path), content); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

func dockerWriteFileCommand(path string) []string {
	return []string{"sh", "-c", "cat > \"$1\"", "sh", path}
}

func dockerWriteFileChunkCommand(path string, offset int64) ([]string, error) {
	if offset < 0 {
		return nil, fmt.Errorf("offset must not be negative")
	}
	if offset%dockerFileUploadBlockBytes != 0 {
		return nil, fmt.Errorf("offset must be aligned to %d bytes", dockerFileUploadBlockBytes)
	}
	return []string{
		"dd",
		"of=" + path,
		"bs=" + strconv.FormatInt(dockerFileUploadBlockBytes, 10),
		"seek=" + strconv.FormatInt(offset/dockerFileUploadBlockBytes, 10),
		"conv=notrunc",
	}, nil
}

func CreateFile(ctx context.Context, c *Client, containerID string, path string, content []byte) error {
	if err := validateMutablePath(path); err != nil {
		return err
	}

	parent := filepath.Dir(filepath.Clean(path))
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-d", parent}); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-w", parent}); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", parent)
	}

	writeCtx, writeCancel := context.WithTimeout(ctx, 30*time.Second)
	defer writeCancel()
	if _, err := execInContainerWithInput(writeCtx, c, containerID, dockerWriteFileCommand(path), content); err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	return nil
}

func InitChunkedFileUpload(ctx context.Context, c *Client, containerID string, uploadID string, targetPath string, totalBytes int64) error {
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}
	tempPath, cleanTarget, err := uploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}

	parent := filepath.Dir(cleanTarget)
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-d", parent}); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-w", parent}); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", parent)
	}

	initCtx, initCancel := context.WithTimeout(ctx, 30*time.Second)
	defer initCancel()
	if _, err := execInContainer(initCtx, c, containerID, []string{"rm", "-f", tempPath}); err != nil {
		return fmt.Errorf("remove stale upload temp file: %w", err)
	}
	if _, err := execInContainer(initCtx, c, containerID, []string{"touch", tempPath}); err != nil {
		return fmt.Errorf("create upload temp file: %w", err)
	}
	return nil
}

func WriteChunkedFileUpload(ctx context.Context, c *Client, containerID string, uploadID string, targetPath string, offset int64, content []byte) error {
	tempPath, _, err := uploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	command, err := dockerWriteFileChunkCommand(tempPath, offset)
	if err != nil {
		return err
	}

	writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer writeCancel()
	if _, err := execInContainerWithInput(writeCtx, c, containerID, command, content); err != nil {
		return fmt.Errorf("write upload chunk: %w", err)
	}
	return nil
}

func CompleteChunkedFileUpload(ctx context.Context, c *Client, containerID string, uploadID string, targetPath string, totalBytes int64) error {
	tempPath, cleanTarget, err := uploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}

	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	sizeText, err := execInContainer(checkCtx, c, containerID, []string{"stat", "-c", "%s", tempPath})
	if err != nil {
		return fmt.Errorf("inspect upload temp file: %w", err)
	}
	size, err := strconv.ParseInt(strings.TrimSpace(sizeText), 10, 64)
	if err != nil {
		return fmt.Errorf("parse upload temp file size: %w", err)
	}
	if size != totalBytes {
		return fmt.Errorf("upload size mismatch: expected %d bytes, got %d bytes", totalBytes, size)
	}

	completeCtx, completeCancel := context.WithTimeout(ctx, 30*time.Second)
	defer completeCancel()
	if _, err := execInContainer(completeCtx, c, containerID, []string{"mv", "-f", tempPath, cleanTarget}); err != nil {
		return fmt.Errorf("complete upload: %w", err)
	}
	return nil
}

func AbortChunkedFileUpload(ctx context.Context, c *Client, containerID string, uploadID string, targetPath string) error {
	tempPath, _, err := uploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	abortCtx, abortCancel := context.WithTimeout(ctx, 30*time.Second)
	defer abortCancel()
	if _, err := execInContainer(abortCtx, c, containerID, []string{"rm", "-f", tempPath}); err != nil {
		return fmt.Errorf("abort upload: %w", err)
	}
	return nil
}

func CreateDirectory(ctx context.Context, c *Client, containerID string, path string) error {
	if err := validateMutablePath(path); err != nil {
		return err
	}
	parent := filepath.Dir(filepath.Clean(path))
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-d", parent}); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-w", parent}); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"mkdir", path}); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	return nil
}

func DeletePath(ctx context.Context, c *Client, containerID string, path string) error {
	if err := validateMutablePath(path); err != nil {
		return err
	}
	deleteCtx, deleteCancel := context.WithTimeout(ctx, 30*time.Second)
	defer deleteCancel()
	if _, err := execInContainer(deleteCtx, c, containerID, []string{"rm", "-rf", path}); err != nil {
		return fmt.Errorf("delete path: %w", err)
	}
	return nil
}

func MovePath(ctx context.Context, c *Client, containerID string, fromPath string, toPath string) error {
	cleanFrom, cleanTo, err := validateMovePaths(fromPath, toPath)
	if err != nil {
		return err
	}
	parent := filepath.Dir(cleanTo)
	checkCtx, checkCancel := context.WithTimeout(ctx, 5*time.Second)
	defer checkCancel()
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-e", cleanFrom}); err != nil {
		return fmt.Errorf("source path does not exist: %s", cleanFrom)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-d", parent}); err != nil {
		return fmt.Errorf("target parent directory does not exist: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "-w", parent}); err != nil {
		return fmt.Errorf("target parent directory is not writable: %s", parent)
	}
	if _, err := execInContainer(checkCtx, c, containerID, []string{"test", "!", "-e", cleanTo}); err != nil {
		return fmt.Errorf("target path already exists: %s", cleanTo)
	}
	moveCtx, moveCancel := context.WithTimeout(ctx, 30*time.Second)
	defer moveCancel()
	if _, err := execInContainer(moveCtx, c, containerID, []string{"mv", cleanFrom, cleanTo}); err != nil {
		return fmt.Errorf("move path: %w", err)
	}
	return nil
}

// validatePath ensures the path is absolute and does not contain path traversal.
func validatePath(path string) error {
	if path == "" {
		return fmt.Errorf("path is required")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("path must be absolute: %s", path)
	}
	if hasParentTraversalSegment(path) {
		return fmt.Errorf("path must not contain '..': %s", path)
	}
	return nil
}

func hasParentTraversalSegment(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

func validateMutablePath(path string) error {
	if err := validatePath(path); err != nil {
		return err
	}
	if filepath.Clean(path) == "/" {
		return fmt.Errorf("cannot modify root directory")
	}
	return nil
}

func uploadTempPath(uploadID string, targetPath string) (string, string, error) {
	if err := validateUploadID(uploadID); err != nil {
		return "", "", err
	}
	if err := validateMutablePath(targetPath); err != nil {
		return "", "", err
	}
	cleanTarget := filepath.Clean(targetPath)
	parent := filepath.Dir(cleanTarget)
	return filepath.Join(parent, ".opfield-upload-"+uploadID+".tmp"), cleanTarget, nil
}

func validateUploadID(uploadID string) error {
	if len(uploadID) < 8 || len(uploadID) > 128 {
		return fmt.Errorf("invalid upload id")
	}
	for _, ch := range uploadID {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' {
			continue
		}
		return fmt.Errorf("invalid upload id")
	}
	return nil
}

func validateMovePaths(fromPath string, toPath string) (string, string, error) {
	if err := validateMutablePath(fromPath); err != nil {
		return "", "", err
	}
	if err := validateMutablePath(toPath); err != nil {
		return "", "", err
	}
	cleanFrom := filepath.Clean(fromPath)
	cleanTo := filepath.Clean(toPath)
	if cleanFrom == cleanTo {
		return "", "", fmt.Errorf("source and target paths are the same")
	}
	if cleanTo == cleanFrom || strings.HasPrefix(cleanTo, cleanFrom+"/") {
		return "", "", fmt.Errorf("cannot move a directory into itself")
	}
	return cleanFrom, cleanTo, nil
}

func splitDockerExecOutput(raw []byte) ([]byte, []byte) {
	if !isDockerMultiplexedStream(raw) {
		return raw, nil
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdoutBuf, &stderrBuf, bytes.NewReader(raw)); err == nil {
		return stdoutBuf.Bytes(), stderrBuf.Bytes()
	}

	// Some Docker paths return plain stdout without the multiplex header. In that
	// case the raw output is already the stdout payload.
	return raw, nil
}

func isDockerMultiplexedStream(raw []byte) bool {
	if len(raw) == 0 {
		return true
	}

	data := raw
	for len(data) > 0 {
		if len(data) < 8 {
			return false
		}
		if data[0] != 1 && data[0] != 2 {
			return false
		}
		frameSize := int(binary.BigEndian.Uint32(data[4:8]))
		data = data[8:]
		if frameSize > len(data) {
			return false
		}
		data = data[frameSize:]
	}
	return true
}

// execInContainerBytes runs a command inside a container and returns stdout as raw bytes.
// Returns an error if the command exits with a non-zero status.
func execInContainerBytes(ctx context.Context, c *Client, containerID string, cmd []string, maxRead int64) ([]byte, error) {
	return execInContainerBytesAsUser(ctx, c, containerID, cmd, "", maxRead)
}

func execInContainerBytesAsUser(ctx context.Context, c *Client, containerID string, cmd []string, user string, maxRead int64) ([]byte, error) {
	createResult, err := c.cli.ExecCreate(ctx, containerID, client.ExecCreateOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
		User:         user,
	})
	if err != nil {
		return nil, fmt.Errorf("exec create: %w", err)
	}

	attachResult, err := c.cli.ExecAttach(ctx, createResult.ID, client.ExecAttachOptions{})
	if err != nil {
		return nil, fmt.Errorf("exec attach: %w", err)
	}
	defer attachResult.Close()

	// Read all output with size limit to prevent OOM on unexpected large output.
	// The 8-byte Docker multiplex header per frame is stripped below.
	if maxRead <= 0 {
		maxRead = 10 * 1024 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(attachResult.Reader, maxRead))
	if err != nil {
		return nil, fmt.Errorf("exec read: %w", err)
	}

	stdout, stderr := splitDockerExecOutput(raw)

	// Check exit code
	inspResult, inspErr := c.cli.ExecInspect(ctx, createResult.ID, client.ExecInspectOptions{})
	if inspErr == nil && inspResult.ExitCode != 0 {
		errMsg := strings.TrimSpace(string(stderr))
		if errMsg == "" {
			errMsg = strings.TrimSpace(string(stdout))
		}
		if errMsg == "" {
			errMsg = fmt.Sprintf("command exited with code %d", inspResult.ExitCode)
		}
		return nil, fmt.Errorf("%s", errMsg)
	}

	return stdout, nil
}

// execInContainer runs a command inside a container and returns stdout as a string.
// Returns an error if the command exits with a non-zero status.
func execInContainer(ctx context.Context, c *Client, containerID string, cmd []string) (string, error) {
	stdout, err := execInContainerBytes(ctx, c, containerID, cmd, 10*1024*1024)
	if err != nil {
		return "", err
	}
	return string(stdout), nil
}

func execInContainerWithInput(ctx context.Context, c *Client, containerID string, cmd []string, input []byte) (string, error) {
	createResult, err := c.cli.ExecCreate(ctx, containerID, client.ExecCreateOptions{
		Cmd:          cmd,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return "", fmt.Errorf("exec create: %w", err)
	}

	attachResult, err := c.cli.ExecAttach(ctx, createResult.ID, client.ExecAttachOptions{})
	if err != nil {
		return "", fmt.Errorf("exec attach: %w", err)
	}
	defer attachResult.Close()

	writeErr := make(chan error, 1)
	go func() {
		_, err := attachResult.Conn.Write(input)
		if closeErr := attachResult.CloseWrite(); err == nil {
			err = closeErr
		}
		writeErr <- err
	}()

	const maxRead = 10 * 1024 * 1024
	raw, readErr := io.ReadAll(io.LimitReader(attachResult.Reader, maxRead))
	if err := <-writeErr; err != nil {
		return "", fmt.Errorf("exec write: %w", err)
	}
	if readErr != nil {
		return "", fmt.Errorf("exec read: %w", readErr)
	}

	stdout, stderr := splitDockerStream(raw)
	inspResult, inspErr := c.cli.ExecInspect(ctx, createResult.ID, client.ExecInspectOptions{})
	if inspErr == nil && inspResult.ExitCode != 0 {
		errMsg := strings.TrimSpace(stderr)
		if errMsg == "" {
			errMsg = strings.TrimSpace(stdout)
		}
		if errMsg == "" {
			errMsg = fmt.Sprintf("command exited with code %d", inspResult.ExitCode)
		}
		return "", fmt.Errorf("%s", errMsg)
	}

	return stdout, nil
}

func splitDockerStream(raw []byte) (string, string) {
	var stdoutBuf, stderrBuf bytes.Buffer
	data := raw
	for len(data) >= 8 {
		streamType := data[0]
		frameSize := int(data[4])<<24 | int(data[5])<<16 | int(data[6])<<8 | int(data[7])
		data = data[8:]
		if frameSize > len(data) {
			frameSize = len(data)
		}
		if streamType == 2 {
			stderrBuf.Write(data[:frameSize])
		} else {
			stdoutBuf.Write(data[:frameSize])
		}
		data = data[frameSize:]
	}
	return stdoutBuf.String(), stderrBuf.String()
}

// parseLsOutput parses the output of `ls -la --time-style=long-iso` into FileEntry structs.
// Example line: "drwxr-xr-x  2 root root 4096 2024-01-15 10:30 dirname"
func parseLsOutput(output string) []FileEntry {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	entries := make([]FileEntry, 0, len(lines))

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Skip the "total N" line
		if strings.HasPrefix(line, "total ") {
			continue
		}

		entry := parseLsLine(line)
		if entry == nil {
			continue
		}
		// Skip "." and ".." entries
		if entry.Name == "." || entry.Name == ".." {
			continue
		}
		entries = append(entries, *entry)
	}

	return entries
}

// parseLsLine parses a single line of ls -la output.
// Handles both GNU and BusyBox formats:
//
//	GNU:     -rw-r--r--  1 root root 12345 2024-01-15 10:30 filename.txt
//	BusyBox: -rw-r--r--  1 root root 12345 Apr  1 01:10 filename.txt
func parseLsLine(line string) *FileEntry {
	fields := strings.Fields(line)
	if len(fields) < 8 {
		return nil
	}

	permissions := fields[0]
	// Skip non-permission lines (e.g. "total 68" already filtered, but guard)
	if len(permissions) < 2 || !strings.ContainsAny(string(permissions[0]), "dlcbps-") {
		return nil
	}
	isDir := permissions[0] == 'd'

	size, _ := strconv.ParseInt(fields[4], 10, 64)

	// Determine where the filename starts.
	// Fields: 0=perms, 1=links, 2=owner, 3=group, 4=size, then date/time, then name.
	// BusyBox: "Apr  1 01:10" = 3 fields (5,6,7) → name starts at 8
	// GNU:     "2024-01-15 10:30" = 2 fields (5,6) → name starts at 7
	// Detect by checking if field[5] looks like a year (YYYY-MM-DD)
	nameStart := 8
	var modified string
	if len(fields[5]) == 10 && fields[5][4] == '-' {
		// GNU format: "2024-01-15 10:30"
		modified = fields[5] + " " + fields[6]
		nameStart = 7
	} else {
		// BusyBox format: "Apr  1 01:10" or "Apr  1  2024"
		if len(fields) < 9 {
			// Might be short — 8 fields with name at [8] doesn't exist
			// Try with nameStart=8 but check bounds
			modified = strings.Join(fields[5:8], " ")
			nameStart = 8
		} else {
			modified = strings.Join(fields[5:8], " ")
			nameStart = 8
		}
	}

	if nameStart >= len(fields) {
		return nil
	}

	// The name is everything from nameStart onwards (may contain spaces)
	name := strings.Join(fields[nameStart:], " ")

	isSymlink := permissions[0] == 'l'
	// Special files: char device (c), block device (b), socket (s), pipe (p)
	isSpecial := permissions[0] == 'c' || permissions[0] == 'b' || permissions[0] == 's' || permissions[0] == 'p'
	// Writable if owner, group, or other has write permission
	isWritable := len(permissions) >= 9 && (permissions[2] == 'w' || permissions[5] == 'w' || permissions[8] == 'w')
	var linkTarget string

	// Handle symlinks: "name -> target"
	if idx := strings.Index(name, " -> "); idx >= 0 {
		linkTarget = name[idx+4:]
		name = name[:idx]
	}

	return &FileEntry{
		Name:        name,
		Size:        size,
		Permissions: permissions,
		IsDir:       isDir,
		Modified:    modified,
		IsSymlink:   isSymlink,
		LinkTarget:  linkTarget,
		IsSpecial:   isSpecial,
		IsWritable:  isWritable && !isDir && !isSpecial && !isSymlink,
	}
}
