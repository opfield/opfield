package pages

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

func inspectionFixture(t *testing.T) (*Runtime, *fakeNginx, []BindingExpectation) {
	t.Helper()
	r, nginx := newRuntime(t)
	stageRelease(t, r)
	manifest, err := r.readManifest(deploymentID)
	if err != nil {
		t.Fatal(err)
	}
	bindings := []BindingExpectation{
		{Kind: RuntimeConfigBindingRoute, ID: routeID},
		{Kind: RuntimeConfigBindingPreview, ID: "preview.pages.example"},
	}
	for i := range bindings {
		b := &bindings[i]
		b.DeploymentID, b.SHA256, b.Size = deploymentID, manifest.SHA256, manifest.Size
		b.Generation, b.RuntimeConfig = 1, json.RawMessage(`{"api":"/v1"}`)
		if err := r.StageRuntimeConfig(b.Kind, b.ID, 1, b.RuntimeConfig); err != nil {
			t.Fatal(err)
		}
		if _, err := r.ActivateRuntimeConfig(b.Kind, b.ID, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.ActivateTagRoute(routeID, deploymentID); err != nil {
		t.Fatal(err)
	}
	if err := r.MaterializePreview(profileID, deploymentID, bindings[1].ID, "", ""); err != nil {
		t.Fatal(err)
	}
	return r, nginx, bindings
}

func TestBindingInspectionUnchangedAndRestart(t *testing.T) {
	r, nginx, expected := inspectionFixture(t)
	file := filepath.Join(r.releaseContentDir(deploymentID), "index.html")
	before, _ := os.Stat(file)
	js, _ := r.runtimeConfigVersionPath(RuntimeConfigBindingRoute, routeID, 1)
	jsBefore, _ := os.Stat(js)
	reloads := nginx.reloadCalls
	for range 3 {
		got := r.InspectBindings(expected)
		if !reflect.DeepEqual(got.Matches, []bool{true, true}) || got.VerifiedReleases != 1 {
			t.Fatalf("inspection: %#v", got)
		}
	}
	after, _ := os.Stat(file)
	jsAfter, _ := os.Stat(js)
	// Reading may change atime; chmod changes ctime even with identical modes.
	if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) || !reflect.DeepEqual(changeTime(before), changeTime(after)) ||
		!os.SameFile(jsBefore, jsAfter) || !jsBefore.ModTime().Equal(jsAfter.ModTime()) || !reflect.DeepEqual(changeTime(jsBefore), changeTime(jsAfter)) {
		t.Fatal("unchanged inspection rewrote file metadata")
	}
	if nginx.reloadCalls != reloads {
		t.Fatal("inspection reloaded nginx")
	}
	restarted, err := New(r.root, r.configDir, r.certsDir, nginx)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.RepairStorage(); err != nil {
		t.Fatal(err)
	}
	if got := restarted.InspectBindings(expected); !reflect.DeepEqual(got.Matches, []bool{true, true}) {
		t.Fatalf("restart: %#v", got)
	}
}

func changeTime(info os.FileInfo) any {
	stat := reflect.ValueOf(info.Sys()).Elem()
	for _, name := range []string{"Ctim", "Ctimespec"} {
		if field := stat.FieldByName(name); field.IsValid() {
			return field.Interface()
		}
	}
	return nil
}

func TestBindingInspectionDetectsDriftAndRepairsPermissions(t *testing.T) {
	for _, scenario := range []string{"missing-route", "wrong-route", "missing-preview", "wrong-runtime-config", "wrong-current", "symlink", "release-symlink", "wrong-permissions", "changed-fallback", "changed-certificate", "changed-generation", "changed-release"} {
		t.Run(scenario, func(t *testing.T) {
			r, _, expected := inspectionFixture(t)
			file := filepath.Join(r.releaseContentDir(deploymentID), "index.html")
			js, _ := r.runtimeConfigVersionPath(RuntimeConfigBindingRoute, routeID, 1)
			var err error
			switch scenario {
			case "missing-route":
				err = os.Remove(r.routeIncludePath(routeID))
			case "wrong-route":
				err = os.WriteFile(r.routeIncludePath(routeID), []byte("root /wrong;"), 0o640)
			case "missing-preview":
				err = os.Remove(r.previewConfigPath(expected[1].ID))
			case "wrong-runtime-config":
				err = os.WriteFile(js, []byte("tampered"), 0o644)
			case "wrong-current":
				if err = r.StageRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2, []byte(`{}`)); err == nil {
					_, err = r.ActivateRuntimeConfig(RuntimeConfigBindingRoute, routeID, 2)
				}
			case "symlink", "release-symlink":
				outside := filepath.Join(t.TempDir(), "outside")
				if err = os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
					t.Fatal(err)
				}
				path := js
				if scenario == "release-symlink" {
					path = file
				}
				if err = os.Remove(path); err == nil {
					err = os.Symlink(outside, path)
				}
				defer assertMode(t, outside, 0o600)
			case "wrong-permissions":
				err = os.Chmod(file, 0o600)
			case "changed-fallback":
				expected[1].SPAFallback = true
			case "changed-certificate":
				expected[1].CertificateID, expected[1].CertificateVersion = deploymentID, expected[1].SHA256
			case "changed-generation":
				expected[0].Generation = 2
			case "changed-release":
				expected[0].SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}
			if err != nil {
				t.Fatal(err)
			}
			got := r.InspectBindings(expected)
			if scenario == "wrong-permissions" {
				if !got.Matches[0] || !got.Matches[1] {
					t.Fatalf("permissions not repaired: %#v", got)
				}
				assertMode(t, file, 0o644)
			} else if got.Matches[0] && got.Matches[1] {
				t.Fatalf("accepted drift: %#v", got)
			}
			if scenario == "missing-route" || scenario == "wrong-route" {
				if err := r.ActivateTagRoute(routeID, deploymentID); err != nil {
					t.Fatal(err)
				}
				if !r.InspectBindings(expected).Matches[0] {
					t.Fatal("route did not recover")
				}
			}
			if scenario == "missing-preview" {
				if err := r.MaterializePreview(profileID, deploymentID, expected[1].ID, "", ""); err != nil {
					t.Fatal(err)
				}
				if !r.InspectBindings(expected).Matches[1] {
					t.Fatal("preview did not recover")
				}
			}
		})
	}
}

