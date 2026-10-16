package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"golang.org/x/sys/unix"
)

// migrationArtifactMaxAge: the spool of a migration nothing touched for this long is abandoned (Opfield finalizes or
// aborts a migration it runs; a running one writes, reads or queries its artifacts all the time).
const migrationArtifactMaxAge = 6 * time.Hour

// migrationSpaceCheckBytes: a spool write checks the free space after every this many bytes.
const migrationSpaceCheckBytes = 64 << 20

var migrationPathID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type migrationArtifactMetadata struct {
	ArtifactID     string   `json:"artifactId"`
	ArtifactType   string   `json:"artifactType"`
	SizeBytes      int64    `json:"sizeBytes"`
	ArtifactDigest string   `json:"artifactDigest,omitempty"`
	LogicalDigest  string   `json:"logicalDigest,omitempty"`
	EntryCount     int64    `json:"entryCount,omitempty"`
	ContentBytes   int64    `json:"contentBytes,omitempty"`
	ImageID        string   `json:"imageId,omitempty"`
	ImageTags      []string `json:"imageTags,omitempty"`
	Complete       bool     `json:"complete"`
}

type migrationArtifactStore struct {
	root string
	mu   sync.Mutex
	// reserve is the free space a spool write never takes (the node disk reserve of managed instances); 0 checks
	// only that the disk is not full.
	reserve int64
	statfs  func(string, *unix.Statfs_t) error
	// removeAll is os.RemoveAll (tests replace it).
	removeAll func(string) error

	activeMu sync.Mutex
	// active is when this process last read, wrote or queried each migration's spool: a transfer reading one large
	// artifact changes no file time.
	active map[string]time.Time
}

// migrationSpoolSpaceError is a spool write refused or stopped because the node disk would fall below its reserve.
type migrationSpoolSpaceError struct {
	Free, Reserve, Needed int64
}

func (e *migrationSpoolSpaceError) Error() string {
	if e.Needed > 0 {
		return fmt.Sprintf("the migration spool needs %s and the node's disk has %s free, of which %s stays in reserve",
			formatDiskBytes(e.Needed), formatDiskBytes(e.Free), formatDiskBytes(e.Reserve))
	}
	return fmt.Sprintf("the migration spool stopped: the node's disk has %s free and %s stays in reserve",
		formatDiskBytes(e.Free), formatDiskBytes(e.Reserve))
}

// checkSpace refuses a spool write of needed more bytes (0: any more) that would leave less than the reserve free.
// A disk whose free space cannot be read is not refused.
func (s *migrationArtifactStore) checkSpace(needed int64) error {
	statfs := s.statfs
	if statfs == nil {
		statfs = unix.Statfs
	}
	var stat unix.Statfs_t
	if err := statfs(s.root, &stat); err != nil {
		return nil
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	reserve := s.reserve
	if reserve < 0 {
		reserve = 0
	}
	if free-needed <= reserve {
		return &migrationSpoolSpaceError{Free: free, Reserve: reserve, Needed: needed}
	}
	return nil
}

// touch records that the migration's spool is in use now.
func (s *migrationArtifactStore) touch(migrationID string) {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	if s.active == nil {
		s.active = map[string]time.Time{}
	}
	s.active[migrationID] = time.Now()
}

func (s *migrationArtifactStore) lastActive(migrationID string) time.Time {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	return s.active[migrationID]
}

func (s *migrationArtifactStore) forget(migrationID string) {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	delete(s.active, migrationID)
}

// migrationSpoolGuard stops a spool write that would take the node disk below its reserve, or that grows past limit
// (0: no limit), the size the artifact may reach by what it declared.
type migrationSpoolGuard struct {
	store       *migrationArtifactStore
	migrationID string
	limit       int64
	written     int64
	unchecked   int64
}

func (g *migrationSpoolGuard) admit(n int) error {
	g.written += int64(n)
	g.unchecked += int64(n)
	if g.limit > 0 && g.written > g.limit {
		return fmt.Errorf("the migration artifact grew past %s, more than its declared size allows", formatDiskBytes(g.limit))
	}
	if g.unchecked < migrationSpaceCheckBytes {
		return nil
	}
	g.unchecked = 0
	g.store.touch(g.migrationID)
	return g.store.checkSpace(0)
}

// guardedSpoolWriter writes through a migrationSpoolGuard.
type guardedSpoolWriter struct {
	writer io.Writer
	guard  *migrationSpoolGuard
}

func (w *guardedSpoolWriter) Write(data []byte) (int, error) {
	if err := w.guard.admit(len(data)); err != nil {
		return 0, err
	}
	return w.writer.Write(data)
}

func (s *migrationArtifactStore) guard(migrationID string, limit int64) *migrationSpoolGuard {
	return &migrationSpoolGuard{store: s, migrationID: migrationID, limit: limit}
}

// migrationArtifactLimit is the most an artifact of a declared size may take: room for archive overhead.
func migrationArtifactLimit(declared int64) int64 {
	if declared <= 0 {
		return 0
	}
	return declared + declared/2 + 256<<20
}

func (p *DockerPlugin) runMigrationArtifactCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if err := p.migrationStore.cleanupStale(now); err != nil {
				p.logger.Warn("stale migration artifact cleanup failed", "error", err)
			}
		}
	}
}

func newMigrationArtifactStore(stateDir string) (*migrationArtifactStore, error) {
	root := filepath.Join(stateDir, "migrations")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create migration artifact root: %w", err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		return nil, fmt.Errorf("secure migration artifact root: %w", err)
	}
	return &migrationArtifactStore{root: root}, nil
}

