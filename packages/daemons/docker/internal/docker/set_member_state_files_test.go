package docker

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/opfield/opfield/docker-daemon/internal/config"
)

const (
	stateSetKept    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	stateSetGone    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	stateSetRecord  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	stateMemberID   = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	stateDatabaseID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
)

func writeStateFile(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"dataEpoch":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func stateFilePlugin(t *testing.T) (*DockerPlugin, string) {
	t.Helper()
	cfg := &config.Config{}
	cfg.StateDir = t.TempDir()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &DockerPlugin{cfg: cfg, logger: logger, databaseManager: &managedDatabaseManager{root: root, logger: logger}}, cfg.StateDir
}

// DB-O-3: the daemon's start removes the Postgres state and Valkey ACL
// markers of sets it has no member of and no record names; those of sets it
// still has a member of (or a record names) stay, and so do other files.
func TestSweepRemovesStateFilesOfSetsTheNodeNoLongerHas(t *testing.T) {
	p, dir := stateFilePlugin(t)
	keptPG := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetKept+".json"))
	keptKV := writeStateFile(t, filepath.Join(dir, kvMemberStateDir, stateSetKept+"-"+stateMemberID+".acl-mirrored"))
	recordPG := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetRecord+".json"))
	gonePG := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetGone+".json"))
	goneKV := writeStateFile(t, filepath.Join(dir, kvMemberStateDir, stateSetGone+"-"+stateMemberID+".acl-mirrored"))
	other := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, "not-a-set.json"))
	root := p.databaseManager.root
	record, err := json.Marshal(managedDatabaseRecord{ID: stateDatabaseID, Type: "postgres", AvailabilitySetID: stateSetRecord,
		ImagePath: filepath.Join(root, "images", stateDatabaseID+".img"), MountPath: filepath.Join(root, "mounts", stateDatabaseID)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.databaseManager.root, "records", stateDatabaseID+".json"), record, 0o600); err != nil {
		t.Fatal(err)
	}

	p.sweepSetMemberStateOrphans(func() []string { return []string{stateSetKept} })

	for _, path := range []string{keptPG, keptKV, recordPG, other} {
		if !exists(path) {
			t.Fatalf("%s must stay", path)
		}
	}
	for _, path := range []string{gonePG, goneKV} {
		if exists(path) {
			t.Fatalf("%s of a set the node no longer has must go", path)
		}
	}
}

// Without readable records the sweep cannot tell which sets a member still
// needs: it removes nothing.
func TestSweepKeepsEverythingWithoutReadableRecords(t *testing.T) {
	p, dir := stateFilePlugin(t)
	gone := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetGone+".json"))
	if err := os.WriteFile(filepath.Join(p.databaseManager.root, "records", stateDatabaseID+".json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	p.sweepSetMemberStateOrphans(func() []string { return nil })
	if !exists(gone) {
		t.Fatal("with an unreadable record nothing may be removed")
	}
}

// DB-O-3: a member the runtime forgot (lift, removal, set deleted) takes its
// set's state files with it; other sets keep theirs.
func TestForgottenMemberTakesItsStateFiles(t *testing.T) {
	p, dir := stateFilePlugin(t)
	gonePG := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetGone+".json"))
	goneKV := writeStateFile(t, filepath.Join(dir, kvMemberStateDir, stateSetGone+"-"+stateMemberID+".acl-mirrored"))
	kept := writeStateFile(t, filepath.Join(dir, pgMemberStateDir, stateSetKept+".json"))
	p.forgetSetMemberState(stateSetGone)
	if exists(gonePG) || exists(goneKV) {
		t.Fatal("the forgotten set's state files must go")
	}
	if !exists(kept) {
		t.Fatal("another set's state file must stay")
	}
}
