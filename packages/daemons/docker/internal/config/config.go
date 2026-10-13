package config

import (
	"fmt"
	"net/netip"
	"os"
	"regexp"
	"strings"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"gopkg.in/yaml.v3"
)

// DockerConfig holds Docker-specific configuration.
type DockerConfig struct {
	Socket    string   `yaml:"socket"`
	Allowlist []string `yaml:"allowlist"`
	// Mode is empty for a general Docker node. "storage" owns stateful workloads;
	// "databases" is its legacy identity alias and keeps existing paths unchanged.
	Mode     string         `yaml:"mode"`
	Database DatabaseConfig `yaml:"database"`
	Compose  ComposeConfig  `yaml:"compose"`
	Builder  BuilderConfig  `yaml:"builder"`
	// SecureLinks configures the networks of secure links (container, storage and database links).
	SecureLinks SecureLinksConfig `yaml:"secure_links"`
	// LeaseWatchdogDir is the tmpfs directory shared with the independent
	// lease watchdog; empty means /run/opfield-lease-watchdog (or its
	// pre-Opfield name until the watchdog moved it).
	LeaseWatchdogDir string `yaml:"lease_watchdog_dir"`
	// LeaseWatchdogReleasesURL and LeaseWatchdogArtifactBaseURL override the
	// update service used to bootstrap a missing watchdog (default: the
	// installer's get.opfield.dev endpoints).
	LeaseWatchdogReleasesURL     string `yaml:"lease_watchdog_releases_url"`
	LeaseWatchdogArtifactBaseURL string `yaml:"lease_watchdog_artifact_base_url"`
}

func (c DockerConfig) IsStorageProfile() bool {
	return c.Mode == "storage" || c.Mode == "databases"
}

type BuilderConfig struct {
	EgressProfile string `yaml:"egress_profile"`
}

// SecureLinksConfig: SubnetPool is the IPv4 network the /26 subnets of new link networks are taken from (default
// 10.213.0.0/16); it must not overlap the networks the host routes elsewhere.
type SecureLinksConfig struct {
	SubnetPool string `yaml:"subnet_pool"`
}

// ComposeConfig configures the daemon-owned Compose sidecar. It is deliberately
// opt-in: a general Docker daemon advertises Compose only after this exact
// digest-pinned image is present locally and the executor has initialized.
type ComposeConfig struct {
	SidecarImage          string `yaml:"sidecar_image"`
	CommandTimeoutSeconds int    `yaml:"command_timeout_seconds"`
}

const DefaultComposeSidecarImage = "docker.io/docker/compose-bin@sha256:962d5ea7017e5ef425bfa47e492efa2c27d0492e8af58c497011e73b2ce98ee0"

// DatabaseConfig is intentionally small: host storage is selected during
// installer preflight and all per-instance limits arrive through the dedicated
// protobuf command. A configured root may be an existing external volume.
type DatabaseConfig struct {
	StorageRoot  string `yaml:"storage_root"`
	ReserveBytes int64  `yaml:"reserve_bytes"`
}

// Config embeds the shared BaseConfig for the docker daemon.
type Config struct {
	lifecycle.BaseConfig `yaml:",inline"`
	Docker               DockerConfig `yaml:"docker"`
}

var composeSidecarImagePattern = regexp.MustCompile(`^[^\s@]+@sha256:[a-f0-9]{64}$`)

// Load reads and parses the docker daemon config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{}
	cfg.StateDir = "/var/lib/docker-daemon"
	cfg.LogLevel = "info"
	cfg.LogFormat = "json"
	cfg.Docker.Database.StorageRoot = "/var/lib/docker-daemon/databases"
	cfg.Docker.Database.ReserveBytes = 2 * 1024 * 1024 * 1024
	cfg.Docker.Compose.SidecarImage = DefaultComposeSidecarImage
	cfg.Docker.Compose.CommandTimeoutSeconds = 15 * 60
	cfg.Docker.Builder.EgressProfile = "internet"

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.ResolveControlSection()

	if cfg.Control.Address == "" {
		return nil, fmt.Errorf("opfield.address is required")
	}
	if cfg.Docker.Mode != "" && cfg.Docker.Mode != "databases" && cfg.Docker.Mode != "storage" && cfg.Docker.Mode != "builder" {
		return nil, fmt.Errorf("docker.mode must be empty, databases, storage, or builder")
	}
	if (cfg.Docker.Mode == "databases" || cfg.Docker.Mode == "storage") && cfg.Docker.Database.StorageRoot == "" {
		return nil, fmt.Errorf("docker.database.storage_root is required in databases or storage mode")
	}
	if pool := strings.TrimSpace(cfg.Docker.SecureLinks.SubnetPool); pool != "" {
		prefix, err := netip.ParsePrefix(pool)
		if err != nil || !prefix.Addr().Is4() || prefix.Bits() > 26 {
			return nil, fmt.Errorf("docker.secure_links.subnet_pool must be an IPv4 network of /26 or larger")
		}
	}
	if cfg.Docker.Compose.CommandTimeoutSeconds <= 0 {
		return nil, fmt.Errorf("docker.compose.command_timeout_seconds must be positive")
	}
	if cfg.Docker.Compose.SidecarImage != "" && !composeSidecarImagePattern.MatchString(cfg.Docker.Compose.SidecarImage) {
		return nil, fmt.Errorf("docker.compose.sidecar_image must be a sha256-pinned image reference")
	}
	if cfg.Docker.Mode == "builder" {
		if cfg.Docker.Socket != "" {
			return nil, fmt.Errorf("docker.socket must be omitted in builder mode")
		}
		if len(cfg.Docker.Allowlist) != 0 {
			return nil, fmt.Errorf("docker.allowlist must be empty in builder mode")
		}
		if cfg.Docker.Builder.EgressProfile != "internet" && cfg.Docker.Builder.EgressProfile != "offline" {
			return nil, fmt.Errorf("docker.builder.egress_profile must be internet or offline")
		}
	} else {
		if cfg.Docker.Socket == "" {
			cfg.Docker.Socket = "unix:///var/run/docker.sock"
		}
		if len(cfg.Docker.Allowlist) == 0 {
			cfg.Docker.Allowlist = []string{"*"}
		}
	}

	return cfg, nil
}
