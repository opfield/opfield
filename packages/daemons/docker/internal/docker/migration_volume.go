package docker

import (
	"archive/tar"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"
	mobyclient "github.com/moby/moby/client"
	"github.com/zeebo/blake3"
	"golang.org/x/sys/unix"
)

type migrationVolumeImportRequest struct {
	VolumeName             string            `json:"volumeName"`
	Labels                 map[string]string `json:"labels"`
	ExpectedArtifactDigest string            `json:"expectedArtifactDigest"`
	ExpectedLogicalDigest  string            `json:"expectedLogicalDigest"`
	ExpectedEntryCount     int64             `json:"expectedEntryCount"`
	ExpectedContentBytes   int64             `json:"expectedContentBytes"`
}

type migrationVolumeEntry struct {
	Path    string
	Kind    byte
	Mode    uint32
	UID     int
	GID     int
	ModTime int64
	Size    int64
	Link    string
}

func (p *DockerPlugin) prepareMigrationVolume(ctx context.Context, migrationID, artifactID, volumeName string) (migrationArtifactMetadata, error) {
	if err := requireVolumeDataAccess("exporting a volume for migration"); err != nil {
		return migrationArtifactMetadata{}, err
	}
	volume, err := p.client.cli.VolumeInspect(ctx, volumeName, mobyclient.VolumeInspectOptions{})
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("inspect migration volume: %w", err)
	}
	if err := migratableLocalVolume(volume.Volume); err != nil {
		return migrationArtifactMetadata{}, err
	}
	path, err := p.migrationStore.artifactPath(migrationID, artifactID, true)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	if err := p.migrationStore.checkSpace(0); err != nil {
		return migrationArtifactMetadata{}, err
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("create volume artifact: %w", err)
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(tmp)
		}
	}()

	artifactHasher := blake3.New()
	// The archive's size is known only once it is written: the reserve check stops it mid-stream.
	spool := &guardedSpoolWriter{writer: file, guard: p.migrationStore.guard(migrationID, 0)}
	encoder, err := zstd.NewWriter(io.MultiWriter(spool, artifactHasher), zstd.WithEncoderLevel(zstd.SpeedFastest), zstd.WithEncoderConcurrency(1))
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("create zstd volume encoder: %w", err)
	}
	tarWriter := tar.NewWriter(encoder)
	logicalHasher := blake3.New()
	entryCount, contentBytes, err := archiveMigrationTree(volume.Volume.Mountpoint, tarWriter, logicalHasher)
	if err == nil {
		err = tarWriter.Close()
	} else {
		_ = tarWriter.Close()
	}
	if closeErr := encoder.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("archive migration volume: %w", err)
	}
	if err := file.Sync(); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("fsync migration volume artifact: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("stat migration volume artifact: %w", err)
	}
	if err := file.Close(); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("close migration volume artifact: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("commit migration volume artifact: %w", err)
	}
	committed = true
	meta := migrationArtifactMetadata{
		ArtifactID: artifactID, ArtifactType: "volume", SizeBytes: info.Size(),
		ArtifactDigest: hex.EncodeToString(artifactHasher.Sum(nil)), LogicalDigest: hex.EncodeToString(logicalHasher.Sum(nil)),
		EntryCount: entryCount, ContentBytes: contentBytes, Complete: true,
	}
	if err := p.migrationStore.saveMetadata(migrationID, meta); err != nil {
		return migrationArtifactMetadata{}, err
	}
	return meta, nil
}

func archiveMigrationTree(root string, writer *tar.Writer, logical io.Writer) (int64, int64, error) {
	var entryCount, contentBytes int64
	hardlinks := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if unsupported, err := hasUnsupportedMigrationXattrs(path); err == nil && unsupported {
			return fmt.Errorf("extended attributes or ACLs are not supported: %s", rel)
		} else if err != nil && err != unix.ENOTSUP {
			return fmt.Errorf("inspect extended attributes for %s: %w", rel, err)
		}
		kind, err := migrationEntryKind(info.Mode())
		if err != nil {
			return fmt.Errorf("%s: %w", rel, err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("read ownership metadata for %s", rel)
		}
		link := ""
		if kind == 'l' {
			link, err = os.Readlink(path)
			if err != nil {
				return err
			}
		}
		if kind == 'f' && stat.Nlink > 1 {
			key := migrationInodeKey(stat)
			if first, ok := hardlinks[key]; ok {
				kind = 'h'
				link = first
			} else {
				hardlinks[key] = rel
			}
		}
		size := int64(0)
		if kind == 'f' {
			size = info.Size()
		}
		mode := uint32(info.Mode().Perm())
		if kind == 'l' {
			// Symlink permission bits are ignored by Linux and cannot be restored
			// portably. Canonicalize them while preserving ownership and mtime.
			mode = 0777
		}
		evidence := migrationVolumeEntry{Path: rel, Kind: kind, Mode: mode, UID: int(stat.Uid), GID: int(stat.Gid), ModTime: info.ModTime().UnixNano(), Size: size, Link: link}
		if err := writeMigrationEvidence(logical, evidence); err != nil {
			return err
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = rel
		header.Format = tar.FormatPAX
		if kind == 'h' {
			header.Typeflag = tar.TypeLink
			header.Linkname = link
			header.Size = 0
		}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if kind == 'f' {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			n, copyErr := io.Copy(io.MultiWriter(writer, logical), file)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			contentBytes += n
		}
		entryCount++
		return nil
	})
	return entryCount, contentBytes, err
}

