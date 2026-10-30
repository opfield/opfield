package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureServerTokensOffAddsOrTurnsItOff(t *testing.T) {
	dir := t.TempDir()
	for name, tc := range map[string]struct{ in, want string }{
		"missing": {"events {}\nhttp {\n    sendfile on;\n}\n", "server_tokens off;"},
		"on":      {"http {\n    server_tokens on;\n}\n", "    server_tokens off;"},
		"off":     {"http {\n    server_tokens off;\n}\n", "    server_tokens off;"},
	} {
		path := filepath.Join(dir, name+".conf")
		if err := os.WriteFile(path, []byte(tc.in), 0o644); err != nil {
			t.Fatal(err)
		}
		previous, changed, err := EnsureServerTokensOff(path)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got, _ := os.ReadFile(path)
		if !strings.Contains(string(got), tc.want) || strings.Contains(string(got), "server_tokens on") {
			t.Fatalf("%s: got %q", name, got)
		}
		if string(previous) != tc.in || changed != (name != "off") {
			t.Fatalf("%s: previous/changed = %q/%v", name, previous, changed)
		}
	}
}
