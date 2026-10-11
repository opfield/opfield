package config

import (
	"fmt"
	"os"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
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
// runs on. Only this file turns it on or off: Gateway has no command that
// changes it, and in protected mode no command that could write this file.
type ProtectedConfig struct {
	// Enabled refuses console, command execution, file access and host
	// diagnostics from Gateway, whatever it sends. Gateway can still update
	// the relay with official signed releases (same or newer version) and
	// route traffic through it.
	Enabled bool `yaml:"enabled"`
	// AllowDatabaseWitness lets Gateway run database availability witness
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
	cfg.StateDir = "/var/lib/gateway-relay-supervisor"
	cfg.TLS.CACert = "/var/lib/gateway-relay-supervisor/supervisor-identity/ca.pem"
	cfg.TLS.ClientCert = "/var/lib/gateway-relay-supervisor/supervisor-identity/node.pem"
	cfg.TLS.ClientKey = "/var/lib/gateway-relay-supervisor/supervisor-identity/node-key.pem"
	cfg.HostIdentityPath = "/var/lib/gateway/host-identity"
	cfg.LogLevel = "info"
	cfg.LogFormat = "json"
	cfg.Worker.BinaryPath = "/usr/local/lib/gateway-relay/gateway-relay"
	cfg.Worker.IdentityDir = "/var/lib/gateway-relay-supervisor/worker-identity"
	cfg.Worker.StateDir = "/var/lib/gateway-relay-supervisor/worker-state"
	cfg.Worker.ServicePort = 9443
	if err := yaml.Unmarshal(encoded, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.Gateway.Address == "" {
		return nil, fmt.Errorf("gateway.address is required")
	}
	if cfg.Worker.ServicePort < 1 || cfg.Worker.ServicePort > 65535 {
		return nil, fmt.Errorf("worker.service_port must be between 1 and 65535")
	}
	if len(cfg.Worker.AdvertisedAddresses) == 0 {
		return nil, fmt.Errorf("worker.advertised_addresses requires at least one address")
	}
	return cfg, nil
}
