package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureServerNamesHashRaisesAndAddsBothDirectives(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nginx.conf")
	for _, tc := range []struct {
		name, content string
		changed       bool
		want          []string
	}{
		{"installer before 2.12.8", "http {\n    server_names_hash_bucket_size 128;\n}\n", true,
			[]string{"server_names_hash_bucket_size 128;", "server_names_hash_max_size 4096;"}},
		{"small values", "http {\n    server_names_hash_bucket_size 64;\n    server_names_hash_max_size 512;\n}\n", true,
			[]string{"server_names_hash_bucket_size 128;", "server_names_hash_max_size 4096;"}},
		{"larger values stay", "http {\n    server_names_hash_bucket_size 256;\n    server_names_hash_max_size 8192;\n}\n", false,
			[]string{"server_names_hash_bucket_size 256;", "server_names_hash_max_size 8192;"}},
		{"none", "events {}\nhttp {\n}\n", true,
			[]string{"server_names_hash_bucket_size 128;", "server_names_hash_max_size 4096;"}},
	} {
		if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
			t.Fatal(err)
		}
		changed, err := EnsureServerNamesHash(path)
		if err != nil || changed != tc.changed {
			t.Fatalf("%s: changed=%v err=%v", tc.name, changed, err)
		}
		data, _ := os.ReadFile(path)
		for _, want := range tc.want {
			if strings.Count(string(data), want) != 1 {
				t.Fatalf("%s: %q missing or repeated in\n%s", tc.name, want, data)
			}
		}
	}
}
