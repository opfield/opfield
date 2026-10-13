package pages

import (
	"os"
	"path/filepath"
	"testing"
)

// F-9: Pages configs are written and tested at once and their reload is left
// to the handler: with defer_reload that of their batch, otherwise one shortly
// after the last Pages change. Without a deferred reload set up each change
// still reloads at once.
func TestPagesConfigsLoadWithTheReloadOfTheirBatch(t *testing.T) {
	dir := t.TempDir()
	nginx := &fakeNginx{valid: true}
	runtime := &Runtime{configDir: dir, nginx: nginx}
	begins, undos, schedules, batches := 0, 0, 0, 0
	runtime.SetDeferredReload(func() (func(), error) {
		begins++
		return func() { undos++ }, nil
	}, func(batch bool) {
		schedules++
		if batch {
			batches++
		}
	})

	for i, name := range []string{"pages-preview-a.conf", "pages-preview-b.conf", "pages-preview-c.conf"} {
		path := filepath.Join(dir, name)
		if err := runtime.applyConfigWith(path, []byte("server { # "+name+" }\n"), true); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("config %d not written: %v", i, err)
		}
	}
	if nginx.reloadCalls != 0 || nginx.testCalls != 3 || begins != 3 || schedules != 3 || batches != 3 {
		t.Fatalf("reloads %d, tests %d, begins %d, schedules %d, batches %d", nginx.reloadCalls, nginx.testCalls, begins, schedules, batches)
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
	// Without the flag, a removal too: tested at once, loaded shortly after the last Pages change.
	nginx.valid = true
	if err := runtime.applyConfigWith(filepath.Join(dir, "pages-preview-e.conf"), []byte("server {}\n"), false); err != nil {
		t.Fatal(err)
	}
	if err := runtime.applyConfig(filepath.Join(dir, "pages-preview-a.conf"), nil); err != nil {
		t.Fatal(err)
	}
	if nginx.reloadCalls != 0 || schedules != 5 || batches != 3 {
		t.Fatalf("changes without the flag: reloads %d, schedules %d, batches %d", nginx.reloadCalls, schedules, batches)
	}
	// No deferred reload set up: every change reloads at once.
	plain := &Runtime{configDir: dir, nginx: nginx}
	if err := plain.applyConfigWith(filepath.Join(dir, "pages-preview-f.conf"), []byte("server {}\n"), true); err != nil || nginx.reloadCalls != 1 {
		t.Fatalf("flag without deferred reload: %v, reloads %d", err, nginx.reloadCalls)
	}
}
