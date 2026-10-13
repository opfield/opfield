package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The manual setup writes config.yaml first and runs install after it: install keeps that configuration and only
// sets the gateway address, token and certificate fingerprint (F-B14). A host without one gets the template.
func TestInstallKeepsAnExistingConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	written := `# operator settings
gateway:
  address: "old:9443"
nginx:
  config_dir: "/etc/nginx/conf.d/sites"
  htpasswd_dir: "/etc/nginx/htpasswd"
log_level: "debug"
log_format: "text"
`
	if err := os.WriteFile(path, []byte(written), 0o640); err != nil {
		t.Fatal(err)
	}
	kept, err := writeInstallConfig(path, "gw.test:9443", "tok", "sha256:"+strings.Repeat("a", 64))
	if err != nil || !kept {
		t.Fatalf("kept %v err %v", kept, err)
	}
	data, _ := os.ReadFile(path)
	var config struct {
		Control struct {
			Address    string `yaml:"address"`
			Token      string `yaml:"token"`
			CertSHA256 string `yaml:"cert_sha256"`
		} `yaml:"gateway"`
		Nginx struct {
			ConfigDir   string `yaml:"config_dir"`
			HtpasswdDir string `yaml:"htpasswd_dir"`
		} `yaml:"nginx"`
		LogLevel  string `yaml:"log_level"`
		LogFormat string `yaml:"log_format"`
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config.Control.Address != "gw.test:9443" || config.Control.Token != "tok" || !strings.HasPrefix(config.Control.CertSHA256, "sha256:") ||
		config.Nginx.ConfigDir != "/etc/nginx/conf.d/sites" || config.Nginx.HtpasswdDir != "/etc/nginx/htpasswd" ||
		config.LogLevel != "debug" || config.LogFormat != "text" || !strings.Contains(string(data), "# operator settings") {
		t.Fatalf("config after install:\n%s", data)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v, want the operator's 0640", info.Mode())
	}

	fresh := filepath.Join(dir, "fresh.yaml")
	if kept, err := writeInstallConfig(fresh, "gw.test:9443", "tok", "sha256:x"); err != nil || kept {
		t.Fatalf("fresh: kept %v err %v", kept, err)
	}
	if data, _ := os.ReadFile(fresh); !strings.Contains(string(data), `token: "tok"`) || !strings.Contains(string(data), defaultNginxConfigDir()) {
		t.Fatalf("template:\n%s", data)
	}
}
