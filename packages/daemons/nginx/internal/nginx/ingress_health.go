package nginx

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const (
	// IngressHealthPath is the reserved path every Opfield-rendered server block and the node's default servers
	// answer. Probes (DNS failover monitors, the DNS steward) use it to learn whether this ingress node serves.
	IngressHealthPath = naming.IngressHealthPath
	// LegacyIngressHealthPath is answered the same way: monitors of customers set up before 2.12.1 probe it.
	LegacyIngressHealthPath = naming.LegacyIngressHealthPath
	// ingressHealthSocketName is the responder socket in the health socket directory; nginx proxies the reserved
	// paths there, so nginx itself answers 502 while the daemon is not running.
	ingressHealthSocketName = "health.sock"
	// IngressHealthHostname is answered on :80 and :443 by a daemon-managed server block, for probes that address a
	// node by IP (any Host is not enough on :443, where the catch-all rejects unknown SNI).
	IngressHealthHostname = "ingress-health.opfield.invalid"
	// IngressGenerationHeader carries the config generation of the nginx configuration that handled a probe.
	IngressGenerationHeader = "X-Opfield-Ingress-Generation"
	// legacy-name: header of configs rendered for the pre-Opfield names — remove once every node reports none
	LegacyIngressGenerationHeader = "X-Gateway-Ingress-Generation"

	ingressGenerationFilename = "00-opfield-ingress-generation.conf"
	ingressGenerationVariable = "$opfield_ingress_generation"
)

var ingressGenerationPattern = regexp.MustCompile(`default\s+"(\d+)";`)

// IngressHealthSocketDir is the directory of the responder socket under the names in effect.
func IngressHealthSocketDir() string { return naming.Path(naming.IngressHealthSocketDir) }

// IngressHealthSocketPath is the responder socket under the names in effect.
func IngressHealthSocketPath() string {
	return filepath.Join(IngressHealthSocketDir(), ingressHealthSocketName)
}

// IngressHealthHost is the reserved hostname under the names in effect.
func IngressHealthHost() string { return naming.Render(IngressHealthHostname) }

// IngressGenerationFilename is the managed http-level file that defines $opfield_ingress_generation. It is written
// before every reload, so the value in the configuration nginx runs tells which reload it loaded.
func IngressGenerationFilename() string {
	return naming.File(ingressGenerationFilename)
}

func ingressGenerationConfig(generation uint64) []byte {
	return []byte(naming.Render(fmt.Sprintf(`# Managed by Opfield: config generation of the nginx configuration in service (auto-generated).
map $pid %s {
    default "%d";
}
`, ingressGenerationVariable, generation)))
}

// ingressHealthLocationFor is the location of one reserved path.
func ingressHealthLocationFor(path string) string {
	return fmt.Sprintf(`    location = %s {
        access_log off;
        allow all;
        auth_basic off;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        proxy_pass http://unix:%s:/health;
        proxy_set_header Host $host;
        proxy_set_header %s %s;
        proxy_connect_timeout 2s;
        proxy_send_timeout 3s;
        proxy_read_timeout 3s;
    }
`, path, naming.IngressHealthSocketDir+"/"+ingressHealthSocketName, IngressGenerationHeader, ingressGenerationVariable)
}

// IngressHealthLocation is the locations the backend and the daemon-managed servers render for the reserved paths
// (the Opfield one, then the pre-Opfield one), under the names in effect. Kept byte-identical with
// INGRESS_HEALTH_LOCATION in the backend (ingress-health.ts).
func IngressHealthLocation() string {
	return ingressHealthLocations(IngressHealthPath, LegacyIngressHealthPath)
}

func ingressHealthLocations(paths ...string) string {
	var out strings.Builder
	for _, path := range paths {
		out.WriteString(ingressHealthLocationFor(path))
	}
	return naming.Render(out.String())
}

// missingIngressHealthLocations is the locations of the reserved paths content does not have yet ("" when it has
// them all).
func missingIngressHealthLocations(content string) string {
	var missing []string
	for _, path := range []string{IngressHealthPath, LegacyIngressHealthPath} {
		if !strings.Contains(content, "location = "+path+" {") {
			missing = append(missing, path)
		}
	}
	if len(missing) == 0 {
		return ""
	}
	return ingressHealthLocations(missing...)
}

func (m *Manager) generationPath() string {
	if m.configDir == "" {
		return ""
	}
	return filepath.Join(m.configDir, IngressGenerationFilename())
}

// LoadConfigGeneration reads the generation the managed file records. It is the generation nginx runs when its
// last reload succeeded; the health responder verifies that on every probe through the header nginx adds.
func (m *Manager) LoadConfigGeneration() uint64 {
	path := m.generationPath()
	if path == "" {
		return 0
	}
	content, err := ReadFile(path)
	if err != nil || content == nil {
		return 0
	}
	match := ingressGenerationPattern.FindSubmatch(content)
	if match == nil {
		return 0
	}
	generation, err := strconv.ParseUint(string(match[1]), 10, 64)
	if err != nil {
		return 0
	}
	m.generationMu.Lock()
	m.generation = generation
	m.generationMu.Unlock()
	return generation
}

// ConfigGeneration is the generation of the last configuration nginx accepted a reload for.
func (m *Manager) ConfigGeneration() uint64 {
	m.generationMu.Lock()
	defer m.generationMu.Unlock()
	return m.generation
}

// EnsureConfigGeneration writes the generation file when it is missing (a node upgraded to a daemon with ingress
// health), so the variable exists before an Opfield-rendered config refers to it. Returns true when written.
func (m *Manager) EnsureConfigGeneration() (bool, error) {
	path := m.generationPath()
	if path == "" {
		return false, nil
	}
	existing, err := ReadFile(path)
	if err != nil {
		return false, err
	}
	if existing != nil && ingressGenerationPattern.Match(existing) && bytes.Contains(existing, []byte(naming.Render(ingressGenerationVariable))) {
		m.LoadConfigGeneration()
		return false, nil
	}
	m.generationMu.Lock()
	m.generation++
	next := m.generation
	m.generationMu.Unlock()
	return true, WriteAtomic(path, ingressGenerationConfig(next))
}

// stageNextGeneration writes generation+1 before a reload and returns a function that commits it (reload
// succeeded) or restores the previous file (reload failed). Without a config dir it is a no-op.
func (m *Manager) stageNextGeneration() (commit func(ok bool)) {
	path := m.generationPath()
	if path == "" {
		return func(bool) {}
	}
	if _, err := os.Stat(m.configDir); err != nil {
		return func(bool) {}
	}
	previous, _ := ReadFile(path)
	m.generationMu.Lock()
	next := m.generation + 1
	m.generationMu.Unlock()
	if err := WriteAtomic(path, ingressGenerationConfig(next)); err != nil {
		return func(bool) {}
	}
	return func(ok bool) {
		if ok {
			m.generationMu.Lock()
			if next > m.generation {
				m.generation = next
			}
			m.generationMu.Unlock()
			return
		}
		if previous != nil {
			_ = WriteAtomic(path, previous)
		} else {
			_ = RemoveFile(path)
		}
	}
}