func TestStoragePreflightDoesNotTraverseOtherReleases(t *testing.T) {
	r, _, _ := inspectionFixture(t)
	file := filepath.Join(r.releaseContentDir(deploymentID), "index.html")
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.StoragePreflight(1); err != nil {
		t.Fatal(err)
	}
	assertMode(t, file, 0o600)
	if _, err := r.VerifyRelease(deploymentID, ""); err != nil {
		t.Fatal(err)
	}
	assertMode(t, file, 0o644)
}

// Representative reconciliation fixture: 4 releases, 500 files each, 20
// preview bindings. Setup is outside the measurement; steady state is checked.
func BenchmarkPagesBindingInspection(b *testing.B) {
	root := b.TempDir()
	r, err := New(filepath.Join(root, "pages"), filepath.Join(root, "conf.d"), filepath.Join(root, "certs"), &fakeNginx{valid: true})
	if err != nil {
		b.Fatal(err)
	}
	expected := make([]BindingExpectation, 0, 20)
	for d := 0; d < 4; d++ {
		id := fmt.Sprintf("%08d-2222-4222-8222-222222222222", d+1)
		content := r.releaseContentDir(id)
		if err := os.MkdirAll(content, 0755); err != nil {
			b.Fatal(err)
		}
		for f := 0; f < 500; f++ {
			if err := os.WriteFile(filepath.Join(content, fmt.Sprintf("page-%d.html", f)), []byte("<html>page</html>"), 0644); err != nil {
				b.Fatal(err)
			}
		}
		manifest := releaseManifest{DeploymentID: id, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Size: 10000, FileCount: 500}
		data, _ := json.Marshal(manifest)
		if err := os.WriteFile(r.releaseManifestPath(id), data, 0644); err != nil {
			b.Fatal(err)
		}
		for n := 0; n < 5; n++ {
			hostname := fmt.Sprintf("preview-%d-%d.pages.example", d, n)
			value := json.RawMessage(`{"api":"/v1"}`)
			if err := r.StageRuntimeConfig(RuntimeConfigBindingPreview, hostname, 1, value); err != nil {
				b.Fatal(err)
			}
			if _, err := r.ActivateRuntimeConfig(RuntimeConfigBindingPreview, hostname, 1); err != nil {
				b.Fatal(err)
			}
			if err := r.MaterializePreview("default", id, hostname, "", ""); err != nil {
				b.Fatal(err)
			}
			expected = append(expected, BindingExpectation{Kind: RuntimeConfigBindingPreview, ID: hostname, DeploymentID: id, SHA256: manifest.SHA256, Size: manifest.Size, Generation: 1, RuntimeConfig: value})
		}
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		result := r.InspectBindings(expected)
		if result.VerifiedReleases != 4 {
			b.Fatal(result)
		}
		for _, matched := range result.Matches {
			if !matched {
				b.Fatal(result)
			}
		}
	}
}

// A node that has not moved to the Opfield names writes its Pages configs with the pre-Opfield names; inspection must
// still see them as matching, or Opfield republishes the binding (a new runtime-config generation) on every pass.
func TestBindingInspectionMatchesOnNodeWithPreOpfieldNames(t *testing.T) {
	naming.SetLegacy(true)
	t.Cleanup(func() { naming.SetLegacy(false) })
	r, _, expected := inspectionFixture(t)
	content, err := os.ReadFile(r.routeIncludePath(routeID))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "gateway") {
		t.Fatalf("route config not rendered with the pre-Opfield names: %q", content)
	}
	if got := r.InspectBindings(expected); !reflect.DeepEqual(got.Matches, []bool{true, true}) {
		t.Fatalf("inspection on a pre-Opfield node: %#v", got)
	}
}
