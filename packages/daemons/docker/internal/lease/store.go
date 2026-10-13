package lease

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

// FileStore is the durable availabilitylease.Store of a docker daemon: one
// JSON file in the state directory, replaced atomically and fsynced (file
// and directory) before Apply returns, so a promised ballot is on disk
// before any reply leaves (A3).
type FileStore struct {
	mu      sync.Mutex
	path    string
	records map[string][]byte
}

var _ availabilitylease.Store = (*FileStore)(nil)

// OpenFileStore loads the store at path, creating its directory.
func OpenFileStore(path string) (*FileStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create lease state directory: %w", err)
	}
	store := &FileStore{path: path, records: map[string][]byte{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read lease state: %w", err)
	}
	if err := json.Unmarshal(data, &store.records); err != nil {
		// A corrupt store must not silently restart from zero ballots; the
		// operator renames it, and the node then abstains as a fresh
		// acceptor with an incarnation above the wall-clock floor (A3).
		return nil, fmt.Errorf("decode lease state %s: %w", path, err)
	}
	if store.records == nil {
		store.records = map[string][]byte{}
	}
	return store, nil
}

func (s *FileStore) Load() (map[string][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string][]byte, len(s.records))
	for key, value := range s.records {
		out[key] = append([]byte(nil), value...)
	}
	return out, nil
}

func (s *FileStore) Apply(puts map[string][]byte, deletes []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[string][]byte, len(s.records)+len(puts))
	for key, value := range s.records {
		next[key] = value
	}
	for _, key := range deletes {
		delete(next, key)
	}
	for key, value := range puts {
		next[key] = append([]byte(nil), value...)
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := writeDurable(s.path, data); err != nil {
		return err
	}
	s.records = next
	return nil
}

func writeDurable(path string, data []byte) error {
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".lease-state-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
