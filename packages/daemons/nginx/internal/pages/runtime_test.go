package pages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const (
	uploadID     = "11111111-1111-1111-1111-111111111111"
	deploymentID = "22222222-2222-2222-2222-222222222222"
	routeID      = "33333333-3333-3333-3333-333333333333"
	profileID    = "default"
)

type fakeNginx struct {
	valid        bool
	validResults []bool
	testOutput   string
	testCalls    int
	reloadErr    error
	reloadCalls  int
}

func (f *fakeNginx) TestConfig() (bool, string) {
	result := f.valid
	if f.testCalls < len(f.validResults) {
		result = f.validResults[f.testCalls]
	}
	f.testCalls++
	return result, f.testOutput
}
func (f *fakeNginx) Reload() error { f.reloadCalls++; return f.reloadErr }

func TestFinalizeUploadConfinementAndImmutableOwnership(t *testing.T) {
	runtime, nginx := newRuntime(t)
	archive := archiveBytes(t, []tarEntry{
		{name: "./", typeflag: tar.TypeDir},
		{name: "./index.html", body: "hello"},
		{name: "./assets/", typeflag: tar.TypeDir},
		{name: "./assets/app.js", body: "console.log(1)"},
	})
	digest := digestOf(archive)
	if err := runtime.InitUpload(uploadID, deploymentID, int64(len(archive)), digest); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload(uploadID, 0, archive[:4]); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload(uploadID, 4, archive[4:]); err != nil {
		t.Fatal(err)
	}
	assertMode(t, runtime.uploadsDir(), privateDirectoryMode)
	assertMode(t, runtime.uploadArchivePath(uploadID), privateFileMode)
	assertMode(t, runtime.uploadMetaPath(uploadID), privateFileMode)
	manifest, err := runtime.FinalizeUpload(uploadID, deploymentID)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.FileCount != 2 || manifest.SHA256 != digest {
		t.Fatalf("unexpected manifest: %#v", manifest)
	}
	content, err := os.ReadFile(filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"))
	if err != nil || string(content) != "hello" {
		t.Fatalf("release content = %q, %v", content, err)
	}
	if nginx.reloadCalls != 0 {
		t.Fatal("archive finalize must not reload nginx")
	}
	assertMode(t, runtime.root, publicDirectoryMode)
	assertMode(t, runtime.releasesDir(), publicDirectoryMode)
	assertMode(t, runtime.releaseDir(deploymentID), publicDirectoryMode)
	assertMode(t, runtime.releaseContentDir(deploymentID), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"), publicFileMode)
	assertMode(t, filepath.Join(runtime.releaseContentDir(deploymentID), "assets"), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.releaseContentDir(deploymentID), "assets", "app.js"), publicFileMode)
	assertMode(t, runtime.uploadsDir(), privateDirectoryMode)

	if err := runtime.InitUpload("55555555-5555-5555-5555-555555555555", deploymentID, int64(len(archive)), strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload("55555555-5555-5555-5555-555555555555", 0, archive); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.FinalizeUpload("55555555-5555-5555-5555-555555555555", deploymentID); err == nil {
		t.Fatal("expected immutable release checksum failure")
	}
}

func TestFinalizeRejectsTraversalAndLinks(t *testing.T) {
	for _, entry := range []tarEntry{{name: "../escape", body: "no"}, {name: "/escape", body: "no"}, {name: "link", typeflag: tar.TypeSymlink, linkname: "../../escape"}} {
		t.Run(entry.name, func(t *testing.T) {
			runtime, _ := newRuntime(t)
			archive := archiveBytes(t, []tarEntry{entry})
			if err := runtime.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
				t.Fatal(err)
			}
			if _, err := runtime.AppendUpload(uploadID, 0, archive); err != nil {
				t.Fatal(err)
			}
			if _, err := runtime.FinalizeUpload(uploadID, deploymentID); err == nil {
				t.Fatal("expected unsafe archive rejection")
			}
			if _, err := os.Stat(runtime.releaseDir(deploymentID)); !os.IsNotExist(err) {
				t.Fatalf("unsafe archive left release behind: %v", err)
			}
		})
	}
}

func TestConfigSwitchRollsBackAndCleanupHonorsReferences(t *testing.T) {
	runtime, nginx := newRuntime(t)
	stageRelease(t, runtime)
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview-a.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	previewPath := runtime.previewConfigPath("preview-a.pages.example")
	preview, err := os.ReadFile(previewPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(preview), runtime.releaseContentDir(deploymentID)) || !strings.Contains(string(preview), "limit_except GET HEAD") {
		t.Fatalf("unexpected fixed preview config: %s", preview)
	}
	if err := runtime.CleanupDeployment(deploymentID); err == nil {
		t.Fatal("expected referenced release cleanup rejection")
	}
	if err := runtime.RemovePreview("preview-a.pages.example"); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ActivateTagRoute(routeID, deploymentID); err != nil {
		t.Fatal(err)
	}
	if err := runtime.CleanupDeployment(deploymentID); err == nil {
		t.Fatal("expected tag route reference rejection")
	}
	if err := runtime.DeactivateTagRoute(routeID); err != nil {
		t.Fatal(err)
	}
	if err := runtime.CleanupDeployment(deploymentID); err != nil {
		t.Fatal(err)
	}

	stageRelease(t, runtime)
	nginx.valid = false
	nginx.testOutput = "invalid config"
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview-b.pages.example", "", ""); err == nil {
		t.Fatal("expected test failure")
	}
	if _, err := os.Stat(runtime.previewConfigPath("preview-b.pages.example")); !os.IsNotExist(err) {
		t.Fatalf("failed config was not rolled back: %v", err)
	}
	nginx.valid = true
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview-b.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(runtime.previewConfigPath("preview-b.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	nginx.reloadErr = errors.New("reload unavailable")
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview-b.pages.example", "internal-66666666-6666-6666-6666-666666666666", strings.Repeat("6", 64)); err == nil {
		t.Fatal("expected reload failure")
	}
	after, err := os.ReadFile(runtime.previewConfigPath("preview-b.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("reload failure did not restore previous preview config")
	}
}

func TestConfigSwitchValidatesRestoredConfigBeforeRollbackReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "preview.conf")
	if err := os.WriteFile(path, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	fake := &fakeNginx{
		validResults: []bool{true, false},
		testOutput:   "restored config invalid",
		reloadErr:    errors.New("reload unavailable"),
	}
	runtime := &Runtime{nginx: fake}

	err := runtime.applyConfig(path, []byte("new"))
	if err == nil || !strings.Contains(err.Error(), "restored config test failed") {
		t.Fatalf("unexpected rollback error: %v", err)
	}
	content, readErr := os.ReadFile(path)
	if readErr != nil || string(content) != "old" {
		t.Fatalf("rollback content = %q, %v", content, readErr)
	}
	if fake.testCalls != 2 || fake.reloadCalls != 1 {
		t.Fatalf("unexpected validation/reload calls: tests=%d reloads=%d", fake.testCalls, fake.reloadCalls)
	}
}

func TestPreviewFallbackConfiguration(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)

	if err := runtime.MaterializePreview(profileID, deploymentID, "spa.pages.example", "", "", PreviewFallback{SPAFallback: true}); err != nil {
		t.Fatal(err)
	}
	spaConfig, err := os.ReadFile(runtime.previewConfigPath("spa.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(spaConfig), "try_files $uri $uri/ /index.html;") || !strings.Contains(string(spaConfig), "opfield_pages_not_found") {
		t.Fatalf("SPA fallback is missing from preview config: %s", spaConfig)
	}

	customURL := "https://errors.example.com/not-found"
	if err := runtime.MaterializePreview(profileID, deploymentID, "redirect.pages.example", "", "", PreviewFallback{URL: customURL}); err != nil {
		t.Fatal(err)
	}
	redirectConfig, err := os.ReadFile(runtime.previewConfigPath("redirect.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(redirectConfig), "error_page 404 =302 "+customURL+";") || strings.Contains(string(redirectConfig), "location @opfield_pages_not_found") {
		t.Fatalf("custom fallback redirect is incorrect: %s", redirectConfig)
	}

	if err := runtime.MaterializePreview(profileID, deploymentID, "invalid.pages.example", "", "", PreviewFallback{URL: "https://example.com/bad#fragment"}); err == nil {
		t.Fatal("expected unsafe fallback URL rejection")
	}
}

func TestPreviewServesProjectNotFoundPage(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)

	for name, fallback := range map[string]PreviewFallback{"plain.pages.example": {}, "spa.pages.example": {SPAFallback: true}} {
		if err := runtime.MaterializePreview(profileID, deploymentID, name, "", "", fallback); err != nil {
			t.Fatal(err)
		}
		content, err := os.ReadFile(runtime.previewConfigPath(name))
		if err != nil {
			t.Fatal(err)
		}
		config := string(content)
		// The status comes from the original response, so error_page carries no "=" override.
		if !strings.Contains(config, "error_page 404 @opfield_pages_404;") {
			t.Fatalf("%s: 404 is not routed to the project page: %s", name, config)
		}
		if !strings.Contains(config, "location @opfield_pages_404 {\n        try_files /404.html @opfield_pages_not_found;") {
			t.Fatalf("%s: project 404.html is not tried first: %s", name, config)
		}
		if !strings.Contains(config, "location @opfield_pages_not_found {") || !strings.Contains(config, "return 404 '") {
			t.Fatalf("%s: generic page is missing as the last resort: %s", name, config)
		}
		// The SPA fallback covers app paths only: a missing path with a file extension stays a 404.
		extension := "        location ~ \\.[^/]+$ {\n            limit_except GET HEAD { deny all; }\n            try_files $uri =404;"
		if fallback.SPAFallback != strings.Contains(config, extension) {
			t.Fatalf("%s: extension paths (SPA %v): %s", name, fallback.SPAFallback, config)
		}
	}

	// A configured fallback URL redirects and never reaches the project page.
	if err := runtime.MaterializePreview(profileID, deploymentID, "url.pages.example", "", "", PreviewFallback{URL: "https://errors.example.com/x"}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(runtime.previewConfigPath("url.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "opfield_pages_404") {
		t.Fatalf("fallback URL preview must not serve 404.html: %s", content)
	}
}

func TestConfigSwitchSkipsNginxReloadWhenContentIsUnchanged(t *testing.T) {
	runtime, nginx := newRuntime(t)
	stageRelease(t, runtime)
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	if nginx.reloadCalls != 1 {
		t.Fatalf("first materialization reload calls = %d, want 1", nginx.reloadCalls)
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	if nginx.reloadCalls != 1 {
		t.Fatalf("unchanged materialization reload calls = %d, want 1", nginx.reloadCalls)
	}
}

func TestMaterializePreviewRepairsReleaseModes(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)
	if err := os.Chmod(runtime.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runtime.releaseDir(deploymentID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runtime.releaseContentDir(deploymentID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := runtime.MaterializePreview(profileID, deploymentID, "repair.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	assertMode(t, runtime.root, publicDirectoryMode)
	assertMode(t, runtime.releasesDir(), publicDirectoryMode)
	assertMode(t, runtime.releaseDir(deploymentID), publicDirectoryMode)
	assertMode(t, runtime.releaseContentDir(deploymentID), publicDirectoryMode)
	assertMode(t, filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"), publicFileMode)
}

func TestStoragePreflightAndInventory(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)
	if err := runtime.ActivateTagRoute(routeID, deploymentID); err != nil {
		t.Fatal(err)
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "preview.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	inventory, err := runtime.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Deployments) != 1 || len(inventory.Previews) != 1 || len(inventory.Routes) != 1 || inventory.Bytes == 0 {
		t.Fatalf("unexpected inventory: %#v", inventory)
	}
	preflight, err := runtime.StoragePreflight(1)
	if err != nil || !preflight.Available || preflight.FreeBytes < 1 {
		t.Fatalf("unexpected preflight: %#v, %v", preflight, err)
	}
}

func TestRepairStorageRepairsLegacyPublicModesWithoutExposingUploads(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1, []byte(`{"route":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 1); err != nil {
		t.Fatal(err)
	}
	const previewHostname = "preview.pages.example"
	if err := runtime.StageRuntimeConfig(RuntimeConfigBindingPreview, previewHostname, 1, []byte(`{"preview":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.ActivateRuntimeConfig(RuntimeConfigBindingPreview, previewHostname, 1); err != nil {
		t.Fatal(err)
	}
	privateUploadID := "44444444-4444-4444-4444-444444444444"
	privateUpload := archiveBytes(t, []tarEntry{{name: "pending.txt", body: "pending"}})
	if err := runtime.InitUpload(privateUploadID, deploymentID, int64(len(privateUpload)), digestOf(privateUpload)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload(privateUploadID, 0, privateUpload); err != nil {
		t.Fatal(err)
	}

	routeBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingRoute, routeID)
	previewBinding := runtime.runtimeConfigBindingDir(RuntimeConfigBindingPreview, previewHostname)
	for _, path := range []string{
		runtime.root,
		runtime.releasesDir(),
		runtime.releaseDir(deploymentID),
		runtime.releaseContentDir(deploymentID),
		filepath.Join(routeBinding, "..", "..", ".."),
		filepath.Dir(filepath.Dir(routeBinding)),
		filepath.Dir(routeBinding),
		routeBinding,
		filepath.Join(routeBinding, "versions"),
		filepath.Join(previewBinding, "..", ".."),
		filepath.Join(previewBinding, ".."),
		previewBinding,
		filepath.Join(previewBinding, "versions"),
		runtime.uploadsDir(),
	} {
		if err := os.Chmod(filepath.Clean(path), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{
		filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"),
		filepath.Join(routeBinding, "binding.json"),
		filepath.Join(routeBinding, "versions", "1.js"),
		filepath.Join(previewBinding, "binding.json"),
		filepath.Join(previewBinding, "versions", "1.js"),
	} {
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(runtime.uploadsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runtime.uploadArchivePath(privateUploadID), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(runtime.uploadMetaPath(privateUploadID), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := runtime.RepairStorage(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		runtime.root,
		runtime.releasesDir(),
		runtime.releaseDir(deploymentID),
		runtime.releaseContentDir(deploymentID),
		runtime.releaseManifestPath(deploymentID),
		filepath.Join(runtime.releaseContentDir(deploymentID), "index.html"),
		routeBinding,
		filepath.Join(routeBinding, "versions"),
		filepath.Join(routeBinding, "binding.json"),
		filepath.Join(routeBinding, "versions", "1.js"),
		previewBinding,
		filepath.Join(previewBinding, "versions"),
		filepath.Join(previewBinding, "binding.json"),
		filepath.Join(previewBinding, "versions", "1.js"),
	} {
		want := publicDirectoryMode
		if strings.HasSuffix(path, ".html") || strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".json") {
			want = publicFileMode
		}
		assertMode(t, path, want)
	}
	assertMode(t, runtime.uploadsDir(), privateDirectoryMode)
	assertMode(t, runtime.uploadArchivePath(privateUploadID), privateFileMode)
	assertMode(t, runtime.uploadMetaPath(privateUploadID), privateFileMode)
	for _, binding := range []struct {
		kind RuntimeConfigBindingKind
		id   string
	}{
		{kind: RuntimeConfigBindingRoute, id: routeID},
		{kind: RuntimeConfigBindingPreview, id: previewHostname},
	} {
		currentPath, err := runtime.RuntimeConfigPath(binding.kind, binding.id)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(currentPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("runtime config current path is not a symlink after preflight: %s", currentPath)
		}
	}
}

func TestRouteIncludePathUsesConfiguredNginxDirectory(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "custom-nginx", "conf.d")
	runtime, err := New(filepath.Join(t.TempDir(), "pages"), configDir, filepath.Join(t.TempDir(), "certs"), &fakeNginx{valid: true})
	if err != nil {
		t.Fatal(err)
	}
	includePath, err := runtime.RouteIncludePath(routeID)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(configDir, "pages", "routes", routeID+".inc")
	if includePath != want {
		t.Fatalf("include path = %q, want %q", includePath, want)
	}
}

func TestPagesOnlyVersionedCertificateMaterializesWithDefaultProfile(t *testing.T) {
	runtime, _ := newRuntime(t)
	stageRelease(t, runtime)
	certificateID := "internal-66666666-6666-6666-6666-666666666666"
	version := strings.Repeat("a", 64)
	if _, err := nginx.DeployVersionedCert(runtime.certsDir, certificateID, version, "1", []byte("certificate"), []byte("private-key"), nil); err != nil {
		t.Fatal(err)
	}
	if err := runtime.MaterializePreview("default", deploymentID, "preview.pages.example", certificateID, version); err != nil {
		t.Fatal(err)
	}
	certificatePath := filepath.Join(runtime.certsDir, certificateID, "versions", version, "fullchain.pem")
	if _, err := os.Stat(certificatePath); err != nil {
		t.Fatalf("fresh Pages certificate is missing: %v", err)
	}
	config, err := os.ReadFile(runtime.previewConfigPath("preview.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), certificatePath) {
		t.Fatalf("preview config does not use immutable Pages certificate: %s", config)
	}
	if err := runtime.MaterializePreview("wrong", deploymentID, "other.pages.example", "", ""); err == nil {
		t.Fatal("expected non-default profile rejection")
	}
}

func newRuntime(t *testing.T) (*Runtime, *fakeNginx) {
	t.Helper()
	nginx := &fakeNginx{valid: true}
	runtime, err := New(filepath.Join(t.TempDir(), "pages"), filepath.Join(t.TempDir(), "conf"), filepath.Join(t.TempDir(), "certs"), nginx)
	if err != nil {
		t.Fatal(err)
	}
	return runtime, nginx
}

func stageRelease(t *testing.T, runtime *Runtime) {
	t.Helper()
	archive := archiveBytes(t, []tarEntry{{name: "index.html", body: "ok"}})
	if err := runtime.InitUpload(uploadID, deploymentID, int64(len(archive)), digestOf(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.AppendUpload(uploadID, 0, archive); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.FinalizeUpload(uploadID, deploymentID); err != nil {
		t.Fatal(err)
	}
}

type tarEntry struct {
	name, body, linkname string
	typeflag             byte
}

func archiveBytes(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		header := &tar.Header{Name: entry.name, Mode: 0o644, Typeflag: typeflag, Linkname: entry.linkname, Size: int64(len(entry.body))}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.body != "" {
			if _, err := tw.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

func digestOf(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode %s = %04o, want %04o", path, got, want)
	}
}

func TestPreviewRevocationKeepsFilesAndTagRoutes(t *testing.T) {
	runtime, manager := newRuntime(t)
	stageRelease(t, runtime)
	host := "private.pages.example"
	if err := runtime.MaterializePreview(profileID, deploymentID, host, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ActivateTagRoute(routeID, deploymentID); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(runtime.routeIncludePath(routeID))
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.RemovePreview(host); err != nil {
		t.Fatal(err)
	}
	denied, err := os.ReadFile(runtime.previewConfigPath(host))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(denied), "return 404;") || !strings.Contains(string(denied), "ssl_reject_handshake on;") || strings.Contains(string(denied), runtime.releaseContentDir(deploymentID)) {
		t.Fatalf("unsafe revocation config: %s", denied)
	}
	if _, err := runtime.VerifyRelease(deploymentID, ""); err != nil {
		t.Fatal("revocation removed files:", err)
	}
	after, err := os.ReadFile(runtime.routeIncludePath(routeID))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("tag route changed")
	}
	inventory, err := runtime.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Previews) != 0 || len(inventory.Deployments) != 1 {
		t.Fatalf("unexpected inventory: %#v", inventory)
	}
	// Reconciliation is cheap when unchanged and restores missing or rolled-back configuration.
	reloads := manager.reloadCalls
	if err := runtime.RemovePreview(host); err != nil {
		t.Fatal(err)
	}
	if manager.reloadCalls != reloads {
		t.Fatal("unchanged revocation reloaded nginx")
	}
	if err := os.Remove(runtime.previewConfigPath(host)); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RemovePreview(host); err != nil {
		t.Fatal(err)
	}
	restored, _ := os.ReadFile(runtime.previewConfigPath(host))
	if !bytes.Equal(denied, restored) {
		t.Fatal("lost denial was not restored")
	}
	if err := os.WriteFile(runtime.previewConfigPath(host), []byte("old active preview"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RemovePreview(host); err != nil {
		t.Fatal(err)
	}
	restored, _ = os.ReadFile(runtime.previewConfigPath(host))
	if !bytes.Equal(denied, restored) {
		t.Fatal("rolled-back preview was not denied")
	}
	// A failed attempt to re-enable must preserve denial, not expose a partial host.
	manager.reloadErr = errors.New("reload failed")
	if err := runtime.MaterializePreview(profileID, deploymentID, host, "", ""); err == nil {
		t.Fatal("expected reload failure")
	}
	stillDenied, _ := os.ReadFile(runtime.previewConfigPath(host))
	if !bytes.Equal(denied, stillDenied) {
		t.Fatal("denial did not survive rollback")
	}
	manager.reloadErr = nil
	if err := runtime.MaterializePreview(profileID, deploymentID, host, "", ""); err != nil {
		t.Fatal(err)
	}
	live, _ := os.ReadFile(runtime.previewConfigPath(host))
	if !strings.Contains(string(live), runtime.releaseContentDir(deploymentID)) {
		t.Fatal("preview did not reopen")
	}
}
