package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureWorkerReadableDirsOpensDirectoriesAnInstallerLeftPrivate(t *testing.T) {
	root := t.TempDir()
	private := filepath.Join(root, "htpasswd")
	open := filepath.Join(root, "acme")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(open, 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o775); err != nil {
		t.Fatal(err)
	}

	ensureWorkerReadableDirs([]string{private, open, filepath.Join(root, "missing")}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	for path, want := range map[string]os.FileMode{private: 0o755, open: 0o775} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Fatalf("%s: mode %o, want %o", path, got, want)
		}
	}
}
