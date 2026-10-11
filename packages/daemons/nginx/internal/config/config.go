package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
)

const (
	canonicalHtpasswdDir = "/etc/nginx/gateway/htpasswd"
	legacyHtpasswdDir    = "/etc/nginx/htpasswd"
)

type Config struct {
	Gateway GatewayConfig `yaml:"gateway"`
	TLS     TLSConfig     `yaml:"tls"`
	Nginx   NginxConfig   `yaml:"nginx"`
	// Host console and file access settings shared by every daemon type.
	Console  lifecycle.ConsoleConfig `yaml:"console"`
	Files    lifecycle.FilesConfig   `yaml:"files"`
	StateDir string                  `yaml:"state_dir"`
	// HostIdentityPath overrides the shared host identity; a daemon running as
	// its own user keeps a copy in its state directory. Empty means the default.
	HostIdentityPath string `yaml:"host_identity_path"`
	LogLevel         string `yaml:"log_level"`
	LogFormat        string `yaml:"log_format"`
}

type GatewayConfig struct {
	Address    string `yaml:"address"`
	Token      string `yaml:"token"`
	CertSHA256 string `yaml:"cert_sha256"`
	// NextAddress is the address Opfield announced it moves to
	// (lifecycle.GatewayConfig.NextAddress).
	NextAddress string `yaml:"next_address,omitempty"`
}

type TLSConfig struct {
	CACert     string `yaml:"ca_cert"`
	ClientCert string `yaml:"client_cert"`
	ClientKey  string `yaml:"client_key"`
}

type NginxConfig struct {
	ConfigDir        string `yaml:"config_dir"`
	CertsDir         string `yaml:"certs_dir"`
	LogsDir          string `yaml:"logs_dir"`
	GlobalConfig     string `yaml:"global_config"`
	Binary           string `yaml:"binary"`
	StubStatusURL    string `yaml:"stub_status_url"`
	HtpasswdDir      string `yaml:"htpasswd_dir"`
	AcmeChallengeDir string `yaml:"acme_challenge_dir"`
	// PagesRoot is owned exclusively by nginx-daemon. Gateway Pages commands
	// carry opaque IDs, never filesystem paths, and all release data is derived
	// below this directory.
	PagesRoot string `yaml:"pages_root"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		StateDir:  "/var/lib/nginx-daemon",
		LogLevel:  "info",
		LogFormat: "json",
	}
	cfg.Nginx.Binary = "/usr/sbin/nginx"
	cfg.Nginx.ConfigDir = "/etc/nginx/gateway/conf.d"
	cfg.Nginx.CertsDir = "/etc/nginx/certs"
	cfg.Nginx.LogsDir = "/var/log/nginx"
	cfg.Nginx.GlobalConfig = "/etc/nginx/nginx.conf"
	cfg.Nginx.StubStatusURL = "http://127.0.0.1/nginx_status"
	cfg.Nginx.HtpasswdDir = canonicalHtpasswdDir
	cfg.Nginx.AcmeChallengeDir = "/var/www/acme-challenge"
	cfg.Nginx.PagesRoot = "/var/lib/nginx-daemon/pages"

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	// Gateway-generated host configs always reference the canonical directory.
	// Normalize the legacy installer value so daemon updates cannot keep writing
	// valid credentials to a path nginx never reads.
	if cfg.Nginx.HtpasswdDir == legacyHtpasswdDir {
		cfg.Nginx.HtpasswdDir = canonicalHtpasswdDir
	}

	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}

	return cfg, nil
}

func (c *Config) validate() error {
	if c.Gateway.Address == "" {
		return fmt.Errorf("gateway.address is required")
	}
	if c.Nginx.Binary == "" {
		return fmt.Errorf("nginx.binary is required")
	}
	if c.Nginx.ConfigDir == "" {
		return fmt.Errorf("nginx.config_dir is required")
	}
	if c.Nginx.CertsDir == "" {
		return fmt.Errorf("nginx.certs_dir is required")
	}
	return nil
}
