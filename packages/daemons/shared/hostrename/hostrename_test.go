package hostrename

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func pairIn(t *testing.T) Pair {
	t.Helper()
	root := t.TempDir()
	return Pair{Old: filepath.Join(root, "gateway"), New: filepath.Join(root, "opfield")}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// assertMoved checks the end state of every move: the data under the new name,
// the old name a link to it, nothing left over.
func assertMoved(t *testing.T, p Pair, file, content string) {
	t.Helper()
	info, err := os.Lstat(p.New)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("new name is not a real directory: %v %v", info, err)
	}
	if target, err := os.Readlink(p.Old); err != nil || target != filepath.Base(p.New) {
		t.Fatalf("old name links to %q (%v), want %q", target, err, filepath.Base(p.New))
	}
	if got := readFile(t, filepath.Join(p.Old, file)); got != content {
		t.Fatalf("through the old name: %q, want %q", got, content)
	}
	if got := readFile(t, filepath.Join(p.New, file)); got != content {
		t.Fatalf("under the new name: %q, want %q", got, content)
	}
	if _, err := os.Lstat(p.stagingPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging entry left over: %v", err)
	}
	if Resolve(p) != p.New || Legacy(p) {
		t.Fatalf("Resolve = %s, Legacy = %v after the move", Resolve(p), Legacy(p))
	}
}

func TestMoveRenamesAndLinksTheOldName(t *testing.T) {
	for _, withExchange := range []bool{true, false} {
		p := pairIn(t)
		if !withExchange {
			saved := exchangeFn
			exchangeFn = func(string, string) error { return errExchangeUnsupported }
			t.Cleanup(func() { exchangeFn = saved })
		}
		writeFile(t, filepath.Join(p.Old, "host-identity"), "id-1\n")
		if Resolve(p) != p.Old || !Legacy(p) {
			t.Fatal("before the move the old directory is the one in use")
		}
		outcome, err := Move(p)
		if err != nil || outcome != Moved {
			t.Fatalf("exchange=%v: Move = %s, %v", withExchange, outcome, err)
		}
		assertMoved(t, p, "host-identity", "id-1\n")
		outcome, err = Move(p)
		if err != nil || outcome != Done {
			t.Fatalf("second Move = %s, %v; want done", outcome, err)
		}
		assertMoved(t, p, "host-identity", "id-1\n")
	}
}

func TestMoveWithNothingToMove(t *testing.T) {
	p := pairIn(t)
	if outcome, err := Move(p); err != nil || outcome != Absent {
		t.Fatalf("Move = %s, %v; want absent", outcome, err)
	}
	if Resolve(p) != p.New {
		t.Fatal("with neither name the new one is used")
	}
}

// Every state a crash between two steps of a move can leave is finished by
// the next Move.
func TestMoveFinishesAnInterruptedMove(t *testing.T) {
	t.Run("between the two renames of an exchange", func(t *testing.T) {
		p := pairIn(t)
		writeFile(t, filepath.Join(p.stagingPath(), "host-identity"), "id-2\n")
		if err := os.Symlink(filepath.Base(p.New), p.Old); err != nil {
			t.Fatal(err)
		}
		if outcome, err := Move(p); err != nil || outcome != Moved {
			t.Fatalf("Move = %s, %v", outcome, err)
		}
		assertMoved(t, p, "host-identity", "id-2\n")
	})
	t.Run("after the rename, before the link", func(t *testing.T) {
		p := pairIn(t)
		writeFile(t, filepath.Join(p.New, "host-identity"), "id-3\n")
		if err := os.Symlink(filepath.Base(p.New), p.stagingPath()); err != nil {
			t.Fatal(err)
		}
		if outcome, err := Move(p); err != nil || outcome != Done {
			t.Fatalf("Move = %s, %v", outcome, err)
		}
		assertMoved(t, p, "host-identity", "id-3\n")
	})
	t.Run("a stale link before the exchange", func(t *testing.T) {
		p := pairIn(t)
		writeFile(t, filepath.Join(p.Old, "host-identity"), "id-4\n")
		if err := os.Symlink(filepath.Base(p.New), p.stagingPath()); err != nil {
			t.Fatal(err)
		}
		if outcome, err := Move(p); err != nil || outcome != Moved {
			t.Fatalf("Move = %s, %v", outcome, err)
		}
		assertMoved(t, p, "host-identity", "id-4\n")
	})
}

