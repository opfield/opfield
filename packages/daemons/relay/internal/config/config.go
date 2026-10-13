package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/relay-supervisor/internal/hostnames"
	"gopkg.in/yaml.v3"
)

type WorkerConfig struct {
	BinaryPath          string   `yaml:"binary_path"`
	IdentityDir         string   `yaml:"identity_dir"`
	StateDir            string   `yaml:"state_dir"`
	ServicePort         int      `yaml:"service_port"`
	AdvertisedAddresses []string `yaml:"advertised_addresses"`
}

// ProtectedConfig is protected mode, set by the owner of the machine the relay
// runs on. Only this file turns it on or off: Opfield has no command that
// changes it, and in protected mode no command that could write this file.
type ProtectedConfig struct {
	// Enabled refuses console, command execution, file access and host
	// diagnostics from Opfield, whatever it sends. Opfield can still update
	// the relay with official signed releases (same or newer version) and
	// route traffic through it.
	Enabled bool `yaml:"enabled"`
	// AllowDatabaseWitness lets Opfield run database availability witness
	// processes on a protected relay. Off by default; it has no effect
	// without Enabled.
	AllowDatabaseWitness bool `yaml:"allow_database_witness"`
}

type Config struct {
	lifecycle.BaseConfig `yaml:",inline"`
	Worker               WorkerConfig    `yaml:"worker"`
	Protected            ProtectedConfig `yaml:"protected"`
}

func Load(path string) (*Config, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg := &Config{}
	// Defaults for a configuration that names no path: the Opfield
	// directories, or the pre-Opfield ones until they moved (hostnames).
	stateDir := hostnames.DefaultStateDir()
	cfg.StateDir = stateDir
	cfg.TLS.CACert = filepath.Join(stateDir, "supervisor-identity", "ca.pem")
	cfg.TLS.ClientCert = filepath.Join(stateDir, "supervisor-identity", "node.pem")
	cfg.TLS.ClientKey = filepath.Join(stateDir, "supervisor-identity", "node-key.pem")
	// Empty is the host identity every daemon of the host shares
	// (lifecycle.HostIdentityPathFor).
	cfg.HostIdentityPath = ""
	cfg.LogLevel = "info"
	cfg.LogFormat = "json"
	cfg.Worker.BinaryPath = hostnames.DefaultWorkerBinary()
	cfg.Worker.IdentityDir = filepath.Join(stateDir, "worker-identity")
	cfg.Worker.StateDir = filepath.Join(stateDir, "worker-state")
	cfg.Worker.ServicePort = 9443
	if err := yaml.Unmarshal(encoded, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.ResolveControlSection()
	if cfg.Control.Address == "" {
		return nil, fmt.Errorf("opfield.address is required")
	}
	if cfg.Worker.ServicePort < 1 || cfg.Worker.ServicePort > 65535 {
		return nil, fmt.Errorf("worker.service_port must be between 1 and 65535")
	}
	if len(cfg.Worker.AdvertisedAddresses) == 0 {
		return nil, fmt.Errorf("worker.advertised_addresses requires at least one address")
	}
	return cfg, nil
}
