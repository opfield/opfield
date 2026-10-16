package docker

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"
)

// FileEntry describes a single file or directory inside a container.
type FileEntry struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Permissions string `json:"permissions"`
	IsDir       bool   `json:"isDir"`
	Modified    string `json:"modified"`
	IsSymlink   bool   `json:"isSymlink,omitempty"`
	LinkTarget  string `json:"linkTarget,omitempty"`
	IsSpecial   bool   `json:"isSpecial,omitempty"` // char/block device, socket, pipe
	IsWritable  bool   `json:"isWritable,omitempty"`
}

const volumeHelperImage = "busybox:latest"
const dockerFileUploadBlockBytes int64 = 65536

// ListDir lists the contents of a directory inside a container.
// The path must be absolute and must not contain "..".
func ListDir(ctx context.Context, c *Client, containerID string, path string) ([]FileEntry, error) {
	if err := validatePath(path); err != nil {
		return nil, err
	}

	// Use plain ls -la (works on GNU, BusyBox, Alpine, etc.)
	stdout, err := execInContainer(ctx, c, containerID, []string{"ls", "-la", path})
	if err != nil {
		return nil, fmt.Errorf("list dir: %w", err)
	}

	return parseLsOutput(stdout), nil
}

// ListVolumeDir lists a directory inside a Docker volume by mounting it into a short-lived helper container.
func ListVolumeDir(ctx context.Context, c *Client, volumeName string, path string) ([]FileEntry, error) {
	targetPath, err := volumeTargetPath(path)
	if err != nil {
		return nil, err
	}
	stdout, err := runVolumeHelper(ctx, c, volumeName, []string{"ls", "-la", targetPath}, 10*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("list volume dir: %w", err)
	}
	return parseLsOutput(string(stdout)), nil
}

// ExportVolume returns a gzip-compressed tar archive of the volume contents.
func ExportVolume(ctx context.Context, c *Client, volumeName string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = 512 * 1024 * 1024
	}
	if err := ensureVolumeHelperImage(ctx, c); err != nil {
		return nil, err
	}

	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	created, err := c.cli.ContainerCreate(createCtx, client.ContainerCreateOptions{
		Config: &container.Config{
			Image: volumeHelperImage,
			Cmd:   []string{"sleep", "60"},
		},
		HostConfig: &container.HostConfig{
			LogConfig: internalContainerLogConfig(),
			Mounts:    []mount.Mount{{Type: mount.TypeVolume, Source: volumeName, Target: "/volume", ReadOnly: true}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create export helper container: %w", err)
	}
	containerID := created.ID
	defer func() {
		_, _ = c.cli.ContainerRemove(context.Background(), containerID, client.ContainerRemoveOptions{Force: true})
	}()

	if _, err := c.cli.ContainerStart(ctx, containerID, client.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("start export helper container: %w", err)
	}

	archiveResult, err := c.cli.CopyFromContainer(ctx, containerID, client.CopyFromContainerOptions{SourcePath: "/volume/."})
	if err != nil {
		return nil, fmt.Errorf("archive volume: %w", err)
	}
	defer archiveResult.Content.Close()

	data, err := gzipTarArchive(archiveResult.Content, maxBytes)
	if err != nil {
		return nil, fmt.Errorf("export volume: %w", err)
	}
	return data, nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int64
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if int64(b.Len()+len(p)) > b.limit {
		return 0, fmt.Errorf("compressed archive exceeds maximum size of %d bytes", b.limit)
	}
	return b.Buffer.Write(p)
}

func gzipTarArchive(reader io.Reader, maxBytes int64) ([]byte, error) {
	out := &limitedBuffer{limit: maxBytes}
	zw := gzip.NewWriter(out)
	if _, err := io.Copy(zw, reader); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func ReadVolumeFile(ctx context.Context, c *Client, volumeName string, path string, maxBytes int64) ([]byte, error) {
	targetPath, err := volumeTargetPath(path)
	if err != nil {
		return nil, err
	}
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	if _, err := runVolumeHelper(ctx, c, volumeName, []string{"test", "-f", targetPath}, 1024); err != nil {
		return nil, fmt.Errorf("not a regular/readable file: %s", path)
	}
	if _, err := runVolumeHelper(ctx, c, volumeName, []string{"test", "-r", targetPath}, 1024); err != nil {
		return nil, fmt.Errorf("not a regular/readable file: %s", path)
	}
	content, err := readMountedVolumePathArchive(ctx, c, []mount.Mount{
		{Type: mount.TypeVolume, Source: volumeName, Target: "/volume", ReadOnly: true},
	}, targetPath, maxBytes)
	if err != nil {
		return nil, fmt.Errorf("read volume file: %w", err)
	}
	return content, nil
}

func WriteVolumeFile(ctx context.Context, c *Client, volumeName string, path string, content []byte) error {
	targetPath, err := mutableVolumeTargetPath(path)
	if err != nil {
		return err
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-f", targetPath}, 1024); err != nil {
		return fmt.Errorf("file is not writable: %s", path)
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-w", targetPath}, 1024); err != nil {
		return fmt.Errorf("file is not writable: %s", path)
	}
	if _, err := runWritableVolumeHelperWithInput(ctx, c, volumeName, dockerWriteFileCommand(targetPath), content, 1024*1024); err != nil {
		return fmt.Errorf("write volume file: %w", err)
	}
	return nil
}

func CreateVolumeFile(ctx context.Context, c *Client, volumeName string, path string, content []byte) error {
	targetPath, err := mutableVolumeTargetPath(path)
	if err != nil {
		return err
	}
	parent := filepath.Dir(targetPath)
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-d", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", filepath.Dir(filepath.Clean(path)))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-w", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", filepath.Dir(filepath.Clean(path)))
	}
	if _, err := runWritableVolumeHelperWithInput(ctx, c, volumeName, dockerWriteFileCommand(targetPath), content, 1024*1024); err != nil {
		return fmt.Errorf("create volume file: %w", err)
	}
	return nil
}

