package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const servicePortTestConfig = `opfield:
  address: opfield.example.test:9443
  cert_sha256: sha256:00
# The relay worker.
worker:
  binary_path: /usr/local/lib/opfield-relay/relay-worker
  service_port: 9443 # chosen at install
  advertised_addresses:
    - relay.example.test
protected:
  enabled: false
`

func TestSetWorkerServicePortKeepsTheRestOfTheConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(servicePortTestConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetWorkerServicePort(path, 10443); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Worker.ServicePort != 10443 {
		t.Fatalf("service_port = %d, want 10443", cfg.Worker.ServicePort)
	}
	if len(cfg.Worker.AdvertisedAddresses) != 1 || cfg.Worker.AdvertisedAddresses[0] != "relay.example.test" ||
		cfg.Worker.BinaryPath != "/usr/local/lib/opfield-relay/relay-worker" || cfg.Control.Address != "opfield.example.test:9443" {
		t.Fatalf("other settings changed: %+v", cfg)
	}
	written, _ := os.ReadFile(path)
	for _, kept := range []string{"# The relay worker.", "# chosen at install", "service_port: 10443"} {
		if !strings.Contains(string(written), kept) {
			t.Fatalf("config lost %q:\n%s", kept, written)
		}
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestSetWorkerServicePortAddsAMissingPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := strings.Replace(servicePortTestConfig, "  service_port: 9443 # chosen at install\n", "", 1)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetWorkerServicePort(path, 443); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.Worker.ServicePort != 443 {
		t.Fatalf("service_port = %v (%v), want 443", cfg, err)
	}
}

func TestSetWorkerServicePortRejectsANonPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(servicePortTestConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, port := range []int{0, 70000} {
		if err := SetWorkerServicePort(path, port); err == nil {
			t.Fatalf("port %d written", port)
		}
	}
	written, _ := os.ReadFile(path)
	if string(written) != servicePortTestConfig {
		t.Fatal("a refused port changed the config")
	}
}
