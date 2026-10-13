package pages

import (
	"os"
	"path/filepath"
	"testing"
)

// F-9: Pages configs sent with defer_reload are written and tested at once and
// load with one reload of their batch; without the flag, or without a
// deferred reload set up, each change still reloads at once.
func TestPagesConfigsLoadWithTheReloadOfTheirBatch(t *testing.T) {
	dir := t.TempDir()
	nginx := &fakeNginx{valid: true}
	runtime := &Runtime{configDir: dir, nginx: nginx}
	begins, undos, schedules := 0, 0, 0
	runtime.SetDeferredReload(func() (func(), error) {
		begins++
		return func() { undos++ }, nil
	}, func() { schedules++ })

	for i, name := range []string{"pages-preview-a.conf", "pages-preview-b.conf", "pages-preview-c.conf"} {
		path := filepath.Join(dir, name)
		if err := runtime.applyConfigWith(path, []byte("server { # "+name+" }\n"), true); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("config %d not written: %v", i, err)
		}
	}
	if nginx.reloadCalls != 0 || nginx.testCalls != 3 || begins != 3 || schedules != 3 {
		t.Fatalf("reloads %d, tests %d, begins %d, schedules %d", nginx.reloadCalls, nginx.testCalls, begins, schedules)
	}
	// Unchanged content: nothing marked, written or scheduled.
	if err := runtime.applyConfigWith(filepath.Join(dir, "pages-preview-a.conf"), []byte("server { # pages-preview-a.conf }\n"), true); err != nil {
		t.Fatal(err)
	}
	if begins != 3 || schedules != 3 {
		t.Fatalf("an unchanged config was marked or scheduled: begins %d, schedules %d", begins, schedules)
	}
	// A config nginx rejects is restored and its mark taken back.
	nginx.valid = false
	if err := runtime.applyConfigWith(filepath.Join(dir, "pages-preview-d.conf"), []byte("broken"), true); err == nil {
		t.Fatal("a rejected config was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "pages-preview-d.conf")); !os.IsNotExist(err) || undos != 1 || schedules != 3 {
		t.Fatalf("rejected config: stat %v, undos %d, schedules %d", err, undos, schedules)
	}
	// Without the flag: at once.
	nginx.valid = true
	if err := runtime.applyConfigWith(filepath.Join(dir, "pages-preview-e.conf"), []byte("server {}\n"), false); err != nil || nginx.reloadCalls != 1 {
		t.Fatalf("immediate change: %v, reloads %d", err, nginx.reloadCalls)
	}
	// No deferred reload set up: the flag reloads at once.
	plain := &Runtime{configDir: dir, nginx: nginx}
	if err := plain.applyConfigWith(filepath.Join(dir, "pages-preview-f.conf"), []byte("server {}\n"), true); err != nil || nginx.reloadCalls != 2 {
		t.Fatalf("flag without deferred reload: %v, reloads %d", err, nginx.reloadCalls)
	}
}