func CreateVolumeDirectory(ctx context.Context, c *Client, volumeName string, path string) error {
	targetPath, err := mutableVolumeTargetPath(path)
	if err != nil {
		return err
	}
	parent := filepath.Dir(targetPath)
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-d", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", filepath.Dir(filepath.Clean(path)))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-w", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", filepath.Dir(filepath.Clean(path)))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"mkdir", targetPath}, 1024); err != nil {
		return fmt.Errorf("create volume directory: %w", err)
	}
	return nil
}

func DeleteVolumePath(ctx context.Context, c *Client, volumeName string, path string) error {
	targetPath, err := mutableVolumeTargetPath(path)
	if err != nil {
		return err
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"rm", "-rf", targetPath}, 1024); err != nil {
		return fmt.Errorf("delete volume path: %w", err)
	}
	return nil
}

func MoveVolumePath(ctx context.Context, c *Client, volumeName string, fromPath string, toPath string) error {
	cleanFrom, cleanTo, err := validateMovePaths(fromPath, toPath)
	if err != nil {
		return err
	}
	targetFrom, err := volumeTargetPath(cleanFrom)
	if err != nil {
		return err
	}
	targetTo, err := volumeTargetPath(cleanTo)
	if err != nil {
		return err
	}
	parent := filepath.Dir(targetTo)
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-e", targetFrom}, 1024); err != nil {
		return fmt.Errorf("source path does not exist: %s", cleanFrom)
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-d", parent}, 1024); err != nil {
		return fmt.Errorf("target parent directory does not exist: %s", filepath.Dir(cleanTo))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-w", parent}, 1024); err != nil {
		return fmt.Errorf("target parent directory is not writable: %s", filepath.Dir(cleanTo))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "!", "-e", targetTo}, 1024); err != nil {
		return fmt.Errorf("target path already exists: %s", cleanTo)
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"mv", targetFrom, targetTo}, 1024); err != nil {
		return fmt.Errorf("move volume path: %w", err)
	}
	return nil
}

func InitVolumeChunkedFileUpload(ctx context.Context, c *Client, volumeName string, uploadID string, targetPath string, totalBytes int64) error {
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}
	tempPath, cleanTarget, err := volumeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	parent := filepath.Dir(cleanTarget)
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-d", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory does not exist: %s", filepath.Dir(filepath.Clean(targetPath)))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"test", "-w", parent}, 1024); err != nil {
		return fmt.Errorf("parent directory is not writable: %s", filepath.Dir(filepath.Clean(targetPath)))
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"rm", "-f", tempPath}, 1024); err != nil {
		return fmt.Errorf("remove stale upload temp file: %w", err)
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"touch", tempPath}, 1024); err != nil {
		return fmt.Errorf("create upload temp file: %w", err)
	}
	return nil
}

func WriteVolumeChunkedFileUpload(ctx context.Context, c *Client, volumeName string, uploadID string, targetPath string, offset int64, content []byte) error {
	tempPath, _, err := volumeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	command, err := dockerWriteFileChunkCommand(tempPath, offset)
	if err != nil {
		return err
	}
	if _, err := runWritableVolumeHelperWithInput(ctx, c, volumeName, command, content, 1024*1024); err != nil {
		return fmt.Errorf("write upload chunk: %w", err)
	}
	return nil
}

