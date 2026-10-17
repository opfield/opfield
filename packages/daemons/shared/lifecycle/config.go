package lifecycle

import (
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// ControlConfig holds the Opfield connection settings.
type ControlConfig struct {
	Address    string `yaml:"address"`
	Token      string `yaml:"token"`
	CertSHA256 string `yaml:"cert_sha256"`
	// NextAddress is the address Opfield announced it moves to (next
	// address). The daemon switches Address to it once Address stayed
	// unreachable for a while and NextAddress answers.
	NextAddress string `yaml:"next_address,omitempty"`
}

// TLSConfig holds the mTLS certificate paths.
type TLSConfig struct {
	CACert     string `yaml:"ca_cert"`
	ClientCert string `yaml:"client_cert"`
	ClientKey  string `yaml:"client_key"`
}

// ConsoleConfig holds host-level interactive console settings.
type ConsoleConfig struct {
	// Enabled turns the host console (interactive shell and one-shot
	// commands) on or off. Unset means enabled.
	Enabled *bool  `yaml:"enabled"`
	User    string `yaml:"user"` // OS user for console sessions; empty = daemon's own user
}

// FilesConfig holds host file access settings.
type FilesConfig struct {
	// Enabled turns host file browsing, reads and writes on or off. Unset
	// means enabled.
	Enabled *bool `yaml:"enabled"`
}

// BaseConfig holds the configuration common to all daemons.
type BaseConfig struct {
	// Control is the control plane connection in effect: the opfield: section
	// of the config file, else its pre-Opfield pre-Opfield section
	// (ResolveControlSection picks it after loading).
	// legacy-name: the pre-Opfield config section of pre-Opfield installs — remove once every node reports none
	legacycompat.ConfigSectionField[ControlConfig] `yaml:",inline"`
	// Opfield is the opfield: section as written in the file.
	Opfield  ControlConfig `yaml:"opfield"`
	TLS      TLSConfig     `yaml:"tls"`
	Console  ConsoleConfig `yaml:"console"`
	Files    FilesConfig   `yaml:"files"`
	StateDir string        `yaml:"state_dir"`
	// HostIdentityPath points at the one opaque identity shared by every
	// installer-managed daemon on the physical host. Empty (or either default
	// path) means the shared default, /var/lib/opfield/host-identity, or the
	// pre-Opfield legacycompat.StateRoot/host-identity until that directory moved.
	HostIdentityPath string `yaml:"host_identity_path"`
	LogLevel         string `yaml:"log_level"`
	LogFormat        string `yaml:"log_format"`
}

// IsEnrolled checks whether mTLS credentials exist on disk.
func (c *BaseConfig) IsEnrolled() bool {
	if c.TLS.CACert == "" || c.TLS.ClientCert == "" || c.TLS.ClientKey == "" {
		return false
	}
	for _, path := range []string{c.TLS.CACert, c.TLS.ClientCert, c.TLS.ClientKey} {
		if _, err := os.Stat(path); err != nil {
			return false
		}
	}
	return true
}

// ClearTokenFromFile re-reads the config file, removes the token, and writes it back.
func ClearTokenFromFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return err
	}

	for _, section := range ControlSectionKeys {
		if gw, ok := raw[section].(map[string]interface{}); ok {
			delete(gw, "token")
		}
	}

	out, err := yaml.Marshal(raw)
	if err != nil {
		return err
	}

	return atomicfile.WriteFile(path, out, 0600)
}

// LoadBaseConfig loads only the base config fields from a YAML file.
func LoadBaseConfig(path string) (*BaseConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &BaseConfig{
		LogLevel:  "info",
		LogFormat: "json",
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.ResolveControlSection()

	if cfg.Control.Address == "" {
		return nil, fmt.Errorf("opfield.address is required")
	}

	return cfg, nil
}

// ControlSectionKeys are the config file keys of the control plane section:
// the Opfield one first.
// legacy-name: the pre-Opfield config section — remove once every node reports none
var ControlSectionKeys = []string{"opfield", legacycompat.ConfigSection}

// ResolveControlSection makes Opfield the section in effect: opfield: when the
// file has one with an address, else the pre-Opfield section.
func (c *BaseConfig) ResolveControlSection() {
	if strings.TrimSpace(c.Opfield.Address) != "" {
		c.Control = c.Opfield
	}
}

// UsesLegacyControlSection reports whether the file's control section is still
// the pre-Opfield one.
func (c *BaseConfig) UsesLegacyControlSection() bool {
	return strings.TrimSpace(c.Opfield.Address) == "" && strings.TrimSpace(c.Control.Address) != ""
}
