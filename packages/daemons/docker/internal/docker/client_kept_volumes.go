package docker

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// dockerKeptVolumesCapability advertises the volume action "keep": Opfield sends the volumes a removed container's
// anonymous-volume cleanup must keep (the ones the user manages in Opfield, a database row the daemon cannot see,
// and every one an Opfield config names). The set replaces the previous one and survives restarts, so cleanups the
// daemon starts on its own use the last set too.
const dockerKeptVolumesCapability = "docker_kept_volumes_v1"

const keptVolumesFile = "kept-volumes.json"

func keptVolumesPath(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Join(stateDir, keptVolumesFile)
}

type keptVolumes struct {
	mu    sync.RWMutex
	path  string
	names map[string]bool
}

type keptVolumesDocument struct {
	Names []string `json:"names"`
}

// newKeptVolumes loads the persisted set; a missing or unreadable file leaves it empty (as before Opfield sent one).
func newKeptVolumes(path string) *keptVolumes {
	k := &keptVolumes{path: path, names: map[string]bool{}}
	if path == "" {
		return k
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return k
	}
	var doc keptVolumesDocument
	if json.Unmarshal(data, &doc) == nil {
		k.names = keptVolumeSet(doc.Names)
	}
	return k
}

func keptVolumeSet(names []string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			set[name] = true
			set[strings.ToLower(name)] = true
		}
	}
	return set
}

// has reports whether removal must keep the volume; a nil set keeps nothing.
func (k *keptVolumes) has(name string) bool {
	if k == nil {
		return false
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.names[name] || k.names[strings.ToLower(name)]
}

// replace persists the set Opfield sent and then uses it; the previous set stays when it cannot be written.
func (k *keptVolumes) replace(content []byte) (int, error) {
	if k == nil {
		return 0, errors.New("kept volumes are not available")
	}
	var doc keptVolumesDocument
	if err := json.Unmarshal(content, &doc); err != nil {
		return 0, fmt.Errorf("parse kept volumes: %w", err)
	}
	if doc.Names == nil {
		return 0, errors.New("kept volumes: names is required")
	}
	set := keptVolumeSet(doc.Names)
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.path != "" {
		data, err := json.Marshal(keptVolumesDocument{Names: doc.Names})
		if err != nil {
			return 0, err
		}
		if err := atomicfile.WriteFile(k.path, data, 0o600); err != nil {
			return 0, fmt.Errorf("save kept volumes: %w", err)
		}
	}
	k.names = set
	return len(doc.Names), nil
}