func validateMigrationPathID(kind, value string) error {
	if !migrationPathID.MatchString(value) {
		return fmt.Errorf("invalid %s", kind)
	}
	return nil
}

func (s *migrationArtifactStore) migrationDir(migrationID string, create bool) (string, error) {
	if err := validateMigrationPathID("migration id", migrationID); err != nil {
		return "", err
	}
	dir := filepath.Join(s.root, migrationID)
	s.touch(migrationID)
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return "", fmt.Errorf("create migration directory: %w", err)
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return "", fmt.Errorf("secure migration directory: %w", err)
		}
	}
	return dir, nil
}

func (s *migrationArtifactStore) artifactPath(migrationID, artifactID string, create bool) (string, error) {
	if err := validateMigrationPathID("artifact id", artifactID); err != nil {
		return "", err
	}
	dir, err := s.migrationDir(migrationID, create)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, artifactID), nil
}

func (s *migrationArtifactStore) heartbeat(migrationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.migrationDir(migrationID, true)
	if err != nil {
		return err
	}
	now := time.Now()
	return os.Chtimes(dir, now, now)
}

func (s *migrationArtifactStore) query(migrationID, artifactID string) (migrationArtifactMetadata, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.artifactPath(migrationID, artifactID, false)
	if err != nil {
		return migrationArtifactMetadata{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return migrationArtifactMetadata{}, fmt.Errorf("stat migration artifact: %w", err)
	}
	meta := migrationArtifactMetadata{ArtifactID: artifactID, SizeBytes: info.Size()}
	data, err := os.ReadFile(path + ".meta.json")
	if err == nil {
		if err := json.Unmarshal(data, &meta); err != nil {
			return migrationArtifactMetadata{}, fmt.Errorf("decode artifact metadata: %w", err)
		}
		meta.SizeBytes = info.Size()
	} else if !errors.Is(err, os.ErrNotExist) {
		return migrationArtifactMetadata{}, fmt.Errorf("read artifact metadata: %w", err)
	}
	return meta, nil
}

func (s *migrationArtifactStore) saveMetadata(migrationID string, meta migrationArtifactMetadata) error {
	path, err := s.artifactPath(migrationID, meta.ArtifactID, true)
	if err != nil {
		return err
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("encode artifact metadata: %w", err)
	}
	if err := atomicfile.WriteFile(path+".meta.json", data, 0600); err != nil {
		return fmt.Errorf("write artifact metadata: %w", err)
	}
	return nil
}

func (s *migrationArtifactStore) openRead(migrationID, artifactID string, offset int64) (*os.File, int64, error) {
	if offset < 0 {
		return nil, 0, fmt.Errorf("artifact offset must be non-negative")
	}
	path, err := s.artifactPath(migrationID, artifactID, false)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, fmt.Errorf("open migration artifact: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, fmt.Errorf("stat migration artifact: %w", err)
	}
	if offset > info.Size() {
		_ = f.Close()
		return nil, 0, fmt.Errorf("artifact offset %d exceeds size %d", offset, info.Size())
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, 0, fmt.Errorf("seek migration artifact: %w", err)
	}
	return f, info.Size(), nil
}

func (s *migrationArtifactStore) openWrite(migrationID, artifactID string, offset int64) (*os.File, error) {
	if offset < 0 {
		return nil, fmt.Errorf("artifact offset must be non-negative")
	}
	path, err := s.artifactPath(migrationID, artifactID, true)
	if err != nil {
		return nil, err
	}
	if err := s.checkSpace(0); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open migration artifact for write: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat migration artifact: %w", err)
	}
	if info.Size() != offset {
		_ = f.Close()
		return nil, fmt.Errorf("artifact resume offset mismatch: requested %d, current %d", offset, info.Size())
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("seek migration artifact: %w", err)
	}
	return f, nil
}

func (s *migrationArtifactStore) remove(migrationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.migrationDir(migrationID, false)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove migration artifacts: %w", err)
	}
	s.forget(migrationID)
	return nil
}

// cleanupStale removes the spools of abandoned migrations: nothing in this process used one for
// migrationArtifactMaxAge and none of its files changed for as long. One that cannot be removed does not stop the
// others.
func (s *migrationArtifactStore) cleanupStale(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return fmt.Errorf("read migration artifact root: %w", err)
	}
	var errs []error
	for _, entry := range entries {
		if !entry.IsDir() || !migrationPathID.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(s.root, entry.Name())
		latest, err := latestModTime(dir)
		if err != nil {
			errs = append(errs, fmt.Errorf("stat migration directory %q: %w", entry.Name(), err))
			continue
		}
		if active := s.lastActive(entry.Name()); active.After(latest) {
			latest = active
		}
		if now.Sub(latest) <= migrationArtifactMaxAge {
			continue
		}
		removeAll := s.removeAll
		if removeAll == nil {
			removeAll = os.RemoveAll
		}
		if err := removeAll(dir); err != nil {
			errs = append(errs, fmt.Errorf("remove stale migration %q: %w", entry.Name(), err))
			continue
		}
		s.forget(entry.Name())
	}
	return errors.Join(errs...)
}

// latestModTime is the newest modification time of a migration directory and the files in it.
func latestModTime(dir string) (time.Time, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return time.Time{}, err
	}
	latest := info.ModTime()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return time.Time{}, err
	}
	for _, entry := range entries {
		if entryInfo, err := entry.Info(); err == nil && entryInfo.ModTime().After(latest) {
			latest = entryInfo.ModTime()
		}
	}
	return latest, nil
}
