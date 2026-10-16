package docker

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func agedMigrationDir(t *testing.T, store *migrationArtifactStore, id string, dirAge, fileAge time.Duration, now time.Time) {
	t.Helper()
	dir := filepath.Join(store.root, id)
	file := filepath.Join(dir, "image")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, now.Add(-fileAge), now.Add(-fileAge)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(dir, now.Add(-dirAge), now.Add(-dirAge)); err != nil {
		t.Fatal(err)
	}
}

func TestStaleMigrationSpoolsGoAndLiveOnesStay(t *testing.T) {
	now := time.Now()
	store, err := newMigrationArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agedMigrationDir(t, store, "abandoned", 7*time.Hour, 7*time.Hour, now)
	agedMigrationDir(t, store, "receiving", 7*time.Hour, time.Minute, now) // a long transfer writing one artifact
	agedMigrationDir(t, store, "sending", 7*time.Hour, 7*time.Hour, now)   // a long transfer reading one artifact
	agedMigrationDir(t, store, "paused", 5*time.Hour, 5*time.Hour, now)
	store.touch("sending")

	if err := store.cleanupStale(now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.root, "abandoned")); !os.IsNotExist(err) {
		t.Fatalf("abandoned spool stays: %v", err)
	}
	for _, live := range []string{"receiving", "sending", "paused"} {
		if _, err := os.Stat(filepath.Join(store.root, live, "image")); err != nil {
			t.Errorf("%s spool removed: %v", live, err)
		}
	}
}

func TestStaleMigrationCleanupContinuesPastAFailure(t *testing.T) {
	now := time.Now()
	store, err := newMigrationArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agedMigrationDir(t, store, "a-stuck", 7*time.Hour, 7*time.Hour, now)
	agedMigrationDir(t, store, "b-abandoned", 7*time.Hour, 7*time.Hour, now)
	store.removeAll = func(path string) error {
		if strings.HasSuffix(path, "a-stuck") {
			return errors.New("device or resource busy")
		}
		return os.RemoveAll(path)
	}
	if err := store.cleanupStale(now); err == nil || !strings.Contains(err.Error(), "a-stuck") {
		t.Fatalf("error = %v, want the stuck spool named", err)
	}
	if _, err := os.Stat(filepath.Join(store.root, "b-abandoned")); !os.IsNotExist(err) {
		t.Fatalf("the spool after the stuck one stays: %v", err)
	}
}

func TestMigrationSpoolKeepsTheNodeReserve(t *testing.T) {
	const gib = int64(1) << 30
	store := &migrationArtifactStore{root: t.TempDir(), reserve: 2 * gib, statfs: statfsWithFree(5 * gib)}
	if err := store.checkSpace(2 * gib); err != nil {
		t.Fatalf("a 2 GiB artifact on 5 GiB free with a 2 GiB reserve: %v", err)
	}
	var spaceErr *migrationSpoolSpaceError
	if err := store.checkSpace(4 * gib); !errors.As(err, &spaceErr) {
		t.Fatalf("a 4 GiB artifact was admitted: %v", err)
	}

	// Mid-stream: the disk fills from elsewhere while the artifact is written.
	free := 3 * gib
	store.statfs = func(_ string, stat *unix.Statfs_t) error {
		stat.Bsize = 4096
		stat.Bavail = uint64(free / 4096)
		return nil
	}
	var sink bytes.Buffer
	writer := &guardedSpoolWriter{writer: &sink, guard: store.guard("m1", 0)}
	chunk := make([]byte, 1<<20)
	for written := 0; written < migrationSpaceCheckBytes; written += len(chunk) {
		if _, err := writer.Write(chunk); err != nil {
			t.Fatalf("write stopped with space left: %v", err)
		}
	}
	free = 2*gib - 1
	var stopErr error
	for written := 0; written <= migrationSpaceCheckBytes && stopErr == nil; written += len(chunk) {
		_, stopErr = writer.Write(chunk)
	}
	if !errors.As(stopErr, &spaceErr) {
		t.Fatalf("the write went on below the reserve: %v", stopErr)
	}
	if store.lastActive("m1").IsZero() {
		t.Fatal("a spool write did not mark the migration in use")
	}
}

func TestMigrationArtifactCannotOutgrowItsDeclaredSize(t *testing.T) {
	store := &migrationArtifactStore{root: t.TempDir(), statfs: statfsWithFree(1 << 40)}
	declared := int64(10 << 20)
	writer := &guardedSpoolWriter{writer: &bytes.Buffer{}, guard: store.guard("m1", migrationArtifactLimit(declared))}
	if _, err := writer.Write(make([]byte, declared)); err != nil {
		t.Fatalf("the declared size was refused: %v", err)
	}
	var err error
	for i := 0; i < 1024 && err == nil; i++ {
		_, err = writer.Write(make([]byte, 1<<20))
	}
	if err == nil || !strings.Contains(err.Error(), "declared size") {
		t.Fatalf("the artifact grew without limit: %v", err)
	}
	if migrationArtifactLimit(0) != 0 {
		t.Fatal("an undeclared size got a limit")
	}
}
