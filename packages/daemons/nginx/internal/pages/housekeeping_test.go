package pages

import (
	"archive/tar"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func runtimeConfigVersionNames(t *testing.T, r *Runtime, kind RuntimeConfigBindingKind, bindingID string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(r.runtimeConfigBindingDir(kind, bindingID), "versions"))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func publishRuntimeConfig(t *testing.T, r *Runtime, generation uint64) {
	t.Helper()
	if err := r.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, generation, []byte(`{"generation":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, generation); err != nil {
		t.Fatal(err)
	}
}

func setModified(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestActivateRuntimeConfigKeepsActiveAndRollbackGenerationOnly(t *testing.T) {
	r, _ := newRuntime(t)
	for generation := uint64(1); generation <= 5; generation++ {
		publishRuntimeConfig(t, r, generation)
	}
	if got := runtimeConfigVersionNames(t, r, RuntimeConfigBindingRoute, routeID); strings.Join(got, ",") != "4.js,5.js" {
		t.Fatalf("versions after five publications = %v, want the active one and its predecessor", got)
	}
	// Rolling back to the predecessor keeps the generation it replaced (a retry may activate it again).
	if _, err := r.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 4); err != nil {
		t.Fatal(err)
	}
	if got := runtimeConfigVersionNames(t, r, RuntimeConfigBindingRoute, routeID); strings.Join(got, ",") != "4.js,5.js" {
		t.Fatalf("versions after rollback = %v", got)
	}
}

func TestActivateRuntimeConfigKeepsGenerationStagedForTheNextActivation(t *testing.T) {
	r, _ := newRuntime(t)
	publishRuntimeConfig(t, r, 1)
	publishRuntimeConfig(t, r, 2)
	// Generation 4 is staged by a publication that has not activated it yet.
	if err := r.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 4, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	publishRuntimeConfig(t, r, 3)
	if got := runtimeConfigVersionNames(t, r, RuntimeConfigBindingRoute, routeID); strings.Join(got, ",") != "2.js,3.js,4.js" {
		t.Fatalf("versions = %v", got)
	}
	if _, err := r.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 4); err != nil {
		t.Fatalf("activating the staged generation: %v", err)
	}
}

func TestSweepPrunesRuntimeConfigHistoryOfExistingNodes(t *testing.T) {
	r, _ := newRuntime(t)
	publishRuntimeConfig(t, r, 1)
	versionsDir := filepath.Join(r.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "versions")
	// History an older daemon left behind, plus a long-abandoned newer stage and a fresh one.
	now := time.Now()
	for _, name := range []string{"10.js", "11.js", "12.js", "20.js", "21.js"} {
		if err := os.WriteFile(filepath.Join(versionsDir, name), []byte("x"), publicFileMode); err != nil {
			t.Fatal(err)
		}
	}
	setModified(t, filepath.Join(versionsDir, "20.js"), now.Add(-2*time.Hour))
	if err := os.Remove(filepath.Join(r.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "current.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("versions", "12.js"), filepath.Join(r.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID), "current.js")); err != nil {
		t.Fatal(err)
	}
	result, err := r.Sweep(now, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeConfigVersionNames(t, r, RuntimeConfigBindingRoute, routeID); strings.Join(got, ",") != "11.js,12.js,21.js" {
		t.Fatalf("versions after sweep = %v", got)
	}
	if result.RuntimeConfigVersions != 3 {
		t.Fatalf("removed %d versions, want 3", result.RuntimeConfigVersions)
	}
	if path, err := r.RuntimeConfigPath(RuntimeConfigBindingRoute, routeID); err != nil {
		t.Fatal(err)
	} else if _, err := os.Stat(path); err != nil {
		t.Fatalf("current.js no longer resolves: %v", err)
	}
}

func TestSweepLeavesBindingWithUnreadablePointer(t *testing.T) {
	r, _ := newRuntime(t)
	publishRuntimeConfig(t, r, 1)
	bindingDir := r.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID)
	if err := os.WriteFile(filepath.Join(bindingDir, "versions", "2.js"), []byte("x"), publicFileMode); err != nil {
		t.Fatal(err)
	}
	setModified(t, filepath.Join(bindingDir, "versions", "2.js"), time.Now().Add(-48*time.Hour))
	if err := os.Remove(filepath.Join(bindingDir, "current.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bindingDir, "current.js"), []byte("not a link"), publicFileMode); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Sweep(time.Now(), false); err != nil {
		t.Fatal(err)
	}
	if got := runtimeConfigVersionNames(t, r, RuntimeConfigBindingRoute, routeID); strings.Join(got, ",") != "1.js,2.js" {
		t.Fatalf("versions = %v", got)
	}
}

func TestSweepRemovesAbandonedUploadsOnly(t *testing.T) {
	r, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	const abandoned = "44444444-4444-4444-4444-444444444444"
	if err := r.InitUpload(abandoned, "55555555-5555-5555-5555-555555555555", int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(abandoned, 0, archive[:3]); err != nil {
		t.Fatal(err)
	}
	if err := r.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, archive[:3]); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-7 * time.Hour)
	setModified(t, r.uploadMetaPath(abandoned), old)
	setModified(t, r.uploadArchivePath(abandoned), old)
	// The live upload's meta is old, but its archive was appended to just now.
	setModified(t, r.uploadMetaPath(uploadID), old)
	result, err := r.Sweep(time.Now(), false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Uploads != 1 {
		t.Fatalf("removed %d uploads, want 1", result.Uploads)
	}
	for _, path := range []string{r.uploadMetaPath(abandoned), r.uploadArchivePath(abandoned)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s survived the sweep: %v", path, err)
		}
	}
	if _, err := r.AppendUpload(uploadID, 3, archive[3:]); err != nil {
		t.Fatalf("live upload broken by the sweep: %v", err)
	}
	if _, err := r.FinalizeUpload(uploadID, deploymentID); err != nil {
		t.Fatal(err)
	}
}

func TestNewUploadReplacesEarlierUploadOfTheSameDeployment(t *testing.T) {
	r, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	const retry = "66666666-6666-6666-6666-666666666666"
	const otherDeployment = "77777777-7777-7777-7777-777777777777"
	const other = "88888888-8888-8888-8888-888888888888"
	if err := r.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, archive[:3]); err != nil {
		t.Fatal(err)
	}
	if err := r.InitUpload(other, otherDeployment, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if err := r.InitUpload(retry, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(r.uploadArchivePath(uploadID)); !os.IsNotExist(err) {
		t.Fatalf("earlier upload of the Deployment kept: %v", err)
	}
	if _, err := os.Lstat(r.uploadMetaPath(other)); err != nil {
		t.Fatalf("upload of another Deployment removed: %v", err)
	}
	// Re-initializing the same upload keeps it.
	if err := r.InitUpload(retry, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(r.uploadMetaPath(retry)); err != nil {
		t.Fatal(err)
	}
}

func TestFailedFinalizeOfCompleteArchiveRemovesUpload(t *testing.T) {
	r, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "../escape", body: "x"}})
	if err := r.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, archive); err != nil {
		t.Fatal(err)
	}
	if _, err := r.FinalizeUpload(uploadID, deploymentID); err == nil {
		t.Fatal("finalize accepted an escaping archive")
	}
	if _, err := os.Lstat(r.uploadArchivePath(uploadID)); !os.IsNotExist(err) {
		t.Fatalf("failed upload kept: %v", err)
	}
}

func TestIncompleteFinalizeKeepsUpload(t *testing.T) {
	r, _ := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	if err := r.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, archive[:3]); err != nil {
		t.Fatal(err)
	}
	if _, err := r.FinalizeUpload(uploadID, deploymentID); err == nil {
		t.Fatal("finalize accepted an incomplete archive")
	}
	if _, err := os.Lstat(r.uploadArchivePath(uploadID)); err != nil {
		t.Fatalf("incomplete upload removed: %v", err)
	}
}

func TestSweepRemovesCrashLeftoverStages(t *testing.T) {
	r, _ := newRuntime(t)
	stageRelease(t, r)
	old := filepath.Join(r.releasesDir(), ".stage-"+deploymentID+"-123")
	fresh := filepath.Join(r.releasesDir(), ".stage-"+deploymentID+"-456")
	for _, dir := range []string{old, fresh} {
		if err := os.MkdirAll(filepath.Join(dir, "content"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	setModified(t, old, time.Now().Add(-2*time.Hour))
	result, err := r.Sweep(time.Now(), false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Stages != 1 {
		t.Fatalf("removed %d stages, want 1", result.Stages)
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatal("old stage kept")
	}
	for _, path := range []string{fresh, r.releaseDir(deploymentID)} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s removed: %v", path, err)
		}
	}
}

func TestSweepExpiresOldRevokedPreviewsWhenAllowed(t *testing.T) {
	r, nginx := newRuntime(t)
	stageRelease(t, r)
	for _, hostname := range []string{"old.pages.example", "recent.pages.example", "live.pages.example"} {
		if err := r.MaterializePreview(profileID, deploymentID, hostname, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, hostname := range []string{"old.pages.example", "recent.pages.example"} {
		if err := r.RemovePreview(hostname); err != nil {
			t.Fatal(err)
		}
	}
	monthAgo := time.Now().Add(-31 * 24 * time.Hour)
	setModified(t, r.previewConfigPath("old.pages.example"), monthAgo)
	setModified(t, r.previewConfigPath("live.pages.example"), monthAgo)
	if result, err := r.Sweep(time.Now(), false); err != nil || result.RevokedPreviews != 0 {
		t.Fatalf("sweep without the default server removed previews: %#v, %v", result, err)
	}
	reloads := nginx.reloadCalls
	result, err := r.Sweep(time.Now(), true)
	if err != nil {
		t.Fatal(err)
	}
	if result.RevokedPreviews != 1 || nginx.reloadCalls != reloads+1 {
		t.Fatalf("result %#v, reloads %d", result, nginx.reloadCalls-reloads)
	}
	if _, err := os.Lstat(r.previewConfigPath("old.pages.example")); !os.IsNotExist(err) {
		t.Fatal("expired tombstone kept")
	}
	for _, hostname := range []string{"recent.pages.example", "live.pages.example"} {
		if _, err := os.Lstat(r.previewConfigPath(hostname)); err != nil {
			t.Fatalf("%s removed: %v", hostname, err)
		}
	}
}

func TestSweepRestoresRevokedPreviewsWhenNginxRejectsTheChange(t *testing.T) {
	r, nginx := newRuntime(t)
	stageRelease(t, r)
	if err := r.MaterializePreview(profileID, deploymentID, "old.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := r.RemovePreview("old.pages.example"); err != nil {
		t.Fatal(err)
	}
	setModified(t, r.previewConfigPath("old.pages.example"), time.Now().Add(-31*24*time.Hour))
	nginx.valid = false
	if _, err := r.Sweep(time.Now(), true); err == nil {
		t.Fatal("sweep ignored the failed nginx test")
	}
	content, err := os.ReadFile(r.previewConfigPath("old.pages.example"))
	if err != nil || !isRevokedPreview(content) {
		t.Fatalf("tombstone not restored: %v", err)
	}
}

func TestReleaseExtractionKeepsTheNodeReserve(t *testing.T) {
	r, _ := newRuntime(t)
	original := filesystemSpace
	t.Cleanup(func() { filesystemSpace = original })
	// 100 MiB filesystem, 10 MiB + 100 bytes free: the reserve (10 MiB) leaves 100 bytes for Pages.
	filesystemSpace = func(string) (int64, int64, error) { return 10<<20 + 100, 100 << 20, nil }
	preflight, err := r.StoragePreflight(200)
	if err != nil || preflight.Available {
		t.Fatalf("preflight inside the reserve: %#v, %v", preflight, err)
	}
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: strings.Repeat("a", 4096)}})
	if err := r.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, archive); err != nil {
		t.Fatal(err)
	}
	if _, err := r.FinalizeUpload(uploadID, deploymentID); err == nil || !strings.Contains(err.Error(), "reserve") {
		t.Fatalf("finalize = %v, want the reserve refusal", err)
	}
	if _, err := os.Lstat(r.releaseDir(deploymentID)); !os.IsNotExist(err) {
		t.Fatal("release stored inside the reserve")
	}
	filesystemSpace = func(string) (int64, int64, error) { return 50 << 20, 100 << 20, nil }
	small := archiveBytes(t, []tarEntry{{name: "index.html", typeflag: tar.TypeReg, body: "ok"}})
	if err := r.InitUpload(uploadID, deploymentID, int64(len(small)), digestOf(small)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AppendUpload(uploadID, 0, small); err != nil {
		t.Fatal(err)
	}
	if _, err := r.FinalizeUpload(uploadID, deploymentID); err != nil {
		t.Fatal(err)
	}
}