func hasUnsupportedMigrationXattrs(path string) (bool, error) {
	size, err := unix.Llistxattr(path, nil)
	if err != nil || size == 0 {
		return false, err
	}
	buf := make([]byte, size)
	n, err := unix.Llistxattr(path, buf)
	if err != nil {
		return false, err
	}
	for _, name := range strings.Split(string(buf[:n]), "\x00") {
		if name == "" {
			continue
		}
		// macOS attaches this non-portable provenance marker to every test-created
		// file. Docker daemons are Linux workloads; ignore only that host marker so
		// cross-platform unit tests still exercise the archive logic.
		if runtime.GOOS == "darwin" && name == "com.apple.provenance" {
			continue
		}
		return true, nil
	}
	return false, nil
}

func (p *DockerPlugin) importMigrationVolume(ctx context.Context, migrationID, artifactID, configJSON string) (migrationArtifactMetadata, error) {
	if err := requireVolumeDataAccess("importing a migrated volume"); err != nil {
		return migrationArtifactMetadata{}, err
	}
	var req migrationVolumeImportRequest
	if err := json.Unmarshal([]byte(configJSON), &req); err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("parse volume import request: %w", err)
	}
	if req.VolumeName == "" || req.ExpectedArtifactDigest == "" || req.ExpectedLogicalDigest == "" {
		return migrationArtifactMetadata{}, fmt.Errorf("volume identity and expected digests are required")
	}
	if meta, err := p.migrationStore.query(migrationID, artifactID); err == nil && meta.Complete &&
		meta.ArtifactDigest == req.ExpectedArtifactDigest && meta.LogicalDigest == req.ExpectedLogicalDigest &&
		meta.EntryCount == req.ExpectedEntryCount && meta.ContentBytes == req.ExpectedContentBytes {
		return meta, nil
	}
	volume, err := p.client.cli.VolumeInspect(ctx, req.VolumeName, mobyclient.VolumeInspectOptions{})
	if isNotFoundErr(err) {
		created, createErr := p.client.cli.VolumeCreate(ctx, mobyclient.VolumeCreateOptions{Name: req.VolumeName, Driver: "local", Labels: req.Labels})
		err = createErr
		volume.Volume = created.Volume
	}
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("prepare target migration volume: %w", err)
	}
	if volume.Volume.Driver != "local" || volume.Volume.Mountpoint == "" {
		return migrationArtifactMetadata{}, fmt.Errorf("target volume must use the local driver")
	}
	empty, err := directoryEmpty(volume.Volume.Mountpoint)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	if !empty {
		return migrationArtifactMetadata{}, fmt.Errorf("target volume is not empty")
	}
	path, err := p.migrationStore.artifactPath(migrationID, artifactID, false)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("open migration volume artifact: %w", err)
	}
	defer file.Close()
	artifactHasher := blake3.New()
	decoder, err := zstd.NewReader(io.TeeReader(file, artifactHasher), zstd.WithDecoderConcurrency(1))
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("open migration volume archive: %w", err)
	}
	entries, logicalDigest, entryCount, contentBytes, err := extractMigrationTree(volume.Volume.Mountpoint, tar.NewReader(decoder))
	if err == nil {
		_, err = io.Copy(io.Discard, decoder)
	}
	decoder.Close()
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	artifactDigest := hex.EncodeToString(artifactHasher.Sum(nil))
	if artifactDigest != req.ExpectedArtifactDigest || logicalDigest != req.ExpectedLogicalDigest ||
		entryCount != req.ExpectedEntryCount || contentBytes != req.ExpectedContentBytes {
		return migrationArtifactMetadata{}, fmt.Errorf("target volume evidence mismatch")
	}
	if err := verifyMigrationMetadata(volume.Volume.Mountpoint, entries); err != nil {
		return migrationArtifactMetadata{}, err
	}
	if err := fsyncMigrationTree(volume.Volume.Mountpoint); err != nil {
		return migrationArtifactMetadata{}, err
	}
	info, err := file.Stat()
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	meta := migrationArtifactMetadata{ArtifactID: artifactID, ArtifactType: "volume", SizeBytes: info.Size(), ArtifactDigest: artifactDigest, LogicalDigest: logicalDigest, EntryCount: entryCount, ContentBytes: contentBytes, Complete: true}
	if err := p.migrationStore.saveMetadata(migrationID, meta); err != nil {
		return migrationArtifactMetadata{}, err
	}
	return meta, nil
}

