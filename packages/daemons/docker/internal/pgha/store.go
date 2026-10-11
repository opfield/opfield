package pgha

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// State is what the engine keeps about its member across restarts, next to
// the runtime's own file (the lease library persists the certified value).
type State struct {
	// DataEpoch counts rewinds, rebuilds and seeds of the data directory: a
	// previous holder whose data was replaced since it held is not eligible
	// by the previous-holder rule (AS6).
	DataEpoch uint64 `json:"dataEpoch"`
	// HeldDataEpoch is DataEpoch when this member last took the primary role.
	HeldDataEpoch uint64 `json:"heldDataEpoch"`
	// RebuildKept: a rebuild kept the previous data directory; it is dropped
	// once the new one streams.
	RebuildKept bool `json:"rebuildKept,omitempty"`
	// NeedsRebuild: a real pg_rewind began and failed part-way, so the data
	// directory mixes source and target pages (H3). It is never started,
	// only rebuilt.
	NeedsRebuild bool `json:"needsRebuild,omitempty"`
}

// Store keeps one engine state file per set (written atomically, fsynced).
type Store struct{ dir string }

// NewStore creates dir if needed.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("Postgres member state directory: %w", err)
	}
	return &Store{dir: dir}, nil
}

func (s *Store) path(setID string) string { return filepath.Join(s.dir, setID+".json") }

// Load reads a set's state; a missing file is the zero state, a broken one an
// error (the member then never starts writable: the runtime cannot open it).
func (s *Store) Load(setID string) (State, error) {
	data, err := os.ReadFile(s.path(setID))
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("Postgres member state of set %s: %w", setID, err)
	}
	return state, nil
}

// Save writes a set's state durably.
func (s *Store) Save(setID string, state State) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return WriteDurable(s.path(setID), data, 0o600)
}

// Delete removes a set's state.
func (s *Store) Delete(setID string) error {
	if err := os.Remove(s.path(setID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(s.dir)
}

// WriteDurable replaces path atomically: temporary file, fsync, rename,
// fsync of the directory.
func WriteDurable(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(mode); err != nil {
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
	return syncDir(dir)
}

func syncDir(dir string) error {
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
