package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
)

func writeCLIConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: gateway.example.com:9443\nworker:\n  advertised_addresses:\n    - relay.example.com\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runCLI(t *testing.T, path string, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := runProtectedCommand(args, path, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestProtectedCommandTurnsProtectedModeOnAndOff(t *testing.T) {
	path := writeCLIConfig(t)
	if code, out, _ := runCLI(t, path, "status"); code != 0 || !strings.Contains(out, "Protected mode: off") {
		t.Fatalf("status = %d %q", code, out)
	}
	code, out, errOut := runCLI(t, path, "on")
	if code != 0 || !strings.Contains(out, "Restart the relay supervisor") {
		t.Fatalf("on = %d %q %q", code, out, errOut)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Protected.Enabled || cfg.Protected.AllowDatabaseWitness {
		t.Fatalf("on wrote %+v", cfg.Protected)
	}
	if code, out, _ := runCLI(t, path, "on", "--allow-database-witness"); code != 0 || !strings.Contains(out, "witness allowed") {
		t.Fatalf("on --allow-database-witness = %d %q", code, out)
	}
	if code, out, _ := runCLI(t, path, "status"); code != 0 || !strings.Contains(out, "on (database availability witness allowed)") {
		t.Fatalf("status = %d %q", code, out)
	}
	if code, _, _ := runCLI(t, path, "off"); code != 0 {
		t.Fatalf("off = %d", code)
	}
	if cfg, err = config.Load(path); err != nil {
		t.Fatal(err)
	}
	if cfg.Protected.Enabled || cfg.Protected.AllowDatabaseWitness {
		t.Fatalf("off wrote %+v", cfg.Protected)
	}
}

func TestProtectedCommandRejectsBadUsage(t *testing.T) {
	path := writeCLIConfig(t)
	for _, args := range [][]string{{}, {"maybe"}, {"off", "--allow-database-witness"}, {"status", "extra"}} {
		if code, _, _ := runCLI(t, path, args...); code != 2 {
			t.Fatalf("%v exited %d, want 2", args, code)
		}
	}
	if code, _, errOut := runCLI(t, filepath.Join(t.TempDir(), "missing.yaml"), "on"); code != 1 || !strings.Contains(errOut, "load relay supervisor config") {
		t.Fatalf("missing config = %d %q", code, errOut)
	}
}