func CompleteVolumeChunkedFileUpload(ctx context.Context, c *Client, volumeName string, uploadID string, targetPath string, totalBytes int64) error {
	tempPath, cleanTarget, err := volumeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if totalBytes < 0 {
		return fmt.Errorf("total bytes must not be negative")
	}
	sizeText, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"stat", "-c", "%s", tempPath}, 1024)
	if err != nil {
		return fmt.Errorf("inspect upload temp file: %w", err)
	}
	size, err := strconv.ParseInt(strings.TrimSpace(string(sizeText)), 10, 64)
	if err != nil {
		return fmt.Errorf("parse upload temp file size: %w", err)
	}
	if size != totalBytes {
		return fmt.Errorf("upload size mismatch: expected %d bytes, got %d bytes", totalBytes, size)
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"mv", "-f", tempPath, cleanTarget}, 1024); err != nil {
		return fmt.Errorf("complete upload: %w", err)
	}
	return nil
}

func AbortVolumeChunkedFileUpload(ctx context.Context, c *Client, volumeName string, uploadID string, targetPath string) error {
	tempPath, _, err := volumeUploadTempPath(uploadID, targetPath)
	if err != nil {
		return err
	}
	if _, err := runWritableVolumeHelper(ctx, c, volumeName, []string{"rm", "-f", tempPath}, 1024); err != nil {
		return fmt.Errorf("abort upload: %w", err)
	}
	return nil
}

func CopyVolumeContents(ctx context.Context, c *Client, sourceVolume string, targetVolume string) error {
	if strings.TrimSpace(sourceVolume) == "" || strings.TrimSpace(targetVolume) == "" {
		return fmt.Errorf("source and target volume names are required")
	}
	_, err := runMountedVolumeHelper(ctx, c, []mount.Mount{
		{Type: mount.TypeVolume, Source: sourceVolume, Target: "/from", ReadOnly: true},
		{Type: mount.TypeVolume, Source: targetVolume, Target: "/to"},
	}, []string{"sh", "-c", "cp -a /from/. /to/"}, 10*1024*1024)
	if err != nil {
		return fmt.Errorf("copy volume contents: %w", err)
	}
	return nil
}

func volumeTargetPath(path string) (string, error) {
	if err := validatePath(path); err != nil {
		return "", err
	}
	cleaned := filepath.Clean(path)
	if cleaned == "/" {
		return "/volume", nil
	}
	return filepath.Join("/volume", strings.TrimPrefix(cleaned, "/")), nil
}

func mutableVolumeTargetPath(path string) (string, error) {
	if err := validateMutablePath(path); err != nil {
		return "", err
	}
	return volumeTargetPath(path)
}

func volumeUploadTempPath(uploadID string, targetPath string) (string, string, error) {
	if err := validateUploadID(uploadID); err != nil {
		return "", "", err
	}
	cleanTarget, err := mutableVolumeTargetPath(targetPath)
	if err != nil {
		return "", "", err
	}
	parent := filepath.Dir(cleanTarget)
	return filepath.Join(parent, ".opfield-upload-"+uploadID+".tmp"), cleanTarget, nil
}

func runVolumeHelper(ctx context.Context, c *Client, volumeName string, command []string, maxBytes int64) ([]byte, error) {
	return runVolumeHelperWithInput(ctx, c, volumeName, command, nil, maxBytes, true)
}

func runWritableVolumeHelper(ctx context.Context, c *Client, volumeName string, command []string, maxBytes int64) ([]byte, error) {
	return runVolumeHelperWithInput(ctx, c, volumeName, command, nil, maxBytes, false)
}

func runWritableVolumeHelperWithInput(ctx context.Context, c *Client, volumeName string, command []string, input []byte, maxBytes int64) ([]byte, error) {
	return runVolumeHelperWithInput(ctx, c, volumeName, command, input, maxBytes, false)
}

func runVolumeHelperWithInput(ctx context.Context, c *Client, volumeName string, command []string, input []byte, maxBytes int64, readOnly bool) ([]byte, error) {
	if strings.TrimSpace(volumeName) == "" {
		return nil, fmt.Errorf("volume name is required")
	}
	return runMountedVolumeHelperWithInput(ctx, c, []mount.Mount{
		{Type: mount.TypeVolume, Source: volumeName, Target: "/volume", ReadOnly: readOnly},
	}, command, input, maxBytes)
}

func runMountedVolumeHelper(ctx context.Context, c *Client, mounts []mount.Mount, command []string, maxBytes int64) ([]byte, error) {
	return runMountedVolumeHelperWithInput(ctx, c, mounts, command, nil, maxBytes)
}

