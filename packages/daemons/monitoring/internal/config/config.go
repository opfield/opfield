package config

import (
	"fmt"
	"os"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"gopkg.in/yaml.v3"
)

// Config embeds the shared BaseConfig for the monitoring daemon.
type Config struct {
	lifecycle.BaseConfig `yaml:",inline"`
}

// Load reads and parses the monitoring daemon config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{}
	cfg.StateDir = "/var/lib/monitoring-daemon"
	cfg.LogLevel = "info"
	cfg.LogFormat = "json"

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.ResolveControlSection()

	if cfg.Control.Address == "" {
		return nil, fmt.Errorf("opfield.address is required")
	}

	return cfg, nil
}
