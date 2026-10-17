package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReadsHostAccessSwitches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: \"opfield.example.com:9443\"\nconsole:\n  enabled: false\n  user: \"ops\"\nfiles:\n  enabled: false\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Console.IsEnabled() || cfg.Files.IsEnabled() {
		t.Fatalf("console and files must be disabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	if cfg.Console.User != "ops" {
		t.Fatalf("console.user = %q", cfg.Console.User)
	}
}

func TestLoadKeepsHostAccessEnabledByDefault(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("gateway:\n  address: \"opfield.example.com:9443\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Console.IsEnabled() || !cfg.Files.IsEnabled() {
		t.Fatalf("console and files must default to enabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
}

func TestLoadReadsHostIdentityPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	write := func(contents string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	write("gateway:\n  address: gw.example:9443\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HostIdentityPath != "" {
		t.Fatalf("default host identity path = %q, want empty (the shared default)", cfg.HostIdentityPath)
	}

	write("gateway:\n  address: gw.example:9443\nhost_identity_path: \"/var/lib/nginx-daemon/host-identity\"\n")
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HostIdentityPath != "/var/lib/nginx-daemon/host-identity" {
		t.Fatalf("host identity path = %q", cfg.HostIdentityPath)
	}
}
