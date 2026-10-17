package lifecycle

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"

	"gopkg.in/yaml.v3"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// MigrateControlConfigKey renames the pre-Opfield section of the
// daemon config file at path to opfield:, keeping its content, every other key,
// their order and comments. It does nothing when the file already has an
// opfield: section with an address (then a leftover pre-Opfield section goes). Run
// it only on a confirmed start (OnStartConfirmed) and only for daemons whose
// loader reads opfield: (ResolveControlSection), since a binary the launcher
// rolls back to before that may know only the pre-Opfield section.
func MigrateControlConfigKey(path string) (bool, error) {
	controlConfigFileMu.Lock()
	defer controlConfigFileMu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return false, fmt.Errorf("parse config: %w", err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return false, errors.New("config file is not a YAML mapping")
	}
	root := document.Content[0]
	legacyIndex, opfieldIndex := -1, -1
	for index := 0; index+1 < len(root.Content); index += 2 {
		switch root.Content[index].Value {
		case "gateway":
			legacyIndex = index
		case "opfield":
			opfieldIndex = index
		}
	}
	if legacyIndex < 0 {
		return false, nil
	}
	if opfieldIndex >= 0 {
		section := root.Content[opfieldIndex+1]
		address := yamlMappingValue(section, "address")
		if section.Kind != yaml.MappingNode || address == nil || address.Value == "" {
			// An opfield: section without an address is not the one in effect:
			// leave the file alone.
			return false, nil
		}
		root.Content = append(root.Content[:legacyIndex], root.Content[legacyIndex+2:]...)
	} else {
		root.Content[legacyIndex].Value = "opfield"
	}
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return false, err
	}
	if err := encoder.Close(); err != nil {
		return false, err
	}
	if err := atomicfile.WriteFile(path, out.Bytes(), info.Mode().Perm()); err != nil {
		return false, err
	}
	return true, nil
}

// HostIdentityPathFor is the host identity file a daemon uses: the configured
// path, or for the default (empty, or either default path) the one in the
// shared state directory under its current name.
func HostIdentityPathFor(configured string) string {
	if isDefaultHostIdentityPath(configured) {
		return hostrename.StateRoot.Join(hostrename.HostIdentityName)
	}
	return configured
}

func isDefaultHostIdentityPath(path string) bool {
	switch path {
	case "",
		hostrename.StateRoot.New + "/" + hostrename.HostIdentityName,
		// legacy-name: /var/lib/gateway/host-identity written into configs by pre-Opfield installers — remove once every node reports none
		hostrename.StateRoot.Old + "/" + hostrename.HostIdentityName:
		return true
	}
	return false
}

// MoveSharedStateRoot moves the legacy state root to /var/lib/opfield (leaving a
// link under the old name) on a confirmed start. Every daemon of a host runs
// it; the first one moves, the others find it done.
func MoveSharedStateRoot(logger *slog.Logger) {
	outcome, err := hostrename.Move(hostrename.StateRoot)
	switch {
	case err != nil:
		logger.Warn("shared state directory keeps its pre-Opfield name", "path", hostrename.StateRoot.Old, "outcome", outcome.String(), "error", err)
	case outcome == hostrename.Moved:
		logger.Info("moved the shared state directory to its Opfield name", "from", hostrename.StateRoot.Old, "to", hostrename.StateRoot.New)
	}
}

// LegacyHostPaths counts the shared host directories still under their
// pre-Opfield name (for the daemon's legacy name report).
func LegacyHostPaths() uint32 {
	if hostrename.Legacy(hostrename.StateRoot) {
		return 1
	}
	return 0
}

// MigrateControlConfigKeyOnConfirmedStart renames the pre-Opfield section of the
// daemon's config file to opfield: once this start is confirmed. Only daemons
// whose loader calls ResolveControlSection may use it.
func MigrateControlConfigKeyOnConfirmedStart(cfg *BaseConfig, path string, logger *slog.Logger) {
	OnStartConfirmed(func() {
		changed, err := MigrateControlConfigKey(path)
		if err != nil {
			logger.Warn("config keeps its pre-Opfield gateway: section", "path", path, "error", err)
			return
		}
		if changed {
			if cfg != nil && cfg.UsesLegacyControlSection() {
				cfg.Opfield = cfg.Control
			}
			logger.Info("renamed the config section gateway: to opfield:", "path", path)
		}
	})
}
