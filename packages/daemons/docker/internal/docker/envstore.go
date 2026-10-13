package docker

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// EnvStore manages per-container env override files stored as KEY=VALUE lines
// under a configurable directory. Each container gets its own file:
// {dir}/{container-name}.env
type EnvStore struct {
	dir string
}

// NewEnvStore creates an EnvStore rooted at dir.
func NewEnvStore(dir string) *EnvStore {
	return &EnvStore{dir: dir}
}

// Load reads the env file for containerName and returns it as a map.
// Returns an empty map (not an error) if the file does not exist yet.
func (s *EnvStore) Load(containerName string) (map[string]string, error) {
	path := s.path(containerName)
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open env file %s: %w", path, err)
	}
	defer f.Close()
	return parseEnvFile(f), nil
}

// Save writes env to the container's env file atomically (temp file + rename).
// If env is empty the file is removed instead.
func (s *EnvStore) Save(containerName string, env map[string]string) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("create envstore dir: %w", err)
	}
	path := s.path(containerName)
	if len(env) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove env file: %w", err)
		}
		return nil
	}
	err := atomicfile.Write(path, 0o600, func(f *os.File) error {
		for k, v := range env {
			if _, err := fmt.Fprintf(f, "%s=%s\n", k, v); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("write env file: %w", err)
	}
	return nil
}

// Apply merges additions into the current stored env for containerName,
// removes the keys listed in removals, and saves the result.
// Returns the resulting stored map.
func (s *EnvStore) Apply(containerName string, additions map[string]string, removals []string) (map[string]string, error) {
	env, err := s.Load(containerName)
	if err != nil {
		return nil, err
	}
	for k, v := range additions {
		env[k] = v
	}
	for _, k := range removals {
		delete(env, k)
	}
	if err := s.Save(containerName, env); err != nil {
		return nil, err
	}
	return env, nil
}

// MergeInto takes a Docker env slice ([]string{"KEY=VALUE",...}), applies the
// stored overrides on top (daemon values win on conflict), and returns the merged
// slice. Entries not in the container's env are appended.
func (s *EnvStore) MergeInto(containerName string, containerEnv []string) ([]string, error) {
	overrides, err := s.Load(containerName)
	if err != nil {
		return nil, err
	}
	if len(overrides) == 0 {
		return containerEnv, nil
	}
	seen := make(map[string]bool, len(containerEnv))
	merged := make([]string, 0, len(containerEnv)+len(overrides))
	for _, kv := range containerEnv {
		key := kv
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			key = kv[:idx]
		}
		seen[key] = true
		if val, ok := overrides[key]; ok {
			merged = append(merged, key+"="+val)
		} else {
			merged = append(merged, kv)
		}
	}
	for k, v := range overrides {
		if !seen[k] {
			merged = append(merged, k+"="+v)
		}
	}
	return merged, nil
}

// ComputeRemovals returns the set of keys that were in the last applied env
// but are no longer in newContext, so they must be actively removed from the
// container env on the next recreate.
func (s *EnvStore) ComputeRemovals(containerName string, newContext map[string]string) ([]string, error) {
	applied, err := s.loadApplied(containerName)
	if err != nil {
		return nil, err
	}
	var removals []string
	for k := range applied {
		if _, stillPresent := newContext[k]; !stillPresent {
			removals = append(removals, k)
		}
	}
	return removals, nil
}

// SaveApplied records the context env that was just applied to the container.
// Call this after a successful update/recreate.
func (s *EnvStore) SaveApplied(containerName string, env map[string]string) error {
	return s.Save(containerName+".applied", env)
}

func (s *EnvStore) loadApplied(containerName string) (map[string]string, error) {
	path := s.appliedPath(containerName)
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open applied env file %s: %w", path, err)
	}
	defer f.Close()
	return parseEnvFile(f), nil
}

func (s *EnvStore) path(containerName string) string {
	return filepath.Join(s.dir, containerName+".env")
}

func (s *EnvStore) appliedPath(containerName string) string {
	return filepath.Join(s.dir, containerName+".applied.env")
}

// parseEnvFile reads KEY=VALUE lines from r, ignoring blank lines and # comments.
func parseEnvFile(r io.Reader) map[string]string {
	env := make(map[string]string)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			continue
		}
		env[line[:idx]] = line[idx+1:]
	}
	return env
}
