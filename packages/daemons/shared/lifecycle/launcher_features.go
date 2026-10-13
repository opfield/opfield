package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

const (
	// LauncherFeatureListenerKeep: the launcher keeps what a daemon process
	// hands it (listeners, later connections) for the next daemon process.
	LauncherFeatureListenerKeep = "listener_keep_v1"
	// LauncherFeatureSelfUpdate: the launcher replaces itself with a newer
	// launcher in place, keeping its process, its daemon child and everything
	// it keeps (launcher_selfupdate.go).
	LauncherFeatureSelfUpdate = "self_update_v1"
	// LauncherFeatureOpenRC: the launcher recognizes OpenRC's supervise-daemon
	// as the service manager that starts it again, so it updates itself in
	// place under OpenRC too. Launchers with self_update_v1 alone (2.11.4-rc.6)
	// took OpenRC for manual mode and never did.
	LauncherFeatureOpenRC = "openrc_v1"

	// launcherCapabilityPrefix names a launcher feature among the node
	// capabilities a daemon reports (launcher_listener_keep_v1, ...).
	launcherCapabilityPrefix = "launcher_"
	// launcherFeaturesFlag makes `launcher-probe` describe the launcher the
	// binary runs. Binaries that predate it ignore the flag and print the
	// plain probe line.
	launcherFeaturesFlag = "--features"
)

// launcherBinaryFeatures are the features the launcher of this binary has
// when everything it needs is available.
var launcherBinaryFeatures = []string{LauncherFeatureListenerKeep, LauncherFeatureSelfUpdate, LauncherFeatureOpenRC}

// launcherUpdatesItself reports whether a launcher with these features execs
// into a refreshed launcher in place under every service manager that starts
// it again.
func launcherUpdatesItself(launcher LauncherInfo) bool {
	return launcher.Has(LauncherFeatureSelfUpdate) && launcher.Has(LauncherFeatureOpenRC)
}

// LauncherInfo describes the launcher process a daemon runs under.
type LauncherInfo struct {
	// Managed is false for a daemon that runs without a launcher.
	Managed bool
	// Version is empty for a launcher that predates reporting it.
	Version  string
	Features []string
}

// Has reports whether the launcher has feature (LauncherFeature...).
func (i LauncherInfo) Has(feature string) bool {
	return slices.Contains(i.Features, feature)
}

// Capabilities names the launcher's features as node capabilities.
func (i LauncherInfo) Capabilities() []string {
	capabilities := make([]string, 0, len(i.Features))
	for _, feature := range i.Features {
		capabilities = append(capabilities, launcherCapabilityPrefix+feature)
	}
	return capabilities
}

func (i LauncherInfo) equal(other LauncherInfo) bool {
	return i.Managed == other.Managed && i.Version == other.Version && slices.Equal(i.Features, other.Features)
}

// LauncherFeatures describes the launcher this daemon process runs under now.
// A launcher that updated itself in place reports its new version and
// features from then on, so callers ask again rather than keep the answer.
func LauncherFeatures() LauncherInfo {
	if launcherManagedFromEnvironment() != "1" {
		return LauncherInfo{}
	}
	info := LauncherInfo{Managed: true}
	stateDir := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv))
	if filepath.IsAbs(stateDir) {
		if owner, err := readLauncherOwner(stateDir); err == nil && owner.PID == os.Getppid() && owner.Version != "" {
			info.Version = owner.Version
			info.Features = append([]string(nil), owner.Features...)
			return info
		}
	}
	// A launcher that predates reporting its features: it keeps listeners
	// when it handed this process a keeper channel (2.11 and later).
	if listenerkeep.FromLauncher() {
		info.Features = []string{LauncherFeatureListenerKeep}
	}
	return info
}

func readLauncherOwner(stateDir string) (*launcherOwner, error) {
	contents, err := os.ReadFile(filepath.Join(stateDir, "launcher", "owner.json"))
	if err != nil {
		return nil, err
	}
	var owner launcherOwner
	if err := json.Unmarshal(contents, &owner); err != nil {
		return nil, err
	}
	return &owner, nil
}

// launcherProbeFeatures is what `launcher-probe --features` prints.
type launcherProbeFeatures struct {
	Protocol int      `json:"protocol"`
	Version  string   `json:"version"`
	Features []string `json:"features"`
}

func (p launcherProbeFeatures) has(feature string) bool {
	return slices.Contains(p.Features, feature)
}

// probeLauncherFeatures asks the binary at path which launcher it runs. A
// binary that predates the question reports no features.
func probeLauncherFeatures(path string) (launcherProbeFeatures, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, LauncherProbeCommand, launcherFeaturesFlag).Output()
	if err != nil {
		return launcherProbeFeatures{}, err
	}
	line := strings.TrimSpace(string(output))
	if line == fmt.Sprintf("gateway-daemon-launcher %d", LauncherProtocolVersion) {
		return launcherProbeFeatures{Protocol: LauncherProtocolVersion}, nil
	}
	var probe launcherProbeFeatures
	if err := json.Unmarshal([]byte(line), &probe); err != nil {
		return launcherProbeFeatures{}, fmt.Errorf("unsupported launcher probe response %q", line)
	}
	if probe.Protocol != LauncherProtocolVersion {
		return launcherProbeFeatures{}, errors.New("launcher protocol does not match")
	}
	return probe, nil
}
