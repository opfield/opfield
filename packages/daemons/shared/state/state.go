package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// State holds persistent daemon state with thread-safe access.
// Daemon-specific fields are stored in the Extras map.
type State struct {
	NodeID        string         `json:"node_id"`
	Enrolled      bool           `json:"enrolled"`
	CertExpiresAt int64          `json:"cert_expires_at"` // Unix timestamp
	Extras        map[string]any `json:"extras,omitempty"`

	mu   sync.RWMutex
	path string
}

func Load(stateDir string) (*State, error) {
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}

	path := filepath.Join(stateDir, "state.json")
	s := &State{path: path, Extras: make(map[string]any)}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}

	if err := json.Unmarshal(data, s); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}

	if s.Extras == nil {
		s.Extras = make(map[string]any)
	}

	return s, nil
}

func (s *State) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	// The node's identity: a kill -9 mid-write must leave the previous file, not a partial one.
	if err := atomicfile.WriteFile(s.path, data, 0644); err != nil {
		return fmt.Errorf("write state: %w", err)
	}
	return nil
}

func (s *State) SetEnrolled(nodeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NodeID = nodeID
	s.Enrolled = true
}

func (s *State) SetCertExpiry(expiresAt int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.CertExpiresAt = expiresAt
}

func (s *State) GetCertExpiry() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.CertExpiresAt
}

// SetExtra stores a daemon-specific key-value pair.
func (s *State) SetExtra(key string, value any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Extras[key] = value
}

// GetExtra retrieves a daemon-specific value by key.
func (s *State) GetExtra(key string) (any, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.Extras[key]
	return v, ok
}

// GetExtraString retrieves a daemon-specific string value by key.
func (s *State) GetExtraString(key string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if v, ok := s.Extras[key]; ok {
		if str, ok := v.(string); ok {
			return str
		}
	}
	return ""
}
