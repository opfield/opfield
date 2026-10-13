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
)

const migrationArtifactMaxAge = 72 * time.Hour

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
	return nil
}

func (s *migrationArtifactStore) cleanupStale(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return fmt.Errorf("read migration artifact root: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !migrationPathID.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("stat migration directory %q: %w", entry.Name(), err)
		}
		if now.Sub(info.ModTime()) <= migrationArtifactMaxAge {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.root, entry.Name())); err != nil {
			return fmt.Errorf("remove stale migration %q: %w", entry.Name(), err)
		}
	}
	return nil
}
