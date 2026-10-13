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

// withHadLegacyNames makes the host one that ran components under the old
// names (had) or one installed with the Opfield names.
func withHadLegacyNames(t *testing.T, had bool) {
	t.Helper()
	saved := hadLegacyNames
	hadLegacyNames = func() bool { return had }
	t.Cleanup(func() { hadLegacyNames = saved })
}

func TestEnsureRunDirMeetsComponentsOfEitherRelease(t *testing.T) {
	withHadLegacyNames(t, true)
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

// appHostFixture is a host that runs the app and a node daemon: the node
// daemon's data under the old name, the app's sandbox workspaces under the new
// one (its host move binds them there), and the empty workspace directory the
// app left under the old name.
func appHostFixture(t *testing.T, oldWorkspace bool) Pair {
	t.Helper()
	p := pairIn(t)
	writeFile(t, filepath.Join(p.Old, "host-identity"), "id-7\n")
	writeFile(t, filepath.Join(p.Old, "builder", "shared", "state.json"), "{}")
	if err := os.MkdirAll(filepath.Join(p.Old, "sandbox-workspaces"), 0o755); err != nil {
		t.Fatal(err)
	}
	if oldWorkspace {
		writeFile(t, filepath.Join(p.Old, "sandbox-workspaces", "run-old", "out.txt"), "old run")
		writeFile(t, filepath.Join(p.Old, "sandbox-workspaces", "shared", "a.txt"), "a")
	}
	writeFile(t, filepath.Join(p.New, "sandbox-workspaces", "run-new", "out.txt"), "new run")
	writeFile(t, filepath.Join(p.New, "sandbox-workspaces", "shared", "b.txt"), "b")
	writeFile(t, filepath.Join(p.New, "cloud-init", "marker"), "m")
	return p
}

func assertAppHostMerged(t *testing.T, p Pair, oldWorkspace bool, workspace os.FileInfo) {
	t.Helper()
	assertMoved(t, p, "host-identity", "id-7\n")
	for file, content := range map[string]string{
		"builder/shared/state.json":          "{}",
		"sandbox-workspaces/run-new/out.txt": "new run",
		"sandbox-workspaces/shared/b.txt":    "b",
		"cloud-init/marker":                  "m",
	} {
		if got := readFile(t, filepath.Join(p.New, file)); got != content {
			t.Fatalf("%s = %q, want %q", file, got, content)
		}
	}
	if oldWorkspace {
		if got := readFile(t, filepath.Join(p.New, "sandbox-workspaces", "run-old", "out.txt")); got != "old run" {
			t.Fatalf("old run = %q", got)
		}
		if got := readFile(t, filepath.Join(p.New, "sandbox-workspaces", "shared", "a.txt")); got != "a" {
			t.Fatalf("old shared = %q", got)
		}
	}
	// The app's workspace directory is the same directory as before (a running
	// container binds it), not a copy.
	now, err := os.Stat(filepath.Join(p.New, "sandbox-workspaces"))
	if err != nil || !os.SameFile(now, workspace) {
		t.Fatalf("the sandbox workspace directory was replaced: %v", err)
	}
}

// F-2: on an app host that is also a node, the new directory holds only what
// the app put there; the move carries it into the node's directory and
// finishes, with the sandbox workspaces on both sides (empty or not).
func TestMoveMergesWhatTheNewReleaseCreatedFirst(t *testing.T) {
	for _, oldWorkspace := range []bool{false, true} {
		p := appHostFixture(t, oldWorkspace)
		workspace, err := os.Stat(filepath.Join(p.New, "sandbox-workspaces"))
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := Move(p)
		if err != nil || outcome != Moved {
			t.Fatalf("old workspace %v: Move = %s, %v", oldWorkspace, outcome, err)
		}
		assertAppHostMerged(t, p, oldWorkspace, workspace)
		if outcome, err := Move(p); err != nil || outcome != Done {
			t.Fatalf("second Move = %s, %v", outcome, err)
		}
	}
}

// A crash at any step of the merge leaves a state the next Move finishes.
func TestMoveFinishesAMergeAfterACrashAtEveryStep(t *testing.T) {
	saved := mergeStep
	t.Cleanup(func() { mergeStep = saved })
	for _, oldWorkspace := range []bool{false, true} {
		steps := 0
		mergeStep = func() error { steps++; return nil }
		p := appHostFixture(t, oldWorkspace)
		if _, err := Move(p); err != nil {
			t.Fatal(err)
		}
		if steps < 3 {
			t.Fatalf("old workspace %v: the merge took %d steps", oldWorkspace, steps)
		}
		for crashAt := 1; crashAt <= steps; crashAt++ {
			p := appHostFixture(t, oldWorkspace)
			workspace, err := os.Stat(filepath.Join(p.New, "sandbox-workspaces"))
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			crash := errors.New("crash")
			mergeStep = func() error {
				count++
				if count == crashAt {
					return crash
				}
				return nil
			}
			if outcome, err := Move(p); outcome != Conflict || !errors.Is(err, crash) {
				t.Fatalf("crash at %d: Move = %s, %v", crashAt, outcome, err)
			}
			// Until the move finishes, the old directory stays in use.
			if Resolve(p) != p.Old || readFile(t, filepath.Join(p.Old, "host-identity")) != "id-7\n" {
				t.Fatalf("crash at %d: Resolve = %s", crashAt, Resolve(p))
			}
			mergeStep = func() error { return nil }
			if outcome, err := Move(p); err != nil || outcome != Moved {
				t.Fatalf("after a crash at %d: Move = %s, %v", crashAt, outcome, err)
			}
			assertAppHostMerged(t, p, oldWorkspace, workspace)
		}
	}
}

// Entries of the same name that do not merge (a file in both) are a conflict,
// found before anything moves.
func TestMoveMergeConflictChangesNothing(t *testing.T) {
	p := appHostFixture(t, true)
	writeFile(t, filepath.Join(p.Old, "sandbox-workspaces", "shared", "b.txt"), "old b")
	outcome, err := Move(p)
	if outcome != Conflict || !errors.Is(err, ErrConflict) {
		t.Fatalf("Move = %s, %v; want a conflict", outcome, err)
	}
	for path, content := range map[string]string{
		filepath.Join(p.Old, "sandbox-workspaces", "shared", "b.txt"):    "old b",
		filepath.Join(p.Old, "sandbox-workspaces", "shared", "a.txt"):    "a",
		filepath.Join(p.New, "sandbox-workspaces", "shared", "b.txt"):    "b",
		filepath.Join(p.New, "sandbox-workspaces", "run-new", "out.txt"): "new run",
		filepath.Join(p.New, "cloud-init", "marker"):                     "m",
	} {
		if got := readFile(t, path); got != content {
			t.Fatalf("a conflict changed %s: %q", path, got)
		}
	}
	if _, err := os.Lstat(filepath.Join(p.Old, "cloud-init")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a conflict moved an entry")
	}
	if Resolve(p) != p.Old || !Legacy(p) {
		t.Fatal("in a conflict the old directory stays in use")
	}
}

// O-2: a host installed with the Opfield names gets no old name: neither a
// run directory created at boot nor a directory Move finds only under its new
// name links the old one.
func TestFreshHostGetsNoOldNames(t *testing.T) {
	withHadLegacyNames(t, false)
	p := pairIn(t)
	path, err := EnsureRunDir(p, 0o755)
	if err != nil || path != p.New {
		t.Fatalf("EnsureRunDir = %s, %v", path, err)
	}
	if _, err := os.Lstat(p.Old); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a fresh host got the old run directory name: %v", err)
	}
	q := pairIn(t)
	writeFile(t, filepath.Join(q.New, "host-identity"), "id-8\n")
	if outcome, err := Move(q); err != nil || outcome != Done {
		t.Fatalf("Move = %s, %v", outcome, err)
	}
	if _, err := os.Lstat(q.Old); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a fresh host got the old state directory name: %v", err)
	}
	if Resolve(q) != q.New || Legacy(q) {
		t.Fatal("a fresh host uses the new name")
	}
	// A caller that knows its node had the old names links them.
	r := pairIn(t)
	if _, err := EnsureRunDirLinked(r, 0o755, true); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(r.Old); err != nil || target != filepath.Base(r.New) {
		t.Fatalf("old name links to %q (%v)", target, err)
	}
}

// Without rename exchange, a crash between the rename and the link leaves the
// staging link, which marks the move: the next Move links the old name.
func TestMoveFallbackCrashAfterTheRenameStillLinks(t *testing.T) {
	withHadLegacyNames(t, false)
	saved := exchangeFn
	exchangeFn = func(string, string) error { return errExchangeUnsupported }
	t.Cleanup(func() { exchangeFn = saved })
	p := pairIn(t)
	writeFile(t, filepath.Join(p.Old, "host-identity"), "id-9\n")
	// The first steps of the fallback: the staging link, then the rename.
	if err := os.Symlink(filepath.Base(p.New), p.stagingPath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p.Old, p.New); err != nil {
		t.Fatal(err)
	}
	if outcome, err := Move(p); err != nil || outcome != Done {
		t.Fatalf("Move = %s, %v", outcome, err)
	}
	assertMoved(t, p, "host-identity", "id-9\n")
}
