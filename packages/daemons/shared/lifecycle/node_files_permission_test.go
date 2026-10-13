package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A non-root daemon that cannot enter a directory on the way names the permission error, so Opfield answers 403.
func TestWriteUnderAnUnenterableDirectoryNamesThePermissionError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root enters every directory")
	}
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(filepath.Join(locked, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(locked, "sub", "x"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	for _, create := range []bool{false, true} {
		err := writeNodeFile(filepath.Join(locked, "sub", "x"), []byte("y"), create)
		if err == nil || !strings.Contains(err.Error(), "permission denied") {
			t.Fatalf("create=%v: error %v, want a permission denied error", create, err)
		}
	}
}

// Saving a file that was deleted meanwhile names the missing file, so Opfield answers 404.
func TestWriteOfADeletedFileNamesTheMissingFile(t *testing.T) {
	err := writeNodeFile(filepath.Join(t.TempDir(), "gone.txt"), []byte("y"), false)
	if err == nil || !strings.Contains(err.Error(), "no such file or directory") {
		t.Fatalf("error %v, want a no such file or directory error", err)
	}
}