func runMountedVolumeHelperWithInput(ctx context.Context, c *Client, mounts []mount.Mount, command []string, input []byte, maxBytes int64) ([]byte, error) {
	if err := ensureVolumeHelperImage(ctx, c); err != nil {
		return nil, err
	}

	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	created, err := c.cli.ContainerCreate(createCtx, client.ContainerCreateOptions{
		Config: &container.Config{
			Image:        volumeHelperImage,
			Cmd:          command,
			AttachStdout: true,
			AttachStderr: true,
			AttachStdin:  input != nil,
			OpenStdin:    input != nil,
			StdinOnce:    input != nil,
		},
		HostConfig: &container.HostConfig{
			LogConfig: internalContainerLogConfig(),
			Mounts:    mounts,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create helper container: %w", err)
	}
	containerID := created.ID
	defer func() {
		_, _ = c.cli.ContainerRemove(context.Background(), containerID, client.ContainerRemoveOptions{Force: true})
	}()

	var attachResp client.ContainerAttachResult
	if input != nil {
		attachCtx, attachCancel := context.WithTimeout(ctx, 30*time.Second)
		defer attachCancel()
		var err error
		attachResp, err = c.cli.ContainerAttach(attachCtx, containerID, client.ContainerAttachOptions{
			Stream: true,
			Stdin:  true,
		})
		if err != nil {
			return nil, fmt.Errorf("attach helper container stdin: %w", err)
		}
		defer attachResp.Close()
	}

	if _, err := c.cli.ContainerStart(ctx, containerID, client.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("start helper container: %w", err)
	}

	if input != nil {
		go func() {
			_, _ = attachResp.Conn.Write(input)
			_ = attachResp.CloseWrite()
		}()
	}

	wait := c.cli.ContainerWait(ctx, containerID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case err := <-wait.Error:
		if err != nil {
			return nil, fmt.Errorf("wait helper container: %w", err)
		}
	case response := <-wait.Result:
		logs, stderr, logErr := readContainerLogs(ctx, c, containerID, maxBytes)
		if response.StatusCode != 0 {
			if logErr != nil {
				return nil, fmt.Errorf("helper container exited with status %d", response.StatusCode)
			}
			message := strings.TrimSpace(stderr)
			if message == "" {
				message = strings.TrimSpace(string(logs))
			}
			return nil, fmt.Errorf("helper container exited with status %d: %s", response.StatusCode, message)
		}
		return logs, logErr
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	logs, _, err := readContainerLogs(ctx, c, containerID, maxBytes)
	return logs, err
}

func readMountedVolumePathArchive(ctx context.Context, c *Client, mounts []mount.Mount, targetPath string, maxBytes int64) ([]byte, error) {
	if err := ensureVolumeHelperImage(ctx, c); err != nil {
		return nil, err
	}

	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	created, err := c.cli.ContainerCreate(createCtx, client.ContainerCreateOptions{
		Config: &container.Config{
			Image: volumeHelperImage,
			Cmd:   []string{"sleep", "60"},
		},
		HostConfig: &container.HostConfig{
			LogConfig: internalContainerLogConfig(),
			Mounts:    mounts,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create archive helper container: %w", err)
	}
	containerID := created.ID
	defer func() {
		_, _ = c.cli.ContainerRemove(context.Background(), containerID, client.ContainerRemoveOptions{Force: true})
	}()

	if _, err := c.cli.ContainerStart(ctx, containerID, client.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("start archive helper container: %w", err)
	}

	archiveResult, err := c.cli.CopyFromContainer(ctx, containerID, client.CopyFromContainerOptions{SourcePath: targetPath})
	if err != nil {
		return nil, fmt.Errorf("archive path: %w", err)
	}
	archive := archiveResult.Content
	defer archive.Close()

	return readSingleRegularFileFromTar(archive, maxBytes)
}

func readSingleRegularFileFromTar(reader io.Reader, maxBytes int64) ([]byte, error) {
	tr := tar.NewReader(reader)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("archive did not contain a regular file")
		}
		if err != nil {
			return nil, fmt.Errorf("read archive: %w", err)
		}
		if header.FileInfo().IsDir() {
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return nil, fmt.Errorf("not a regular file")
		}
		if maxBytes <= 0 {
			maxBytes = 1024 * 1024
		}
		var out bytes.Buffer
		if _, err := io.CopyN(&out, tr, maxBytes); err != nil && err != io.EOF {
			return nil, fmt.Errorf("read archived file: %w", err)
		}
		return out.Bytes(), nil
	}
}

func ensureVolumeHelperImage(ctx context.Context, c *Client) error {
	if _, err := c.cli.ImageInspect(ctx, volumeHelperImage); err == nil {
		return nil
	}
	resp, err := c.cli.ImagePull(ctx, volumeHelperImage, client.ImagePullOptions{})
	if err != nil {
		return fmt.Errorf("pull helper image %s: %w", volumeHelperImage, err)
	}
	defer resp.Close()
	_, _ = io.Copy(io.Discard, resp)
	return nil
}