func extractMigrationTree(root string, reader *tar.Reader) ([]migrationVolumeEntry, string, int64, int64, error) {
	hasher := blake3.New()
	var entries []migrationVolumeEntry
	var contentBytes int64
	seen := map[string]bool{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", 0, 0, fmt.Errorf("read migration volume archive: %w", err)
		}
		clean := filepath.Clean(filepath.FromSlash(header.Name))
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, "", 0, 0, fmt.Errorf("unsafe migration archive path")
		}
		if seen[clean] {
			return nil, "", 0, 0, fmt.Errorf("duplicate migration archive path")
		}
		seen[clean] = true
		target := filepath.Join(root, clean)
		if err := ensureMigrationParentsSafe(root, target); err != nil {
			return nil, "", 0, 0, err
		}
		kind, err := migrationTarKind(header.Typeflag)
		if err != nil {
			return nil, "", 0, 0, fmt.Errorf("%s: %w", header.Name, err)
		}
		entry := migrationVolumeEntry{Path: filepath.ToSlash(clean), Kind: kind, Mode: uint32(header.Mode) & 0777, UID: header.Uid, GID: header.Gid, ModTime: header.ModTime.UnixNano(), Size: header.Size, Link: header.Linkname}
		if err := writeMigrationEvidence(hasher, entry); err != nil {
			return nil, "", 0, 0, err
		}
		switch kind {
		case 'd':
			err = os.MkdirAll(target, fs.FileMode(entry.Mode))
		case 'l':
			if err = os.MkdirAll(filepath.Dir(target), 0700); err == nil {
				err = os.Symlink(entry.Link, target)
			}
		case 'h':
			linkPath, linkErr := safeMigrationArchiveLink(root, entry.Link)
			if linkErr != nil {
				err = linkErr
			} else if err = os.MkdirAll(filepath.Dir(target), 0700); err == nil {
				err = os.Link(linkPath, target)
			}
		case 'f':
			if err = os.MkdirAll(filepath.Dir(target), 0700); err == nil {
				var file *os.File
				file, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, fs.FileMode(entry.Mode))
				if err == nil {
					var n int64
					n, err = io.CopyN(io.MultiWriter(file, hasher), reader, header.Size)
					contentBytes += n
					if err == nil {
						err = file.Sync()
					}
					if closeErr := file.Close(); err == nil {
						err = closeErr
					}
				}
			}
		}
		if err != nil {
			return nil, "", 0, 0, fmt.Errorf("extract %s: %w", header.Name, err)
		}
		entries = append(entries, entry)
	}
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		target := filepath.Join(root, filepath.FromSlash(entry.Path))
		if err := os.Lchown(target, entry.UID, entry.GID); err != nil {
			return nil, "", 0, 0, fmt.Errorf("restore ownership for %s: %w", entry.Path, err)
		}
		if entry.Kind != 'l' {
			if err := os.Chmod(target, fs.FileMode(entry.Mode)); err != nil {
				return nil, "", 0, 0, fmt.Errorf("restore mode for %s: %w", entry.Path, err)
			}
			stamp := time.Unix(0, entry.ModTime)
			if err := os.Chtimes(target, stamp, stamp); err != nil {
				return nil, "", 0, 0, fmt.Errorf("restore mtime for %s: %w", entry.Path, err)
			}
		} else {
			stamp := unix.NsecToTimespec(entry.ModTime)
			if err := unix.UtimesNanoAt(unix.AT_FDCWD, target, []unix.Timespec{stamp, stamp}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return nil, "", 0, 0, fmt.Errorf("restore symlink mtime for %s: %w", entry.Path, err)
			}
		}
	}
	return entries, hex.EncodeToString(hasher.Sum(nil)), int64(len(entries)), contentBytes, nil
}

func migrationEntryKind(mode fs.FileMode) (byte, error) {
	switch {
	case mode.IsRegular():
		return 'f', nil
	case mode.IsDir():
		return 'd', nil
	case mode&os.ModeSymlink != 0:
		return 'l', nil
	default:
		return 0, fmt.Errorf("special filesystem entries are not supported")
	}
}

func migrationTarKind(flag byte) (byte, error) {
	switch flag {
	case tar.TypeReg, tar.TypeRegA:
		return 'f', nil
	case tar.TypeDir:
		return 'd', nil
	case tar.TypeSymlink:
		return 'l', nil
	case tar.TypeLink:
		return 'h', nil
	default:
		return 0, fmt.Errorf("special archive entries are not supported")
	}
}

func writeMigrationEvidence(writer io.Writer, entry migrationVolumeEntry) error {
	for _, value := range []any{uint32(len(entry.Path)), entry.Kind, entry.Mode, int64(entry.UID), int64(entry.GID), entry.ModTime, entry.Size, uint32(len(entry.Link))} {
		if err := binary.Write(writer, binary.LittleEndian, value); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(writer, entry.Path); err != nil {
		return err
	}
	_, err := io.WriteString(writer, entry.Link)
	return err
}

func directoryEmpty(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open target volume: %w", err)
	}
	defer file.Close()
	_, err = file.Readdirnames(1)
	if err == io.EOF {
		return true, nil
	}
	return false, err
}