func TestMoveTakesOverTheOtherDirection(t *testing.T) {
	p := pairIn(t)
	writeFile(t, filepath.Join(p.Old, "host-identity"), "id-5\n")
	if err := os.Symlink(filepath.Base(p.Old), p.New); err != nil {
		t.Fatal(err)
	}
	if Resolve(p) != p.Old {
		t.Fatal("the old directory is the real one")
	}
	if outcome, err := Move(p); err != nil || outcome != Moved {
		t.Fatalf("Move = %s, %v", outcome, err)
	}
	assertMoved(t, p, "host-identity", "id-5\n")
}

func TestMoveLeavesTwoDirectoriesWithData(t *testing.T) {
	p := pairIn(t)
	writeFile(t, filepath.Join(p.Old, "host-identity"), "old\n")
	writeFile(t, filepath.Join(p.New, "host-identity"), "new\n")
	outcome, err := Move(p)
	if outcome != Conflict || !errors.Is(err, ErrConflict) {
		t.Fatalf("Move = %s, %v; want a conflict", outcome, err)
	}
	if readFile(t, filepath.Join(p.Old, "host-identity")) != "old\n" || readFile(t, filepath.Join(p.New, "host-identity")) != "new\n" {
		t.Fatal("a conflict changed a directory")
	}
	if Resolve(p) != p.Old || !Legacy(p) {
		t.Fatal("in a conflict the old directory, which older components use, stays in use and is reported")
	}
}

func TestMoveDropsAnEmptyDirectoryAnotherComponentCreated(t *testing.T) {
	p := pairIn(t)
	writeFile(t, filepath.Join(p.Old, "host-identity"), "id-6\n")
	if err := os.Mkdir(p.New, 0o755); err != nil {
		t.Fatal(err)
	}
	if outcome, err := Move(p); err != nil || outcome != Moved {
		t.Fatalf("Move = %s, %v", outcome, err)
	}
	assertMoved(t, p, "host-identity", "id-6\n")
}

func TestEnsureRunDirMeetsComponentsOfEitherRelease(t *testing.T) {
	t.Run("first after boot", func(t *testing.T) {
		p := pairIn(t)
		path, err := EnsureRunDir(p, 0o755)
		if err != nil || path != p.New {
			t.Fatalf("EnsureRunDir = %s, %v", path, err)
		}
		writeFile(t, filepath.Join(p.Old, "heartbeat"), "1")
		assertMoved(t, p, "heartbeat", "1")
		// An older component that runs MkdirAll on the old name later finds it.
		if err := os.MkdirAll(p.Old, 0o755); err != nil {
			t.Fatal(err)
		}
		assertMoved(t, p, "heartbeat", "1")
	})
	t.Run("an older component was first", func(t *testing.T) {
		p := pairIn(t)
		writeFile(t, filepath.Join(p.Old, "records", "a.json"), "{}")
		path, err := EnsureRunDir(p, 0o755)
		if err != nil || path != p.New {
			t.Fatalf("EnsureRunDir = %s, %v", path, err)
		}
		assertMoved(t, p, "records/a.json", "{}")
	})
	t.Run("an older component raced the creation", func(t *testing.T) {
		p := pairIn(t)
		if err := os.Mkdir(p.New, 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(p.Old, "heartbeat"), "2")
		path, err := EnsureRunDir(p, 0o755)
		if err != nil || path != p.New {
			t.Fatalf("EnsureRunDir = %s, %v", path, err)
		}
		assertMoved(t, p, "heartbeat", "2")
	})
}

func TestWithLockAndPathHelpers(t *testing.T) {
	p := pairIn(t)
	called := false
	if err := WithLock(p, func() error { called = true; return nil }); err != nil || !called {
		t.Fatalf("WithLock = %v, called %v", err, called)
	}
	if !p.IsOldName(filepath.Join(p.Old, "x")) || p.IsOldName(p.New) {
		t.Fatal("IsOldName")
	}
	if got := p.ToNew(filepath.Join(p.Old, "x")); got != filepath.Join(p.New, "x") {
		t.Fatalf("ToNew = %s", got)
	}
	if err := (Pair{Old: "/a/x", New: "/b/y"}).validate(); err == nil {
		t.Fatal("names in different directories must be refused")
	}
}
